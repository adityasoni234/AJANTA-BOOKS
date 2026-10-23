"""Returns, refunds, credit notes and exchanges.

Refunds are calculated from the original sale lines (their actual taxable value and GST, so
original discounts and rounding are honoured), never from current prices. The sale row is
locked while a return is created, so concurrent returns cannot exceed the quantity sold.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.core.money import ZERO, r2
from app.models import (
    CustomerLedger,
    Invoice,
    Location,
    Organization,
    Payment,
    PaymentAllocation,
    PaymentMethod,
    RegisterSession,
    Return,
    ReturnLine,
    Sale,
)
from app.services import accounting, approvals, gst
from app.services import inventory as inv
from app.services.accounting import Leg
from app.services.audit import audit
from app.services.inventory import Ref
from app.services.numbering import current_fy, next_number, sequence_number
from app.services.sales import buyer_snapshot, seller_snapshot
from app.services.settings import get_policy

DISPOSITION_BUCKET = {"RESTOCK": "ON_HAND", "QUARANTINE": "QUARANTINED", "DAMAGED": "DAMAGED"}
DISPOSITION_COPY = {"RESTOCK": "AVAILABLE", "QUARANTINE": "QUARANTINED", "DAMAGED": "DAMAGED"}


def returned_so_far(db: Session, sale_id: uuid.UUID) -> dict[uuid.UUID, dict]:
    """Per sale line: qty and amounts already returned (completed or pending approval)."""
    rows = db.execute(
        select(ReturnLine.sale_line_id, func.sum(ReturnLine.qty), func.sum(ReturnLine.taxable_value),
               func.sum(ReturnLine.cgst), func.sum(ReturnLine.sgst), func.sum(ReturnLine.igst))
        .join(Return, Return.id == ReturnLine.return_id)
        .where(Return.sale_id == sale_id, Return.status != "REJECTED")
        .group_by(ReturnLine.sale_line_id))
    return {sl: {"qty": int(q), "amounts": (t, c, s, i)} for sl, q, t, c, s, i in rows}


def returned_copy_ids(db: Session, sale_id: uuid.UUID) -> set[uuid.UUID]:
    return set(db.scalars(select(ReturnLine.copy_id).join(Return).where(
        Return.sale_id == sale_id, Return.status != "REJECTED", ReturnLine.copy_id.is_not(None))))


def create_return(db: Session, ctx, *, idempotency_key: str, sale_id: uuid.UUID, lines: list[dict], reason: str,
                  refund_method_id: uuid.UUID, refund_reference: str | None,
                  register_session_id: uuid.UUID | None) -> tuple[Return, bool]:
    existing = db.scalar(select(Return).where(Return.idempotency_key == idempotency_key))
    if existing:
        ctx.ensure_resource(existing.location_id)
        return existing, False
    sale = db.scalar(select(Sale).where(Sale.id == sale_id).with_for_update(of=Sale))
    if sale is None:
        raise NotFound("Sale not found")
    ctx.ensure_resource(sale.location_id)
    if sale.status != "COMPLETED":
        raise Conflict("Only completed sales can be returned")
    if sale.balance_due > 0:
        raise Conflict("Collect the outstanding balance on this sale before processing a return")
    policy = get_policy(db)
    if sale.created_at < datetime.now(UTC) - timedelta(days=policy.return_window_days) and not ctx.has("returns.approve"):
        raise Forbidden(f"Return window of {policy.return_window_days} days has passed; a manager must process it",
                        code="return_window")
    method = db.get(PaymentMethod, refund_method_id)
    if method is None or method.kind == "CREDIT":
        raise ValidationFailed("Refund method not allowed")
    if method.kind == "STORE_CREDIT" and sale.customer_id is None:
        raise ValidationFailed("Store credit refunds require a customer on the original sale")
    if method.requires_reference and not refund_reference:
        raise ValidationFailed(f"{method.name} refunds need a reference")
    session = None
    if method.kind == "CASH":
        if not register_session_id:
            raise ValidationFailed("Cash refunds must be made from an open register session")
        session = db.get(RegisterSession, register_session_id)
        if session is None or session.status != "OPEN" or session.location_id != sale.location_id:
            raise Conflict("Register session is not open at this outlet", code="register_closed")
    if not lines:
        raise ValidationFailed("Select at least one item to return")

    sale_lines = {sl.id: sl for sl in sale.lines}
    done = returned_so_far(db, sale.id)
    done_copies = returned_copy_ids(db, sale.id)
    prepared = []
    req_qty: dict[uuid.UUID, int] = {}
    for ln in lines:
        sl = sale_lines.get(uuid.UUID(str(ln["sale_line_id"])))
        if sl is None:
            raise ValidationFailed("Line does not belong to this sale")
        qty = int(ln["qty"])
        req_qty[sl.id] = req_qty.get(sl.id, 0) + qty
        prev = done.get(sl.id, {"qty": 0, "amounts": (ZERO, ZERO, ZERO, ZERO)})
        if qty <= 0 or prev["qty"] + req_qty[sl.id] > sl.qty:
            raise Conflict(f"Return quantity for '{sl.title}' exceeds quantity sold "
                           f"({sl.qty} sold, {prev['qty']} already returned)", code="excess_return")
        disposition = ln.get("disposition") or "RESTOCK"
        if disposition not in DISPOSITION_BUCKET:
            raise ValidationFailed("Invalid disposition")
        condition = ln.get("condition") or ("DAMAGED" if disposition == "DAMAGED" else "GOOD")
        if disposition == "RESTOCK" and condition in ("POOR", "DAMAGED"):
            raise ValidationFailed(f"'{sl.title}' in {condition.lower()} condition cannot be restocked as sellable")
        if sl.copy_id:
            if ln.get("copy_id") and uuid.UUID(str(ln["copy_id"])) != sl.copy_id:
                raise ValidationFailed("Returned copy does not match the copy sold on this line")
            if sl.copy_id in done_copies:
                raise Conflict("This copy has already been returned", code="excess_return")
        taxable, cgst, sgst, igst = gst.prorate_return(
            sale_qty=sl.qty, return_qty=qty, taxable=sl.taxable_value, cgst=sl.cgst, sgst=sl.sgst, igst=sl.igst,
            already_qty=prev["qty"], already=tuple(r2(x or 0) for x in prev["amounts"]))
        prev["qty"] += qty
        prev["amounts"] = tuple(a + b for a, b in zip(prev["amounts"], (taxable, cgst, sgst, igst), strict=True))
        done[sl.id] = prev
        prepared.append((sl, qty, disposition, condition, taxable, cgst, sgst, igst))

    taxable_t = sum((p[4] for p in prepared), ZERO)
    cgst_t = sum((p[5] for p in prepared), ZERO)
    sgst_t = sum((p[6] for p in prepared), ZERO)
    igst_t = sum((p[7] for p in prepared), ZERO)
    fully_returned = all(done.get(sl.id, {"qty": 0})["qty"] == sl.qty for sl in sale.lines)
    round_off = sale.round_off if fully_returned else ZERO
    refund = taxable_t + cgst_t + sgst_t + igst_t + round_off
    if refund < 0:
        round_off, refund = ZERO, taxable_t + cgst_t + sgst_t + igst_t
    needs_approval = (policy.refund_approval_threshold > 0 and refund >= policy.refund_approval_threshold
                      and not ctx.has("returns.approve"))
    ret = Return(
        id=uuid.uuid4(), number=next_number(db, "RET"), sale_id=sale.id, location_id=sale.location_id,
        register_session_id=session.id if session else None, customer_id=sale.customer_id,
        status="PENDING_APPROVAL" if needs_approval else "COMPLETED", reason=reason, refund_method_id=method.id,
        refund_reference=refund_reference, taxable_total=taxable_t, cgst_total=cgst_t, sgst_total=sgst_t,
        igst_total=igst_t, round_off=round_off, refund_total=refund, idempotency_key=idempotency_key,
        created_by=ctx.user_id,
    )
    db.add(ret)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Return).where(Return.idempotency_key == idempotency_key))
        if existing:
            return existing, False
        raise
    for sl, qty, disposition, condition, taxable, cgst, sgst, igst in prepared:
        db.add(ReturnLine(return_id=ret.id, sale_line_id=sl.id, book_id=sl.book_id, copy_id=sl.copy_id, qty=qty,
                          disposition=disposition, condition=condition, taxable_value=taxable, cgst=cgst, sgst=sgst,
                          igst=igst, line_total=taxable + cgst + sgst + igst, unit_cost=sl.unit_cost))
    db.flush()
    db.refresh(ret)
    if needs_approval:
        req = approvals.create(db, ctx, type_="REFUND", location_id=sale.location_id,
                               title=f"Refund {ret.number}: ₹{refund} via {method.name}", entity_type="return",
                               entity_id=ret.id, amount=refund, reason=reason)
        ret.approval_request_id = req.id
    else:
        complete_return(db, ctx, ret, approver_id=ctx.user_id)
    audit(db, ctx, "returns.created", entity_type="return", entity_id=ret.id, location_id=sale.location_id,
          details={"number": ret.number, "refund": refund, "status": ret.status})
    return ret, True


def complete_return(db: Session, ctx, ret: Return, *, approver_id) -> None:
    sale = db.get(Sale, ret.sale_id)
    method = db.get(PaymentMethod, ret.refund_method_id)
    ref = Ref("RETURN", ret.id, ret.number)
    balances = inv.lock_balances(db, [(ret.location_id, ln.book_id) for ln in ret.lines])
    cost_back = ZERO
    for ln in ret.lines:
        bal = balances[(ret.location_id, ln.book_id)]
        bucket = DISPOSITION_BUCKET[ln.disposition]
        inv.receive_cost(bal, ln.qty, ln.unit_cost)
        inv.apply(db, bal, bucket=bucket, delta=ln.qty, movement_type="SALE_RETURN", ref=ref, actor_id=ctx.user_id,
                  unit_cost=ln.unit_cost, copy_id=ln.copy_id, note=f"{ln.disposition} ({ln.condition})")
        if ln.copy_id:
            c = inv.lock_copy(db, ln.copy_id)
            if c.status != "SOLD":
                raise Conflict(f"Copy {c.copy_code} is not in sold state; cannot accept return")
            inv.move_copy(db, c, event="RETURNED_BY_CUSTOMER", to_status=DISPOSITION_COPY[ln.disposition], ref=ref,
                          actor_id=ctx.user_id, to_location_id=ret.location_id, condition=ln.condition)
        if ln.unit_cost is not None:
            cost_back += r2(ln.unit_cost * ln.qty)
    ret.cogs_reversed = cost_back

    # Credit note (linked to the original invoice)
    loc = db.get(Location, ret.location_id)
    org = db.scalar(select(Organization).limit(1))
    fy = current_fy(db)
    original = db.scalar(select(Invoice).where(Invoice.sale_id == sale.id))
    cn = Invoice(id=uuid.uuid4(), number=next_number(db, "CREDIT_NOTE", scope=str(ret.location_id),
                                                     prefix=f"{loc.invoice_prefix}C", fy=fy, width=5),
                 doc_type="CREDIT_NOTE", return_id=ret.id, original_invoice_id=original.id if original else None,
                 location_id=ret.location_id, financial_year=fy, seller=seller_snapshot(org, loc),
                 buyer=buyer_snapshot(sale.customer), place_of_supply=sale.place_of_supply)
    db.add(cn)

    legs = [Leg("SALES_RETURNS", ret.taxable_total), Leg("OUTPUT_CGST", ret.cgst_total),
            Leg("OUTPUT_SGST", ret.sgst_total), Leg("OUTPUT_IGST", ret.igst_total), Leg("ROUND_OFF", ret.round_off)]
    if method.kind in ("STORE_CREDIT", "EXCHANGE"):
        legs.append(Leg(method.account_id, -ret.refund_total))
        if method.kind == "STORE_CREDIT":
            db.add(CustomerLedger(customer_id=sale.customer_id, kind="STORE_CREDIT", delta=ret.refund_total,
                                  ref_type="RETURN", ref_id=ret.id, note=f"Refund {ret.number}", actor_id=ctx.user_id))
    elif ret.refund_total > 0:
        session_id = ret.register_session_id
        if method.kind == "CASH":
            session = db.get(RegisterSession, session_id) if session_id else None
            if session is None or session.status != "OPEN":
                raise Conflict("Cash refunds need an open register session; reopen and retry", code="register_closed")
        pay = Payment(id=uuid.uuid4(), number=sequence_number(db, "payment_seq", "PAY"), direction="OUT",
                      purpose="SALE_REFUND", payment_method_id=method.id, account_id=method.account_id,
                      amount=ret.refund_total, reference=ret.refund_reference, location_id=ret.location_id,
                      register_session_id=session_id if method.kind == "CASH" else None, customer_id=sale.customer_id,
                      created_by=ctx.user_id)
        db.add(pay)
        db.flush()
        db.add(PaymentAllocation(payment_id=pay.id, return_id=ret.id, amount=ret.refund_total))
        legs.append(Leg(method.account_id, -ret.refund_total))
    if cost_back:
        legs += [Leg("INVENTORY", cost_back), Leg("COGS", -cost_back)]
    je = accounting.post(db, source_type="RETURN", source_id=ret.id, location_id=ret.location_id, actor_id=ctx.user_id,
                         memo=f"Return {ret.number} / credit note {cn.number}", legs=legs)
    ret.journal_entry_id = je.id if je else None

    # Loyalty points reversal (proportional to returned taxable value)
    earned = db.scalar(select(func.coalesce(func.sum(CustomerLedger.delta), 0)).where(
        CustomerLedger.ref_id == sale.id, CustomerLedger.kind == "LOYALTY", CustomerLedger.ref_type == "SALE"))
    if earned and sale.taxable_total > 0:
        back = (Decimal(earned) * ret.taxable_total / sale.taxable_total).to_integral_value(rounding="ROUND_CEILING")
        if back > 0:
            db.add(CustomerLedger(customer_id=sale.customer_id, kind="LOYALTY", delta=-back, ref_type="RETURN",
                                  ref_id=ret.id, note=f"Reversed on {ret.number}", actor_id=ctx.user_id))
    ret.status = "COMPLETED"
    ret.approved_by = approver_id
    ret.completed_at = datetime.now(UTC)


def _approve_refund(db: Session, ctx, req) -> None:
    ret = db.scalar(select(Return).where(Return.id == req.entity_id).with_for_update(of=Return))
    if ret is None or ret.status != "PENDING_APPROVAL":
        raise Conflict("Return is not pending approval")
    db.scalar(select(Sale).where(Sale.id == ret.sale_id).with_for_update(of=Sale))
    complete_return(db, ctx, ret, approver_id=ctx.user_id)


def _reject_refund(db: Session, ctx, req) -> None:
    ret = db.get(Return, req.entity_id)
    if ret and ret.status == "PENDING_APPROVAL":
        ret.status = "REJECTED"


approvals.register("REFUND", _approve_refund, _reject_refund)
