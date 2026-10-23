"""Stock transfer workflow.

DRAFT -> REQUESTED -> APPROVED (stock reserved at source) -> IN_TRANSIT (source on_hand out,
destination in_transit in) -> PARTIALLY_RECEIVED -> COMPLETED, or DISCREPANCY -> (resolve) -> COMPLETED.
Every transition locks the transfer row, so double dispatch / double receipt is impossible.
Receipts carry an idempotency key so retried requests are no-ops.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.core.money import ZERO, r2
from app.models import (
    Book,
    IndividualCopy,
    Location,
    StockTransfer,
    StockTransferLine,
    TransferLineCopy,
    TransferReceipt,
)
from app.services import accounting, approvals
from app.services import inventory as inv
from app.services.accounting import Leg
from app.services.audit import audit
from app.services.inventory import Ref
from app.services.notify import notify_permission
from app.services.numbering import next_number
from app.services.settings import get_policy


def lock_transfer(db: Session, ctx, transfer_id: uuid.UUID) -> StockTransfer:
    t = db.scalar(select(StockTransfer).where(StockTransfer.id == transfer_id).with_for_update(of=StockTransfer)
                  .execution_options(populate_existing=True))
    if t is None:
        raise NotFound("Transfer not found")
    ctx.ensure_resource(t.source_location_id, t.dest_location_id)
    return t


def _ref(t: StockTransfer) -> Ref:
    return Ref("TRANSFER", t.id, t.number)


def create(db: Session, ctx, *, source_id, dest_id, lines: list[dict], notes: str | None) -> StockTransfer:
    if source_id == dest_id:
        raise ValidationFailed("Source and destination must differ")
    if not (ctx.can_access(source_id) or ctx.can_access(dest_id)):
        raise Forbidden("You must belong to the source or destination location", code="location_denied")
    for lid in (source_id, dest_id):
        loc = db.get(Location, lid)
        if loc is None or not loc.is_active:
            raise ValidationFailed("Location not found or inactive")
    t = StockTransfer(id=uuid.uuid4(), number=next_number(db, "TRF"), source_location_id=source_id,
                      dest_location_id=dest_id, notes=notes, created_by=ctx.user_id)
    db.add(t)
    db.flush()
    set_lines(db, t, lines)
    return t


def set_lines(db: Session, t: StockTransfer, lines: list[dict]) -> None:
    if not lines:
        raise ValidationFailed("At least one line is required")
    seen = set()
    t.lines.clear()
    db.flush()
    for i, ln in enumerate(lines, start=1):
        book = db.get(Book, ln["book_id"])
        if book is None:
            raise ValidationFailed("Book not found")
        if book.id in seen:
            raise ValidationFailed(f"'{book.title}' appears more than once")
        seen.add(book.id)
        t.lines.append(StockTransferLine(line_no=i, book_id=book.id, qty_requested=int(ln["qty"])))


def request(db: Session, ctx, t: StockTransfer) -> None:
    if t.status != "DRAFT":
        raise Conflict("Only draft transfers can be submitted")
    t.status = "REQUESTED"
    t.requested_at = datetime.now(UTC)
    needs = get_policy(db).transfer_requires_approval
    if needs and not (ctx.has("transfers.approve") and ctx.can_access(t.source_location_id)):
        approvals.create(db, ctx, type_="TRANSFER", location_id=t.source_location_id,
                         title=f"Transfer {t.number}: {_loc_name(db, t.source_location_id)} → {_loc_name(db, t.dest_location_id)}",
                         entity_type="stock_transfer", entity_id=t.id,
                         payload={"lines": len(t.lines), "units": sum(ln.qty_requested for ln in t.lines)})
    else:
        approve(db, ctx, t)


def _loc_name(db: Session, lid) -> str:
    loc = db.get(Location, lid)
    return loc.name if loc else str(lid)


def approve(db: Session, ctx, t: StockTransfer) -> None:
    """Reserve requested quantities at the source so they cannot be sold before dispatch."""
    if t.status != "REQUESTED":
        raise Conflict("Transfer is not awaiting approval")
    balances = inv.lock_balances(db, [(t.source_location_id, ln.book_id) for ln in t.lines])
    for ln in t.lines:
        bal = balances[(t.source_location_id, ln.book_id)]
        if bal.on_hand - bal.reserved < ln.qty_requested:
            raise Conflict(f"Insufficient available stock at source for '{ln.book.title}': "
                           f"available {bal.on_hand - bal.reserved}, requested {ln.qty_requested}",
                           code="insufficient_stock")
        inv.apply(db, bal, bucket="RESERVED", delta=ln.qty_requested, movement_type="TRANSFER_RESERVE", ref=_ref(t),
                  actor_id=ctx.user_id)
    t.status = "APPROVED"
    t.approved_by, t.approved_at = ctx.user_id, datetime.now(UTC)
    notify_permission(db, "transfers.dispatch", t.source_location_id, kind="TRANSFER_APPROVED",
                      title=f"Transfer {t.number} approved — ready to dispatch", link=f"/transfers/{t.id}")


def _release_reservation(db: Session, ctx, t: StockTransfer) -> None:
    balances = inv.lock_balances(db, [(t.source_location_id, ln.book_id) for ln in t.lines])
    for ln in t.lines:
        inv.apply(db, balances[(t.source_location_id, ln.book_id)], bucket="RESERVED", delta=-ln.qty_requested,
                  movement_type="TRANSFER_UNRESERVE", ref=_ref(t), actor_id=ctx.user_id)


def _approve_handler(db: Session, ctx, req) -> None:
    t = lock_transfer(db, ctx, req.entity_id)
    approve(db, ctx, t)


def _reject_handler(db: Session, ctx, req) -> None:
    t = db.get(StockTransfer, req.entity_id)
    if t and t.status == "REQUESTED":
        t.status = "REJECTED"
        t.rejection_reason = req.decision_note


approvals.register("TRANSFER", _approve_handler, _reject_handler)


def cancel(db: Session, ctx, t: StockTransfer, reason: str) -> None:
    if t.status not in ("DRAFT", "REQUESTED", "APPROVED"):
        raise Conflict("Only transfers that have not been dispatched can be cancelled")
    if t.status == "APPROVED":
        _release_reservation(db, ctx, t)
    approvals.cancel_pending(db, "stock_transfer", t.id)
    t.status = "CANCELLED"
    t.rejection_reason = reason


def dispatch(db: Session, ctx, t: StockTransfer, lines: list[dict]) -> None:
    if not ctx.can_access(t.source_location_id):
        raise Forbidden("Only the source location can dispatch", code="location_denied")
    if t.status != "APPROVED":
        raise Conflict("Transfer must be approved (and not yet dispatched) to dispatch")
    by_line = {str(ln["line_id"]): ln for ln in lines} if lines else {}
    ref = _ref(t)
    pairs = [(t.source_location_id, ln.book_id) for ln in t.lines] + [(t.dest_location_id, ln.book_id) for ln in t.lines]
    balances = inv.lock_balances(db, pairs)
    value = ZERO
    for ln in t.lines:
        spec = by_line.get(str(ln.id), {})
        qty = int(spec.get("qty", ln.qty_requested))
        if qty < 0 or qty > ln.qty_requested:
            raise ValidationFailed(f"Dispatch quantity for '{ln.book.title}' must be between 0 and {ln.qty_requested}")
        src = balances[(t.source_location_id, ln.book_id)]
        dst = balances[(t.dest_location_id, ln.book_id)]
        inv.apply(db, src, bucket="RESERVED", delta=-ln.qty_requested, movement_type="TRANSFER_UNRESERVE", ref=ref,
                  actor_id=ctx.user_id)
        ln.qty_dispatched = qty
        ln.unit_cost = src.avg_cost
        if qty == 0:
            continue
        if ln.book.tracking_mode == "COPY":
            copies = inv.pick_copies(db, book_id=ln.book_id, location_id=t.source_location_id, qty=qty,
                                     copy_ids=[uuid.UUID(str(c)) for c in spec.get("copy_ids") or []] or None)
            for c in copies:
                inv.apply(db, src, bucket="ON_HAND", delta=-1, movement_type="TRANSFER_OUT", ref=ref, actor_id=ctx.user_id,
                          unit_cost=src.avg_cost, copy_id=c.id, check_available=True)
                inv.apply(db, dst, bucket="IN_TRANSIT", delta=1, movement_type="TRANSFER_IN_TRANSIT", ref=ref,
                          actor_id=ctx.user_id, unit_cost=src.avg_cost, copy_id=c.id)
                inv.move_copy(db, c, event="TRANSFER_DISPATCHED", to_status="IN_TRANSIT", ref=ref, actor_id=ctx.user_id,
                              to_location_id=t.dest_location_id)
                ln.copies.append(TransferLineCopy(copy_id=c.id, state="DISPATCHED"))
        else:
            inv.apply(db, src, bucket="ON_HAND", delta=-qty, movement_type="TRANSFER_OUT", ref=ref, actor_id=ctx.user_id,
                      unit_cost=src.avg_cost, check_available=True)
            inv.apply(db, dst, bucket="IN_TRANSIT", delta=qty, movement_type="TRANSFER_IN_TRANSIT", ref=ref,
                      actor_id=ctx.user_id, unit_cost=src.avg_cost)
        value += r2(Decimal(qty) * (src.avg_cost or ZERO))
        inv.low_stock_check(db, src, ln.book)
    if sum(ln.qty_dispatched for ln in t.lines) == 0:
        raise ValidationFailed("Nothing to dispatch")
    t.status = "IN_TRANSIT"
    t.dispatched_by, t.dispatched_at = ctx.user_id, datetime.now(UTC)
    accounting.post(db, source_type="TRANSFER_DISPATCH", source_id=t.id, actor_id=ctx.user_id,
                    memo=f"Transfer {t.number} dispatched",
                    legs=[Leg("INVENTORY", value, location_id=t.dest_location_id),
                          Leg("INVENTORY", -value, location_id=t.source_location_id)])
    notify_permission(db, "transfers.receive", t.dest_location_id, kind="TRANSFER_DISPATCHED",
                      title=f"Transfer {t.number} is on its way", link=f"/transfers/{t.id}")


def receive(db: Session, ctx, t: StockTransfer, *, idempotency_key: str, lines: list[dict], final: bool,
            notes: str | None) -> tuple[TransferReceipt, bool]:
    existing = db.scalar(select(TransferReceipt).where(TransferReceipt.idempotency_key == idempotency_key))
    if existing:
        if existing.transfer_id != t.id:
            raise Conflict("Idempotency key already used for another transfer")
        return existing, False
    if not ctx.can_access(t.dest_location_id):
        raise Forbidden("Only the destination location can receive", code="location_denied")
    if t.status not in ("IN_TRANSIT", "PARTIALLY_RECEIVED"):
        raise Conflict("Transfer is not awaiting receipt")
    rec = TransferReceipt(id=uuid.uuid4(), transfer_id=t.id, idempotency_key=idempotency_key, kind="RECEIPT",
                          received_by=ctx.user_id, notes=notes, details={"lines": []})
    db.add(rec)
    db.flush()
    ref = Ref("TRANSFER", t.id, t.number)
    balances = inv.lock_balances(db, [(t.dest_location_id, ln.book_id) for ln in t.lines])
    by_line = {str(x["line_id"]): x for x in lines}
    details = []
    for ln in t.lines:
        spec = by_line.get(str(ln.id))
        if not spec:
            continue
        good, bad = int(spec.get("qty_received") or 0), int(spec.get("qty_damaged") or 0)
        if good < 0 or bad < 0:
            raise ValidationFailed("Quantities cannot be negative")
        if good + bad == 0:
            continue
        if good + bad > ln.qty_outstanding:
            raise Conflict(f"'{ln.book.title}': receiving {good + bad} but only {ln.qty_outstanding} outstanding")
        bal = balances[(t.dest_location_id, ln.book_id)]
        inv.receive_cost(bal, good + bad, ln.unit_cost)
        if ln.book.tracking_mode == "COPY":
            pending = [lc for lc in ln.copies if lc.state == "DISPATCHED"]
            want_good = [uuid.UUID(str(c)) for c in spec.get("copy_ids_received") or []]
            want_bad = [uuid.UUID(str(c)) for c in spec.get("copy_ids_damaged") or []]
            pend_ids = {lc.copy_id for lc in pending}
            if want_good or want_bad:
                if len(want_good) != good or len(want_bad) != bad or not set(want_good + want_bad) <= pend_ids \
                        or len(set(want_good + want_bad)) != good + bad:
                    raise ValidationFailed(f"'{ln.book.title}': scanned copies do not match the dispatched copies")
            else:
                ordered = sorted(pending, key=lambda lc: str(lc.copy_id))
                want_good = [lc.copy_id for lc in ordered[:good]]
                want_bad = [lc.copy_id for lc in ordered[good:good + bad]]
            state_by = {cid: "RECEIVED" for cid in want_good} | {cid: "DAMAGED" for cid in want_bad}
            for lc in pending:
                if lc.copy_id in state_by:
                    c = inv.lock_copy(db, lc.copy_id)
                    target = "ON_HAND" if state_by[lc.copy_id] == "RECEIVED" else "DAMAGED"
                    inv.apply(db, bal, bucket="IN_TRANSIT", delta=-1, movement_type="TRANSFER_IN", ref=ref,
                              actor_id=ctx.user_id, unit_cost=ln.unit_cost, copy_id=c.id)
                    inv.apply(db, bal, bucket=target, delta=1, movement_type="TRANSFER_IN", ref=ref,
                              actor_id=ctx.user_id, unit_cost=ln.unit_cost, copy_id=c.id)
                    inv.move_copy(db, c, event="TRANSFER_RECEIVED",
                                  to_status="AVAILABLE" if target == "ON_HAND" else "DAMAGED", ref=ref,
                                  actor_id=ctx.user_id, condition="DAMAGED" if target == "DAMAGED" else None)
                    lc.state = state_by[lc.copy_id]
        else:
            inv.apply(db, bal, bucket="IN_TRANSIT", delta=-(good + bad), movement_type="TRANSFER_IN", ref=ref,
                      actor_id=ctx.user_id, unit_cost=ln.unit_cost)
            if good:
                inv.apply(db, bal, bucket="ON_HAND", delta=good, movement_type="TRANSFER_IN", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost)
            if bad:
                inv.apply(db, bal, bucket="DAMAGED", delta=bad, movement_type="TRANSFER_IN_DAMAGED", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost, note="Damaged in transit")
        ln.qty_received += good
        ln.qty_damaged += bad
        details.append({"line_id": str(ln.id), "book_id": str(ln.book_id), "received": good, "damaged": bad})
    if not details:
        raise ValidationFailed("Nothing received")
    rec.details = {"lines": details}
    outstanding = sum(ln.qty_outstanding for ln in t.lines)
    if outstanding == 0:
        t.status = "COMPLETED"
        t.completed_at = datetime.now(UTC)
    elif final:
        t.status = "DISCREPANCY"
        notify_permission(db, "transfers.approve", t.source_location_id, kind="TRANSFER_DISCREPANCY",
                          title=f"Transfer {t.number} has {outstanding} unit(s) missing", link=f"/transfers/{t.id}")
    else:
        t.status = "PARTIALLY_RECEIVED"
    return rec, True


def resolve(db: Session, ctx, t: StockTransfer, *, idempotency_key: str, lines: list[dict], notes: str | None) -> None:
    """Resolve outstanding (missing) units as LOST (written off) or RETURNED to the source."""
    existing = db.scalar(select(TransferReceipt).where(TransferReceipt.idempotency_key == idempotency_key))
    if existing:
        return
    if t.status not in ("DISCREPANCY", "PARTIALLY_RECEIVED", "IN_TRANSIT"):
        raise Conflict("Transfer has no outstanding quantities to resolve")
    if not (ctx.has("transfers.approve") or ctx.has("inventory.approve")):
        raise Forbidden("Resolving discrepancies requires transfer or inventory approval permission")
    db.add(TransferReceipt(transfer_id=t.id, idempotency_key=idempotency_key, kind="RESOLUTION", received_by=ctx.user_id,
                           notes=notes, details={"lines": lines}))
    ref = Ref("TRANSFER", t.id, t.number)
    pairs = [(t.dest_location_id, ln.book_id) for ln in t.lines] + [(t.source_location_id, ln.book_id) for ln in t.lines]
    balances = inv.lock_balances(db, pairs)
    by_line = {str(x["line_id"]): x for x in lines}
    lost_value, returned_value = ZERO, ZERO
    for ln in t.lines:
        spec = by_line.get(str(ln.id))
        if not spec or ln.qty_outstanding == 0:
            continue
        action = spec.get("action")
        qty = ln.qty_outstanding
        dst = balances[(t.dest_location_id, ln.book_id)]
        src = balances[(t.source_location_id, ln.book_id)]
        copies = [lc for lc in ln.copies if lc.state == "DISPATCHED"]
        if action == "LOST":
            for lc in copies or [None] * 0:
                c = inv.lock_copy(db, lc.copy_id)
                inv.apply(db, dst, bucket="IN_TRANSIT", delta=-1, movement_type="TRANSFER_LOSS", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost, copy_id=c.id)
                inv.move_copy(db, c, event="TRANSFER_LOST", to_status="LOST", ref=ref, actor_id=ctx.user_id)
                lc.state = "LOST"
            if not copies:
                inv.apply(db, dst, bucket="IN_TRANSIT", delta=-qty, movement_type="TRANSFER_LOSS", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost)
            ln.qty_lost += qty
            lost_value += r2(Decimal(qty) * (ln.unit_cost or ZERO))
        elif action == "RETURN":
            inv.receive_cost(src, qty, ln.unit_cost)
            for lc in copies:
                c = inv.lock_copy(db, lc.copy_id)
                inv.apply(db, dst, bucket="IN_TRANSIT", delta=-1, movement_type="TRANSFER_RETURN", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost, copy_id=c.id)
                inv.apply(db, src, bucket="ON_HAND", delta=1, movement_type="TRANSFER_RETURN", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost, copy_id=c.id)
                inv.move_copy(db, c, event="TRANSFER_RETURNED", to_status="AVAILABLE", ref=ref, actor_id=ctx.user_id,
                              to_location_id=t.source_location_id)
                lc.state = "RETURNED"
            if not copies:
                inv.apply(db, dst, bucket="IN_TRANSIT", delta=-qty, movement_type="TRANSFER_RETURN", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost)
                inv.apply(db, src, bucket="ON_HAND", delta=qty, movement_type="TRANSFER_RETURN", ref=ref,
                          actor_id=ctx.user_id, unit_cost=ln.unit_cost)
            ln.qty_returned += qty
            returned_value += r2(Decimal(qty) * (ln.unit_cost or ZERO))
        else:
            raise ValidationFailed("Action must be LOST or RETURN")
    if any(ln.qty_outstanding for ln in t.lines):
        raise ValidationFailed("Resolve every outstanding line")
    t.status = "COMPLETED"
    t.completed_at = datetime.now(UTC)
    legs = []
    if lost_value:
        legs += [Leg("INVENTORY_ADJ", lost_value, location_id=t.dest_location_id),
                 Leg("INVENTORY", -lost_value, location_id=t.dest_location_id)]
    if returned_value:
        legs += [Leg("INVENTORY", returned_value, location_id=t.source_location_id),
                 Leg("INVENTORY", -returned_value, location_id=t.dest_location_id)]
    accounting.post(db, source_type="TRANSFER_RESOLUTION", source_id=t.id, actor_id=ctx.user_id,
                    memo=f"Transfer {t.number} discrepancy resolved", legs=legs)
    audit(db, ctx, "transfers.resolved", entity_type="stock_transfer", entity_id=t.id, location_id=t.dest_location_id,
          details={"lost_value": lost_value, "returned_value": returned_value})


def copies_for_line(db: Session, ln: StockTransferLine) -> list[dict]:
    if not ln.copies:
        return []
    codes = {c.id: c.copy_code for c in db.scalars(select(IndividualCopy).where(
        IndividualCopy.id.in_([lc.copy_id for lc in ln.copies])))}
    return [{"copy_id": lc.copy_id, "copy_code": codes.get(lc.copy_id), "state": lc.state} for lc in ln.copies]
