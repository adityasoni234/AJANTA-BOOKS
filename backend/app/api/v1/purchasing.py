import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.db import get_db
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.models import (
    Book,
    GoodsReceipt,
    Location,
    Payment,
    PaymentAllocation,
    PurchaseOrder,
    Supplier,
    SupplierInvoice,
    SupplierReturn,
    User,
)
from app.schemas.common import ORM, Page, PageParams, paginate
from app.services import approvals
from app.services import purchasing as svc
from app.services.audit import audit
from app.services.gst import valid_gstin
from app.services.numbering import local_today, next_code, next_number

router = APIRouter(tags=["purchasing"])


# ---------------------------------------------------------------- suppliers


class SupplierIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    contact_person: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    email: EmailStr | None = None
    gstin: str | None = None
    pan: str | None = Field(default=None, pattern=r"^[A-Z]{5}\d{4}[A-Z]$")
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    state_code: str | None = Field(default=None, pattern=r"^\d{2}$")
    pincode: str | None = None
    payment_terms_days: int = Field(default=30, ge=0, le=365)
    notes: str | None = Field(default=None, max_length=2000)
    is_active: bool = True

    @field_validator("gstin")
    @classmethod
    def _g(cls, v):
        if v:
            v = v.strip().upper()
            if not valid_gstin(v):
                raise ValueError("Invalid GSTIN (format or checksum)")
        return v or None


class SupplierOut(SupplierIn, ORM):
    id: uuid.UUID
    code: str
    email: str | None = None
    created_at: datetime
    outstanding: Decimal | None = None
    overdue: Decimal | None = None


def _outstanding(db: Session, supplier_ids: list[uuid.UUID]) -> dict:
    """{supplier_id: [outstanding, overdue]} for open supplier invoices."""
    due = SupplierInvoice.total - SupplierInvoice.amount_paid
    open_ = SupplierInvoice.status.in_(["OPEN", "PARTIALLY_PAID"])
    overdue = func.sum(case((SupplierInvoice.due_date < date.today(), due), else_=0))
    rows = db.execute(select(SupplierInvoice.supplier_id, func.sum(due), overdue)
                      .where(SupplierInvoice.supplier_id.in_(supplier_ids), open_)
                      .group_by(SupplierInvoice.supplier_id))
    return {sid: [Decimal(o or 0), Decimal(od or 0)] for sid, o, od in rows}


@router.get("/suppliers", response_model=Page[SupplierOut])
def list_suppliers(q: str | None = Query(None, max_length=100), active: bool | None = None, params: PageParams = Depends(),
                   ctx: AuthContext = Depends(require("suppliers.view")), db: Session = Depends(get_db)):
    stmt = select(Supplier).order_by(Supplier.name)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Supplier.name.ilike(like), Supplier.code.ilike(like), Supplier.gstin.ilike(like),
                              Supplier.phone.ilike(like)))
    if active is not None:
        stmt = stmt.where(Supplier.is_active.is_(active))
    rows, total = paginate(db, stmt, params)
    show_money = ctx.has("finance.view") or ctx.has("purchasing.view")
    dues = _outstanding(db, [s.id for s in rows]) if show_money and rows else {}
    items = []
    for s in rows:
        o = SupplierOut.model_validate(s)
        if show_money:
            o.outstanding, o.overdue = dues.get(s.id, [Decimal(0), Decimal(0)])
        items.append(o)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("/suppliers", response_model=SupplierOut, status_code=201)
def create_supplier(body: SupplierIn, ctx: AuthContext = Depends(require("suppliers.manage")), db: Session = Depends(get_db)):
    if body.gstin and body.state_code and body.gstin[:2] != body.state_code:
        raise ValidationFailed("GSTIN state code does not match supplier state")
    s = Supplier(code=next_code(db, "SUPPLIER", "S", 4), **body.model_dump())
    if body.gstin and not body.state_code:
        s.state_code = body.gstin[:2]
    db.add(s)
    db.flush()
    audit(db, ctx, "purchasing.supplier_created", entity_type="supplier", entity_id=s.id, details={"name": s.name})
    db.commit()
    return s


