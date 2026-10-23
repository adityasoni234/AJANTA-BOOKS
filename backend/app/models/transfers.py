import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UnitCost, UUIDPk

TRANSFER_STATUSES = (
    "DRAFT", "REQUESTED", "APPROVED", "REJECTED", "IN_TRANSIT", "PARTIALLY_RECEIVED", "DISCREPANCY", "COMPLETED",
    "CANCELLED",
)


class StockTransfer(UUIDPk, Timestamps, Base):
    __tablename__ = "stock_transfers"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    source_location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    dest_location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT", index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    requested_at: Mapped[datetime | None] = mapped_column()
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column()
    dispatched_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    dispatched_at: Mapped[datetime | None] = mapped_column()
    completed_at: Mapped[datetime | None] = mapped_column()
    rejection_reason: Mapped[str | None] = mapped_column(String(300))

    lines: Mapped[list["StockTransferLine"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="StockTransferLine.line_no"
    )
    receipts: Mapped[list["TransferReceipt"]] = relationship(lazy="selectin", order_by="TransferReceipt.received_at")

    __table_args__ = (
        CheckConstraint("source_location_id <> dest_location_id", name="distinct_locations"),
        CheckConstraint(
            "status in ('DRAFT','REQUESTED','APPROVED','REJECTED','IN_TRANSIT','PARTIALLY_RECEIVED','DISCREPANCY','COMPLETED','CANCELLED')",
            name="status",
        ),
    )


class StockTransferLine(UUIDPk, Base):
    __tablename__ = "stock_transfer_lines"
    transfer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stock_transfers.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    qty_requested: Mapped[int] = mapped_column(Integer)
    qty_dispatched: Mapped[int] = mapped_column(Integer, default=0)
    qty_received: Mapped[int] = mapped_column(Integer, default=0)
    qty_damaged: Mapped[int] = mapped_column(Integer, default=0)
    qty_lost: Mapped[int] = mapped_column(Integer, default=0)
    qty_returned: Mapped[int] = mapped_column(Integer, default=0)
    unit_cost: Mapped[Decimal | None] = mapped_column(UnitCost)

    book = relationship("Book", lazy="joined")
    copies: Mapped[list["TransferLineCopy"]] = relationship(cascade="all, delete-orphan", lazy="selectin")

    __table_args__ = (
        UniqueConstraint("transfer_id", "book_id"),
        CheckConstraint("qty_requested > 0", name="qty_pos"),
        CheckConstraint(
            "qty_received >= 0 and qty_damaged >= 0 and qty_lost >= 0 and qty_returned >= 0 and qty_dispatched >= 0",
            name="qty_nonneg",
        ),
        CheckConstraint(
            "qty_received + qty_damaged + qty_lost + qty_returned <= qty_dispatched", name="qty_accounted"
        ),
    )

    @property
    def qty_outstanding(self) -> int:
        return self.qty_dispatched - self.qty_received - self.qty_damaged - self.qty_lost - self.qty_returned


class TransferLineCopy(Base):
    __tablename__ = "transfer_line_copies"
    line_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("stock_transfer_lines.id", ondelete="CASCADE"), primary_key=True
    )
    copy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("individual_copies.id"), primary_key=True)
    state: Mapped[str] = mapped_column(String(12), default="DISPATCHED")
    __table_args__ = (
        CheckConstraint("state in ('DISPATCHED','RECEIVED','DAMAGED','LOST','RETURNED')", name="state"),
    )


class TransferReceipt(UUIDPk, Base):
    __tablename__ = "transfer_receipts"
    transfer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stock_transfers.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True)
    kind: Mapped[str] = mapped_column(String(12), default="RECEIPT")
    received_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    received_at: Mapped[datetime] = mapped_column(server_default=func.now())
    notes: Mapped[str | None] = mapped_column(Text)
    details: Mapped[dict] = mapped_column(default=dict)
    __table_args__ = (CheckConstraint("kind in ('RECEIPT','RESOLUTION')", name="kind"),)
