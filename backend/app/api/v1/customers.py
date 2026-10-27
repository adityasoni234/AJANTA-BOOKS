import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import case, func, or_, select, text
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.db import get_db
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.money import D, r2
from app.models import Customer, CustomerLedger, Invoice, Location, PaymentMethod, Return, Sale, User
from app.schemas.common import ORM, Page, PageParams, paginate
from app.services import accounting
from app.services import returns as ret_svc
from app.services import sales as sales_svc
from app.services.accounting import Leg
from app.services.audit import audit
from app.services.gst import valid_gstin
from app.services.numbering import next_code
from app.services.reports import local_date
from app.services.settings import get_policy

router = APIRouter(tags=["customers"])


class CustomerIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    phone: str | None = Field(default=None, pattern=r"^\+?\d{7,15}$")
    email: EmailStr | None = None
    gstin: str | None = None
    billing_address: str | None = Field(default=None, max_length=500)
    state_code: str | None = Field(default=None, pattern=r"^\d{2}$")
    notes: str | None = Field(default=None, max_length=2000)
    marketing_consent: bool = False
    credit_limit: Decimal = Field(default=Decimal(0), ge=0, max_digits=12, decimal_places=2)
    is_active: bool = True

    @field_validator("gstin")
    @classmethod
    def _g(cls, v):
        if v:
            v = v.strip().upper()
            if not valid_gstin(v):
                raise ValueError("Invalid GSTIN (format or checksum)")
        return v or None


class CustomerOut(ORM):
    id: uuid.UUID
    code: str
    name: str
    phone: str | None
    email: str | None
    gstin: str | None
    billing_address: str | None
    state_code: str | None
    notes: str | None
    marketing_consent: bool
    credit_limit: Decimal
    is_active: bool
    created_at: datetime
    lifetime_spend: Decimal | None = None
    visits: int | None = None
    last_purchase_at: datetime | None = None
    store_credit: Decimal | None = None
    loyalty_points: Decimal | None = None
    outstanding: Decimal | None = None
    segment: str | None = None


def _segment(spend: Decimal, visits: int, last: datetime | None) -> str:
    if visits == 0:
        return "NEW"
    if last and (datetime.now(UTC) - last).days > 180:
        return "LAPSED"
    if spend >= 20000 or visits >= 15:
        return "VIP"
    if visits >= 3:
        return "REGULAR"
    return "OCCASIONAL"


def _stats(db: Session, ctx: AuthContext, ids: list[uuid.UUID]) -> dict:
    if not ids:
        return {}
    rows = db.execute(select(Sale.customer_id, func.coalesce(func.sum(Sale.grand_total), 0), func.count(), func.max(Sale.created_at),
                             func.coalesce(func.sum(Sale.grand_total - Sale.amount_paid), 0))
                      .where(Sale.customer_id.in_(ids), Sale.status == "COMPLETED", ctx.loc_filter(Sale.location_id))
                      .group_by(Sale.customer_id))
    out = {cid: {"spend": D(s), "visits": n, "last": last, "outstanding": D(o)} for cid, s, n, last, o in rows}
    refunds = db.execute(select(Return.customer_id, func.sum(Return.refund_total))
                         .where(Return.customer_id.in_(ids), Return.status == "COMPLETED", ctx.loc_filter(Return.location_id))
                         .group_by(Return.customer_id))
    for cid, total in refunds:
        out.setdefault(cid, {"spend": D(0), "visits": 0, "last": None, "outstanding": D(0)})["spend"] -= D(total)
    led = db.execute(select(CustomerLedger.customer_id, CustomerLedger.kind, func.sum(CustomerLedger.delta))
                     .where(CustomerLedger.customer_id.in_(ids)).group_by(CustomerLedger.customer_id, CustomerLedger.kind))
    for cid, kind, total in led:
        out.setdefault(cid, {"spend": D(0), "visits": 0, "last": None, "outstanding": D(0)})[kind] = D(total)
    return out


def _out(c: Customer, st: dict | None) -> CustomerOut:
    o = CustomerOut.model_validate(c)
    st = st or {"spend": D(0), "visits": 0, "last": None, "outstanding": D(0)}
    o.lifetime_spend, o.visits, o.last_purchase_at = st["spend"], st["visits"], st["last"]
    o.store_credit, o.loyalty_points = st.get("STORE_CREDIT", D(0)), st.get("LOYALTY", D(0))
    o.outstanding = st["outstanding"]
    o.segment = _segment(st["spend"], st["visits"], st["last"])
    return o


