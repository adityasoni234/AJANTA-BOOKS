import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Rate, Timestamps, UnitCost, UUIDPk


class Supplier(UUIDPk, Timestamps, Base):
    __tablename__ = "suppliers"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    contact_person: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(200))
    gstin: Mapped[str | None] = mapped_column(String(15))
    pan: Mapped[str | None] = mapped_column(String(10))
    address_line1: Mapped[str | None] = mapped_column(String(200))
    address_line2: Mapped[str | None] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(100))
    state_code: Mapped[str | None] = mapped_column(String(2))
    pincode: Mapped[str | None] = mapped_column(String(10))
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=30)
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


PO_STATUSES = ("DRAFT", "PENDING_APPROVAL", "APPROVED", "ISSUED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED")


class PurchaseOrder(UUIDPk, Timestamps, Base):
    __tablename__ = "purchase_orders"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT", index=True)
    order_date: Mapped[date] = mapped_column(Date)
    expected_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    subtotal: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    tax_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column()
    issued_at: Mapped[datetime | None] = mapped_column()
    closed_at: Mapped[datetime | None] = mapped_column()
    cancel_reason: Mapped[str | None] = mapped_column(String(300))
    # Set for purchase orders raised from a school order (one per author).
    school_order_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("school_orders.id"), index=True)
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("authors.id"))
    # When the order email was last opened in the user's mail app (the system cannot confirm sending).
    email_opened_at: Mapped[datetime | None] = mapped_column()

    supplier = relationship("Supplier", lazy="joined")
    lines: Mapped[list["PurchaseOrderLine"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="PurchaseOrderLine.line_no"
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('DRAFT','PENDING_APPROVAL','APPROVED','ISSUED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')",
            name="status",
        ),
    )


class PurchaseOrderLine(UUIDPk, Base):
    __tablename__ = "purchase_order_lines"
    po_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("purchase_orders.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"), index=True)
    qty_ordered: Mapped[int] = mapped_column(Integer)
    qty_received: Mapped[int] = mapped_column(Integer, default=0)
    qty_cancelled: Mapped[int] = mapped_column(Integer, default=0)
    unit_cost: Mapped[Decimal] = mapped_column(UnitCost)
    discount_pct: Mapped[Decimal] = mapped_column(Rate, default=Decimal("0"))
    tax_rate: Mapped[Decimal] = mapped_column(Rate, default=Decimal("0"))

    book = relationship("Book", lazy="joined")

    __table_args__ = (
        CheckConstraint("qty_ordered > 0", name="qty_pos"),
        CheckConstraint("qty_received >= 0 and qty_cancelled >= 0", name="qty_nonneg"),
        CheckConstraint("qty_received + qty_cancelled <= qty_ordered", name="qty_bound"),
        CheckConstraint("unit_cost >= 0", name="cost_nonneg"),
        CheckConstraint("discount_pct >= 0 and discount_pct <= 100", name="discount_range"),
    )

    @property
    def qty_outstanding(self) -> int:
        return self.qty_ordered - self.qty_received - self.qty_cancelled


class SupplierInvoice(UUIDPk, Timestamps, Base):
    __tablename__ = "supplier_invoices"
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id"), index=True)
    invoice_number: Mapped[str] = mapped_column(String(60))
    invoice_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date)
    po_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("purchase_orders.id"))
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"))
    taxable_amount: Mapped[Decimal] = mapped_column()
    cgst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    sgst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    igst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    other_charges: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column()
    amount_paid: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    status: Mapped[str] = mapped_column(String(20), default="OPEN")
    attachment_path: Mapped[str | None] = mapped_column(String(300))
    notes: Mapped[str | None] = mapped_column(Text)
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))

    supplier = relationship("Supplier", lazy="joined")

    __table_args__ = (
        UniqueConstraint("supplier_id", "invoice_number", name="uq_supplier_invoices_supplier_number"),
        CheckConstraint("status in ('OPEN','PARTIALLY_PAID','PAID','CANCELLED')", name="status"),
        CheckConstraint("total >= 0 and amount_paid >= 0 and amount_paid <= total", name="amounts"),
        CheckConstraint(
            "total = taxable_amount + cgst + sgst + igst + other_charges", name="total_consistent"
        ),
    )

    @property
    def balance_due(self) -> Decimal:
        return self.total - self.amount_paid


class GoodsReceipt(UUIDPk, Base):
    __tablename__ = "goods_receipts"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    po_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("purchase_orders.id"), index=True)
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    supplier_ref: Mapped[str | None] = mapped_column(String(60))
    freight: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    other_charges: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    goods_value: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    total_landed: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    notes: Mapped[str | None] = mapped_column(Text)
    supplier_invoice_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("supplier_invoices.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True)
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    received_at: Mapped[datetime] = mapped_column(server_default=func.now())

    supplier = relationship("Supplier", lazy="joined")
    lines: Mapped[list["GoodsReceiptLine"]] = relationship(cascade="all, delete-orphan", lazy="selectin")

    __table_args__ = (CheckConstraint("freight >= 0 and other_charges >= 0", name="charges_nonneg"),)


class GoodsReceiptLine(UUIDPk, Base):
    __tablename__ = "goods_receipt_lines"
    grn_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("goods_receipts.id", ondelete="CASCADE"), index=True)
    po_line_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("purchase_order_lines.id"))
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    qty_received: Mapped[int] = mapped_column(Integer)
    qty_damaged: Mapped[int] = mapped_column(Integer, default=0)
    unit_cost: Mapped[Decimal] = mapped_column(UnitCost)
    landed_unit_cost: Mapped[Decimal] = mapped_column(UnitCost)

    book = relationship("Book", lazy="joined")

    __table_args__ = (
        CheckConstraint("qty_received >= 0 and qty_damaged >= 0", name="qty_nonneg"),
        CheckConstraint("qty_received + qty_damaged > 0", name="qty_pos"),
    )


class SupplierReturn(UUIDPk, Base):
    __tablename__ = "supplier_returns"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"))
    grn_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("goods_receipts.id"))
    reason: Mapped[str] = mapped_column(String(300))
    value: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True)
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    supplier = relationship("Supplier", lazy="joined")
    lines: Mapped[list["SupplierReturnLine"]] = relationship(cascade="all, delete-orphan", lazy="selectin")


class SupplierReturnLine(UUIDPk, Base):
    __tablename__ = "supplier_return_lines"
    supplier_return_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("supplier_returns.id", ondelete="CASCADE"), index=True
    )
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    copy_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("individual_copies.id"))
    from_bucket: Mapped[str] = mapped_column(String(12))
    qty: Mapped[int] = mapped_column(Integer)
    unit_cost: Mapped[Decimal] = mapped_column(UnitCost)
    __table_args__ = (CheckConstraint("qty > 0", name="qty_pos"),)
