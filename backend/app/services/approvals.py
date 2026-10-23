"""Approval center. Domain modules register handlers that run when a request is approved/rejected."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, Forbidden, NotFound
from app.models import ApprovalRequest
from app.services.audit import audit
from app.services.notify import notify_permission, notify_users

APPROVER_PERMISSION = {
    "PURCHASE_ORDER": "purchasing.approve",
    "STOCK_ADJUSTMENT": "inventory.approve",
    "TRANSFER": "transfers.approve",
    "DISCOUNT": "pos.discount_override",
    "REFUND": "returns.approve",
    "EXPENSE": "expenses.approve",
    "VOID": "pos.void",
}

LINKS = {
    "PURCHASE_ORDER": "/purchasing/orders/{id}",
    "STOCK_ADJUSTMENT": "/inventory/adjustments",
    "TRANSFER": "/transfers/{id}",
    "DISCOUNT": "/approvals",
    "REFUND": "/returns/{id}",
    "EXPENSE": "/finance/expenses",
    "VOID": "/sales/{id}",
}

# type -> (on_approve, on_reject); each receives (db, ctx, request)
_handlers: dict[str, tuple[Callable | None, Callable | None]] = {}


def register(type_: str, on_approve: Callable | None, on_reject: Callable | None = None) -> None:
    _handlers[type_] = (on_approve, on_reject)


def create(db: Session, ctx, *, type_: str, location_id: uuid.UUID | None, title: str, entity_type: str | None = None,
           entity_id: uuid.UUID | None = None, amount: Decimal | None = None, payload: dict | None = None,
           reason: str | None = None) -> ApprovalRequest:
    req = ApprovalRequest(
        id=uuid.uuid4(), type=type_, status="PENDING", location_id=location_id, entity_type=entity_type,
        entity_id=entity_id, title=title, amount=amount, payload=payload or {}, reason=reason,
        requested_by=ctx.user_id,
    )
    db.add(req)
    db.flush()
    link = LINKS.get(type_, "/approvals").format(id=entity_id or req.id)
    notify_permission(
        db, APPROVER_PERMISSION[type_], location_id, kind="APPROVAL_REQUESTED", title=f"Approval needed: {title}",
        body=reason, link="/approvals", exclude=ctx.user_id,
    )
    audit(db, ctx, "approval.requested", entity_type="approval_request", entity_id=req.id, location_id=location_id,
          details={"type": type_, "title": title, "amount": amount, "link": link})
    return req


def pending_for(db: Session, entity_type: str, entity_id: uuid.UUID) -> ApprovalRequest | None:
    return db.scalar(
        select(ApprovalRequest).where(
            ApprovalRequest.entity_type == entity_type,
            ApprovalRequest.entity_id == entity_id,
            ApprovalRequest.status == "PENDING",
        )
    )


def decide(db: Session, ctx, request_id: uuid.UUID, approve: bool, note: str | None = None) -> ApprovalRequest:
    req = db.scalar(select(ApprovalRequest).where(ApprovalRequest.id == request_id).with_for_update(of=ApprovalRequest))
    if req is None:
        raise NotFound("Approval request not found")
    ctx.ensure_resource(req.location_id)
    perm = APPROVER_PERMISSION[req.type]
    if not ctx.has(perm):
        raise Forbidden(f"Missing permission: {perm}", code="permission_denied")
    if req.status != "PENDING":
        raise Conflict(f"Request is already {req.status.lower()}")
    if req.requested_by == ctx.user_id:
        raise Forbidden("You cannot approve or reject your own request", code="self_approval")
    req.status = "APPROVED" if approve else "REJECTED"
    req.decided_by = ctx.user_id
    req.decided_at = datetime.now(UTC)
    req.decision_note = note
    on_approve, on_reject = _handlers.get(req.type, (None, None))
    handler = on_approve if approve else on_reject
    if handler:
        handler(db, ctx, req)
    notify_users(
        db, [req.requested_by], kind="APPROVAL_DECIDED",
        title=f"{'Approved' if approve else 'Rejected'}: {req.title}", body=note,
        link=LINKS.get(req.type, "/approvals").format(id=req.entity_id or req.id), location_id=req.location_id,
    )
    audit(db, ctx, f"approval.{'approved' if approve else 'rejected'}", entity_type="approval_request",
          entity_id=req.id, location_id=req.location_id, details={"type": req.type, "note": note})
    return req


def cancel_pending(db: Session, entity_type: str, entity_id: uuid.UUID) -> None:
    req = pending_for(db, entity_type, entity_id)
    if req:
        req.status = "CANCELLED"
        req.decided_at = datetime.now(UTC)
