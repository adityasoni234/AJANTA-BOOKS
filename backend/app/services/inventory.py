"""Inventory core.

All stock changes go through `apply()`, which writes an append-only ledger row and updates the
balance row in the same transaction. Balance rows are locked (SELECT ... FOR UPDATE) in a
deterministic order before mutation, which serialises concurrent sales/receipts of the same item
and prevents overselling. The DB check constraint `on_hand >= 0` is the last line of defence.

Valuation: weighted-average cost per (location, book). Receipts recompute the average; issues
(sales, transfers out, write-offs) are costed at the current average.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.money import ZERO, r2, r4
from app.models import (
    Book,
    CopyEvent,
    IndividualCopy,
    InventoryBalance,
    InventoryLedger,
    Location,
    StockAdjustment,
    StockAdjustmentLine,
    Stocktake,
)
from app.services import accounting, approvals
from app.services.accounting import Leg
from app.services.audit import audit
from app.services.notify import notify_permission
from app.services.numbering import next_code, next_number
from app.services.settings import get_policy

BUCKET_FIELD = {
    "ON_HAND": "on_hand",
    "DAMAGED": "damaged",
    "QUARANTINED": "quarantined",
    "IN_TRANSIT": "in_transit",
    "RESERVED": "reserved",
}
# Buckets that represent physical stock held at the location (valued in inventory).
VALUED_BUCKETS = ("ON_HAND", "DAMAGED", "QUARANTINED")
COPY_STATUS_FOR_BUCKET = {"ON_HAND": "AVAILABLE", "DAMAGED": "DAMAGED", "QUARANTINED": "QUARANTINED"}


@dataclass
class Ref:
    type: str
    id: uuid.UUID | None = None
    number: str | None = None


def lock_balances(db: Session, pairs: list[tuple[uuid.UUID, uuid.UUID]]) -> dict[tuple, InventoryBalance]:
    """Create (if missing) and lock balance rows in sorted order to avoid deadlocks."""
    uniq = sorted(set(pairs), key=lambda p: (str(p[0]), str(p[1])))
    if not uniq:
        return {}
    db.execute(
        insert(InventoryBalance)
        .values([{"id": uuid.uuid4(), "location_id": loc, "book_id": book} for loc, book in uniq])
        .on_conflict_do_nothing(index_elements=["location_id", "book_id"])
    )
    out: dict[tuple, InventoryBalance] = {}
    for loc, book in uniq:
        bal = db.scalars(
            select(InventoryBalance)
            .where(InventoryBalance.location_id == loc, InventoryBalance.book_id == book)
            .with_for_update(of=InventoryBalance)
            .execution_options(populate_existing=True)
        ).one()
        out[(loc, book)] = bal
    return out


def lock_balance(db: Session, location_id: uuid.UUID, book_id: uuid.UUID) -> InventoryBalance:
    return lock_balances(db, [(location_id, book_id)])[(location_id, book_id)]


def _book_title(db: Session, book_id) -> str:
    b = db.get(Book, book_id)
    return b.title if b else str(book_id)


def apply(db: Session, bal: InventoryBalance, *, bucket: str, delta: int, movement_type: str, ref: Ref,
          actor_id: uuid.UUID | None, unit_cost: Decimal | None = None, copy_id: uuid.UUID | None = None,
          note: str | None = None, check_available: bool = False) -> None:
    """Mutate one bucket of a locked balance and append the ledger row."""
    if delta == 0:
        return
    field = BUCKET_FIELD[bucket]
    current = getattr(bal, field)
    new = current + delta
    if new < 0:
        raise Conflict(
            f"Insufficient {bucket.lower().replace('_', ' ')} stock for '{_book_title(db, bal.book_id)}': "
            f"have {current}, need {-delta}",
            code="insufficient_stock",
            details={"book_id": str(bal.book_id), "location_id": str(bal.location_id), "have": current},
        )
    if check_available and bucket == "ON_HAND" and delta < 0 and (bal.on_hand - bal.reserved) < -delta:
        raise Conflict(
            f"Insufficient available stock for '{_book_title(db, bal.book_id)}': "
            f"available {bal.on_hand - bal.reserved}, need {-delta}",
            code="insufficient_stock",
            details={"book_id": str(bal.book_id), "available": bal.on_hand - bal.reserved},
        )
    if bucket == "RESERVED" and new > bal.on_hand:
        raise Conflict("Cannot reserve more than on-hand stock", code="insufficient_stock")
    setattr(bal, field, new)
    db.add(
        InventoryLedger(
            location_id=bal.location_id, book_id=bal.book_id, copy_id=copy_id, bucket=bucket, qty_delta=delta,
            movement_type=movement_type, ref_type=ref.type, ref_id=ref.id, ref_number=ref.number,
            unit_cost=unit_cost, note=note, actor_id=actor_id,
        )
    )


def valued_qty(bal: InventoryBalance) -> int:
    return bal.on_hand + bal.damaged + bal.quarantined


def receive_cost(bal: InventoryBalance, qty: int, unit_cost: Decimal | None) -> None:
    """Update weighted-average cost before adding `qty` valued units at `unit_cost`."""
    if unit_cost is None or qty <= 0:
        return
    existing = valued_qty(bal)
    if bal.avg_cost is None or existing <= 0:
        bal.avg_cost = r4(unit_cost)
    else:
        bal.avg_cost = r4((bal.avg_cost * existing + unit_cost * qty) / (existing + qty))


def low_stock_check(db: Session, bal: InventoryBalance, book: Book | None = None) -> None:
    """Notify when available stock falls to/below the reorder level (location override or book default)."""
    book = book or db.get(Book, bal.book_id)
    level = bal.reorder_level if bal.reorder_level is not None else (book.reorder_level if book else 0)
    if level and (bal.on_hand - bal.reserved) <= level:
        loc = db.get(Location, bal.location_id)
        state = "Out of stock" if bal.on_hand - bal.reserved <= 0 else "Low stock"
        notify_permission(
            db, "inventory.view", bal.location_id, kind="LOW_STOCK",
            title=f"{state}: {book.title if book else ''} at {loc.name if loc else ''}",
            body=f"Available {bal.on_hand - bal.reserved}, reorder level {level}",
            link=f"/inventory?location={bal.location_id}&book={bal.book_id}",
        )


# ---------------------------------------------------------------- individual copies


def create_copies(db: Session, *, book: Book, location_id: uuid.UUID, qty: int, status: str, unit_cost: Decimal | None,
                  ref: Ref, actor_id: uuid.UUID | None, condition: str = "NEW") -> list[IndividualCopy]:
    prefix = get_policy(db).copy_code_prefix
    copies = []
    for _ in range(qty):
        c = IndividualCopy(
            id=uuid.uuid4(), copy_code=next_code(db, "COPY", prefix, width=8), book_id=book.id,
            location_id=location_id, status=status, condition=condition, acquisition_cost=unit_cost,
        )
        db.add(c)
        db.flush()
        db.add(CopyEvent(copy_id=c.id, event_type="CREATED", to_location_id=location_id, to_status=status,
                         condition=condition, ref_type=ref.type, ref_id=ref.id, actor_id=actor_id))
        copies.append(c)
    return copies


def lock_copy(db: Session, copy_id: uuid.UUID) -> IndividualCopy:
    c = db.scalars(
        select(IndividualCopy).where(IndividualCopy.id == copy_id).with_for_update(of=IndividualCopy)
        .execution_options(populate_existing=True)
    ).one_or_none()
    if c is None:
        raise NotFound("Copy not found")
    return c


def lock_copy_by_code(db: Session, code: str) -> IndividualCopy:
    c = db.scalars(
        select(IndividualCopy).where(IndividualCopy.copy_code == code).with_for_update(of=IndividualCopy)
        .execution_options(populate_existing=True)
    ).one_or_none()
    if c is None:
        raise NotFound(f"Copy {code} not found")
    return c


def move_copy(db: Session, c: IndividualCopy, *, event: str, to_status: str, ref: Ref, actor_id,
              to_location_id: uuid.UUID | None = None, condition: str | None = None, note: str | None = None) -> None:
    ev = CopyEvent(
        copy_id=c.id, event_type=event, from_location_id=c.location_id,
        to_location_id=to_location_id or c.location_id, from_status=c.status, to_status=to_status,
        condition=condition or c.condition, ref_type=ref.type, ref_id=ref.id, note=note, actor_id=actor_id,
    )
    c.status = to_status
    if to_location_id:
        c.location_id = to_location_id
    if condition:
        c.condition = condition
    db.add(ev)


def pick_copies(db: Session, *, book_id, location_id, qty: int, status: str = "AVAILABLE",
                copy_ids: list[uuid.UUID] | None = None) -> list[IndividualCopy]:
    """Lock specific copies (if given) or the oldest copies with `status` at the location."""
    if copy_ids:
        if len(copy_ids) != qty or len(set(copy_ids)) != qty:
            raise ValidationFailed("Copy list must match quantity and be unique")
        copies = [lock_copy(db, cid) for cid in sorted(copy_ids, key=str)]
        for c in copies:
            if c.book_id != book_id or c.location_id != location_id or c.status != status:
                raise Conflict(f"Copy {c.copy_code} is not {status.lower()} at this location", code="copy_unavailable")
        return copies
    copies = list(
        db.scalars(
            select(IndividualCopy)
            .where(IndividualCopy.book_id == book_id, IndividualCopy.location_id == location_id,
                   IndividualCopy.status == status)
            .order_by(IndividualCopy.created_at, IndividualCopy.copy_code)
            .limit(qty)
            .with_for_update(of=IndividualCopy, skip_locked=True)
        )
    )
    if len(copies) < qty:
        raise Conflict(f"Only {len(copies)} {status.lower()} copies available", code="insufficient_stock")
    return copies


# ---------------------------------------------------------------- adjustments

ADJ_REASON_BUCKETS = {
    # reason: (from_bucket, to_bucket) defaults
    "OPENING": (None, "ON_HAND"),
    "FOUND": (None, "ON_HAND"),
    "LOSS": ("ON_HAND", None),
    "DAMAGE": ("ON_HAND", "DAMAGED"),
    "WRITE_OFF": ("DAMAGED", None),
    "QUARANTINE": ("ON_HAND", "QUARANTINED"),
    "RELEASE": ("QUARANTINED", "ON_HAND"),
}


def adjustment_value(db: Session, location_id, lines: list[dict]) -> Decimal:
    """Absolute value of stock entering/leaving (bucket-to-bucket moves have no value impact)."""
    total = ZERO
    for ln in lines:
        if ln.get("from_bucket") and ln.get("to_bucket"):
            continue
        cost = ln.get("unit_cost")
        if cost is None:
            bal = db.scalar(select(InventoryBalance).where(InventoryBalance.location_id == location_id,
                                                           InventoryBalance.book_id == ln["book_id"]))
            cost = bal.avg_cost if bal and bal.avg_cost is not None else ZERO
        total += Decimal(ln["qty"]) * Decimal(cost)
    return r2(total)


def create_adjustment(db: Session, ctx, *, location_id, reason_code: str, lines: list[dict], notes: str | None,
                      stocktake_id=None) -> StockAdjustment:
    ctx.ensure_location(location_id)
    if not lines:
        raise ValidationFailed("At least one line is required")
    norm = []
    for ln in lines:
        frm, to = ln.get("from_bucket"), ln.get("to_bucket")
        if reason_code in ADJ_REASON_BUCKETS and frm is None and to is None:
            frm, to = ADJ_REASON_BUCKETS[reason_code]
        if frm is None and to is None:
            raise ValidationFailed("Each line needs a source or destination bucket")
        for b in (frm, to):
            if b is not None and b not in VALUED_BUCKETS:
                raise ValidationFailed(f"Bucket {b} cannot be adjusted directly")
        if int(ln["qty"]) <= 0:
            raise ValidationFailed("Quantity must be positive")
        book = db.get(Book, ln["book_id"])
        if book is None:
            raise NotFound("Book not found")
        if book.tracking_mode == "COPY" and frm is not None:
            if not ln.get("copy_ids"):
                raise ValidationFailed(f"'{book.title}' is copy-tracked: specify the copies being adjusted")
            if len(set(ln["copy_ids"])) != int(ln["qty"]):
                raise ValidationFailed("Number of copies must equal the quantity")
        norm.append({**ln, "from_bucket": frm, "to_bucket": to})
    value = adjustment_value(db, location_id, norm)
    policy = get_policy(db)
    needs_approval = (
        not ctx.has("inventory.approve")
        and policy.adjustment_approval_threshold > 0
        and value >= policy.adjustment_approval_threshold
    ) or (reason_code in ("OPENING",) and not ctx.has("inventory.approve"))
    adj = StockAdjustment(
        id=uuid.uuid4(), number=next_number(db, "ADJ"), location_id=location_id, reason_code=reason_code,
        status="PENDING_APPROVAL" if needs_approval else "POSTED", notes=notes, value=value,
        stocktake_id=stocktake_id, created_by=ctx.user_id,
    )
    db.add(adj)
    db.flush()
    for ln in norm:
        copy_ids = ln.get("copy_ids") or []
        if copy_ids and ln["from_bucket"] is not None:
            for cid in copy_ids:
                db.add(StockAdjustmentLine(adjustment_id=adj.id, book_id=ln["book_id"], copy_id=cid, qty=1,
                                           from_bucket=ln["from_bucket"], to_bucket=ln["to_bucket"],
                                           unit_cost=ln.get("unit_cost")))
        else:
            db.add(StockAdjustmentLine(adjustment_id=adj.id, book_id=ln["book_id"], qty=int(ln["qty"]),
                                       from_bucket=ln["from_bucket"], to_bucket=ln["to_bucket"],
                                       unit_cost=ln.get("unit_cost")))
    db.flush()
    db.refresh(adj)
    if needs_approval:
        approvals.create(db, ctx, type_="STOCK_ADJUSTMENT", location_id=location_id,
                         title=f"Stock adjustment {adj.number} ({reason_code})", entity_type="stock_adjustment",
                         entity_id=adj.id, amount=value, reason=notes)
    else:
        post_adjustment(db, adj, actor_id=ctx.user_id, approver_id=ctx.user_id)
    audit(db, ctx, "inventory.adjustment_created", entity_type="stock_adjustment", entity_id=adj.id,
          location_id=location_id, details={"reason": reason_code, "value": value, "status": adj.status})
    return adj


def post_adjustment(db: Session, adj: StockAdjustment, *, actor_id, approver_id=None) -> None:
    ref = Ref("ADJUSTMENT", adj.id, adj.number)
    balances = lock_balances(db, [(adj.location_id, ln.book_id) for ln in adj.lines])
    inv_delta = ZERO  # value entering (+) or leaving (-) inventory
    opening_value = ZERO
    for ln in adj.lines:
        bal = balances[(adj.location_id, ln.book_id)]
        book = db.get(Book, ln.book_id)
        if ln.from_bucket is None:  # stock enters
            cost = Decimal(ln.unit_cost) if ln.unit_cost is not None else bal.avg_cost
            receive_cost(bal, ln.qty, cost)
            apply(db, bal, bucket=ln.to_bucket, delta=ln.qty, movement_type=f"ADJ_{adj.reason_code}", ref=ref,
                  actor_id=actor_id, unit_cost=cost)
            val = r2(Decimal(ln.qty) * cost) if cost is not None else ZERO
            if adj.reason_code == "OPENING":
                opening_value += val
            else:
                inv_delta += val
            if book.tracking_mode == "COPY":
                status = COPY_STATUS_FOR_BUCKET[ln.to_bucket]
                create_copies(db, book=book, location_id=adj.location_id, qty=ln.qty, status=status,
                              unit_cost=cost, ref=ref, actor_id=actor_id)
        else:
            cost = bal.avg_cost
            apply(db, bal, bucket=ln.from_bucket, delta=-ln.qty, movement_type=f"ADJ_{adj.reason_code}", ref=ref,
                  actor_id=actor_id, unit_cost=cost, copy_id=ln.copy_id,
                  check_available=ln.from_bucket == "ON_HAND")
            if ln.to_bucket is not None:
                apply(db, bal, bucket=ln.to_bucket, delta=ln.qty, movement_type=f"ADJ_{adj.reason_code}", ref=ref,
                      actor_id=actor_id, unit_cost=cost, copy_id=ln.copy_id)
            else:
                inv_delta -= r2(Decimal(ln.qty) * cost) if cost is not None else ZERO
            if ln.copy_id:
                c = lock_copy(db, ln.copy_id)
                expected = COPY_STATUS_FOR_BUCKET[ln.from_bucket]
                if c.location_id != adj.location_id or c.status != expected:
                    raise Conflict(f"Copy {c.copy_code} is not {expected.lower()} at this location")
                new_status = COPY_STATUS_FOR_BUCKET.get(ln.to_bucket or "", "LOST" if adj.reason_code == "LOSS" else "WRITTEN_OFF")
                move_copy(db, c, event=f"ADJ_{adj.reason_code}", to_status=new_status, ref=ref, actor_id=actor_id,
                          condition="DAMAGED" if ln.to_bucket == "DAMAGED" else None)
        low_stock_check(db, bal, book)
    legs = []
    if inv_delta != ZERO:
        legs += [Leg("INVENTORY", inv_delta), Leg("INVENTORY_ADJ", -inv_delta)]
    if opening_value != ZERO:
        legs += [Leg("INVENTORY", opening_value), Leg("OPENING_EQUITY", -opening_value)]
    je = accounting.post(db, source_type="STOCK_ADJUSTMENT", source_id=adj.id, legs=legs,
                         memo=f"Stock adjustment {adj.number} ({adj.reason_code})", location_id=adj.location_id,
                         actor_id=actor_id)
    adj.journal_entry_id = je.id if je else None
    adj.status = "POSTED"
    adj.posted_at = datetime.now(UTC)
    adj.approved_by = approver_id


def _approve_adjustment(db: Session, ctx, req) -> None:
    adj = db.get(StockAdjustment, req.entity_id)
    if adj is None or adj.status != "PENDING_APPROVAL":
        raise Conflict("Adjustment is not pending approval")
    post_adjustment(db, adj, actor_id=ctx.user_id, approver_id=ctx.user_id)


def _reject_adjustment(db: Session, ctx, req) -> None:
    adj = db.get(StockAdjustment, req.entity_id)
    if adj and adj.status == "PENDING_APPROVAL":
        adj.status = "REJECTED"


approvals.register("STOCK_ADJUSTMENT", _approve_adjustment, _reject_adjustment)


# ---------------------------------------------------------------- stocktake


def post_stocktake(db: Session, ctx, st: Stocktake) -> StockAdjustment | None:
    if st.status != "OPEN":
        raise Conflict("Stocktake is not open")
    found, loss = [], []
    balances = lock_balances(db, [(st.location_id, ln.book_id) for ln in st.lines])
    for ln in st.lines:
        bal = balances[(st.location_id, ln.book_id)]
        ln.system_qty = bal.on_hand
        variance = ln.counted_qty - bal.on_hand
        book = db.get(Book, ln.book_id)
        if variance == 0:
            continue
        if book.tracking_mode == "COPY":
            raise ValidationFailed(
                f"'{book.title}' is copy-tracked; reconcile copies individually via adjustments instead of a count"
            )
        if variance > 0:
            found.append({"book_id": ln.book_id, "qty": variance, "from_bucket": None, "to_bucket": "ON_HAND"})
        else:
            if bal.reserved > ln.counted_qty:
                raise Conflict(f"'{book.title}': counted quantity is below stock reserved for transfers")
            loss.append({"book_id": ln.book_id, "qty": -variance, "from_bucket": "ON_HAND", "to_bucket": None})
    st.status = "POSTED"
    st.posted_by = ctx.user_id
    st.posted_at = datetime.now(UTC)
    if not found and not loss:
        return None
    return create_adjustment(db, ctx, location_id=st.location_id, reason_code="STOCKTAKE", lines=found + loss,
                             notes=f"Stocktake {st.number}", stocktake_id=st.id)


# ---------------------------------------------------------------- reconciliation


def reconcile(db: Session, location_ids: list[uuid.UUID] | None = None) -> list[dict]:
    """Compare balance rows with ledger sums and copy counts. Returns discrepancies only."""
    led = (
        select(
            InventoryLedger.location_id, InventoryLedger.book_id, InventoryLedger.bucket,
            func.sum(InventoryLedger.qty_delta).label("qty"),
        )
        .group_by(InventoryLedger.location_id, InventoryLedger.book_id, InventoryLedger.bucket)
    )
    if location_ids is not None:
        led = led.where(InventoryLedger.location_id.in_(location_ids))
    sums: dict[tuple, dict[str, int]] = {}
    for loc, book, bucket, qty in db.execute(led):
        sums.setdefault((loc, book), {})[bucket] = int(qty)
    bq = select(InventoryBalance)
    if location_ids is not None:
        bq = bq.where(InventoryBalance.location_id.in_(location_ids))
    issues = []
    seen = set()
    copy_counts = {
        (loc, book, status): n
        for loc, book, status, n in db.execute(
            select(IndividualCopy.location_id, IndividualCopy.book_id, IndividualCopy.status, func.count())
            .group_by(IndividualCopy.location_id, IndividualCopy.book_id, IndividualCopy.status)
        )
    }
    for bal in db.scalars(bq):
        key = (bal.location_id, bal.book_id)
        seen.add(key)
        s = sums.get(key, {})
        for bucket, field in BUCKET_FIELD.items():
            if int(getattr(bal, field)) != s.get(bucket, 0):
                issues.append({"location_id": bal.location_id, "book_id": bal.book_id, "bucket": bucket,
                               "balance": getattr(bal, field), "ledger": s.get(bucket, 0), "kind": "LEDGER_MISMATCH"})
        book = db.get(Book, bal.book_id)
        if book and book.tracking_mode == "COPY":
            for bucket, status in COPY_STATUS_FOR_BUCKET.items():
                n = copy_counts.get((bal.location_id, bal.book_id, status), 0)
                if bucket == "ON_HAND":
                    n += copy_counts.get((bal.location_id, bal.book_id, "RESERVED"), 0)
                if n != getattr(bal, BUCKET_FIELD[bucket]):
                    issues.append({"location_id": bal.location_id, "book_id": bal.book_id, "bucket": bucket,
                                   "balance": getattr(bal, BUCKET_FIELD[bucket]), "copies": n, "kind": "COPY_MISMATCH"})
    for key, s in sums.items():
        if key not in seen and any(v != 0 for v in s.values()):
            issues.append({"location_id": key[0], "book_id": key[1], "kind": "MISSING_BALANCE", "ledger": s})
    return issues
