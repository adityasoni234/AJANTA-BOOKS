import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, Date, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk

ACCOUNT_TYPES = ("ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE")


class Account(UUIDPk, Timestamps, Base):
    """Chart of accounts. Cash/bank accounts double as the 'financial accounts' used by the cashbook."""

    __tablename__ = "accounts"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(10))
    system_key: Mapped[str | None] = mapped_column(String(40), unique=True)
    is_cash_or_bank: Mapped[bool] = mapped_column(Boolean, default=False)
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    description: Mapped[str | None] = mapped_column(String(300))

    __table_args__ = (
        CheckConstraint("type in ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')", name="type"),
    )


class JournalEntry(UUIDPk, Base):
    """Posted, immutable double-entry journal. Balanced-ness is enforced by a deferred DB trigger."""

    __tablename__ = "journal_entries"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    entry_date: Mapped[date] = mapped_column(Date, index=True)
    source_type: Mapped[str] = mapped_column(String(30), index=True)
    source_id: Mapped[uuid.UUID | None] = mapped_column()
    memo: Mapped[str | None] = mapped_column(String(300))
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"), index=True)
    reversal_of_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"), unique=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    posted_at: Mapped[datetime] = mapped_column(server_default=func.now())

    lines: Mapped[list["JournalLine"]] = relationship(lazy="selectin", order_by="JournalLine.id")

    __table_args__ = (Index("ix_journal_entries_source", "source_type", "source_id"),)


class JournalLine(Base):
    __tablename__ = "journal_lines"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    entry_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journal_entries.id"), index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"), index=True)
    debit: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    credit: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"), index=True)
    memo: Mapped[str | None] = mapped_column(String(300))

    account = relationship("Account", lazy="joined")

    __table_args__ = (
        CheckConstraint("debit >= 0 and credit >= 0", name="nonneg"),
        CheckConstraint("(debit = 0) <> (credit = 0)", name="one_side"),
    )


class BankReconciliation(UUIDPk, Base):
    __tablename__ = "bank_reconciliations"
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"), index=True)
    statement_date: Mapped[date] = mapped_column(Date)
    statement_balance: Mapped[Decimal] = mapped_column()
    book_balance: Mapped[Decimal] = mapped_column()
    difference: Mapped[Decimal] = mapped_column()
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ExpenseCategory(UUIDPk, Base):
    __tablename__ = "expense_categories"
    name: Mapped[str] = mapped_column(String(80), unique=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    account = relationship("Account", lazy="joined")


class Expense(UUIDPk, Timestamps, Base):
    __tablename__ = "expenses"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("expense_categories.id"))
    expense_date: Mapped[date] = mapped_column(Date, index=True)
    amount: Mapped[Decimal] = mapped_column()
    description: Mapped[str] = mapped_column(String(300))
    vendor: Mapped[str | None] = mapped_column(String(160))
    paid_from_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    register_session_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("register_sessions.id"))
    reference: Mapped[str | None] = mapped_column(String(100))
    receipt_path: Mapped[str | None] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(20))
    idempotency_key: Mapped[str | None] = mapped_column(String(80), unique=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column()
    rejection_reason: Mapped[str | None] = mapped_column(String(300))
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journal_entries.id"))

    category = relationship("ExpenseCategory", lazy="joined")

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_pos"),
        CheckConstraint("status in ('PENDING_APPROVAL','POSTED','REJECTED')", name="status"),
    )
