import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.db import get_db
from app.core.errors import Conflict, NotFound
from app.core.money import ZERO
from app.models import (
    Customer,
    IndividualCopy,
    Invoice,
    Location,
    Payment,
    PaymentAllocation,
    PaymentMethod,
    Register,
    RegisterSession,
    Return,
    Sale,
    User,
)
from app.schemas.common import ORM, Page, PageParams, paginate
from app.services import finance as fin
from app.services import sales as svc
from app.services.audit import audit
from app.services.words import amount_in_words

router = APIRouter(tags=["pos"])


class PaymentMethodOut(ORM):
    id: uuid.UUID
    code: str
    name: str
    kind: str
    requires_reference: bool
    is_active: bool


@router.get("/payment-methods", response_model=list[PaymentMethodOut])
def payment_methods(_: AuthContext = Depends(require_any("pos.sell", "finance.view", "returns.create", "expenses.create")),
                    db: Session = Depends(get_db)):
    return list(db.scalars(select(PaymentMethod).order_by(PaymentMethod.sort_order)))


# ---------------------------------------------------------------- registers & sessions


class RegisterOut(BaseModel):
    id: uuid.UUID
    location_id: uuid.UUID
    location_name: str
    name: str
    is_active: bool
    open_session: dict | None


@router.get("/registers", response_model=list[RegisterOut])
def list_registers(location_id: uuid.UUID | None = None,
                   ctx: AuthContext = Depends(require_any("registers.operate", "registers.manage")),
                   db: Session = Depends(get_db)):
    q = (select(Register, Location.name).join(Location, Location.id == Register.location_id)
         .where(ctx.loc_filter(Register.location_id)).order_by(Location.name, Register.name))
    if location_id:
        ctx.ensure_location(location_id)
        q = q.where(Register.location_id == location_id)
    out = []
    for reg, lname in db.execute(q):
        s = db.scalar(select(RegisterSession).where(RegisterSession.register_id == reg.id, RegisterSession.status == "OPEN"))
        opener = db.get(User, s.opened_by) if s else None
        out.append(RegisterOut(id=reg.id, location_id=reg.location_id, location_name=lname, name=reg.name,
                               is_active=reg.is_active,
                               open_session={"id": s.id, "opened_at": s.opened_at, "opened_by": opener.full_name if opener else None,
                                             "opened_by_id": s.opened_by, "opening_float": s.opening_float} if s else None))
    return out


class RegisterIn(BaseModel):
    location_id: uuid.UUID
    name: str = Field(min_length=1, max_length=60)
    is_active: bool = True


@router.post("/registers", status_code=201)
def create_register(body: RegisterIn, ctx: AuthContext = Depends(require("registers.manage")), db: Session = Depends(get_db)):
    ctx.ensure_location(body.location_id)
    loc = db.get(Location, body.location_id)
    if loc is None or loc.type != "OUTLET":
        raise Conflict("Registers can only be added to outlets")
    reg = Register(**body.model_dump())
    db.add(reg)
    db.flush()
    audit(db, ctx, "register.created", entity_type="register", entity_id=reg.id, location_id=reg.location_id,
          details={"name": reg.name})
    db.commit()
    return {"id": reg.id}


@router.put("/registers/{register_id}")
def update_register(register_id: uuid.UUID, body: RegisterIn, ctx: AuthContext = Depends(require("registers.manage")),
                    db: Session = Depends(get_db)):
    reg = db.get(Register, register_id)
    if reg is None:
        raise NotFound("Register not found")
    ctx.ensure_resource(reg.location_id)
    reg.name, reg.is_active = body.name, body.is_active
    audit(db, ctx, "register.updated", entity_type="register", entity_id=reg.id, location_id=reg.location_id)
    db.commit()
    return {"id": reg.id}


class OpenSessionIn(BaseModel):
    register_id: uuid.UUID
    opening_float: Decimal = Field(ge=0, max_digits=12, decimal_places=2)


@router.post("/register-sessions", status_code=201)
def open_session(body: OpenSessionIn, ctx: AuthContext = Depends(require("registers.operate")), db: Session = Depends(get_db)):
    s = fin.open_session(db, ctx, body.register_id, body.opening_float)
    db.commit()
    return {"id": s.id, "status": s.status}


class SessionOut(BaseModel):
    id: uuid.UUID
    register_id: uuid.UUID
    register_name: str
    location_id: uuid.UUID
    location_name: str
    status: str
    opened_by: str | None
    opened_at: datetime
    closed_by: str | None
    closed_at: datetime | None
    opening_float: Decimal
    expected_cash: Decimal | None
    counted_cash: Decimal | None
    variance: Decimal | None
    closing_notes: str | None
    summary: dict | None = None