@router.get("/suppliers/{supplier_id}", response_model=SupplierOut)
def get_supplier(supplier_id: uuid.UUID, ctx: AuthContext = Depends(require("suppliers.view")), db: Session = Depends(get_db)):
    s = db.get(Supplier, supplier_id)
    if s is None:
        raise NotFound("Supplier not found")
    o = SupplierOut.model_validate(s)
    if ctx.has("finance.view") or ctx.has("purchasing.view"):
        o.outstanding, o.overdue = _outstanding(db, [s.id]).get(s.id, [Decimal(0), Decimal(0)])
    return o


@router.put("/suppliers/{supplier_id}", response_model=SupplierOut)
def update_supplier(supplier_id: uuid.UUID, body: SupplierIn, ctx: AuthContext = Depends(require("suppliers.manage")),
                    db: Session = Depends(get_db)):
    s = db.get(Supplier, supplier_id)
    if s is None:
        raise NotFound("Supplier not found")
    if body.gstin and body.state_code and body.gstin[:2] != body.state_code:
        raise ValidationFailed("GSTIN state code does not match supplier state")
    before = SupplierOut.model_validate(s).model_dump(mode="json")
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    audit(db, ctx, "purchasing.supplier_updated", entity_type="supplier", entity_id=s.id,
          details={"before": before, "after": body.model_dump(mode="json")})
    db.commit()
    return s


@router.get("/suppliers/{supplier_id}/statement")
def supplier_statement(supplier_id: uuid.UUID, ctx: AuthContext = Depends(require_any("finance.view", "purchasing.view")),
                       db: Session = Depends(get_db)):
    """Chronological statement: invoices (credit), payments and debit notes (debit), running balance."""
    s = db.get(Supplier, supplier_id)
    if s is None:
        raise NotFound("Supplier not found")
    entries = []
    for si in db.scalars(select(SupplierInvoice).where(SupplierInvoice.supplier_id == s.id, ctx.loc_filter(SupplierInvoice.location_id))):
        entries.append({"date": si.invoice_date, "type": "INVOICE", "ref": si.invoice_number, "id": si.id,
                        "credit": si.total, "debit": Decimal(0), "status": si.status, "due_date": si.due_date})
    for p in db.scalars(select(Payment).where(Payment.supplier_id == s.id, ctx.loc_filter(Payment.location_id))):
        entries.append({"date": p.payment_date, "type": "PAYMENT", "ref": p.number, "id": p.id, "credit": Decimal(0),
                        "debit": p.amount, "status": None, "due_date": None})
    for r in db.scalars(select(SupplierReturn).where(SupplierReturn.supplier_id == s.id, ctx.loc_filter(SupplierReturn.location_id))):
        entries.append({"date": r.created_at.date(), "type": "DEBIT_NOTE", "ref": r.number, "id": r.id,
                        "credit": Decimal(0), "debit": r.value, "status": None, "due_date": None})
    entries.sort(key=lambda e: (e["date"], e["type"] != "INVOICE"))
    bal = Decimal(0)
    for e in entries:
        bal += e["credit"] - e["debit"]
        e["balance"] = bal
    return {"supplier": SupplierOut.model_validate(s), "entries": entries, "closing_balance": bal}


# ---------------------------------------------------------------- purchase orders


class POLineIn(BaseModel):
    book_id: uuid.UUID
    qty: int = Field(gt=0, le=100000)
    unit_cost: Decimal = Field(ge=0, max_digits=14, decimal_places=4)
    discount_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    tax_rate: Decimal = Field(default=Decimal(0), ge=0, le=50)


class POIn(BaseModel):
    supplier_id: uuid.UUID
    location_id: uuid.UUID
    expected_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    lines: list[POLineIn] = Field(min_length=1, max_length=500)


class POLineOut(BaseModel):
    id: uuid.UUID
    line_no: int
    book_id: uuid.UUID
    title: str
    sku: str
    isbn13: str | None
    qty_ordered: int
    qty_received: int
    qty_cancelled: int
    qty_outstanding: int
    unit_cost: Decimal
    discount_pct: Decimal
    tax_rate: Decimal
    tracking_mode: str


