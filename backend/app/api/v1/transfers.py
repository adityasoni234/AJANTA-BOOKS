import uuid
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require
from app.core.db import get_db
from app.core.errors import Conflict
from app.models import Location, StockTransfer, User
from app.schemas.common import Page, PageParams, paginate
from app.services import approvals
from app.services import transfers as svc
from app.services.audit import audit

router = APIRouter(tags=["transfers"])


class TLineIn(BaseModel):
    book_id: uuid.UUID
    qty: int = Field(gt=0, le=100000)


class TransferIn(BaseModel):
    source_location_id: uuid.UUID
    dest_location_id: uuid.UUID
    notes: str | None = Field(default=None, max_length=1000)
    lines: list[TLineIn] = Field(min_length=1, max_length=500)
    submit: bool = False


class TransferOut(BaseModel):
    id: uuid.UUID
    number: str
    source_location_id: uuid.UUID
    source_location_name: str
    dest_location_id: uuid.UUID
    dest_location_name: str
    status: str
    notes: str | None
    created_by_name: str | None
    created_at: datetime
    requested_at: datetime | None
    approved_at: datetime | None
    dispatched_at: datetime | None
    completed_at: datetime | None
    rejection_reason: str | None
    total_units: int
    lines: list[dict]
    receipts: list[dict]
    approval_request_id: uuid.UUID | None = None
    can: dict = {}


def _out(db: Session, ctx: AuthContext, t: StockTransfer, detail: bool = True) -> TransferOut:
    locs = {loc.id: loc.name for loc in db.scalars(select(Location).where(Location.id.in_([t.source_location_id, t.dest_location_id])))}
    users = {}

    def uname(uid):
        if uid is None:
            return None
        if uid not in users:
            u = db.get(User, uid)
            users[uid] = u.full_name if u else None
        return users[uid]

    cost = ctx.has("reports.financial") or ctx.has("purchasing.view")
    lines = [{"id": ln.id, "book_id": ln.book_id, "title": ln.book.title, "sku": ln.book.sku, "isbn13": ln.book.isbn13,
              "tracking_mode": ln.book.tracking_mode, "qty_requested": ln.qty_requested,
              "qty_dispatched": ln.qty_dispatched, "qty_received": ln.qty_received, "qty_damaged": ln.qty_damaged,
              "qty_lost": ln.qty_lost, "qty_returned": ln.qty_returned, "qty_outstanding": ln.qty_outstanding,
              "unit_cost": ln.unit_cost if cost else None,
              "copies": svc.copies_for_line(db, ln) if detail else []} for ln in t.lines]
    pending = approvals.pending_for(db, "stock_transfer", t.id) if t.status == "REQUESTED" else None
    src_ok, dst_ok = ctx.can_access(t.source_location_id), ctx.can_access(t.dest_location_id)
    can = {
        "edit": t.status == "DRAFT" and ctx.has("transfers.create"),
        "submit": t.status == "DRAFT" and ctx.has("transfers.create"),
        "approve": t.status == "REQUESTED" and ctx.has("transfers.approve") and src_ok and (pending is None or pending.requested_by != ctx.user_id),
        "dispatch": t.status == "APPROVED" and ctx.has("transfers.dispatch") and src_ok,
        "receive": t.status in ("IN_TRANSIT", "PARTIALLY_RECEIVED") and ctx.has("transfers.receive") and dst_ok,
        "resolve": t.status in ("DISCREPANCY", "PARTIALLY_RECEIVED") and (ctx.has("transfers.approve") or ctx.has("inventory.approve")),
        "cancel": t.status in ("DRAFT", "REQUESTED", "APPROVED") and ctx.has("transfers.create"),
    }
    return TransferOut(
        id=t.id, number=t.number, source_location_id=t.source_location_id,
        source_location_name=locs.get(t.source_location_id, ""), dest_location_id=t.dest_location_id,
        dest_location_name=locs.get(t.dest_location_id, ""), status=t.status, notes=t.notes,
        created_by_name=uname(t.created_by), created_at=t.created_at, requested_at=t.requested_at,
        approved_at=t.approved_at, dispatched_at=t.dispatched_at, completed_at=t.completed_at,
        rejection_reason=t.rejection_reason, total_units=sum(ln.qty_requested for ln in t.lines), lines=lines,
        receipts=[{"id": r.id, "kind": r.kind, "received_by": uname(r.received_by), "received_at": r.received_at,
                   "notes": r.notes, "details": r.details} for r in t.receipts] if detail else [],
        approval_request_id=pending.id if pending else None, can=can,
    )