def _session_out(db: Session, s: RegisterSession, with_summary: bool) -> SessionOut:
    loc = db.get(Location, s.location_id)
    ob, cb = db.get(User, s.opened_by), db.get(User, s.closed_by) if s.closed_by else None
    return SessionOut(id=s.id, register_id=s.register_id, register_name=s.register.name, location_id=s.location_id,
                      location_name=loc.name, status=s.status, opened_by=ob.full_name if ob else None,
                      opened_at=s.opened_at, closed_by=cb.full_name if cb else None, closed_at=s.closed_at,
                      opening_float=s.opening_float, expected_cash=s.expected_cash, counted_cash=s.counted_cash,
                      variance=s.variance, closing_notes=s.closing_notes,
                      summary=fin.session_summary(db, s) if with_summary else None)


@router.get("/register-sessions", response_model=Page[SessionOut])
def list_sessions(location_id: uuid.UUID | None = None, status: str | None = None, discrepancy: bool | None = None,
                  params: PageParams = Depends(), ctx: AuthContext = Depends(require_any("registers.operate", "registers.manage")),
                  db: Session = Depends(get_db)):
    stmt = select(RegisterSession).where(ctx.loc_filter(RegisterSession.location_id)).order_by(RegisterSession.opened_at.desc())
    if not ctx.has("registers.manage"):
        stmt = stmt.where(RegisterSession.opened_by == ctx.user_id)
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(RegisterSession.location_id == location_id)
    if status:
        stmt = stmt.where(RegisterSession.status == status)
    if discrepancy:
        stmt = stmt.where(RegisterSession.variance != 0)
    rows, total = paginate(db, stmt, params)
    return Page(items=[_session_out(db, s, False) for s in rows], total=total, page=params.page, page_size=params.page_size)


@router.get("/register-sessions/{session_id}", response_model=SessionOut)
def get_session(session_id: uuid.UUID, ctx: AuthContext = Depends(require_any("registers.operate", "registers.manage")),
                db: Session = Depends(get_db)):
    s = db.get(RegisterSession, session_id)
    if s is None:
        raise NotFound("Session not found")
    ctx.ensure_resource(s.location_id)
    if not ctx.has("registers.manage") and s.opened_by != ctx.user_id and s.status != "OPEN":
        raise NotFound("Session not found")
    return _session_out(db, s, True)


class CloseSessionIn(BaseModel):
    counted_cash: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    notes: str | None = Field(default=None, max_length=500)


@router.post("/register-sessions/{session_id}/close", response_model=SessionOut)
def close_session(session_id: uuid.UUID, body: CloseSessionIn, ctx: AuthContext = Depends(require("registers.operate")),
                  db: Session = Depends(get_db)):
    s = fin.close_session(db, ctx, session_id, body.counted_cash, body.notes)
    db.commit()
    return _session_out(db, s, True)


# ---------------------------------------------------------------- quote & checkout


class CartItem(BaseModel):
    book_id: uuid.UUID | None = None
    copy_id: uuid.UUID | None = None
    qty: int = Field(default=1, gt=0, le=10000)
    line_discount: Decimal = Field(default=Decimal(0), ge=0, max_digits=12, decimal_places=2)


class QuoteIn(BaseModel):
    location_id: uuid.UUID
    customer_id: uuid.UUID | None = None
    items: list[CartItem] = Field(min_length=1, max_length=300)
    bill_discount: Decimal = Field(default=Decimal(0), ge=0, max_digits=12, decimal_places=2)
    place_of_supply: str | None = Field(default=None, pattern=r"^\d{2}$")


def _quote_payload(lines, bill, meta) -> dict:
    return {
        **meta,
        "lines": [{"book_id": ln.book.id, "copy_id": ln.copy_id, "title": ln.book.title, "sku": ln.book.sku,
                   "qty": ln.qty, "unit_price": ln.unit_price, "mrp": ln.book.mrp, "tax_rate": ln.tax_rate,
                   "min_selling_price": ln.book.min_selling_price, "gross": lr.gross, "line_discount": lr.line_discount,
                   "bill_discount_alloc": lr.bill_discount_alloc, "taxable_value": lr.taxable_value, "cgst": lr.cgst,
                   "sgst": lr.sgst, "igst": lr.igst, "line_total": lr.line_total}
                  for ln, lr in zip(lines, bill.lines, strict=True)],
        "gross": bill.gross, "line_discount_total": bill.line_discount_total, "bill_discount": bill.bill_discount,
        "discount_total": bill.discount_total, "taxable_total": bill.taxable_total, "cgst_total": bill.cgst_total,
        "sgst_total": bill.sgst_total, "igst_total": bill.igst_total, "tax_total": bill.tax_total,
        "round_off": bill.round_off, "grand_total": bill.grand_total,
        "discount_pct": (bill.discount_total / bill.gross * 100).quantize(Decimal("0.01")) if bill.gross else ZERO,
    }