class POOut(BaseModel):
    id: uuid.UUID
    number: str
    supplier_id: uuid.UUID
    supplier_name: str
    location_id: uuid.UUID
    location_name: str
    status: str
    order_date: date
    expected_date: date | None
    notes: str | None
    subtotal: Decimal
    tax_total: Decimal
    total: Decimal
    created_by_name: str | None
    approved_at: datetime | None
    issued_at: datetime | None
    created_at: datetime
    lines: list[POLineOut]
    receipts: list[dict] = []
    approval_request_id: uuid.UUID | None = None


def _po_out(db: Session, po: PurchaseOrder, detail: bool = True) -> POOut:
    loc = db.get(Location, po.location_id)
    creator = db.get(User, po.created_by)
    lines = [POLineOut(id=ln.id, line_no=ln.line_no, book_id=ln.book_id, title=ln.book.title, sku=ln.book.sku,
                       isbn13=ln.book.isbn13, qty_ordered=ln.qty_ordered, qty_received=ln.qty_received,
                       qty_cancelled=ln.qty_cancelled, qty_outstanding=ln.qty_outstanding, unit_cost=ln.unit_cost,
                       discount_pct=ln.discount_pct, tax_rate=ln.tax_rate, tracking_mode=ln.book.tracking_mode)
             for ln in po.lines] if detail else []
    receipts = [{"id": g.id, "number": g.number, "received_at": g.received_at, "total_landed": g.total_landed,
                 "invoiced": g.supplier_invoice_id is not None}
                for g in db.scalars(select(GoodsReceipt).where(GoodsReceipt.po_id == po.id).order_by(GoodsReceipt.received_at))] if detail else []
    pending = approvals.pending_for(db, "purchase_order", po.id) if po.status == "PENDING_APPROVAL" else None
    return POOut(id=po.id, number=po.number, supplier_id=po.supplier_id, supplier_name=po.supplier.name,
                 location_id=po.location_id, location_name=loc.name, status=po.status, order_date=po.order_date,
                 expected_date=po.expected_date, notes=po.notes, subtotal=po.subtotal, tax_total=po.tax_total,
                 total=po.total, created_by_name=creator.full_name if creator else None, approved_at=po.approved_at,
                 issued_at=po.issued_at, created_at=po.created_at, lines=lines, receipts=receipts,
                 approval_request_id=pending.id if pending else None)


@router.get("/purchase-orders", response_model=Page[POOut])
def list_pos(status: str | None = None, supplier_id: uuid.UUID | None = None, location_id: uuid.UUID | None = None,
             q: str | None = Query(None, max_length=60), params: PageParams = Depends(),
             ctx: AuthContext = Depends(require("purchasing.view")), db: Session = Depends(get_db)):
    stmt = select(PurchaseOrder).where(ctx.loc_filter(PurchaseOrder.location_id)).order_by(PurchaseOrder.created_at.desc())
    if status:
        stmt = stmt.where(PurchaseOrder.status.in_(status.split(",")))
    if supplier_id:
        stmt = stmt.where(PurchaseOrder.supplier_id == supplier_id)
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(PurchaseOrder.location_id == location_id)
    if q:
        stmt = stmt.where(PurchaseOrder.number.ilike(f"%{q}%"))
    rows, total = paginate(db, stmt, params)
    return Page(items=[_po_out(db, p, detail=False) for p in rows], total=total, page=params.page, page_size=params.page_size)


def _get_po(db: Session, ctx: AuthContext, po_id: uuid.UUID, lock: bool = False) -> PurchaseOrder:
    q = select(PurchaseOrder).where(PurchaseOrder.id == po_id)
    if lock:
        q = q.with_for_update(of=PurchaseOrder)
    po = db.scalar(q)
    if po is None:
        raise NotFound("Purchase order not found")
    ctx.ensure_resource(po.location_id)
    return po


