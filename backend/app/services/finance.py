"""Register sessions & cash reconciliation, expenses, account transfers, bank reconciliation."""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.money import ZERO, D, r2
from app.models import (
    Account,
    Expense,
    ExpenseCategory,
    JournalLine,
    Payment,
    PaymentMethod,
    Register,
    RegisterSession,
    Sale,
)
from app.services import accounting, approvals
from app.services.accounting import Leg
from app.services.audit import audit
from app.services.notify import notify_permission
from app.services.numbering import next_number
from app.services.settings import get_policy

# ---------------------------------------------------------------- registers


def open_session(db: Session, ctx, register_id: uuid.UUID, opening_float: Decimal) -> RegisterSession:
    reg = db.scalar(select(Register).where(Register.id == register_id).with_for_update(of=Register))
    if reg is None or not reg.is_active:
        raise NotFound("Register not found or inactive")
    ctx.ensure_location(reg.location_id)
    if db.scalar(select(RegisterSession.id).where(RegisterSession.register_id == reg.id, RegisterSession.status == "OPEN")):
        raise Conflict("This register already has an open session")
    s = RegisterSession(id=uuid.uuid4(), register_id=reg.id, location_id=reg.location_id, opened_by=ctx.user_id,
                        opening_float=r2(opening_float))
    db.add(s)
    db.flush()
    audit(db, ctx, "register.opened", entity_type="register_session", entity_id=s.id, location_id=reg.location_id,
          details={"register": reg.name, "opening_float": s.opening_float})
    return s


def session_summary(db: Session, s: RegisterSession) -> dict:
    """Expected cash and totals by payment method for a register session."""
    rows = db.execute(
        select(PaymentMethod.code, PaymentMethod.name, PaymentMethod.kind, Payment.direction, func.sum(Payment.amount),
               func.count())
        .join(PaymentMethod, PaymentMethod.id == Payment.payment_method_id)
        .where(Payment.register_session_id == s.id)
        .group_by(PaymentMethod.code, PaymentMethod.name, PaymentMethod.kind, Payment.direction))
    by_method: dict[str, dict] = {}
    cash_in = cash_out = ZERO
    for code, name, kind, direction, total, n in rows:
        m = by_method.setdefault(code, {"code": code, "name": name, "kind": kind, "in": ZERO, "out": ZERO, "count": 0})
        m["in" if direction == "IN" else "out"] += D(total)
        m["count"] += n
        if kind == "CASH":
            if direction == "IN":
                cash_in += D(total)
            else:
                cash_out += D(total)
    cash_expenses = D(db.scalar(select(func.coalesce(func.sum(Expense.amount), 0)).where(
        Expense.register_session_id == s.id, Expense.status == "POSTED")))
    sales = db.execute(select(func.count(), func.coalesce(func.sum(Sale.grand_total), 0)).where(
        Sale.register_session_id == s.id, Sale.status == "COMPLETED")).one()
    voided = db.scalar(select(func.count()).select_from(Sale).where(Sale.register_session_id == s.id,
                                                                    Sale.status == "CANCELLED"))
    expected = s.opening_float + cash_in - cash_out - cash_expenses
    return {
        "opening_float": s.opening_float, "cash_in": cash_in, "cash_out": cash_out, "cash_expenses": cash_expenses,
        "expected_cash": expected, "sales_count": int(sales[0]), "sales_total": D(sales[1]), "voided_count": int(voided),
        "by_method": [{**m, "net": m["in"] - m["out"]} for m in by_method.values()],
    }


def close_session(db: Session, ctx, session_id: uuid.UUID, counted_cash: Decimal, notes: str | None) -> RegisterSession:
    s = db.scalar(select(RegisterSession).where(RegisterSession.id == session_id).with_for_update(of=RegisterSession))
    if s is None:
        raise NotFound("Register session not found")
    ctx.ensure_resource(s.location_id)
    if s.status != "OPEN":
        raise Conflict("Session is already closed")
    if s.opened_by != ctx.user_id and not ctx.has("registers.manage"):
        raise ValidationFailed("Only the cashier who opened the session or a manager can close it")
    summary = session_summary(db, s)
    s.expected_cash = summary["expected_cash"]
    s.counted_cash = r2(counted_cash)
    s.variance = s.counted_cash - s.expected_cash
    s.status, s.closed_by, s.closed_at, s.closing_notes = "CLOSED", ctx.user_id, datetime.now(UTC), notes
    if s.variance != ZERO:
        je = accounting.post(db, source_type="REGISTER_CLOSE", source_id=s.id, location_id=s.location_id,
                             actor_id=ctx.user_id, memo=f"Cash {'over' if s.variance > 0 else 'short'} — {s.register.name}",
                             legs=[Leg("CASH", s.variance), Leg("CASH_OVER_SHORT", -s.variance)])
        s.journal_entry_id = je.id if je else None
    if abs(s.variance) >= get_policy(db).register_variance_alert and s.variance != 0:
        notify_permission(db, "registers.manage", s.location_id, kind="CASH_DISCREPANCY",
                          title=f"Cash variance of ₹{s.variance} on {s.register.name}",
                          body=f"Expected ₹{s.expected_cash}, counted ₹{s.counted_cash}", link="/finance/registers")
    audit(db, ctx, "register.closed", entity_type="register_session", entity_id=s.id, location_id=s.location_id,
          details={"expected": s.expected_cash, "counted": s.counted_cash, "variance": s.variance})
    return s


# ---------------------------------------------------------------- expenses


