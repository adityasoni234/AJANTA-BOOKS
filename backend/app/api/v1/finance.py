import os
import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, File, Header, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.config import get_settings
from app.core.db import get_db
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.money import ZERO, D, r2
from app.models import (
    Account,
    BankReconciliation,
    Expense,
    ExpenseCategory,
    JournalEntry,
    JournalLine,
    Location,
    User,
)
from app.schemas.common import ORM, Page, PageParams, paginate
from app.services import accounting
from app.services import finance as svc
from app.services.accounting import Leg
from app.services.audit import audit

router = APIRouter(tags=["finance"])


# ---------------------------------------------------------------- chart of accounts


class AccountOut(ORM):
    id: uuid.UUID
    code: str
    name: str
    type: str
    system_key: str | None
    is_cash_or_bank: bool
    location_id: uuid.UUID | None
    is_active: bool
    description: str | None
    balance: Decimal | None = None


@router.get("/accounts", response_model=list[AccountOut])
def list_accounts(cash_or_bank: bool | None = None, with_balances: bool = False,
                  ctx: AuthContext = Depends(require_any("accounting.view", "finance.view", "expenses.create")),
                  db: Session = Depends(get_db)):
    q = select(Account).order_by(Account.code)
    if cash_or_bank is not None:
        q = q.where(Account.is_cash_or_bank.is_(cash_or_bank))
    rows = list(db.scalars(q))
    out = [AccountOut.model_validate(a) for a in rows]
    if with_balances and (ctx.has("accounting.view") or ctx.has("finance.view")):
        loc_ids = None if ctx.all_locations else sorted(ctx.location_ids)
        bal_q = select(JournalLine.account_id, func.sum(JournalLine.debit - JournalLine.credit)).group_by(JournalLine.account_id)
        if loc_ids is not None:
            bal_q = bal_q.where(JournalLine.location_id.in_(loc_ids))
        bals = dict(db.execute(bal_q).all())
        for o in out:
            o.balance = D(bals.get(o.id, 0))
    return out


class AccountIn(BaseModel):
    code: str = Field(min_length=3, max_length=20, pattern=r"^[0-9A-Z-]+$")
    name: str = Field(min_length=2, max_length=120)
    type: str = Field(pattern=r"^(ASSET|LIABILITY|EQUITY|INCOME|EXPENSE)$")
    is_cash_or_bank: bool = False
    location_id: uuid.UUID | None = None
    is_active: bool = True
    description: str | None = Field(default=None, max_length=300)


@router.post("/accounts", response_model=AccountOut, status_code=201)
def create_account(body: AccountIn, ctx: AuthContext = Depends(require("accounting.manage")), db: Session = Depends(get_db)):
    if body.is_cash_or_bank and body.type != "ASSET":
        raise ValidationFailed("Cash and bank accounts must be asset accounts")
    if db.scalar(select(Account).where(Account.code == body.code)):
        raise Conflict("Account code already exists")
    a = Account(**body.model_dump())
    db.add(a)
    db.flush()
    audit(db, ctx, "accounting.account_created", entity_type="account", entity_id=a.id, details=body.model_dump(mode="json"))
    db.commit()
    return a


@router.put("/accounts/{account_id}", response_model=AccountOut)
def update_account(account_id: uuid.UUID, body: AccountIn, ctx: AuthContext = Depends(require("accounting.manage")),
                   db: Session = Depends(get_db)):
    a = db.get(Account, account_id)
    if a is None:
        raise NotFound("Account not found")
    has_lines = db.scalar(select(func.count()).select_from(JournalLine).where(JournalLine.account_id == a.id))
    if a.system_key and (body.type != a.type or not body.is_active or body.is_cash_or_bank != a.is_cash_or_bank):
        raise ValidationFailed("System accounts can be renamed but not retyped or deactivated")
    if has_lines and body.type != a.type:
        raise ValidationFailed("Account type cannot change once postings exist")
    before = AccountOut.model_validate(a).model_dump(mode="json")
    for k, v in body.model_dump().items():
        setattr(a, k, v)
    audit(db, ctx, "accounting.account_updated", entity_type="account", entity_id=a.id,
          details={"before": before, "after": body.model_dump(mode="json")})
    db.commit()
    return a