@router.post("/purchase-orders", response_model=POOut, status_code=201)
def create_po(body: POIn, ctx: AuthContext = Depends(require("purchasing.create")), db: Session = Depends(get_db)):
    ctx.ensure_location(body.location_id)
    sup = db.get(Supplier, body.supplier_id)
    if sup is None or not sup.is_active:
        raise ValidationFailed("Supplier not found or inactive")
    po = PurchaseOrder(id=uuid.uuid4(), number=next_number(db, "PO"), supplier_id=sup.id, location_id=body.location_id,
                       order_date=local_today(db), expected_date=body.expected_date, notes=body.notes,
                       created_by=ctx.user_id)
    db.add(po)
    db.flush()
    svc.set_po_lines(db, po, [ln.model_dump() for ln in body.lines])
    audit(db, ctx, "purchasing.po_created", entity_type="purchase_order", entity_id=po.id, location_id=po.location_id,
          details={"number": po.number, "total": po.total})
    db.commit()
    db.refresh(po)
    return _po_out(db, po)


@router.get("/purchase-orders/{po_id}", response_model=POOut)
def get_po(po_id: uuid.UUID, ctx: AuthContext = Depends(require("purchasing.view")), db: Session = Depends(get_db)):
    return _po_out(db, _get_po(db, ctx, po_id))


@router.put("/purchase-orders/{po_id}", response_model=POOut)
def update_po(po_id: uuid.UUID, body: POIn, ctx: AuthContext = Depends(require("purchasing.create")), db: Session = Depends(get_db)):
    po = _get_po(db, ctx, po_id, lock=True)
    if po.status != "DRAFT":
        raise Conflict("Only draft purchase orders can be edited")
    ctx.ensure_location(body.location_id)
    po.supplier_id, po.location_id, po.expected_date, po.notes = body.supplier_id, body.location_id, body.expected_date, body.notes
    svc.set_po_lines(db, po, [ln.model_dump() for ln in body.lines])
    audit(db, ctx, "purchasing.po_updated", entity_type="purchase_order", entity_id=po.id, location_id=po.location_id)
    db.commit()
    db.refresh(po)
    return _po_out(db, po)


@router.post("/purchase-orders/{po_id}/submit", response_model=POOut)
def submit_po(po_id: uuid.UUID, ctx: AuthContext = Depends(require("purchasing.create")), db: Session = Depends(get_db)):
    po = _get_po(db, ctx, po_id, lock=True)
    svc.submit_po(db, ctx, po)
    audit(db, ctx, "purchasing.po_submitted", entity_type="purchase_order", entity_id=po.id, location_id=po.location_id,
          details={"status": po.status})
    db.commit()
    return _po_out(db, po)


class DecisionIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=500)


@router.post("/purchase-orders/{po_id}/decision", response_model=POOut)
def decide_po(po_id: uuid.UUID, body: DecisionIn, ctx: AuthContext = Depends(require("purchasing.approve")),
              db: Session = Depends(get_db)):
    po = _get_po(db, ctx, po_id, lock=True)
    req = approvals.pending_for(db, "purchase_order", po.id)
    if req is None:
        raise Conflict("No pending approval for this purchase order")
    approvals.decide(db, ctx, req.id, body.approve, body.note)
    db.commit()
    return _po_out(db, po)


@router.post("/purchase-orders/{po_id}/issue", response_model=POOut)
def issue_po(po_id: uuid.UUID, ctx: AuthContext = Depends(require("purchasing.create")), db: Session = Depends(get_db)):
    po = _get_po(db, ctx, po_id, lock=True)
    if po.status != "APPROVED":
        raise Conflict("Only approved purchase orders can be issued")
    po.status, po.issued_at = "ISSUED", datetime.now(UTC)
    audit(db, ctx, "purchasing.po_issued", entity_type="purchase_order", entity_id=po.id, location_id=po.location_id)
    db.commit()
    return _po_out(db, po)


class CancelIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/purchase-orders/{po_id}/cancel", response_model=POOut)
def cancel_po(po_id: uuid.UUID, body: CancelIn, ctx: AuthContext = Depends(require("purchasing.create")),
              db: Session = Depends(get_db)):
    """Cancels an unreceived PO, or short-closes a partially received one (outstanding qty cancelled)."""
    po = _get_po(db, ctx, po_id, lock=True)
    if po.status in ("RECEIVED", "CLOSED", "CANCELLED"):
        raise Conflict(f"Purchase order is already {po.status.lower()}")
    received = sum(ln.qty_received for ln in po.lines)
    for ln in po.lines:
        ln.qty_cancelled += ln.qty_outstanding
    po.status = "CLOSED" if received else "CANCELLED"
    po.cancel_reason, po.closed_at = body.reason, datetime.now(UTC)
    approvals.cancel_pending(db, "purchase_order", po.id)
    audit(db, ctx, "purchasing.po_closed" if received else "purchasing.po_cancelled", entity_type="purchase_order",
          entity_id=po.id, location_id=po.location_id, details={"reason": body.reason})
    db.commit()
    return _po_out(db, po)


