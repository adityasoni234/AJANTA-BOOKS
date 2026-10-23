import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, UUIDPk


class Organization(UUIDPk, Timestamps, Base):
    """The single bookstore business. Legal/tax identity used on invoices."""

    __tablename__ = "organizations"
    legal_name: Mapped[str] = mapped_column(String(200))
    trade_name: Mapped[str | None] = mapped_column(String(200))
    gstin: Mapped[str | None] = mapped_column(String(15))
    gst_registration_type: Mapped[str] = mapped_column(String(20), default="REGULAR")
    pan: Mapped[str | None] = mapped_column(String(10))
    address_line1: Mapped[str | None] = mapped_column(String(200))
    address_line2: Mapped[str | None] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(100))
    state_code: Mapped[str | None] = mapped_column(String(2))
    pincode: Mapped[str | None] = mapped_column(String(10))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(200))
    financial_year_start_month: Mapped[int] = mapped_column(Integer, default=4)
    timezone: Mapped[str] = mapped_column(String(50), default="Asia/Kolkata")
    currency: Mapped[str] = mapped_column(String(3), default="INR")

    __table_args__ = (
        CheckConstraint(
            "gst_registration_type in ('REGULAR','COMPOSITION','UNREGISTERED')", name="gst_reg_type"
        ),
        CheckConstraint("financial_year_start_month between 1 and 12", name="fy_month"),
    )


class Location(UUIDPk, Timestamps, Base):
    __tablename__ = "locations"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(20))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    address_line1: Mapped[str | None] = mapped_column(String(200))
    address_line2: Mapped[str | None] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(100))
    state_code: Mapped[str] = mapped_column(String(2))
    pincode: Mapped[str | None] = mapped_column(String(10))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(200))
    gstin: Mapped[str | None] = mapped_column(String(15))
    invoice_prefix: Mapped[str] = mapped_column(String(10))

    __table_args__ = (CheckConstraint("type in ('WAREHOUSE','OUTLET')", name="type"),)


class Setting(Base):
    """Key/value organisation policy settings (validated by app.services.settings)."""

    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict] = mapped_column()
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", use_alter=True))
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())


class DocumentSequence(UUIDPk, Base):
    """Gapless per-scope document numbering. Rows are locked FOR UPDATE when issuing."""

    __tablename__ = "document_sequences"
    scope: Mapped[str] = mapped_column(String(40))
    doc_type: Mapped[str] = mapped_column(String(30))
    financial_year: Mapped[str] = mapped_column(String(9))
    prefix: Mapped[str] = mapped_column(String(30))
    next_value: Mapped[int] = mapped_column(Integer, default=1)

    __table_args__ = (UniqueConstraint("scope", "doc_type", "financial_year"),)


class Notification(UUIDPk, Base):
    __tablename__ = "notifications"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(300))
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    read_at: Mapped[datetime | None] = mapped_column()


class ApprovalRequest(UUIDPk, Base):
    __tablename__ = "approval_requests"
    type: Mapped[str] = mapped_column(String(30), index=True)
    status: Mapped[str] = mapped_column(String(20), default="PENDING", index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(40))
    entity_id: Mapped[uuid.UUID | None] = mapped_column()
    title: Mapped[str] = mapped_column(String(200))
    amount: Mapped[Decimal | None] = mapped_column()
    payload: Mapped[dict] = mapped_column(default=dict)
    reason: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    requested_at: Mapped[datetime] = mapped_column(server_default=func.now())
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column()
    decision_note: Mapped[str | None] = mapped_column(Text)
    consumed_at: Mapped[datetime | None] = mapped_column()

    __table_args__ = (
        CheckConstraint("status in ('PENDING','APPROVED','REJECTED','CANCELLED')", name="status"),
        CheckConstraint(
            "type in ('PURCHASE_ORDER','STOCK_ADJUSTMENT','TRANSFER','DISCOUNT','REFUND','EXPENSE','VOID')",
            name="type",
        ),
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(80), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(60))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"), index=True)
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    request_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(default=dict)