def _segment_expr(ctx: AuthContext):
    """SQL version of _segment() so the segment filter applies before pagination."""
    sale_stats = (select(Sale.customer_id.label("cid"), func.count().label("visits"),
                         func.sum(Sale.grand_total).label("spend"), func.max(Sale.created_at).label("last"))
                  .where(Sale.status == "COMPLETED", ctx.loc_filter(Sale.location_id))
                  .group_by(Sale.customer_id).subquery())
    ret_stats = (select(Return.customer_id.label("cid"), func.sum(Return.refund_total).label("refunds"))
                 .where(Return.status == "COMPLETED", ctx.loc_filter(Return.location_id))
                 .group_by(Return.customer_id).subquery())
    visits = func.coalesce(sale_stats.c.visits, 0)
    spend = func.coalesce(sale_stats.c.spend, 0) - func.coalesce(ret_stats.c.refunds, 0)
    segment = case(
        (visits == 0, "NEW"),
        (sale_stats.c.last < func.now() - text("interval '180 days'"), "LAPSED"),
        (or_(spend >= 20000, visits >= 15), "VIP"),
        (visits >= 3, "REGULAR"),
        else_="OCCASIONAL",
    )
    return sale_stats, ret_stats, segment


@router.get("/customers", response_model=Page[CustomerOut])
def list_customers(q: str | None = Query(None, max_length=100), segment: str | None = Query(None, pattern=r"^(NEW|LAPSED|VIP|REGULAR|OCCASIONAL)$"),
                   with_balance: bool | None = None, params: PageParams = Depends(),
                   ctx: AuthContext = Depends(require_any("customers.view", "pos.sell")), db: Session = Depends(get_db)):
    stmt = select(Customer).order_by(Customer.name)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Customer.name.ilike(like), Customer.phone.ilike(like), Customer.email.ilike(like),
                              Customer.code.ilike(like), Customer.gstin.ilike(like)))
    if with_balance:
        stmt = stmt.where(Customer.id.in_(select(Sale.customer_id).where(Sale.grand_total > Sale.amount_paid,
                                                                        Sale.status == "COMPLETED")))
    if segment:
        sale_stats, ret_stats, seg = _segment_expr(ctx)
        stmt = (stmt.outerjoin(sale_stats, sale_stats.c.cid == Customer.id)
                .outerjoin(ret_stats, ret_stats.c.cid == Customer.id).where(seg == segment))
    rows, total = paginate(db, stmt, params)
    st = _stats(db, ctx, [c.id for c in rows])
    return Page(items=[_out(c, st.get(c.id)) for c in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/customers/check-duplicates", response_model=list[CustomerOut])
def check_duplicates(body: CustomerIn, ctx: AuthContext = Depends(require_any("customers.view", "pos.sell")),
                     db: Session = Depends(get_db)):
    conds = [func.similarity(Customer.name, body.name) > 0.55]
    if body.phone:
        conds.append(Customer.phone == body.phone)
    if body.email:
        conds.append(func.lower(Customer.email) == body.email.lower())
    if body.gstin:
        conds.append(Customer.gstin == body.gstin)
    return [_out(c, None) for c in db.scalars(select(Customer).where(or_(*conds)).limit(10))]


@router.post("/customers", response_model=CustomerOut, status_code=201)
def create_customer(body: CustomerIn, location_id: uuid.UUID | None = None,
                    ctx: AuthContext = Depends(require("customers.manage")), db: Session = Depends(get_db)):
    if body.credit_limit > 0 and not ctx.has("finance.manage") and not ctx.has("registers.manage"):
        raise ValidationFailed("Only managers can set a credit limit")
    if body.phone and db.scalar(select(Customer.id).where(Customer.phone == body.phone)):
        raise Conflict("A customer with this phone number already exists")
    c = Customer(code=next_code(db, "CUSTOMER", "C", 6), **body.model_dump(), created_by=ctx.user_id,
                 consent_updated_at=datetime.now(UTC) if body.marketing_consent else None)
    if body.gstin and not body.state_code:
        c.state_code = body.gstin[:2]
    if location_id:
        ctx.ensure_location(location_id)
        c.home_location_id = location_id
    db.add(c)
    db.flush()
    audit(db, ctx, "customers.created", entity_type="customer", entity_id=c.id, location_id=location_id,
          details={"name": c.name})
    db.commit()
    return _out(c, None)


@router.get("/customers/{customer_id}", response_model=CustomerOut)
def get_customer(customer_id: uuid.UUID, ctx: AuthContext = Depends(require_any("customers.view", "pos.sell")),
                 db: Session = Depends(get_db)):
    c = db.get(Customer, customer_id)
    if c is None:
        raise NotFound("Customer not found")
    return _out(c, _stats(db, ctx, [c.id]).get(c.id))


@router.put("/customers/{customer_id}", response_model=CustomerOut)
def update_customer(customer_id: uuid.UUID, body: CustomerIn, ctx: AuthContext = Depends(require("customers.manage")),
                    db: Session = Depends(get_db)):
    c = db.get(Customer, customer_id)
    if c is None:
        raise NotFound("Customer not found")
    if body.credit_limit != c.credit_limit and not ctx.has("finance.manage") and not ctx.has("registers.manage"):
        raise ValidationFailed("Only managers can change a credit limit")
    if body.phone and body.phone != c.phone and db.scalar(select(Customer.id).where(Customer.phone == body.phone)):
        raise Conflict("A customer with this phone number already exists")
    before = CustomerOut.model_validate(c).model_dump(mode="json")
    if body.marketing_consent != c.marketing_consent:
        c.consent_updated_at = datetime.now(UTC)
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    audit(db, ctx, "customers.updated", entity_type="customer", entity_id=c.id,
          details={"before": before, "after": body.model_dump(mode="json")})
    db.commit()
    return _out(c, _stats(db, ctx, [c.id]).get(c.id))


@router.get("/customers/{customer_id}/history")
def customer_history(customer_id: uuid.UUID, ctx: AuthContext = Depends(require_any("customers.view", "pos.sell")),
                     db: Session = Depends(get_db)):
    c = db.get(Customer, customer_id)
    if c is None:
        raise NotFound("Customer not found")
    sales = db.execute(select(Sale, Invoice.number, Location.name).outerjoin(Invoice, Invoice.sale_id == Sale.id)
                       .join(Location, Location.id == Sale.location_id)
                       .where(Sale.customer_id == c.id, ctx.loc_filter(Sale.location_id))
                       .order_by(Sale.created_at.desc()).limit(200))
    rets = db.scalars(select(Return).where(Return.customer_id == c.id, ctx.loc_filter(Return.location_id))
                      .order_by(Return.created_at.desc()).limit(200))
    ledger = db.execute(select(CustomerLedger, User.full_name).outerjoin(User, User.id == CustomerLedger.actor_id)
                        .where(CustomerLedger.customer_id == c.id).order_by(CustomerLedger.created_at.desc()).limit(200))
    return {
        "sales": [{"id": s.id, "invoice_number": n, "location": loc, "status": s.status, "grand_total": s.grand_total,
                   "balance_due": s.balance_due, "items": sum(ln.qty for ln in s.lines), "created_at": s.created_at}
                  for s, n, loc in sales],
        "returns": [{"id": r.id, "number": r.number, "status": r.status, "refund_total": r.refund_total,
                     "created_at": r.created_at} for r in rets],
        "ledger": [{"kind": led.kind, "delta": led.delta, "note": led.note, "ref_type": led.ref_type, "by": name,
                    "created_at": led.created_at} for led, name in ledger],
    }


class CreditAdjustIn(BaseModel):
    kind: str = Field(pattern=r"^(STORE_CREDIT|LOYALTY)$")
    delta: Decimal = Field(max_digits=12, decimal_places=2)
    note: str = Field(min_length=3, max_length=300)


@router.post("/customers/{customer_id}/ledger")
def adjust_ledger(customer_id: uuid.UUID, body: CreditAdjustIn, location_id: uuid.UUID | None = None,
                  ctx: AuthContext = Depends(require("customers.manage")), db: Session = Depends(get_db)):
    """Manual, audited adjustments. Store credit goes through the GL (goodwill expense)."""
    c = db.scalar(select(Customer).where(Customer.id == customer_id).with_for_update(of=Customer))
    if c is None:
        raise NotFound("Customer not found")
    if body.delta == 0:
        raise ValidationFailed("Adjustment cannot be zero")
    if body.kind == "STORE_CREDIT":
        if not ctx.has("finance.manage"):
            raise ValidationFailed("Store credit adjustments require finance permission")
        if sales_svc.customer_balance(db, c.id, "STORE_CREDIT") + body.delta < 0:
            raise Conflict("Store credit cannot become negative")
        accounting.post(db, source_type="STORE_CREDIT_ADJ", source_id=c.id, actor_id=ctx.user_id, location_id=location_id,
                        memo=f"Store credit adjustment — {c.name}: {body.note}",
                        legs=[Leg("LOYALTY_EXPENSE", r2(body.delta)), Leg("STORE_CREDIT", -r2(body.delta))])
    else:
        if body.delta != body.delta.to_integral_value():
            raise ValidationFailed("Loyalty points must be whole numbers")
        if sales_svc.customer_balance(db, c.id, "LOYALTY") + body.delta < 0:
            raise Conflict("Loyalty points cannot become negative")
    db.add(CustomerLedger(customer_id=c.id, kind=body.kind, delta=body.delta, ref_type="MANUAL", note=body.note,
                          actor_id=ctx.user_id))
    audit(db, ctx, "customers.ledger_adjusted", entity_type="customer", entity_id=c.id, details=body.model_dump(mode="json"))
    db.commit()
    return {"message": "Adjusted"}


@router.post("/customers/{customer_id}/redeem-points")
def redeem_points(customer_id: uuid.UUID, points: int = Query(gt=0, le=1000000),
                  ctx: AuthContext = Depends(require("pos.sell")), db: Session = Depends(get_db)):
    """Convert loyalty points into store credit at the configured point value."""
    policy = get_policy(db)
    if not policy.loyalty_enabled:
        raise ValidationFailed("Loyalty programme is disabled")
    c = db.scalar(select(Customer).where(Customer.id == customer_id).with_for_update(of=Customer))
    if c is None:
        raise NotFound("Customer not found")
    if sales_svc.customer_balance(db, c.id, "LOYALTY") < points:
        raise Conflict("Not enough points")
    value = r2(Decimal(points) * policy.loyalty_point_value)
    if value <= 0:
        raise ValidationFailed("Point value is zero")
    db.add(CustomerLedger(customer_id=c.id, kind="LOYALTY", delta=-points, ref_type="REDEEM", note="Redeemed",
                          actor_id=ctx.user_id))
    db.add(CustomerLedger(customer_id=c.id, kind="STORE_CREDIT", delta=value, ref_type="REDEEM",
                          note=f"{points} points redeemed", actor_id=ctx.user_id))
    accounting.post(db, source_type="LOYALTY_REDEEM", source_id=c.id, actor_id=ctx.user_id,
                    memo=f"Loyalty redemption — {c.name}", legs=[Leg("LOYALTY_EXPENSE", value), Leg("STORE_CREDIT", -value)])
    audit(db, ctx, "customers.points_redeemed", entity_type="customer", entity_id=c.id, details={"points": points, "value": value})
    db.commit()
    return {"store_credit_added": value}


class ReceiptAlloc(BaseModel):
    sale_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)


class CustomerReceiptIn(BaseModel):
    location_id: uuid.UUID
    payment_method_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    reference: str | None = Field(default=None, max_length=100)
    register_session_id: uuid.UUID | None = None
    allocations: list[ReceiptAlloc] = Field(min_length=1, max_length=100)


@router.post("/customers/{customer_id}/receipts", status_code=201)
def customer_receipt(customer_id: uuid.UUID, body: CustomerReceiptIn,
                     idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
                     ctx: AuthContext = Depends(require("pos.sell")), db: Session = Depends(get_db)):
    pay, created = sales_svc.receive_customer_payment(
        db, ctx, idempotency_key=idempotency_key, customer_id=customer_id, location_id=body.location_id,
        payment_method_id=body.payment_method_id, amount=body.amount, reference=body.reference,
        allocations=[a.model_dump() for a in body.allocations], register_session_id=body.register_session_id)
    db.commit()
    return {"id": pay.id, "number": pay.number, "amount": pay.amount, "replayed": not created}


# ---------------------------------------------------------------- returns


class ReturnLineIn(BaseModel):
    sale_line_id: uuid.UUID
    qty: int = Field(gt=0, le=10000)
    disposition: str = Field(default="RESTOCK", pattern=r"^(RESTOCK|QUARANTINE|DAMAGED)$")
    condition: str = Field(default="GOOD", pattern=r"^(NEW|GOOD|FAIR|POOR|DAMAGED)$")
    copy_id: uuid.UUID | None = None


class ReturnIn(BaseModel):
    sale_id: uuid.UUID
    reason: str = Field(min_length=3, max_length=300)
    refund_method_id: uuid.UUID
    refund_reference: str | None = Field(default=None, max_length=100)
    register_session_id: uuid.UUID | None = None
    lines: list[ReturnLineIn] = Field(min_length=1, max_length=300)


def return_payload(db: Session, r: Return) -> dict:
    sale = db.get(Sale, r.sale_id)
    orig = db.scalar(select(Invoice).where(Invoice.sale_id == r.sale_id))
    cn = db.scalar(select(Invoice).where(Invoice.return_id == r.id))
    loc = db.get(Location, r.location_id)
    by = db.get(User, r.created_by)
    sl = {ln.id: ln for ln in sale.lines}
    from app.services.words import amount_in_words

    return {
        "id": r.id, "number": r.number, "status": r.status, "sale_id": r.sale_id,
        "original_invoice_number": orig.number if orig else None,
        "credit_note": {"id": cn.id, "number": cn.number, "issued_at": cn.issued_at, "seller": cn.seller,
                        "buyer": cn.buyer, "place_of_supply": cn.place_of_supply} if cn else None,
        "location_id": r.location_id, "location_name": loc.name, "reason": r.reason,
        "refund_method": r.refund_method.name, "refund_method_kind": r.refund_method.kind,
        "refund_reference": r.refund_reference, "taxable_total": r.taxable_total, "cgst_total": r.cgst_total,
        "sgst_total": r.sgst_total, "igst_total": r.igst_total, "round_off": r.round_off, "refund_total": r.refund_total,
        "amount_in_words": amount_in_words(r.refund_total), "customer_name": sale.customer.name if sale.customer else None,
        "lines": [{"sale_line_id": ln.sale_line_id, "title": sl[ln.sale_line_id].title,
                   "hsn_code": sl[ln.sale_line_id].hsn_code, "qty": ln.qty, "disposition": ln.disposition,
                   "condition": ln.condition, "taxable_value": ln.taxable_value, "tax_rate": sl[ln.sale_line_id].tax_rate,
                   "cgst": ln.cgst, "sgst": ln.sgst, "igst": ln.igst, "line_total": ln.line_total} for ln in r.lines],
        "created_by": by.full_name if by else None, "created_at": r.created_at, "completed_at": r.completed_at,
        "approval_request_id": r.approval_request_id,
    }


@router.post("/returns", status_code=201)
def create_return(body: ReturnIn, idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
                  ctx: AuthContext = Depends(require("returns.create")), db: Session = Depends(get_db)):
    r, created = ret_svc.create_return(db, ctx, idempotency_key=idempotency_key, sale_id=body.sale_id,
                                       lines=[ln.model_dump() for ln in body.lines], reason=body.reason,
                                       refund_method_id=body.refund_method_id, refund_reference=body.refund_reference,
                                       register_session_id=body.register_session_id)
    db.commit()
    db.expire_all()
    out = return_payload(db, db.get(Return, r.id))
    out["replayed"] = not created
    return out


@router.get("/returns")
def list_returns(location_id: uuid.UUID | None = None, status: str | None = None, date_from: date | None = None,
                 date_to: date | None = None, params: PageParams = Depends(),
                 ctx: AuthContext = Depends(require_any("returns.create", "sales.view")), db: Session = Depends(get_db)):
    stmt = select(Return).where(ctx.loc_filter(Return.location_id)).order_by(Return.created_at.desc())
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(Return.location_id == location_id)
    if status:
        stmt = stmt.where(Return.status == status)
    if date_from:
        stmt = stmt.where(local_date(db, Return.created_at) >= date_from)
    if date_to:
        stmt = stmt.where(local_date(db, Return.created_at) <= date_to)
    rows, total = paginate(db, stmt, params)
    return {"items": [return_payload(db, r) for r in rows], "total": total, "page": params.page, "page_size": params.page_size}


@router.get("/returns/{return_id}")
def get_return(return_id: uuid.UUID, ctx: AuthContext = Depends(require_any("returns.create", "sales.view")),
               db: Session = Depends(get_db)):
    r = db.get(Return, return_id)
    if r is None:
        raise NotFound("Return not found")
    ctx.ensure_resource(r.location_id)
    return return_payload(db, r)


@router.get("/exchange-method")
def exchange_method(_: AuthContext = Depends(require("returns.create")), db: Session = Depends(get_db)):
    m = db.scalar(select(PaymentMethod).where(PaymentMethod.kind == "EXCHANGE"))
    return {"id": m.id if m else None}