# ---------------------------------------------------------------- goods receipts


class GRNLineIn(BaseModel):
    po_line_id: uuid.UUID | None = None
    book_id: uuid.UUID | None = None
    qty_received: int = Field(default=0, ge=0, le=100000)
    qty_damaged: int = Field(default=0, ge=0, le=100000)
    unit_cost: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=4)


class GRNIn(BaseModel):
    location_id: uuid.UUID
    po_id: uuid.UUID | None = None
    supplier_id: uuid.UUID | None = None
    supplier_ref: str | None = Field(default=None, max_length=60)
    freight: Decimal = Field(default=Decimal(0), ge=0, max_digits=12, decimal_places=2)
    other_charges: Decimal = Field(default=Decimal(0), ge=0, max_digits=12, decimal_places=2)
    notes: str | None = Field(default=None, max_length=1000)
    lines: list[GRNLineIn] = Field(min_length=1, max_length=500)


class GRNOut(BaseModel):
    id: uuid.UUID
    number: str
    po_id: uuid.UUID | None
    po_number: str | None
    supplier_id: uuid.UUID
    supplier_name: str
    location_id: uuid.UUID
    location_name: str
    supplier_ref: str | None
    freight: Decimal
    other_charges: Decimal
    goods_value: Decimal
    total_landed: Decimal
    supplier_invoice_id: uuid.UUID | None
    received_at: datetime
    notes: str | None
    lines: list[dict]
    replayed: bool = False


def _grn_out(db: Session, g: GoodsReceipt) -> GRNOut:
    po = db.get(PurchaseOrder, g.po_id) if g.po_id else None
    loc = db.get(Location, g.location_id)
    return GRNOut(id=g.id, number=g.number, po_id=g.po_id, po_number=po.number if po else None, supplier_id=g.supplier_id,
                  supplier_name=g.supplier.name, location_id=g.location_id, location_name=loc.name,
                  supplier_ref=g.supplier_ref, freight=g.freight, other_charges=g.other_charges,
                  goods_value=g.goods_value, total_landed=g.total_landed, supplier_invoice_id=g.supplier_invoice_id,
                  received_at=g.received_at, notes=g.notes,
                  lines=[{"book_id": ln.book_id, "title": ln.book.title, "sku": ln.book.sku, "qty_received": ln.qty_received,
                          "qty_damaged": ln.qty_damaged, "unit_cost": ln.unit_cost, "landed_unit_cost": ln.landed_unit_cost}
                         for ln in g.lines])


