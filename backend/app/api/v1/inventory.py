import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.db import get_db
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.money import r2
from app.models import (
    Book,
    CopyEvent,
    IndividualCopy,
    InventoryBalance,
    InventoryLedger,
    Location,
    StockAdjustment,
    Stocktake,
    StocktakeLine,
    User,
)
from app.schemas.common import ORM, Page, PageParams, paginate
from app.services import catalog as catalog_svc
from app.services import inventory as inv
from app.services.audit import audit
from app.services.numbering import next_number

router = APIRouter(tags=["inventory"])


def _cost_visible(ctx: AuthContext) -> bool:
    return ctx.has("reports.financial") or ctx.has("purchasing.view")


class BalanceOut(BaseModel):
    location_id: uuid.UUID
    location_name: str
    book_id: uuid.UUID
    sku: str
    barcode: str
    isbn13: str | None
    title: str
    authors: list[str]
    tracking_mode: str
    on_hand: int
    reserved: int
    available: int
    damaged: int
    quarantined: int
    in_transit: int
    reorder_level: int
    reorder_qty: int
    stock_status: str
    selling_price: Decimal
    avg_cost: Decimal | None = None
    stock_value: Decimal | None = None


def _effective_reorder(bal, book):
    return bal.reorder_level if bal.reorder_level is not None else book.reorder_level


def stock_status(bal, book) -> str:
    avail = bal.on_hand - bal.reserved
    level = _effective_reorder(bal, book)
    if avail <= 0:
        return "OUT"
    if level and avail <= level:
        return "LOW"
    return "OK"