@router.post("/pos/quote")
def quote(body: QuoteIn, ctx: AuthContext = Depends(require("pos.sell")), db: Session = Depends(get_db)):
    """Authoritative server-side pricing preview (no side effects)."""
    ctx.ensure_location(body.location_id)
    lines, bill, meta = svc.quote(db, ctx, location_id=body.location_id, items=[i.model_dump() for i in body.items],
                                  customer_id=body.customer_id, bill_discount=body.bill_discount,
                                  place_of_supply_code=body.place_of_supply)
    return _quote_payload(lines, bill, meta)


class DiscountRequestIn(QuoteIn):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/pos/discount-approvals", status_code=201)
def request_discount(body: DiscountRequestIn, ctx: AuthContext = Depends(require("pos.sell")), db: Session = Depends(get_db)):
    req = svc.request_discount_approval(db, ctx, location_id=body.location_id, items=[i.model_dump() for i in body.items],
                                        customer_id=body.customer_id, bill_discount=body.bill_discount,
                                        reason=body.reason, place_of_supply_code=body.place_of_supply)
    db.commit()
    return {"id": req.id, "status": req.status}


@router.get("/pos/discount-approvals/{req_id}")
def discount_status(req_id: uuid.UUID, ctx: AuthContext = Depends(require("pos.sell")), db: Session = Depends(get_db)):
    from app.models import ApprovalRequest

    req = db.get(ApprovalRequest, req_id)
    if req is None or req.type != "DISCOUNT":
        raise NotFound("Approval not found")
    ctx.ensure_resource(req.location_id)
    return {"id": req.id, "status": req.status, "decision_note": req.decision_note, "consumed": req.consumed_at is not None,
            "payload": req.payload}


class PaymentIn(BaseModel):
    payment_method_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    tendered: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    reference: str | None = Field(default=None, max_length=100)


class CheckoutIn(QuoteIn):
    register_session_id: uuid.UUID
    payments: list[PaymentIn] = Field(default_factory=list, max_length=10)
    discount_reason: str | None = Field(default=None, max_length=200)
    discount_approval_id: uuid.UUID | None = None
    exchange_return_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=500)


@router.post("/pos/checkout", status_code=201)
def checkout(body: CheckoutIn, idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
             ctx: AuthContext = Depends(require("pos.sell")), db: Session = Depends(get_db)):
    sale, created = svc.checkout(
        db, ctx, idempotency_key=idempotency_key, location_id=body.location_id,
        register_session_id=body.register_session_id, items=[i.model_dump() for i in body.items],
        payments=[p.model_dump() for p in body.payments], customer_id=body.customer_id,
        bill_discount=body.bill_discount, discount_reason=body.discount_reason,
        discount_approval_id=body.discount_approval_id, place_of_supply_code=body.place_of_supply,
        exchange_return_id=body.exchange_return_id, notes=body.notes)
    db.commit()
    db.expire_all()
    out = sale_detail_payload(db, ctx, db.get(Sale, sale.id))
    out["replayed"] = not created
    return out


# ---------------------------------------------------------------- sales history & invoices


class SaleRow(BaseModel):
    id: uuid.UUID
    invoice_number: str | None
    doc_type: str | None
    location_id: uuid.UUID
    location_name: str
    customer_id: uuid.UUID | None
    customer_name: str | None
    status: str
    grand_total: Decimal
    discount_total: Decimal
    tax_total: Decimal
    amount_paid: Decimal
    balance_due: Decimal
    items: int
    cashier: str | None
    created_at: datetime