@router.get("/goods-receipts", response_model=Page[GRNOut])
def list_grns(supplier_id: uuid.UUID | None = None, location_id: uuid.UUID | None = None, uninvoiced: bool | None = None,
              params: PageParams = Depends(), ctx: AuthContext = Depends(require("purchasing.view")),
              db: Session = Depends(get_db)):
    stmt = select(GoodsReceipt).where(ctx.loc_filter(GoodsReceipt.location_id)).order_by(GoodsReceipt.received_at.desc())
    if supplier_id:
        stmt = stmt.where(GoodsReceipt.supplier_id == supplier_id)
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(GoodsReceipt.location_id == location_id)
    if uninvoiced:
        stmt = stmt.where(GoodsReceipt.supplier_invoice_id.is_(None))
    rows, total = paginate(db, stmt, params)
    return Page(items=[_grn_out(db, g) for g in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/goods-receipts", response_model=GRNOut, status_code=201)
def create_grn(body: GRNIn, idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
               ctx: AuthContext = Depends(require("purchasing.receive")), db: Session = Depends(get_db)):
    grn, created = svc.receive_goods(
        db, ctx, idempotency_key=idempotency_key, location_id=body.location_id, supplier_id=body.supplier_id,
        po_id=body.po_id, lines=[ln.model_dump() for ln in body.lines], freight=body.freight,
        other_charges=body.other_charges, supplier_ref=body.supplier_ref, notes=body.notes)
    db.commit()
    out = _grn_out(db, grn)
    out.replayed = not created
    return out


@router.get("/goods-receipts/{grn_id}", response_model=GRNOut)
def get_grn(grn_id: uuid.UUID, ctx: AuthContext = Depends(require("purchasing.view")), db: Session = Depends(get_db)):
    g = db.get(GoodsReceipt, grn_id)
    if g is None:
        raise NotFound("Goods receipt not found")
    ctx.ensure_resource(g.location_id)
    return _grn_out(db, g)


# ---------------------------------------------------------------- supplier invoices & payments


class SupplierInvoiceIn(BaseModel):
    supplier_id: uuid.UUID
    invoice_number: str = Field(min_length=1, max_length=60)
    invoice_date: date
    due_date: date | None = None
    grn_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    taxable_amount: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    cgst: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    sgst: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    igst: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    other_charges: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    notes: str | None = Field(default=None, max_length=1000)


class SupplierInvoiceOut(ORM):
    id: uuid.UUID
    supplier_id: uuid.UUID
    supplier_name: str | None = None
    invoice_number: str
    invoice_date: date
    due_date: date
    location_id: uuid.UUID
    taxable_amount: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    other_charges: Decimal
    total: Decimal
    amount_paid: Decimal
    balance_due: Decimal
    status: str
    notes: str | None
    created_at: datetime
    grns: list[dict] = []
    overdue: bool = False


def _si_out(db: Session, si: SupplierInvoice) -> SupplierInvoiceOut:
    o = SupplierInvoiceOut.model_validate(si)
    o.supplier_name = si.supplier.name
    o.grns = [{"id": g.id, "number": g.number, "total_landed": g.total_landed}
              for g in db.scalars(select(GoodsReceipt).where(GoodsReceipt.supplier_invoice_id == si.id))]
    o.overdue = si.status in ("OPEN", "PARTIALLY_PAID") and si.due_date < date.today()
    return o


@router.get("/supplier-invoices", response_model=Page[SupplierInvoiceOut])
def list_supplier_invoices(supplier_id: uuid.UUID | None = None, status: str | None = None, overdue: bool | None = None,
                           params: PageParams = Depends(), ctx: AuthContext = Depends(require_any("finance.view", "purchasing.view")),
                           db: Session = Depends(get_db)):
    stmt = select(SupplierInvoice).where(ctx.loc_filter(SupplierInvoice.location_id)).order_by(SupplierInvoice.due_date)
    if supplier_id:
        stmt = stmt.where(SupplierInvoice.supplier_id == supplier_id)
    if status:
        stmt = stmt.where(SupplierInvoice.status.in_(status.split(",")))
    if overdue:
        stmt = stmt.where(SupplierInvoice.due_date < date.today(), SupplierInvoice.status.in_(["OPEN", "PARTIALLY_PAID"]))
    rows, total = paginate(db, stmt, params)
    return Page(items=[_si_out(db, s) for s in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/supplier-invoices", response_model=SupplierInvoiceOut, status_code=201)
def create_supplier_invoice(body: SupplierInvoiceIn, ctx: AuthContext = Depends(require("finance.manage")),
                            db: Session = Depends(get_db)):
    si = svc.record_supplier_invoice(db, ctx, **body.model_dump())
    db.commit()
    return _si_out(db, si)


class AllocationIn(BaseModel):
    supplier_invoice_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)


class SupplierPaymentIn(BaseModel):
    supplier_id: uuid.UUID
    location_id: uuid.UUID
    payment_method_id: uuid.UUID
    account_id: uuid.UUID | None = None
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    reference: str | None = Field(default=None, max_length=100)
    payment_date: date
    notes: str | None = Field(default=None, max_length=300)
    allocations: list[AllocationIn] = Field(min_length=1, max_length=100)


@router.post("/supplier-payments", status_code=201)
def create_supplier_payment(body: SupplierPaymentIn,
                            idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
                            ctx: AuthContext = Depends(require("finance.manage")), db: Session = Depends(get_db)):
    pay, created = svc.pay_supplier(db, ctx, idempotency_key=idempotency_key,
                                    **body.model_dump(exclude={"allocations"}),
                                    allocations=[a.model_dump() for a in body.allocations])
    db.commit()
    return {"id": pay.id, "number": pay.number, "amount": pay.amount, "replayed": not created}


@router.get("/supplier-payments")
def list_supplier_payments(supplier_id: uuid.UUID | None = None, params: PageParams = Depends(),
                           ctx: AuthContext = Depends(require("finance.view")), db: Session = Depends(get_db)):
    stmt = (select(Payment).where(Payment.purpose == "SUPPLIER_PAYMENT", ctx.loc_filter(Payment.location_id))
            .order_by(Payment.created_at.desc()))
    if supplier_id:
        stmt = stmt.where(Payment.supplier_id == supplier_id)
    rows, total = paginate(db, stmt, params)
    sups = {s.id: s.name for s in db.scalars(select(Supplier).where(Supplier.id.in_({p.supplier_id for p in rows})))} if rows else {}
    items = []
    for p in rows:
        allocs = db.execute(select(PaymentAllocation.amount, SupplierInvoice.invoice_number)
                            .join(SupplierInvoice, SupplierInvoice.id == PaymentAllocation.supplier_invoice_id)
                            .where(PaymentAllocation.payment_id == p.id))
        items.append({"id": p.id, "number": p.number, "supplier_id": p.supplier_id, "supplier_name": sups.get(p.supplier_id),
                      "amount": p.amount, "method": p.method.name, "reference": p.reference, "payment_date": p.payment_date,
                      "allocations": [{"invoice_number": n, "amount": a} for a, n in allocs]})
    return {"items": items, "total": total, "page": params.page, "page_size": params.page_size}


# ---------------------------------------------------------------- supplier returns


class SRLineIn(BaseModel):
    book_id: uuid.UUID
    qty: int = Field(gt=0, le=100000)
    from_bucket: str = Field(default="DAMAGED", pattern=r"^(ON_HAND|DAMAGED|QUARANTINED)$")
    copy_ids: list[uuid.UUID] | None = None


class SupplierReturnIn(BaseModel):
    supplier_id: uuid.UUID
    location_id: uuid.UUID
    grn_id: uuid.UUID | None = None
    reason: str = Field(min_length=3, max_length=300)
    lines: list[SRLineIn] = Field(min_length=1, max_length=200)


@router.post("/supplier-returns", status_code=201)
def create_supplier_return(body: SupplierReturnIn,
                           idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
                           ctx: AuthContext = Depends(require("purchasing.return")), db: Session = Depends(get_db)):
    sr, created = svc.return_to_supplier(db, ctx, idempotency_key=idempotency_key, supplier_id=body.supplier_id,
                                         location_id=body.location_id, grn_id=body.grn_id, reason=body.reason,
                                         lines=[ln.model_dump() for ln in body.lines])
    db.commit()
    return {"id": sr.id, "number": sr.number, "value": sr.value, "replayed": not created}


@router.get("/supplier-returns")
def list_supplier_returns(params: PageParams = Depends(), ctx: AuthContext = Depends(require("purchasing.view")),
                          db: Session = Depends(get_db)):
    stmt = select(SupplierReturn).where(ctx.loc_filter(SupplierReturn.location_id)).order_by(SupplierReturn.created_at.desc())
    rows, total = paginate(db, stmt, params)
    books = {}
    items = []
    for r in rows:
        lines = []
        for ln in r.lines:
            if ln.book_id not in books:
                books[ln.book_id] = db.get(Book, ln.book_id)
            lines.append({"title": books[ln.book_id].title, "qty": ln.qty, "from_bucket": ln.from_bucket})
        items.append({"id": r.id, "number": r.number, "supplier_name": r.supplier.name, "reason": r.reason,
                      "value": r.value, "created_at": r.created_at, "lines": lines})
    return {"items": items, "total": total, "page": params.page, "page_size": params.page_size}