@router.get("/inventory", response_model=Page[BalanceOut])
def balances(location_id: uuid.UUID | None = None, q: str | None = Query(None, max_length=100),
             status: str | None = Query(None, pattern=r"^(LOW|OUT|OK|IN_STOCK|DAMAGED|IN_TRANSIT)$"),
             category_id: uuid.UUID | None = None, params: PageParams = Depends(),
             ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    reorder = func.coalesce(InventoryBalance.reorder_level, Book.reorder_level)
    avail = InventoryBalance.on_hand - InventoryBalance.reserved
    stmt = (select(InventoryBalance, Book, Location)
            .join(Book, Book.id == InventoryBalance.book_id)
            .join(Location, Location.id == InventoryBalance.location_id)
            .where(ctx.loc_filter(InventoryBalance.location_id))
            .order_by(Book.title, Location.name))
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(InventoryBalance.location_id == location_id)
    if q:
        stmt = stmt.where(catalog_svc_filter(q))
    if category_id:
        stmt = stmt.where(Book.category_id == category_id)
    if status == "OUT":
        stmt = stmt.where(avail <= 0, Book.status == "ACTIVE")
    elif status == "LOW":
        stmt = stmt.where(avail > 0, reorder > 0, avail <= reorder)
    elif status == "OK":
        stmt = stmt.where(avail > 0, or_(reorder == 0, avail > reorder))
    elif status == "IN_STOCK":
        stmt = stmt.where(InventoryBalance.on_hand > 0)
    elif status == "DAMAGED":
        stmt = stmt.where(or_(InventoryBalance.damaged > 0, InventoryBalance.quarantined > 0))
    elif status == "IN_TRANSIT":
        stmt = stmt.where(InventoryBalance.in_transit > 0)
    else:
        stmt = stmt.where(or_(InventoryBalance.on_hand != 0, InventoryBalance.damaged != 0,
                              InventoryBalance.quarantined != 0, InventoryBalance.in_transit != 0,
                              Book.status == "ACTIVE"))
    rows, total = paginate(db, stmt, params, scalars=False)
    cost = _cost_visible(ctx)
    items = []
    for bal, book, loc in rows:
        items.append(BalanceOut(
            location_id=loc.id, location_name=loc.name, book_id=book.id, sku=book.sku, barcode=book.barcode,
            isbn13=book.isbn13, title=book.title, authors=book.author_names, tracking_mode=book.tracking_mode,
            on_hand=bal.on_hand, reserved=bal.reserved, available=bal.on_hand - bal.reserved, damaged=bal.damaged,
            quarantined=bal.quarantined, in_transit=bal.in_transit, reorder_level=_effective_reorder(bal, book),
            reorder_qty=bal.reorder_qty if bal.reorder_qty is not None else book.reorder_qty,
            stock_status=stock_status(bal, book),
            selling_price=bal.price_override if bal.price_override is not None else book.selling_price,
            avg_cost=bal.avg_cost if cost else None,
            stock_value=r2((bal.avg_cost or 0) * inv.valued_qty(bal)) if cost and bal.avg_cost is not None else None,
        ))
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def catalog_svc_filter(q: str):
    from app.api.v1.catalog import _search_filter

    return _search_filter(q)


@router.get("/inventory/summary")
def summary(ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    cost = _cost_visible(ctx)
    valued = InventoryBalance.on_hand + InventoryBalance.damaged + InventoryBalance.quarantined
    stmt = (select(Location.id, Location.name, Location.type,
                   func.coalesce(func.sum(InventoryBalance.on_hand), 0),
                   func.coalesce(func.sum(InventoryBalance.reserved), 0),
                   func.coalesce(func.sum(InventoryBalance.damaged + InventoryBalance.quarantined), 0),
                   func.coalesce(func.sum(InventoryBalance.in_transit), 0),
                   func.coalesce(func.sum(valued * func.coalesce(InventoryBalance.avg_cost, 0)), 0),
                   func.count(case((and_(valued > 0, InventoryBalance.avg_cost.is_(None)), 1))),
                   func.count(func.distinct(case((InventoryBalance.on_hand > 0, InventoryBalance.book_id)))))
            .select_from(Location).outerjoin(InventoryBalance, InventoryBalance.location_id == Location.id)
            .where(ctx.loc_filter(Location.id), Location.is_active.is_(True))
            .group_by(Location.id, Location.name, Location.type).order_by(Location.type.desc(), Location.name))
    out = []
    for lid, name, typ, on_hand, reserved, unsellable, transit, value, missing_cost, titles in db.execute(stmt):
        out.append({"location_id": lid, "location_name": name, "location_type": typ, "on_hand": int(on_hand),
                    "reserved": int(reserved), "unsellable": int(unsellable), "in_transit": int(transit),
                    "titles_in_stock": int(titles),
                    "value": str(r2(value)) if cost else None, "items_missing_cost": int(missing_cost) if cost else None})
    return out


class LedgerRow(ORM):
    id: int
    location_id: uuid.UUID
    location_name: str | None = None
    book_id: uuid.UUID
    title: str | None = None
    sku: str | None = None
    copy_id: uuid.UUID | None
    bucket: str
    qty_delta: int
    movement_type: str
    ref_type: str | None
    ref_id: uuid.UUID | None
    ref_number: str | None
    unit_cost: Decimal | None
    note: str | None
    actor_name: str | None = None
    created_at: datetime


@router.get("/inventory/ledger", response_model=Page[LedgerRow])
def ledger(location_id: uuid.UUID | None = None, book_id: uuid.UUID | None = None, movement_type: str | None = None,
           ref_number: str | None = None, date_from: date | None = None, date_to: date | None = None,
           params: PageParams = Depends(), ctx: AuthContext = Depends(require("inventory.view")),
           db: Session = Depends(get_db)):
    stmt = (select(InventoryLedger, Location.name, Book.title, Book.sku, User.full_name)
            .join(Location, Location.id == InventoryLedger.location_id)
            .join(Book, Book.id == InventoryLedger.book_id)
            .outerjoin(User, User.id == InventoryLedger.actor_id)
            .where(ctx.loc_filter(InventoryLedger.location_id)).order_by(InventoryLedger.id.desc()))
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(InventoryLedger.location_id == location_id)
    if book_id:
        stmt = stmt.where(InventoryLedger.book_id == book_id)
    if movement_type:
        stmt = stmt.where(InventoryLedger.movement_type == movement_type)
    if ref_number:
        stmt = stmt.where(InventoryLedger.ref_number.ilike(f"%{ref_number}%"))
    if date_from:
        stmt = stmt.where(InventoryLedger.created_at >= date_from)
    if date_to:
        stmt = stmt.where(func.date(InventoryLedger.created_at) <= date_to)
    rows, total = paginate(db, stmt, params, scalars=False)
    cost = _cost_visible(ctx)
    items = []
    for led, lname, title, sku, aname in rows:
        o = LedgerRow.model_validate(led)
        o.location_name, o.title, o.sku, o.actor_name = lname, title, sku, aname
        if not cost:
            o.unit_cost = None
        items.append(o)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/inventory/reconciliation")
def reconciliation(location_id: uuid.UUID | None = None, ctx: AuthContext = Depends(require("inventory.approve")),
                   db: Session = Depends(get_db)):
    """Detect differences between balances and the ledger / copy registry. Resolve via adjustments."""
    loc_ids = ctx.scoped_location_ids(location_id)
    issues = inv.reconcile(db, loc_ids)
    books = {b.id: b for b in db.scalars(select(Book).where(Book.id.in_({i["book_id"] for i in issues})))} if issues else {}
    for i in issues:
        b = books.get(i["book_id"])
        i["title"] = b.title if b else None
        i["sku"] = b.sku if b else None
    return {"checked_at": datetime.now().isoformat(), "issues": issues, "ok": not issues}


# ---------------------------------------------------------------- adjustments


class AdjLineIn(BaseModel):
    book_id: uuid.UUID
    qty: int = Field(gt=0, le=100000)
    from_bucket: str | None = Field(default=None, pattern=r"^(ON_HAND|DAMAGED|QUARANTINED)$")
    to_bucket: str | None = Field(default=None, pattern=r"^(ON_HAND|DAMAGED|QUARANTINED)$")
    unit_cost: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=4)
    copy_ids: list[uuid.UUID] | None = None


class AdjustmentIn(BaseModel):
    location_id: uuid.UUID
    reason_code: str = Field(pattern=r"^(OPENING|FOUND|LOSS|DAMAGE|WRITE_OFF|QUARANTINE|RELEASE|CORRECTION)$")
    notes: str | None = Field(default=None, max_length=1000)
    lines: list[AdjLineIn] = Field(min_length=1, max_length=500)


class AdjustmentOut(BaseModel):
    id: uuid.UUID
    number: str
    location_id: uuid.UUID
    location_name: str
    reason_code: str
    status: str
    notes: str | None
    value: Decimal | None
    created_by_name: str | None
    created_at: datetime
    posted_at: datetime | None
    lines: list[dict]


def _adj_out(db: Session, a: StockAdjustment, cost: bool) -> AdjustmentOut:
    loc = db.get(Location, a.location_id)
    creator = db.get(User, a.created_by)
    books = {b.id: b for b in db.scalars(select(Book).where(Book.id.in_([ln.book_id for ln in a.lines])))}
    copies = {c.id: c.copy_code for c in db.scalars(select(IndividualCopy).where(
        IndividualCopy.id.in_([ln.copy_id for ln in a.lines if ln.copy_id])))} if any(ln.copy_id for ln in a.lines) else {}
    return AdjustmentOut(
        id=a.id, number=a.number, location_id=a.location_id, location_name=loc.name, reason_code=a.reason_code,
        status=a.status, notes=a.notes, value=a.value if cost else None,
        created_by_name=creator.full_name if creator else None, created_at=a.created_at, posted_at=a.posted_at,
        lines=[{"book_id": str(ln.book_id), "title": books[ln.book_id].title, "sku": books[ln.book_id].sku,
                "qty": ln.qty, "from_bucket": ln.from_bucket, "to_bucket": ln.to_bucket,
                "copy_code": copies.get(ln.copy_id)} for ln in a.lines],
    )


@router.get("/inventory/adjustments", response_model=Page[AdjustmentOut])
def list_adjustments(location_id: uuid.UUID | None = None, status: str | None = None, params: PageParams = Depends(),
                     ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    stmt = select(StockAdjustment).where(ctx.loc_filter(StockAdjustment.location_id)).order_by(StockAdjustment.created_at.desc())
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(StockAdjustment.location_id == location_id)
    if status:
        stmt = stmt.where(StockAdjustment.status == status)
    rows, total = paginate(db, stmt, params)
    cost = _cost_visible(ctx)
    return Page(items=[_adj_out(db, a, cost) for a in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/inventory/adjustments", response_model=AdjustmentOut, status_code=201)
def create_adjustment(body: AdjustmentIn, ctx: AuthContext = Depends(require("inventory.adjust")),
                      db: Session = Depends(get_db)):
    if body.reason_code == "CORRECTION" and any(ln.from_bucket is None and ln.to_bucket is None for ln in body.lines):
        raise ValidationFailed("Correction lines must specify source and/or destination buckets")
    adj = inv.create_adjustment(db, ctx, location_id=body.location_id, reason_code=body.reason_code,
                                lines=[ln.model_dump() for ln in body.lines], notes=body.notes)
    db.commit()
    db.refresh(adj)
    return _adj_out(db, adj, _cost_visible(ctx))


# ---------------------------------------------------------------- stocktakes


class StocktakeOut(BaseModel):
    id: uuid.UUID
    number: str
    location_id: uuid.UUID
    location_name: str
    status: str
    notes: str | None
    created_at: datetime
    posted_at: datetime | None
    lines: list[dict]


def _st_out(db: Session, st: Stocktake) -> StocktakeOut:
    loc = db.get(Location, st.location_id)
    ids = [ln.book_id for ln in st.lines]
    books = {b.id: b for b in db.scalars(select(Book).where(Book.id.in_(ids)))} if ids else {}
    bals = {b.book_id: b for b in db.scalars(select(InventoryBalance).where(
        InventoryBalance.location_id == st.location_id, InventoryBalance.book_id.in_(ids)))} if ids else {}
    lines = []
    for ln in st.lines:
        system = ln.system_qty if ln.system_qty is not None else (bals[ln.book_id].on_hand if ln.book_id in bals else 0)
        lines.append({"book_id": str(ln.book_id), "title": books[ln.book_id].title, "sku": books[ln.book_id].sku,
                      "counted_qty": ln.counted_qty, "system_qty": system, "variance": ln.counted_qty - system})
    return StocktakeOut(id=st.id, number=st.number, location_id=st.location_id, location_name=loc.name,
                        status=st.status, notes=st.notes, created_at=st.created_at, posted_at=st.posted_at,
                        lines=sorted(lines, key=lambda x: x["title"]))


class StocktakeIn(BaseModel):
    location_id: uuid.UUID
    notes: str | None = Field(default=None, max_length=1000)


@router.get("/inventory/stocktakes", response_model=Page[StocktakeOut])
def list_stocktakes(location_id: uuid.UUID | None = None, params: PageParams = Depends(),
                    ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    stmt = select(Stocktake).where(ctx.loc_filter(Stocktake.location_id)).order_by(Stocktake.created_at.desc())
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(Stocktake.location_id == location_id)
    rows, total = paginate(db, stmt, params)
    return Page(items=[_st_out(db, s) for s in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/inventory/stocktakes", response_model=StocktakeOut, status_code=201)
def create_stocktake(body: StocktakeIn, ctx: AuthContext = Depends(require("inventory.stocktake")), db: Session = Depends(get_db)):
    ctx.ensure_location(body.location_id)
    st = Stocktake(number=next_number(db, "STK"), location_id=body.location_id, notes=body.notes, created_by=ctx.user_id)
    db.add(st)
    db.flush()
    audit(db, ctx, "inventory.stocktake_started", entity_type="stocktake", entity_id=st.id, location_id=body.location_id)
    db.commit()
    return _st_out(db, st)


def _get_st(db: Session, ctx: AuthContext, st_id: uuid.UUID, lock: bool = False) -> Stocktake:
    q = select(Stocktake).where(Stocktake.id == st_id)
    if lock:
        q = q.with_for_update(of=Stocktake)
    st = db.scalar(q)
    if st is None:
        raise NotFound("Stocktake not found")
    ctx.ensure_resource(st.location_id)
    return st


@router.get("/inventory/stocktakes/{st_id}", response_model=StocktakeOut)
def get_stocktake(st_id: uuid.UUID, ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    return _st_out(db, _get_st(db, ctx, st_id))


class CountIn(BaseModel):
    book_id: uuid.UUID | None = None
    code: str | None = Field(default=None, max_length=60)
    counted_qty: int = Field(ge=0, le=1000000)
    mode: str = Field(default="SET", pattern=r"^(SET|ADD)$")


@router.post("/inventory/stocktakes/{st_id}/counts", response_model=StocktakeOut)
def record_counts(st_id: uuid.UUID, counts: list[CountIn], ctx: AuthContext = Depends(require("inventory.stocktake")),
                  db: Session = Depends(get_db)):
    st = _get_st(db, ctx, st_id, lock=True)
    if st.status != "OPEN":
        raise Conflict("Stocktake is not open")
    existing = {ln.book_id: ln for ln in st.lines}
    for c in counts[:1000]:
        if c.book_id:
            book_id = catalog_svc.get_book(db, c.book_id).id
        elif c.code:
            book_id = catalog_svc.lookup_code(db, c.code)[0].id
        else:
            raise ValidationFailed("Each count needs a book_id or code")
        if book_id in existing:
            ln = existing[book_id]
            ln.counted_qty = c.counted_qty if c.mode == "SET" else ln.counted_qty + c.counted_qty
        else:
            ln = StocktakeLine(stocktake_id=st.id, book_id=book_id, counted_qty=c.counted_qty)
            db.add(ln)
            st.lines.append(ln)
            existing[book_id] = ln
    db.commit()
    db.refresh(st)
    return _st_out(db, st)


@router.post("/inventory/stocktakes/{st_id}/post")
def post_stocktake(st_id: uuid.UUID, ctx: AuthContext = Depends(require("inventory.stocktake")), db: Session = Depends(get_db)):
    st = _get_st(db, ctx, st_id, lock=True)
    adj = inv.post_stocktake(db, ctx, st)
    audit(db, ctx, "inventory.stocktake_posted", entity_type="stocktake", entity_id=st.id, location_id=st.location_id,
          details={"adjustment": adj.number if adj else None})
    db.commit()
    return {"status": st.status, "adjustment_number": adj.number if adj else None,
            "adjustment_status": adj.status if adj else None}


@router.post("/inventory/stocktakes/{st_id}/cancel")
def cancel_stocktake(st_id: uuid.UUID, ctx: AuthContext = Depends(require("inventory.stocktake")), db: Session = Depends(get_db)):
    st = _get_st(db, ctx, st_id, lock=True)
    if st.status != "OPEN":
        raise Conflict("Only open stocktakes can be cancelled")
    st.status = "CANCELLED"
    audit(db, ctx, "inventory.stocktake_cancelled", entity_type="stocktake", entity_id=st.id, location_id=st.location_id)
    db.commit()
    return {"status": st.status}


# ---------------------------------------------------------------- individual copies


class CopyOut(BaseModel):
    id: uuid.UUID
    copy_code: str
    book_id: uuid.UUID
    title: str
    sku: str
    location_id: uuid.UUID
    location_name: str
    status: str
    condition: str
    acquisition_cost: Decimal | None
    selling_price: Decimal
    notes: str | None
    created_at: datetime


def _copy_out(c: IndividualCopy, loc_name: str, cost: bool) -> CopyOut:
    return CopyOut(id=c.id, copy_code=c.copy_code, book_id=c.book_id, title=c.book.title, sku=c.book.sku,
                   location_id=c.location_id, location_name=loc_name, status=c.status, condition=c.condition,
                   acquisition_cost=c.acquisition_cost if cost else None, selling_price=c.book.selling_price,
                   notes=c.notes, created_at=c.created_at)


@router.get("/copies", response_model=Page[CopyOut])
def list_copies(location_id: uuid.UUID | None = None, book_id: uuid.UUID | None = None, status: str | None = None,
                q: str | None = Query(None, max_length=60), params: PageParams = Depends(),
                ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    stmt = (select(IndividualCopy, Location.name).join(Location, Location.id == IndividualCopy.location_id)
            .join(Book, Book.id == IndividualCopy.book_id)
            .where(ctx.loc_filter(IndividualCopy.location_id)).order_by(IndividualCopy.copy_code))
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(IndividualCopy.location_id == location_id)
    if book_id:
        stmt = stmt.where(IndividualCopy.book_id == book_id)
    if status:
        stmt = stmt.where(IndividualCopy.status == status)
    if q:
        stmt = stmt.where(or_(IndividualCopy.copy_code.ilike(f"%{q}%"), Book.title.ilike(f"%{q}%")))
    rows, total = paginate(db, stmt, params, scalars=False)
    cost = _cost_visible(ctx)
    return Page(items=[_copy_out(c, n, cost) for c, n in rows], total=total, page=params.page, page_size=params.page_size)


@router.get("/copies/{copy_id}")
def copy_detail(copy_id: uuid.UUID, ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    c = db.get(IndividualCopy, copy_id)
    if c is None:
        raise NotFound("Copy not found")
    ctx.ensure_resource(c.location_id)
    loc = db.get(Location, c.location_id)
    events = db.execute(select(CopyEvent, User.full_name).outerjoin(User, User.id == CopyEvent.actor_id)
                        .where(CopyEvent.copy_id == c.id).order_by(CopyEvent.created_at))
    locs = {loc.id: loc.name for loc in db.scalars(select(Location))}
    return {
        "copy": _copy_out(c, loc.name, _cost_visible(ctx)),
        "events": [{"event_type": e.event_type, "from_location": locs.get(e.from_location_id),
                    "to_location": locs.get(e.to_location_id), "from_status": e.from_status, "to_status": e.to_status,
                    "condition": e.condition, "ref_type": e.ref_type, "ref_id": e.ref_id, "note": e.note,
                    "actor": name, "created_at": e.created_at} for e, name in events],
    }


class ConditionIn(BaseModel):
    condition: str = Field(pattern=r"^(NEW|GOOD|FAIR|POOR|DAMAGED)$")
    note: str | None = Field(default=None, max_length=300)


@router.post("/copies/{copy_id}/condition")
def set_condition(copy_id: uuid.UUID, body: ConditionIn, ctx: AuthContext = Depends(require("inventory.copies")),
                  db: Session = Depends(get_db)):
    c = inv.lock_copy(db, copy_id)
    ctx.ensure_resource(c.location_id)
    if c.status not in ("AVAILABLE", "QUARANTINED", "DAMAGED"):
        raise Conflict(f"Cannot change condition of a copy that is {c.status.lower()}")
    if body.condition == "DAMAGED":
        raise ValidationFailed("Use a stock adjustment (DAMAGE) to move a copy to damaged stock")
    inv.move_copy(db, c, event="CONDITION", to_status=c.status, ref=inv.Ref("COPY", c.id, c.copy_code),
                  actor_id=ctx.user_id, condition=body.condition, note=body.note)
    audit(db, ctx, "inventory.copy_condition", entity_type="copy", entity_id=c.id, location_id=c.location_id,
          details=body.model_dump())
    db.commit()
    return {"message": "Condition updated"}


class LabelsIn(BaseModel):
    copy_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    book_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    location_id: uuid.UUID | None = None


@router.post("/labels")
def labels(body: LabelsIn, ctx: AuthContext = Depends(require_any("inventory.copies", "catalog.view")),
           db: Session = Depends(get_db)):
    """Label data (code, title, price) for printing barcode labels in the browser."""
    out = []
    if body.copy_ids:
        ctx.require("inventory.copies")
        for c in db.scalars(select(IndividualCopy).where(IndividualCopy.id.in_(body.copy_ids))):
            if ctx.can_access(c.location_id):
                out.append({"code": c.copy_code, "symbology": "CODE128", "title": c.book.title, "sku": c.book.sku,
                            "price": str(c.book.selling_price), "mrp": str(c.book.mrp)})
    if body.book_ids:
        prices = {}
        if body.location_id:
            ctx.ensure_location(body.location_id)
            prices = {b.book_id: b.price_override for b in db.scalars(select(InventoryBalance).where(
                InventoryBalance.location_id == body.location_id, InventoryBalance.book_id.in_(body.book_ids)))
                if b.price_override is not None}
        for b in db.scalars(select(Book).where(Book.id.in_(body.book_ids))).unique():
            sym = "EAN13" if b.barcode.isdigit() and len(b.barcode) == 13 else "CODE128"
            out.append({"code": b.barcode, "symbology": sym, "title": b.title, "sku": b.sku,
                        "price": str(prices.get(b.id, b.selling_price)), "mrp": str(b.mrp)})
    return out