@router.get("/sales", response_model=Page[SaleRow])
def list_sales(location_id: uuid.UUID | None = None, customer_id: uuid.UUID | None = None, status: str | None = None,
               date_from: date | None = None, date_to: date | None = None, q: str | None = Query(None, max_length=60),
               register_session_id: uuid.UUID | None = None, payment_method_id: uuid.UUID | None = None,
               has_balance: bool | None = None, params: PageParams = Depends(),
               ctx: AuthContext = Depends(require("sales.view")), db: Session = Depends(get_db)):
    stmt = (select(Sale, Invoice.number, Invoice.doc_type, Location.name, User.full_name)
            .outerjoin(Invoice, Invoice.sale_id == Sale.id).join(Location, Location.id == Sale.location_id)
            .outerjoin(User, User.id == Sale.created_by)
            .where(ctx.loc_filter(Sale.location_id)).order_by(Sale.created_at.desc()))
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(Sale.location_id == location_id)
    if customer_id:
        stmt = stmt.where(Sale.customer_id == customer_id)
    if status:
        stmt = stmt.where(Sale.status == status)
    if date_from:
        stmt = stmt.where(func.date(func.timezone("Asia/Kolkata", Sale.created_at)) >= date_from)
    if date_to:
        stmt = stmt.where(func.date(func.timezone("Asia/Kolkata", Sale.created_at)) <= date_to)
    if register_session_id:
        stmt = stmt.where(Sale.register_session_id == register_session_id)
    if payment_method_id:
        stmt = stmt.where(Sale.id.in_(select(PaymentAllocation.sale_id).join(Payment).where(
            Payment.payment_method_id == payment_method_id, Payment.direction == "IN")))
    if has_balance:
        stmt = stmt.where(Sale.grand_total > Sale.amount_paid, Sale.status == "COMPLETED")
    if q:
        stmt = stmt.where(or_(Invoice.number.ilike(f"%{q}%"),
                              Sale.customer_id.in_(select(Customer.id).where(or_(Customer.name.ilike(f"%{q}%"),
                                                                                  Customer.phone.ilike(f"%{q}%"))))))
    rows, total = paginate(db, stmt, params, scalars=False)
    items = []
    for sale, num, doc, lname, cashier in rows:
        items.append(SaleRow(id=sale.id, invoice_number=num, doc_type=doc, location_id=sale.location_id,
                             location_name=lname, customer_id=sale.customer_id,
                             customer_name=sale.customer.name if sale.customer else None, status=sale.status,
                             grand_total=sale.grand_total, discount_total=sale.discount_total, tax_total=sale.tax_total,
                             amount_paid=sale.amount_paid, balance_due=sale.balance_due,
                             items=sum(ln.qty for ln in sale.lines), cashier=cashier, created_at=sale.created_at))
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def _tax_summary(lines) -> list[dict]:
    groups: dict[tuple, dict] = {}
    for ln in lines:
        key = (ln.hsn_code or "", ln.tax_rate)
        g = groups.setdefault(key, {"hsn_code": key[0], "tax_rate": key[1], "taxable_value": ZERO, "cgst": ZERO,
                                    "sgst": ZERO, "igst": ZERO})
        g["taxable_value"] += ln.taxable_value
        g["cgst"] += ln.cgst
        g["sgst"] += ln.sgst
        g["igst"] += ln.igst
    return sorted(groups.values(), key=lambda g: (g["hsn_code"], g["tax_rate"]))


