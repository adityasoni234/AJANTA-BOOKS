import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Rate, Timestamps, UnitCost, UUIDPk


class Customer(UUIDPk, Timestamps, Base):
    __tablename__ = "customers"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str | None] = mapped_column(String(20))
    email: Mapped[str | None] = mapped_column(String(200))
    gstin: Mapped[str | None] = mapped_column(String(15))
    billing_address: Mapped[str | None] = mapped_column(Text)
    state_code: Mapped[str | None] = mapped_column(String(2))
    notes: Mapped[str | None] = mapped_column(Text)
    marketing_consent: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_updated_at: Mapped[datetime | None] = mapped_column()
    credit_limit: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    home_location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    __table_args__ = (
        Index("uq_customers_phone", "phone", unique=True, postgresql_where=text("phone is not null")),
        Index("ix_customers_name_trgm", "name", postgresql_using="gin", postgresql_ops={"name": "gin_trgm_ops"}),
        Index("ix_customers_email", func.lower(email)),
    )


class CustomerLedger(UUIDPk, Base):
    """Auditable store-credit and loyalty-points ledger. Balances are sums of deltas."""

    __tablename__ = "customer_ledger"
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"), index=True)
    kind: Mapped[str] = mapped_column(String(15))
    delta: Mapped[Decimal] = mapped_column()
    ref_type: Mapped[str | None] = mapped_column(String(30))
    ref_id: Mapped[uuid.UUID | None] = mapped_column()
    note: Mapped[str | None] = mapped_column(String(300))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    __table_args__ = (
        CheckConstraint("kind in ('STORE_CREDIT','LOYALTY')", name="kind"),
        CheckConstraint("delta <> 0", name="nonzero"),
    )


class Register(UUIDPk, Timestamps, Base):
    __tablename__ = "registers"
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    __table_args__ = (UniqueConstraint("location_id", "name"),)


class RegisterSession(UUIDPk, Base):
    __tablename__ = "register_sessions"
    register_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("registers.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    status: Mapped[str] = mapped_column(String(10), default="OPEN")
    opened_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    opened_at: Mapped[datetime] = mapped_column(server_default=func.now())
    opening_float: Mapped[Decimal] = mapped_column()
    closed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    closed_at: Mapped[datetime | None] = mapped_column()
    expected_cash: Mapped[Decimal | None] = mapped_column()
    counted_cash: Mapped[Decimal | None] = mapped_column()
    variance: Mapped[Decimal | None] = mapped_column()
    closing_notes: Mapped[str | None] = mapped_column(Text)
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))

    register = relationship("Register", lazy="joined")

    __table_args__ = (
        Index(
            "uq_register_sessions_one_open", "register_id", unique=True, postgresql_where=text("status = 'OPEN'")
        ),
        CheckConstraint("status in ('OPEN','CLOSED')", name="status"),
        CheckConstraint("opening_float >= 0", name="float_nonneg"),
    )


class PaymentMethod(UUIDPk, Base):
    __tablename__ = "payment_methods"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(60))
    kind: Mapped[str] = mapped_column(String(20))
    account_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("accounts.id"))
    requires_reference: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (
        CheckConstraint(
            "kind in ('CASH','UPI','CARD','BANK_TRANSFER','STORE_CREDIT','CREDIT','EXCHANGE','OTHER')", name="kind"
        ),
    )