# ---------------------------------------------------------------- journals


class JournalOut(BaseModel):
    id: uuid.UUID
    number: str
    entry_date: date
    source_type: str
    source_id: uuid.UUID | None
    memo: str | None
    location_id: uuid.UUID | None
    location_name: str | None
    reversal_of_id: uuid.UUID | None
    reversed_by_id: uuid.UUID | None
    created_by: str | None
    posted_at: datetime
    total: Decimal
    lines: list[dict]


def _je_out(db: Session, je: JournalEntry) -> JournalOut:
    loc = db.get(Location, je.location_id) if je.location_id else None
    by = db.get(User, je.created_by) if je.created_by else None
    rev = db.scalar(select(JournalEntry.id).where(JournalEntry.reversal_of_id == je.id))
    locs = {}
    lines = []
    for ln in je.lines:
        if ln.location_id and ln.location_id not in locs:
            locs[ln.location_id] = db.get(Location, ln.location_id).name
        lines.append({"account_id": ln.account_id, "account_code": ln.account.code, "account_name": ln.account.name,
                      "debit": ln.debit, "credit": ln.credit, "location_name": locs.get(ln.location_id), "memo": ln.memo})
    return JournalOut(id=je.id, number=je.number, entry_date=je.entry_date, source_type=je.source_type,
                      source_id=je.source_id, memo=je.memo, location_id=je.location_id,
                      location_name=loc.name if loc else None, reversal_of_id=je.reversal_of_id, reversed_by_id=rev,
                      created_by=by.full_name if by else None, posted_at=je.posted_at,
                      total=sum((ln.debit for ln in je.lines), ZERO), lines=lines)


def _je_scope(ctx: AuthContext):
    if ctx.all_locations:
        return None
    return JournalEntry.id.in_(select(JournalLine.entry_id).where(JournalLine.location_id.in_(ctx.location_ids)))


@router.get("/journals", response_model=Page[JournalOut])
def list_journals(source_type: str | None = None, account_id: uuid.UUID | None = None, date_from: date | None = None,
                  date_to: date | None = None, q: str | None = None, params: PageParams = Depends(),
                  ctx: AuthContext = Depends(require("accounting.view")), db: Session = Depends(get_db)):
    stmt = select(JournalEntry).order_by(JournalEntry.posted_at.desc())
    scope = _je_scope(ctx)
    if scope is not None:
        stmt = stmt.where(scope)
    if source_type:
        stmt = stmt.where(JournalEntry.source_type == source_type)
    if account_id:
        stmt = stmt.where(JournalEntry.id.in_(select(JournalLine.entry_id).where(JournalLine.account_id == account_id)))
    if date_from:
        stmt = stmt.where(JournalEntry.entry_date >= date_from)
    if date_to:
        stmt = stmt.where(JournalEntry.entry_date <= date_to)
    if q:
        stmt = stmt.where(or_(JournalEntry.number.ilike(f"%{q}%"), JournalEntry.memo.ilike(f"%{q}%")))
    rows, total = paginate(db, stmt, params)
    return Page(items=[_je_out(db, je) for je in rows], total=total, page=params.page, page_size=params.page_size)


@router.get("/journals/{je_id}", response_model=JournalOut)
def get_journal(je_id: uuid.UUID, ctx: AuthContext = Depends(require("accounting.view")), db: Session = Depends(get_db)):
    je = db.get(JournalEntry, je_id)
    if je is None:
        raise NotFound("Journal entry not found")
    if not ctx.all_locations and not any(ln.location_id in ctx.location_ids for ln in je.lines):
        raise NotFound("Journal entry not found")
    return _je_out(db, je)


class ManualLine(BaseModel):
    account_id: uuid.UUID
    debit: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    credit: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    location_id: uuid.UUID | None = None
    memo: str | None = Field(default=None, max_length=300)


class ManualJournalIn(BaseModel):
    entry_date: date
    memo: str = Field(min_length=3, max_length=300)
    lines: list[ManualLine] = Field(min_length=2, max_length=100)


