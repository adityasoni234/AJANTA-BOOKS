import uuid
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, current_user, require
from app.core.db import get_db
from app.models import ApprovalRequest, Location, Notification, User
from app.schemas.common import Page, PageParams, paginate
from app.services import approvals

# Ensure every domain module has registered its approval handlers.
from app.services import finance as _fin  # noqa: F401
from app.services import inventory as _inv  # noqa: F401
from app.services import purchasing as _pur  # noqa: F401
from app.services import returns as _ret  # noqa: F401
from app.services import sales as _sales  # noqa: F401
from app.services import transfers as _trf  # noqa: F401

router = APIRouter(tags=["approvals"])


class ApprovalOut(BaseModel):
    id: uuid.UUID
    type: str
    status: str
    title: str
    location_id: uuid.UUID | None
    location_name: str | None
    entity_type: str | None
    entity_id: uuid.UUID | None
    amount: Decimal | None
    reason: str | None
    payload: dict
    requested_by: str | None
    requested_by_id: uuid.UUID
    requested_at: datetime
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    can_decide: bool


@router.get("/approvals", response_model=Page[ApprovalOut])
def list_approvals(status: str | None = "PENDING", type: str | None = None, params: PageParams = Depends(),
                   ctx: AuthContext = Depends(require("approvals.view")), db: Session = Depends(get_db)):
    stmt = select(ApprovalRequest).order_by(ApprovalRequest.requested_at.desc())
    if not ctx.all_locations:
        stmt = stmt.where(or_(ApprovalRequest.location_id.in_(ctx.location_ids), ApprovalRequest.requested_by == ctx.user_id))
    if status:
        stmt = stmt.where(ApprovalRequest.status == status)
    if type:
        stmt = stmt.where(ApprovalRequest.type == type)
    rows, total = paginate(db, stmt, params)
    users = {u.id: u.full_name for u in db.scalars(select(User).where(
        User.id.in_({r.requested_by for r in rows} | {r.decided_by for r in rows if r.decided_by})))} if rows else {}
    locs = {loc.id: loc.name for loc in db.scalars(select(Location))}
    items = [ApprovalOut(
        id=r.id, type=r.type, status=r.status, title=r.title, location_id=r.location_id,
        location_name=locs.get(r.location_id), entity_type=r.entity_type, entity_id=r.entity_id, amount=r.amount,
        reason=r.reason, payload=r.payload, requested_by=users.get(r.requested_by), requested_by_id=r.requested_by,
        requested_at=r.requested_at, decided_by=users.get(r.decided_by), decided_at=r.decided_at,
        decision_note=r.decision_note,
        can_decide=(r.status == "PENDING" and ctx.has(approvals.APPROVER_PERMISSION[r.type])
                    and r.requested_by != ctx.user_id and ctx.can_access(r.location_id)))
        for r in rows]
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


class DecideIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=500)


@router.post("/approvals/{request_id}/decision")
def decide(request_id: uuid.UUID, body: DecideIn, ctx: AuthContext = Depends(require("approvals.view")),
           db: Session = Depends(get_db)):
    req = approvals.decide(db, ctx, request_id, body.approve, body.note)
    db.commit()
    return {"id": req.id, "status": req.status}


# ---------------------------------------------------------------- notifications


class NotificationOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    body: str | None
    link: str | None
    created_at: datetime
    read_at: datetime | None


@router.get("/notifications")
def notifications(unread_only: bool = False, params: PageParams = Depends(), ctx: AuthContext = Depends(current_user),
                  db: Session = Depends(get_db)):
    stmt = select(Notification).where(Notification.user_id == ctx.user_id).order_by(Notification.created_at.desc())
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    rows, total = paginate(db, stmt, params)
    unread = db.scalar(select(func.count()).select_from(Notification).where(
        Notification.user_id == ctx.user_id, Notification.read_at.is_(None)))
    return {"items": [NotificationOut.model_validate(n, from_attributes=True) for n in rows], "total": total,
            "unread": unread, "page": params.page, "page_size": params.page_size}


@router.post("/notifications/read")
def mark_read(ids: list[uuid.UUID] | None = None, ctx: AuthContext = Depends(current_user), db: Session = Depends(get_db)):
    q = update(Notification).where(Notification.user_id == ctx.user_id, Notification.read_at.is_(None))
    if ids:
        q = q.where(Notification.id.in_(ids))
    db.execute(q.values(read_at=datetime.now(UTC)))
    db.commit()
    return {"message": "ok"}