def create_expense(db: Session, ctx, *, idempotency_key: str | None, location_id, category_id, expense_date: date,
                   amount: Decimal, description: str, vendor: str | None, paid_from_account_id,
                   register_session_id, reference: str | None) -> tuple[Expense, bool]:
    if idempotency_key:
        existing = db.scalar(select(Expense).where(Expense.idempotency_key == idempotency_key))
        if existing:
            ctx.ensure_resource(existing.location_id)
            return existing, False
    ctx.ensure_location(location_id)
    cat = db.get(ExpenseCategory, category_id)
    if cat is None or not cat.is_active:
        raise ValidationFailed("Expense category not found")
    acc = db.get(Account, paid_from_account_id)
    if acc is None or not acc.is_cash_or_bank or not acc.is_active:
        raise ValidationFailed("Expenses must be paid from a cash or bank account")
    if register_session_id:
        s = db.get(RegisterSession, register_session_id)
        if s is None or s.status != "OPEN" or s.location_id != location_id:
            raise Conflict("Register session is not open at this location")
        if acc.system_key != "CASH":
            raise ValidationFailed("Register expenses must be paid from Cash on Hand")
    amount = r2(amount)
    if amount <= 0:
        raise ValidationFailed("Amount must be positive")
    policy = get_policy(db)
    needs = (policy.expense_approval_threshold > 0 and amount >= policy.expense_approval_threshold
             and not ctx.has("expenses.approve"))
    e = Expense(id=uuid.uuid4(), number=next_number(db, "EXP"), location_id=location_id, category_id=cat.id,
                expense_date=expense_date, amount=amount, description=description, vendor=vendor,
                paid_from_account_id=acc.id, register_session_id=register_session_id, reference=reference,
                status="PENDING_APPROVAL" if needs else "POSTED", idempotency_key=idempotency_key,
                created_by=ctx.user_id)
    db.add(e)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Expense).where(Expense.idempotency_key == idempotency_key))
        if existing:
            return existing, False
        raise
    if needs:
        approvals.create(db, ctx, type_="EXPENSE", location_id=location_id,
                         title=f"Expense {e.number}: {description[:80]} (₹{amount})", entity_type="expense",
                         entity_id=e.id, amount=amount)
    else:
        post_expense(db, ctx, e, approver_id=ctx.user_id)
    audit(db, ctx, "finance.expense_created", entity_type="expense", entity_id=e.id, location_id=location_id,
          details={"amount": amount, "category": cat.name, "status": e.status})
    return e, True


def post_expense(db: Session, ctx, e: Expense, *, approver_id) -> None:
    if e.register_session_id:
        s = db.get(RegisterSession, e.register_session_id)
        if s.status != "OPEN":
            raise Conflict("The register session for this cash expense is closed; record it against a new session")
    cat = db.get(ExpenseCategory, e.category_id)
    je = accounting.post(db, source_type="EXPENSE", source_id=e.id, location_id=e.location_id, actor_id=approver_id,
                         entry_date=e.expense_date, memo=f"Expense {e.number}: {e.description[:100]}",
                         legs=[Leg(cat.account_id, e.amount), Leg(e.paid_from_account_id, -e.amount)])
    e.journal_entry_id = je.id if je else None
    e.status = "POSTED"
    e.approved_by, e.approved_at = approver_id, datetime.now(UTC)


def _approve_expense(db: Session, ctx, req) -> None:
    e = db.scalar(select(Expense).where(Expense.id == req.entity_id).with_for_update(of=Expense))
    if e is None or e.status != "PENDING_APPROVAL":
        raise Conflict("Expense is not pending approval")
    post_expense(db, ctx, e, approver_id=ctx.user_id)


def _reject_expense(db: Session, ctx, req) -> None:
    e = db.get(Expense, req.entity_id)
    if e and e.status == "PENDING_APPROVAL":
        e.status = "REJECTED"
        e.rejection_reason = req.decision_note


approvals.register("EXPENSE", _approve_expense, _reject_expense)


# ---------------------------------------------------------------- accounts


def account_balance(db: Session, account_id: uuid.UUID, *, as_of: date | None = None,
                    location_ids: list[uuid.UUID] | None = None) -> Decimal:
    from app.models import JournalEntry

    q = (select(func.coalesce(func.sum(JournalLine.debit - JournalLine.credit), 0))
         .join(JournalEntry, JournalEntry.id == JournalLine.entry_id).where(JournalLine.account_id == account_id))
    if as_of:
        q = q.where(JournalEntry.entry_date <= as_of)
    if location_ids is not None:
        q = q.where(JournalLine.location_id.in_(location_ids))
    return D(db.scalar(q))


def transfer_funds(db: Session, ctx, *, from_account_id, to_account_id, amount: Decimal, entry_date: date,
                   location_id, memo: str):
    if from_account_id == to_account_id:
        raise ValidationFailed("Choose two different accounts")
    a, b = db.get(Account, from_account_id), db.get(Account, to_account_id)
    if not a or not b or not a.is_cash_or_bank or not b.is_cash_or_bank:
        raise ValidationFailed("Transfers are only between cash/bank accounts")
    if location_id:
        ctx.ensure_location(location_id)
    amount = r2(amount)
    if amount <= 0:
        raise ValidationFailed("Amount must be positive")
    je = accounting.post(db, source_type="FUND_TRANSFER", source_id=None, location_id=location_id, actor_id=ctx.user_id,
                         entry_date=entry_date, memo=memo or f"Transfer {a.name} → {b.name}",
                         legs=[Leg(b.id, amount), Leg(a.id, -amount)])
    audit(db, ctx, "finance.fund_transfer", entity_type="journal_entry", entity_id=je.id, location_id=location_id,
          details={"from": a.name, "to": b.name, "amount": amount})
    return je