@router.post("/journals", response_model=JournalOut, status_code=201)
def manual_journal(body: ManualJournalIn, ctx: AuthContext = Depends(require("accounting.manage")),
                   db: Session = Depends(get_db)):
    if not ctx.all_locations:
        raise ValidationFailed("Manual journals require organisation-wide access")
    dr = sum((r2(ln.debit) for ln in body.lines), ZERO)
    cr = sum((r2(ln.credit) for ln in body.lines), ZERO)
    if dr != cr or dr == 0:
        raise ValidationFailed(f"Debits ({dr}) must equal credits ({cr}) and be non-zero")
    for ln in body.lines:
        if (ln.debit > 0) == (ln.credit > 0):
            raise ValidationFailed("Each line must have either a debit or a credit")
    je = accounting.post(db, source_type="MANUAL", source_id=None, actor_id=ctx.user_id, entry_date=body.entry_date,
                         memo=body.memo,
                         legs=[Leg(ln.account_id, r2(ln.debit) - r2(ln.credit), ln.location_id, ln.memo) for ln in body.lines])
    audit(db, ctx, "accounting.manual_journal", entity_type="journal_entry", entity_id=je.id,
          details={"number": je.number, "total": dr, "memo": body.memo})
    db.commit()
    return _je_out(db, je)


class ReverseIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/journals/{je_id}/reverse", response_model=JournalOut)
def reverse_journal(je_id: uuid.UUID, body: ReverseIn, ctx: AuthContext = Depends(require("accounting.manage")),
                    db: Session = Depends(get_db)):
    je = db.get(JournalEntry, je_id)
    if je is None:
        raise NotFound("Journal entry not found")
    if je.source_type != "MANUAL":
        raise ValidationFailed("System-generated entries are corrected through their source document "
                               "(void, return, adjustment); only manual journals can be reversed here")
    rev = accounting.reverse(db, je, actor_id=ctx.user_id, memo=f"Reversal of {je.number}: {body.reason}")
    audit(db, ctx, "accounting.journal_reversed", entity_type="journal_entry", entity_id=je.id,
          details={"reversal": rev.number, "reason": body.reason})
    db.commit()
    return _je_out(db, rev)


# ---------------------------------------------------------------- cashbook & transfers


