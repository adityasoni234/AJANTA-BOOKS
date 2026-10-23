import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UnitCost, UUIDPk

BUCKETS = ("ON_HAND", "DAMAGED", "QUARANTINED", "IN_TRANSIT", "RESERVED")


class InventoryBalance(UUIDPk, Base):
    """Current stock per (location, book), maintained transactionally with the ledger.

    on_hand      sellable physical stock at the location
    reserved     part of on_hand committed to approved transfers (not available for sale)
    damaged      physically present, not sellable
    quarantined  awaiting inspection (e.g. returns), not sellable
    in_transit   dispatched towards this location, not yet received
    available    = on_hand - reserved (derived)
    """

    __tablename__ = "inventory_balances"
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"))
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"), index=True)
    on_hand: Mapped[int] = mapped_column(Integer, default=0)
    reserved: Mapped[int] = mapped_column(Integer, default=0)
    damaged: Mapped[int] = mapped_column(Integer, default=0)
    quarantined: Mapped[int] = mapped_column(Integer, default=0)
    in_transit: Mapped[int] = mapped_column(Integer, default=0)
    avg_cost: Mapped[Decimal | None] = mapped_column(UnitCost)
    reorder_level: Mapped[int | None] = mapped_column(Integer)
    reorder_qty: Mapped[int | None] = mapped_column(Integer)
    price_override: Mapped[Decimal | None] = mapped_column()
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("location_id", "book_id"),
        CheckConstraint("on_hand >= 0", name="on_hand_nonneg"),
        CheckConstraint("reserved >= 0 and reserved <= on_hand", name="reserved_valid"),
        CheckConstraint("damaged >= 0", name="damaged_nonneg"),
        CheckConstraint("quarantined >= 0", name="quarantined_nonneg"),
        CheckConstraint("in_transit >= 0", name="in_transit_nonneg"),
        CheckConstraint("price_override is null or price_override >= 0", name="price_override_nonneg"),
    )

    @property
    def available(self) -> int:
        return self.on_hand - self.reserved


class InventoryLedger(Base):
    """Append-only stock movement journal. UPDATE/DELETE are blocked by a DB trigger."""

    __tablename__ = "inventory_ledger"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"))
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    copy_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("individual_copies.id"), index=True)
    bucket: Mapped[str] = mapped_column(String(12))
    qty_delta: Mapped[int] = mapped_column(Integer)
    movement_type: Mapped[str] = mapped_column(String(30))
    ref_type: Mapped[str | None] = mapped_column(String(30))
    ref_id: Mapped[uuid.UUID | None] = mapped_column()
    ref_number: Mapped[str | None] = mapped_column(String(40))
    unit_cost: Mapped[Decimal | None] = mapped_column(UnitCost)
    note: Mapped[str | None] = mapped_column(String(300))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        Index("ix_inventory_ledger_loc_book_ts", "location_id", "book_id", "created_at"),
        Index("ix_inventory_ledger_ref", "ref_type", "ref_id"),
        Index("ix_inventory_ledger_created_at", "created_at"),
        CheckConstraint("qty_delta <> 0", name="qty_nonzero"),
        CheckConstraint(
            "bucket in ('ON_HAND','DAMAGED','QUARANTINED','IN_TRANSIT','RESERVED')", name="bucket"
        ),
    )


COPY_STATUSES = ("AVAILABLE", "RESERVED", "IN_TRANSIT", "SOLD", "DAMAGED", "QUARANTINED", "WRITTEN_OFF", "RETURNED_TO_SUPPLIER", "LOST")


class IndividualCopy(UUIDPk, Timestamps, Base):
    __tablename__ = "individual_copies"
    copy_code: Mapped[str] = mapped_column(String(30), unique=True)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"))
    status: Mapped[str] = mapped_column(String(25), default="AVAILABLE")
    condition: Mapped[str] = mapped_column(String(10), default="NEW")
    acquisition_cost: Mapped[Decimal | None] = mapped_column(UnitCost)
    notes: Mapped[str | None] = mapped_column(String(300))

    book = relationship("Book", lazy="joined")

    __table_args__ = (
        Index("ix_individual_copies_book_loc_status", "book_id", "location_id", "status"),
        CheckConstraint(
            "status in ('AVAILABLE','RESERVED','IN_TRANSIT','SOLD','DAMAGED','QUARANTINED','WRITTEN_OFF','RETURNED_TO_SUPPLIER','LOST')",
            name="status",
        ),
        CheckConstraint("condition in ('NEW','GOOD','FAIR','POOR','DAMAGED')", name="condition"),
    )


class CopyEvent(UUIDPk, Base):
    __tablename__ = "copy_events"
    copy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("individual_copies.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(30))
    from_location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"))
    to_location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"))
    from_status: Mapped[str | None] = mapped_column(String(25))
    to_status: Mapped[str | None] = mapped_column(String(25))
    condition: Mapped[str | None] = mapped_column(String(10))
    ref_type: Mapped[str | None] = mapped_column(String(30))
    ref_id: Mapped[uuid.UUID | None] = mapped_column()
    note: Mapped[str | None] = mapped_column(String(300))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class StockAdjustment(UUIDPk, Base):
    """Authorised stock correction. Each line moves qty from one bucket to another;
    a null from_bucket means stock enters (found/opening), a null to_bucket means it leaves (loss/write-off)."""

    __tablename__ = "stock_adjustments"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    reason_code: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20))
    notes: Mapped[str | None] = mapped_column(Text)
    value: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    stocktake_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stocktakes.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    posted_at: Mapped[datetime | None] = mapped_column()
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))

    lines: Mapped[list["StockAdjustmentLine"]] = relationship(cascade="all, delete-orphan", lazy="selectin")

    __table_args__ = (
        CheckConstraint("status in ('PENDING_APPROVAL','POSTED','REJECTED')", name="status"),
        CheckConstraint(
            "reason_code in ('OPENING','FOUND','LOSS','DAMAGE','WRITE_OFF','QUARANTINE','RELEASE','CORRECTION','STOCKTAKE')",
            name="reason",
        ),
    )


class StockAdjustmentLine(UUIDPk, Base):
    __tablename__ = "stock_adjustment_lines"
    adjustment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stock_adjustments.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    copy_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("individual_copies.id"))
    qty: Mapped[int] = mapped_column(Integer)
    from_bucket: Mapped[str | None] = mapped_column(String(12))
    to_bucket: Mapped[str | None] = mapped_column(String(12))
    unit_cost: Mapped[Decimal | None] = mapped_column(UnitCost)

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty_pos"),
        CheckConstraint("from_bucket is not null or to_bucket is not null", name="has_bucket"),
        CheckConstraint("from_bucket is distinct from to_bucket", name="distinct_buckets"),
    )


class Stocktake(UUIDPk, Base):
    __tablename__ = "stocktakes"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    status: Mapped[str] = mapped_column(String(15), default="OPEN")
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    posted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    posted_at: Mapped[datetime | None] = mapped_column()

    lines: Mapped[list["StocktakeLine"]] = relationship(cascade="all, delete-orphan", lazy="selectin")

    __table_args__ = (CheckConstraint("status in ('OPEN','POSTED','CANCELLED')", name="status"),)


class StocktakeLine(UUIDPk, Base):
    __tablename__ = "stocktake_lines"
    stocktake_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stocktakes.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    counted_qty: Mapped[int] = mapped_column(Integer)
    system_qty: Mapped[int | None] = mapped_column(Integer)
    __table_args__ = (
        UniqueConstraint("stocktake_id", "book_id"),
        CheckConstraint("counted_qty >= 0", name="counted_nonneg"),
    )