@router.get("/transfers", response_model=Page[TransferOut])
def list_transfers(status: str | None = None, location_id: uuid.UUID | None = None,
                   direction: str | None = Query(None, pattern=r"^(IN|OUT)$"), q: str | None = Query(None, max_length=40),
                   params: PageParams = Depends(), ctx: AuthContext = Depends(require("transfers.view")),
                   db: Session = Depends(get_db)):
    stmt = (select(StockTransfer)
            .where(or_(ctx.loc_filter(StockTransfer.source_location_id), ctx.loc_filter(StockTransfer.dest_location_id)))
            .order_by(StockTransfer.created_at.desc()))
    if status:
        stmt = stmt.where(StockTransfer.status.in_(status.split(",")))
    if location_id:
        ctx.ensure_location(location_id)
        if direction == "IN":
            stmt = stmt.where(StockTransfer.dest_location_id == location_id)
        elif direction == "OUT":
            stmt = stmt.where(StockTransfer.source_location_id == location_id)
        else:
            stmt = stmt.where(or_(StockTransfer.source_location_id == location_id, StockTransfer.dest_location_id == location_id))
    if q:
        stmt = stmt.where(StockTransfer.number.ilike(f"%{q}%"))
    rows, total = paginate(db, stmt, params)
    return Page(items=[_out(db, ctx, t, detail=False) for t in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/transfers", response_model=TransferOut, status_code=201)
def create_transfer(body: TransferIn, ctx: AuthContext = Depends(require("transfers.create")), db: Session = Depends(get_db)):
    t = svc.create(db, ctx, source_id=body.source_location_id, dest_id=body.dest_location_id,
                   lines=[ln.model_dump() for ln in body.lines], notes=body.notes)
    audit(db, ctx, "transfers.created", entity_type="stock_transfer", entity_id=t.id, location_id=t.dest_location_id,
          details={"number": t.number})
    if body.submit:
        svc.request(db, ctx, t)
    db.commit()
    db.refresh(t)
    return _out(db, ctx, t)


@router.get("/transfers/{transfer_id}", response_model=TransferOut)
def get_transfer(transfer_id: uuid.UUID, ctx: AuthContext = Depends(require("transfers.view")), db: Session = Depends(get_db)):
    t = db.get(StockTransfer, transfer_id)
    if t is None:
        from app.core.errors import NotFound

        raise NotFound("Transfer not found")
    ctx.ensure_resource(t.source_location_id, t.dest_location_id)
    return _out(db, ctx, t)


@router.put("/transfers/{transfer_id}", response_model=TransferOut)
def update_transfer(transfer_id: uuid.UUID, body: TransferIn, ctx: AuthContext = Depends(require("transfers.create")),
                    db: Session = Depends(get_db)):
    t = svc.lock_transfer(db, ctx, transfer_id)
    if t.status != "DRAFT":
        raise Conflict("Only draft transfers can be edited")
    svc.set_lines(db, t, [ln.model_dump() for ln in body.lines])
    t.notes = body.notes
    if body.submit:
        svc.request(db, ctx, t)
    db.commit()
    db.refresh(t)
    return _out(db, ctx, t)


@router.post("/transfers/{transfer_id}/submit", response_model=TransferOut)
def submit_transfer(transfer_id: uuid.UUID, ctx: AuthContext = Depends(require("transfers.create")), db: Session = Depends(get_db)):
    t = svc.lock_transfer(db, ctx, transfer_id)
    svc.request(db, ctx, t)
    audit(db, ctx, "transfers.requested", entity_type="stock_transfer", entity_id=t.id, location_id=t.source_location_id)
    db.commit()
    return _out(db, ctx, t)


class DecisionIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=500)


@router.post("/transfers/{transfer_id}/decision", response_model=TransferOut)
def decide_transfer(transfer_id: uuid.UUID, body: DecisionIn, ctx: AuthContext = Depends(require("transfers.approve")),
                    db: Session = Depends(get_db)):
    t = svc.lock_transfer(db, ctx, transfer_id)
    ctx.ensure_location(t.source_location_id)
    req = approvals.pending_for(db, "stock_transfer", t.id)
    if req is None:
        raise Conflict("No pending approval for this transfer")
    approvals.decide(db, ctx, req.id, body.approve, body.note)
    db.commit()
    return _out(db, ctx, t)


class DispatchLine(BaseModel):
    line_id: uuid.UUID
    qty: int = Field(ge=0, le=100000)
    copy_ids: list[uuid.UUID] | None = None


class DispatchIn(BaseModel):
    lines: list[DispatchLine] = []


@router.post("/transfers/{transfer_id}/dispatch", response_model=TransferOut)
def dispatch_transfer(transfer_id: uuid.UUID, body: DispatchIn, ctx: AuthContext = Depends(require("transfers.dispatch")),
                      db: Session = Depends(get_db)):
    t = svc.lock_transfer(db, ctx, transfer_id)
    svc.dispatch(db, ctx, t, [ln.model_dump() for ln in body.lines])
    audit(db, ctx, "transfers.dispatched", entity_type="stock_transfer", entity_id=t.id, location_id=t.source_location_id,
          details={"units": sum(ln.qty_dispatched for ln in t.lines)})
    db.commit()
    return _out(db, ctx, t)


class ReceiveLine(BaseModel):
    line_id: uuid.UUID
    qty_received: int = Field(default=0, ge=0, le=100000)
    qty_damaged: int = Field(default=0, ge=0, le=100000)
    copy_ids_received: list[uuid.UUID] | None = None
    copy_ids_damaged: list[uuid.UUID] | None = None


class ReceiveIn(BaseModel):
    lines: list[ReceiveLine] = Field(min_length=1)
    final: bool = False
    notes: str | None = Field(default=None, max_length=1000)


@router.post("/transfers/{transfer_id}/receive", response_model=TransferOut)
def receive_transfer(transfer_id: uuid.UUID, body: ReceiveIn,
                     idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
                     ctx: AuthContext = Depends(require("transfers.receive")), db: Session = Depends(get_db)):
    t = svc.lock_transfer(db, ctx, transfer_id)
    _, created = svc.receive(db, ctx, t, idempotency_key=idempotency_key, lines=[ln.model_dump() for ln in body.lines],
                             final=body.final, notes=body.notes)
    if created:
        audit(db, ctx, "transfers.received", entity_type="stock_transfer", entity_id=t.id, location_id=t.dest_location_id,
              details={"status": t.status})
    db.commit()
    return _out(db, ctx, t)


class ResolveLine(BaseModel):
    line_id: uuid.UUID
    action: str = Field(pattern=r"^(LOST|RETURN)$")


class ResolveIn(BaseModel):
    lines: list[ResolveLine] = Field(min_length=1)
    notes: str | None = Field(default=None, max_length=1000)


@router.post("/transfers/{transfer_id}/resolve", response_model=TransferOut)
def resolve_transfer(transfer_id: uuid.UUID, body: ResolveIn,
                     idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
                     ctx: AuthContext = Depends(require("transfers.view")), db: Session = Depends(get_db)):
    t = svc.lock_transfer(db, ctx, transfer_id)
    svc.resolve(db, ctx, t, idempotency_key=idempotency_key, lines=[ln.model_dump(mode="json") for ln in body.lines],
                notes=body.notes)
    db.commit()
    return _out(db, ctx, t)


class CancelIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/transfers/{transfer_id}/cancel", response_model=TransferOut)
def cancel_transfer(transfer_id: uuid.UUID, body: CancelIn, ctx: AuthContext = Depends(require("transfers.create")),
                    db: Session = Depends(get_db)):
    t = svc.lock_transfer(db, ctx, transfer_id)
    svc.cancel(db, ctx, t, body.reason)
    audit(db, ctx, "transfers.cancelled", entity_type="stock_transfer", entity_id=t.id, location_id=t.source_location_id,
          details={"reason": body.reason})
    db.commit()
    return _out(db, ctx, t)


__all__ = ["router", "Decimal"]