@router.get("/cashbook")
def cashbook(account_id: uuid.UUID, date_from: date, date_to: date, location_id: uuid.UUID | None = None,
             ctx: AuthContext = Depends(require("finance.view")), db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    if acc is None or not acc.is_cash_or_bank:
        raise ValidationFailed("Select a cash or bank account")
    if (date_to - date_from).days > 400:
        raise ValidationFailed("Date range is limited to 400 days")
    loc_ids = ctx.scoped_location_ids(location_id)
    opening = D(db.scalar(
        select(func.coalesce(func.sum(JournalLine.debit - JournalLine.credit), 0))
        .join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
        .where(JournalLine.account_id == acc.id, JournalEntry.entry_date < date_from,
               *( [JournalLine.location_id.in_(loc_ids)] if loc_ids is not None else []))))
    q = (select(JournalLine, JournalEntry).join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
         .where(JournalLine.account_id == acc.id, JournalEntry.entry_date >= date_from, JournalEntry.entry_date <= date_to)
         .order_by(JournalEntry.entry_date, JournalEntry.posted_at, JournalLine.id).limit(5000))
    if loc_ids is not None:
        q = q.where(JournalLine.location_id.in_(loc_ids))
    bal = opening
    rows = []
    for ln, je in db.execute(q):
        bal += ln.debit - ln.credit
        rows.append({"date": je.entry_date, "number": je.number, "source_type": je.source_type, "memo": je.memo,
                     "receipt": ln.debit, "payment": ln.credit, "balance": bal, "journal_id": je.id})
    return {"account": AccountOut.model_validate(acc), "opening_balance": opening, "closing_balance": bal,
            "total_receipts": sum((r["receipt"] for r in rows), ZERO),
            "total_payments": sum((r["payment"] for r in rows), ZERO), "entries": rows}


class FundTransferIn(BaseModel):
    from_account_id: uuid.UUID
    to_account_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    entry_date: date
    location_id: uuid.UUID | None = None
    memo: str = Field(default="", max_length=300)


@router.post("/fund-transfers", status_code=201)
def fund_transfer(body: FundTransferIn, ctx: AuthContext = Depends(require("finance.manage")), db: Session = Depends(get_db)):
    je = svc.transfer_funds(db, ctx, **body.model_dump())
    db.commit()
    return {"journal_number": je.number}


class BankRecIn(BaseModel):
    account_id: uuid.UUID
    statement_date: date
    statement_balance: Decimal = Field(max_digits=14, decimal_places=2)
    notes: str | None = Field(default=None, max_length=1000)


@router.post("/bank-reconciliations", status_code=201)
def bank_reconciliation(body: BankRecIn, ctx: AuthContext = Depends(require("finance.manage")), db: Session = Depends(get_db)):
    acc = db.get(Account, body.account_id)
    if acc is None or not acc.is_cash_or_bank:
        raise ValidationFailed("Select a cash or bank account")
    book = svc.account_balance(db, acc.id, as_of=body.statement_date)
    rec = BankReconciliation(account_id=acc.id, statement_date=body.statement_date,
                             statement_balance=r2(body.statement_balance), book_balance=book,
                             difference=r2(body.statement_balance) - book, notes=body.notes, created_by=ctx.user_id)
    db.add(rec)
    audit(db, ctx, "finance.bank_reconciliation", entity_type="account", entity_id=acc.id,
          details={"statement": body.statement_balance, "book": book})
    db.commit()
    return {"id": rec.id, "book_balance": book, "statement_balance": rec.statement_balance, "difference": rec.difference}


@router.get("/bank-reconciliations")
def list_bank_reconciliations(account_id: uuid.UUID | None = None, ctx: AuthContext = Depends(require("finance.view")),
                              db: Session = Depends(get_db)):
    q = select(BankReconciliation, Account.name).join(Account).order_by(BankReconciliation.statement_date.desc()).limit(100)
    if account_id:
        q = q.where(BankReconciliation.account_id == account_id)
    return [{"id": r.id, "account": name, "statement_date": r.statement_date, "statement_balance": r.statement_balance,
             "book_balance": r.book_balance, "difference": r.difference, "notes": r.notes, "created_at": r.created_at}
            for r, name in db.execute(q)]


# ---------------------------------------------------------------- expenses


class ExpenseCategoryOut(ORM):
    id: uuid.UUID
    name: str
    account_id: uuid.UUID
    is_active: bool


@router.get("/expense-categories", response_model=list[ExpenseCategoryOut])
def expense_categories(_: AuthContext = Depends(require_any("expenses.view", "expenses.create")), db: Session = Depends(get_db)):
    return list(db.scalars(select(ExpenseCategory).order_by(ExpenseCategory.name)))


class ExpenseCategoryIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    account_id: uuid.UUID
    is_active: bool = True


@router.post("/expense-categories", response_model=ExpenseCategoryOut, status_code=201)
def create_expense_category(body: ExpenseCategoryIn, ctx: AuthContext = Depends(require("accounting.manage")),
                            db: Session = Depends(get_db)):
    acc = db.get(Account, body.account_id)
    if acc is None or acc.type != "EXPENSE":
        raise ValidationFailed("Expense categories must map to an expense account")
    c = ExpenseCategory(**body.model_dump())
    db.add(c)
    audit(db, ctx, "finance.expense_category_created", entity_type="expense_category", details=body.model_dump(mode="json"))
    db.commit()
    return c


class ExpenseIn(BaseModel):
    location_id: uuid.UUID
    category_id: uuid.UUID
    expense_date: date
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    description: str = Field(min_length=3, max_length=300)
    vendor: str | None = Field(default=None, max_length=160)
    paid_from_account_id: uuid.UUID
    register_session_id: uuid.UUID | None = None
    reference: str | None = Field(default=None, max_length=100)


class ExpenseOut(BaseModel):
    id: uuid.UUID
    number: str
    location_id: uuid.UUID
    location_name: str
    category: str
    expense_date: date
    amount: Decimal
    description: str
    vendor: str | None
    paid_from: str
    reference: str | None
    status: str
    has_receipt: bool
    created_by: str | None
    approved_by: str | None
    rejection_reason: str | None
    created_at: datetime


def _exp_out(db: Session, e: Expense) -> ExpenseOut:
    loc = db.get(Location, e.location_id)
    acc = db.get(Account, e.paid_from_account_id)
    cb, ab = db.get(User, e.created_by), db.get(User, e.approved_by) if e.approved_by else None
    return ExpenseOut(id=e.id, number=e.number, location_id=e.location_id, location_name=loc.name, category=e.category.name,
                      expense_date=e.expense_date, amount=e.amount, description=e.description, vendor=e.vendor,
                      paid_from=acc.name, reference=e.reference, status=e.status, has_receipt=bool(e.receipt_path),
                      created_by=cb.full_name if cb else None, approved_by=ab.full_name if ab else None,
                      rejection_reason=e.rejection_reason, created_at=e.created_at)


@router.get("/expenses", response_model=Page[ExpenseOut])
def list_expenses(location_id: uuid.UUID | None = None, category_id: uuid.UUID | None = None, status: str | None = None,
                  date_from: date | None = None, date_to: date | None = None, params: PageParams = Depends(),
                  ctx: AuthContext = Depends(require("expenses.view")), db: Session = Depends(get_db)):
    stmt = select(Expense).where(ctx.loc_filter(Expense.location_id)).order_by(Expense.expense_date.desc(), Expense.created_at.desc())
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(Expense.location_id == location_id)
    if category_id:
        stmt = stmt.where(Expense.category_id == category_id)
    if status:
        stmt = stmt.where(Expense.status == status)
    if date_from:
        stmt = stmt.where(Expense.expense_date >= date_from)
    if date_to:
        stmt = stmt.where(Expense.expense_date <= date_to)
    rows, total = paginate(db, stmt, params)
    return Page(items=[_exp_out(db, e) for e in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/expenses", response_model=ExpenseOut, status_code=201)
def create_expense(body: ExpenseIn, idempotency_key: str | None = Header(None, alias="Idempotency-Key", max_length=80),
                   ctx: AuthContext = Depends(require("expenses.create")), db: Session = Depends(get_db)):
    e, _ = svc.create_expense(db, ctx, idempotency_key=idempotency_key, **body.model_dump())
    db.commit()
    return _exp_out(db, e)


ALLOWED_RECEIPT = {b"%PDF": ".pdf", b"\xff\xd8\xff": ".jpg", b"\x89PNG\r\n\x1a\n": ".png"}


@router.post("/expenses/{expense_id}/receipt", response_model=ExpenseOut)
async def upload_receipt(expense_id: uuid.UUID, file: UploadFile = File(...),
                         ctx: AuthContext = Depends(require("expenses.create")), db: Session = Depends(get_db)):
    s = get_settings()
    e = db.get(Expense, expense_id)
    if e is None:
        raise NotFound("Expense not found")
    ctx.ensure_resource(e.location_id)
    data = await file.read(s.max_upload_bytes + 1)
    if len(data) > s.max_upload_bytes:
        raise ValidationFailed("File too large")
    ext = next((x for sig, x in ALLOWED_RECEIPT.items() if data.startswith(sig)), None)
    if ext is None:
        raise ValidationFailed("Only PDF, JPEG or PNG receipts are allowed")
    os.makedirs(os.path.join(s.upload_dir, "receipts"), exist_ok=True)
    rel = os.path.join("receipts", f"{e.id}{ext}")
    with open(os.path.join(s.upload_dir, rel), "wb") as fh:
        fh.write(data)
    e.receipt_path = rel
    audit(db, ctx, "finance.expense_receipt", entity_type="expense", entity_id=e.id, location_id=e.location_id)
    db.commit()
    return _exp_out(db, e)


@router.get("/expenses/{expense_id}/receipt")
def get_receipt(expense_id: uuid.UUID, ctx: AuthContext = Depends(require("expenses.view")), db: Session = Depends(get_db)):
    e = db.get(Expense, expense_id)
    if e is None or not e.receipt_path:
        raise NotFound("Receipt not found")
    ctx.ensure_resource(e.location_id)
    root = os.path.realpath(get_settings().upload_dir)
    path = os.path.realpath(os.path.join(root, e.receipt_path))
    if not path.startswith(root + os.sep) or not os.path.exists(path):
        raise NotFound("Receipt not found")
    return FileResponse(path, headers={"Content-Disposition": f"inline; filename={e.number.replace('/', '-')}{os.path.splitext(path)[1]}"})