class Sale(UUIDPk, Base):
    __tablename__ = "sales"
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    register_session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("register_sessions.id"), index=True)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"), index=True)
    status: Mapped[str] = mapped_column(String(12), default="COMPLETED")
    prices_include_tax: Mapped[bool] = mapped_column(Boolean)
    is_interstate: Mapped[bool] = mapped_column(Boolean, default=False)
    place_of_supply: Mapped[str] = mapped_column(String(2))
    gross_amount: Mapped[Decimal] = mapped_column()
    line_discount_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    bill_discount: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    taxable_total: Mapped[Decimal] = mapped_column()
    cgst_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    sgst_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    igst_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    round_off: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    grand_total: Mapped[Decimal] = mapped_column()
    amount_paid: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    cogs_total: Mapped[Decimal | None] = mapped_column()
    cost_complete: Mapped[bool] = mapped_column(Boolean, default=True)
    discount_reason: Mapped[str | None] = mapped_column(String(200))
    discount_approval_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("approval_requests.id"), unique=True)
    exchange_return_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("returns.id", use_alter=True), unique=True)
    notes: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    cancelled_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    cancelled_at: Mapped[datetime | None] = mapped_column()
    cancel_reason: Mapped[str | None] = mapped_column(String(300))
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))

    lines: Mapped[list["SaleLine"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="SaleLine.line_no"
    )
    invoice: Mapped["Invoice | None"] = relationship(
        lazy="joined", primaryjoin="Sale.id == Invoice.sale_id", uselist=False, viewonly=True
    )
    customer = relationship("Customer", lazy="joined")

    __table_args__ = (
        CheckConstraint("status in ('COMPLETED','CANCELLED')", name="status"),
        CheckConstraint("grand_total >= 0 and amount_paid >= 0", name="amounts_nonneg"),
        CheckConstraint("amount_paid <= grand_total", name="not_overpaid"),
        CheckConstraint(
            "grand_total = taxable_total + cgst_total + sgst_total + igst_total + round_off", name="total_consistent"
        ),
        Index("ix_sales_location_created", "location_id", "created_at"),
    )

    @property
    def tax_total(self) -> Decimal:
        return self.cgst_total + self.sgst_total + self.igst_total

    @property
    def discount_total(self) -> Decimal:
        return self.line_discount_total + self.bill_discount

    @property
    def balance_due(self) -> Decimal:
        return self.grand_total - self.amount_paid


class SaleLine(UUIDPk, Base):
    __tablename__ = "sale_lines"
    sale_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sales.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"), index=True)
    copy_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("individual_copies.id"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    hsn_code: Mapped[str | None] = mapped_column(String(8))
    qty: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[Decimal] = mapped_column()
    mrp: Mapped[Decimal] = mapped_column()
    line_discount: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    bill_discount_alloc: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    taxable_value: Mapped[Decimal] = mapped_column()
    tax_rate: Mapped[Decimal] = mapped_column(Rate)
    cgst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    sgst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    igst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    line_total: Mapped[Decimal] = mapped_column()
    unit_cost: Mapped[Decimal | None] = mapped_column(UnitCost)

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty_pos"),
        CheckConstraint("copy_id is null or qty = 1", name="copy_single"),
        CheckConstraint("line_total = taxable_value + cgst + sgst + igst", name="total_consistent"),
    )


class Invoice(UUIDPk, Base):
    """Immutable tax document (tax invoice / bill of supply / credit note). Numbers are never reused."""

    __tablename__ = "invoices"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    doc_type: Mapped[str] = mapped_column(String(20))
    sale_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sales.id"), unique=True)
    return_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("returns.id"), unique=True)
    original_invoice_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("invoices.id"))
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    financial_year: Mapped[str] = mapped_column(String(9))
    issued_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    seller: Mapped[dict] = mapped_column()
    buyer: Mapped[dict] = mapped_column()
    place_of_supply: Mapped[str] = mapped_column(String(2))
    status: Mapped[str] = mapped_column(String(10), default="ISSUED")

    __table_args__ = (
        CheckConstraint("doc_type in ('TAX_INVOICE','BILL_OF_SUPPLY','CREDIT_NOTE')", name="doc_type"),
        CheckConstraint("(sale_id is null) <> (return_id is null)", name="one_source"),
        CheckConstraint("status in ('ISSUED','CANCELLED')", name="status"),
    )