def sale_detail_payload(db: Session, ctx: AuthContext, sale: Sale) -> dict:
    invoice = db.scalar(select(Invoice).where(Invoice.sale_id == sale.id))
    loc = db.get(Location, sale.location_id)
    cashier = db.get(User, sale.created_by)
    pays = db.execute(select(Payment, PaymentAllocation.amount).join(PaymentAllocation, PaymentAllocation.payment_id == Payment.id)
                      .where(PaymentAllocation.sale_id == sale.id).order_by(Payment.created_at))
    copies = {c.id: c.copy_code for c in db.scalars(select(IndividualCopy).where(
        IndividualCopy.id.in_([ln.copy_id for ln in sale.lines if ln.copy_id])))} if any(ln.copy_id for ln in sale.lines) else {}
    returns = list(db.scalars(select(Return).where(Return.sale_id == sale.id).order_by(Return.created_at)))
    from app.services.returns import returned_so_far

    done = returned_so_far(db, sale.id)
    show_cost = ctx.has("reports.financial")
    return {
        "id": sale.id, "status": sale.status, "location_id": sale.location_id, "location_name": loc.name,
        "register_session_id": sale.register_session_id, "customer_id": sale.customer_id,
        "customer_name": sale.customer.name if sale.customer else None,
        "invoice": {"id": invoice.id, "number": invoice.number, "doc_type": invoice.doc_type,
                    "issued_at": invoice.issued_at, "seller": invoice.seller, "buyer": invoice.buyer,
                    "place_of_supply": invoice.place_of_supply, "status": invoice.status,
                    "financial_year": invoice.financial_year} if invoice else None,
        "prices_include_tax": sale.prices_include_tax, "is_interstate": sale.is_interstate,
        "lines": [{"id": ln.id, "line_no": ln.line_no, "book_id": ln.book_id, "title": ln.title, "hsn_code": ln.hsn_code,
                   "copy_id": ln.copy_id, "copy_code": copies.get(ln.copy_id), "qty": ln.qty, "unit_price": ln.unit_price,
                   "mrp": ln.mrp, "line_discount": ln.line_discount, "bill_discount_alloc": ln.bill_discount_alloc,
                   "taxable_value": ln.taxable_value, "tax_rate": ln.tax_rate, "cgst": ln.cgst, "sgst": ln.sgst,
                   "igst": ln.igst, "line_total": ln.line_total, "qty_returned": done.get(ln.id, {"qty": 0})["qty"],
                   "unit_cost": ln.unit_cost if show_cost else None} for ln in sale.lines],
        "tax_summary": _tax_summary(sale.lines),
        "gross_amount": sale.gross_amount, "line_discount_total": sale.line_discount_total,
        "bill_discount": sale.bill_discount, "discount_total": sale.discount_total, "taxable_total": sale.taxable_total,
        "cgst_total": sale.cgst_total, "sgst_total": sale.sgst_total, "igst_total": sale.igst_total,
        "tax_total": sale.tax_total, "round_off": sale.round_off, "grand_total": sale.grand_total,
        "amount_in_words": amount_in_words(sale.grand_total), "amount_paid": sale.amount_paid,
        "balance_due": sale.balance_due, "discount_reason": sale.discount_reason,
        "cogs_total": sale.cogs_total if show_cost else None, "cost_complete": sale.cost_complete,
        "payments": [{"id": p.id, "number": p.number, "direction": p.direction, "purpose": p.purpose,
                      "method": p.method.name, "method_kind": p.method.kind, "amount": amt, "tendered": p.tendered,
                      "change_given": p.change_given, "reference": p.reference, "created_at": p.created_at}
                     for p, amt in pays],
        "returns": [{"id": r.id, "number": r.number, "status": r.status, "refund_total": r.refund_total,
                     "created_at": r.created_at} for r in returns],
        "cashier": cashier.full_name if cashier else None, "created_at": sale.created_at,
        "cancelled_at": sale.cancelled_at, "cancel_reason": sale.cancel_reason, "notes": sale.notes,
    }


def _get_sale(db: Session, ctx: AuthContext, sale_id: uuid.UUID, lock: bool = False) -> Sale:
    q = select(Sale).where(Sale.id == sale_id)
    if lock:
        q = q.with_for_update(of=Sale)
    sale = db.scalar(q)
    if sale is None:
        raise NotFound("Sale not found")
    ctx.ensure_resource(sale.location_id)
    return sale


@router.get("/sales/by-invoice/{number:path}")
def sale_by_invoice(number: str, ctx: AuthContext = Depends(require_any("sales.view", "returns.create")),
                    db: Session = Depends(get_db)):
    inv = db.scalar(select(Invoice).where(Invoice.number == number.strip().upper(), Invoice.sale_id.is_not(None)))
    if inv is None:
        raise NotFound("Invoice not found")
    return sale_detail_payload(db, ctx, _get_sale(db, ctx, inv.sale_id))


@router.get("/sales/{sale_id}")
def get_sale(sale_id: uuid.UUID, ctx: AuthContext = Depends(require_any("sales.view", "returns.create")),
             db: Session = Depends(get_db)):
    return sale_detail_payload(db, ctx, _get_sale(db, ctx, sale_id))


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/sales/{sale_id}/void")
def void(sale_id: uuid.UUID, body: VoidIn, ctx: AuthContext = Depends(require("pos.sell")), db: Session = Depends(get_db)):
    """Users with pos.void cancel immediately; others create a VOID approval request."""
    sale = _get_sale(db, ctx, sale_id, lock=True)
    if ctx.has("pos.void"):
        svc.void_sale(db, ctx, sale, body.reason)
        db.commit()
        return {"status": "CANCELLED"}
    from app.services import approvals

    if approvals.pending_for(db, "sale", sale.id):
        raise Conflict("A void request is already pending for this sale")
    if sale.status != "COMPLETED":
        raise Conflict("Sale is already cancelled")
    req = approvals.create(db, ctx, type_="VOID", location_id=sale.location_id,
                           title=f"Void invoice {sale.invoice.number if sale.invoice else sale.id} (₹{sale.grand_total})",
                           entity_type="sale", entity_id=sale.id, amount=sale.grand_total, reason=body.reason)
    db.commit()
    return {"status": "PENDING_APPROVAL", "approval_request_id": req.id}