class Payment(UUIDPk, Base):
    """A money movement in or out. Allocated to documents via payment_allocations."""

    __tablename__ = "payments"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    direction: Mapped[str] = mapped_column(String(3))
    purpose: Mapped[str] = mapped_column(String(20))
    payment_method_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payment_methods.id"))
    account_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("accounts.id"))
    amount: Mapped[Decimal] = mapped_column()
    tendered: Mapped[Decimal | None] = mapped_column()
    change_given: Mapped[Decimal | None] = mapped_column()
    reference: Mapped[str | None] = mapped_column(String(100))
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    register_session_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("register_sessions.id"), index=True)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"), index=True)
    supplier_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("suppliers.id"), index=True)
    payment_date: Mapped[date] = mapped_column(Date, server_default=func.current_date())
    idempotency_key: Mapped[str | None] = mapped_column(String(80), unique=True)
    notes: Mapped[str | None] = mapped_column(String(300))
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)

    method = relationship("PaymentMethod", lazy="joined")
    allocations: Mapped[list["PaymentAllocation"]] = relationship(cascade="all, delete-orphan", lazy="selectin")

    __table_args__ = (
        CheckConstraint("direction in ('IN','OUT')", name="direction"),
        CheckConstraint(
            "purpose in ('SALE','CUSTOMER_RECEIPT','SALE_REFUND','SALE_VOID','SUPPLIER_PAYMENT')", name="purpose"
        ),
        CheckConstraint("amount > 0", name="amount_pos"),
        CheckConstraint("change_given is null or change_given >= 0", name="change_nonneg"),
    )


class PaymentAllocation(UUIDPk, Base):
    __tablename__ = "payment_allocations"
    payment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payments.id", ondelete="CASCADE"), index=True)
    sale_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sales.id"), index=True)
    return_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("returns.id"), index=True)
    supplier_invoice_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("supplier_invoices.id"), index=True)
    amount: Mapped[Decimal] = mapped_column()
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_pos"),
        CheckConstraint(
            "num_nonnulls(sale_id, return_id, supplier_invoice_id) = 1", name="one_target"
        ),
    )


class Return(UUIDPk, Base):
    __tablename__ = "returns"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    sale_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sales.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    register_session_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("register_sessions.id"))
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"))
    status: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str] = mapped_column(String(300))
    refund_method_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payment_methods.id"))
    refund_reference: Mapped[str | None] = mapped_column(String(100))
    taxable_total: Mapped[Decimal] = mapped_column()
    cgst_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    sgst_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    igst_total: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    round_off: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    refund_total: Mapped[Decimal] = mapped_column()
    cogs_reversed: Mapped[Decimal | None] = mapped_column()
    approval_request_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("approval_requests.id"))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True)
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    completed_at: Mapped[datetime | None] = mapped_column()

    lines: Mapped[list["ReturnLine"]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    refund_method = relationship("PaymentMethod", lazy="joined")

    __table_args__ = (
        CheckConstraint("status in ('PENDING_APPROVAL','COMPLETED','REJECTED')", name="status"),
        CheckConstraint("refund_total >= 0", name="refund_nonneg"),
    )


class ReturnLine(UUIDPk, Base):
    __tablename__ = "return_lines"
    return_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("returns.id", ondelete="CASCADE"), index=True)
    sale_line_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sale_lines.id"), index=True)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"))
    copy_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("individual_copies.id"))
    qty: Mapped[int] = mapped_column(Integer)
    disposition: Mapped[str] = mapped_column(String(12))
    condition: Mapped[str] = mapped_column(String(10), default="GOOD")
    taxable_value: Mapped[Decimal] = mapped_column()
    cgst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    sgst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    igst: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    line_total: Mapped[Decimal] = mapped_column()
    unit_cost: Mapped[Decimal | None] = mapped_column(UnitCost)

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty_pos"),
        CheckConstraint("disposition in ('RESTOCK','QUARANTINE','DAMAGED')", name="disposition"),
    )
