import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    ARRAY,
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

from app.models.base import Base, Rate, Timestamps, UUIDPk


class TaxClass(UUIDPk, Timestamps, Base):
    """Configurable GST classification (rate). Rates are never hard-coded in the billing engine."""

    __tablename__ = "tax_classes"
    code: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    rate: Mapped[Decimal] = mapped_column(Rate)
    is_exempt: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (CheckConstraint("rate >= 0 and rate <= 50", name="rate_range"),)


class Publisher(UUIDPk, Base):
    __tablename__ = "publishers"
    name: Mapped[str] = mapped_column(String(200))
    __table_args__ = (Index("uq_publishers_name", func.lower(name), unique=True),)


class Author(UUIDPk, Base):
    __tablename__ = "authors"
    name: Mapped[str] = mapped_column(String(200))
    # Contact used for school-book order emails; supplier_id is the account purchase orders are raised on.
    email: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(30))
    supplier_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("suppliers.id"))
    __table_args__ = (Index("uq_authors_name", func.lower(name), unique=True),)


class Category(UUIDPk, Base):
    __tablename__ = "categories"
    name: Mapped[str] = mapped_column(String(120))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("categories.id"))
    __table_args__ = (
        Index(
            "uq_categories_parent_name",
            text("coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)"),
            func.lower(name),
            unique=True,
        ),
    )


class BookAuthor(Base):
    __tablename__ = "book_authors"
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), primary_key=True)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("authors.id"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    author: Mapped[Author] = relationship(lazy="joined")


class Book(UUIDPk, Timestamps, Base):
    __tablename__ = "books"
    sku: Mapped[str] = mapped_column(String(40))
    barcode: Mapped[str] = mapped_column(String(40))
    isbn13: Mapped[str | None] = mapped_column(String(13))
    isbn10: Mapped[str | None] = mapped_column(String(10))
    title: Mapped[str] = mapped_column(String(300))
    subtitle: Mapped[str | None] = mapped_column(String(300))
    publisher_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("publishers.id"))
    edition: Mapped[str | None] = mapped_column(String(60))
    publication_date: Mapped[date | None] = mapped_column(Date)
    language: Mapped[str | None] = mapped_column(String(40))
    category_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("categories.id"))
    genre: Mapped[str | None] = mapped_column(String(80))
    binding: Mapped[str | None] = mapped_column(String(40))
    format: Mapped[str | None] = mapped_column(String(40))
    page_count: Mapped[int | None] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list, server_default="{}")
    cover_image_path: Mapped[str | None] = mapped_column(String(300))
    hsn_code: Mapped[str | None] = mapped_column(String(8))
    tax_class_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tax_classes.id"))
    mrp: Mapped[Decimal] = mapped_column()
    selling_price: Mapped[Decimal] = mapped_column()
    min_selling_price: Mapped[Decimal | None] = mapped_column()
    purchase_price: Mapped[Decimal | None] = mapped_column()
    default_supplier_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("suppliers.id"))
    reorder_level: Mapped[int] = mapped_column(Integer, default=0)
    reorder_qty: Mapped[int] = mapped_column(Integer, default=0)
    tracking_mode: Mapped[str] = mapped_column(String(10), default="QUANTITY")
    status: Mapped[str] = mapped_column(String(15), default="ACTIVE", index=True)
    merged_into_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("books.id"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    publisher: Mapped[Publisher | None] = relationship(lazy="joined")
    category: Mapped[Category | None] = relationship(lazy="joined")
    tax_class: Mapped[TaxClass] = relationship(lazy="joined")
    authors: Mapped[list[BookAuthor]] = relationship(
        cascade="all, delete-orphan", order_by="BookAuthor.position", lazy="selectin"
    )

    __table_args__ = (
        Index("uq_books_sku", "sku", unique=True),
        Index("uq_books_barcode", "barcode", unique=True),
        Index("uq_books_isbn13", "isbn13", unique=True, postgresql_where=text("isbn13 is not null")),
        Index("uq_books_isbn10", "isbn10", unique=True, postgresql_where=text("isbn10 is not null")),
        Index("ix_books_title_trgm", "title", postgresql_using="gin", postgresql_ops={"title": "gin_trgm_ops"}),
        CheckConstraint("mrp >= 0 and selling_price >= 0", name="prices_nonneg"),
        CheckConstraint("selling_price <= mrp", name="price_le_mrp"),
        CheckConstraint(
            "min_selling_price is null or (min_selling_price >= 0 and min_selling_price <= selling_price)",
            name="min_price",
        ),
        CheckConstraint("tracking_mode in ('QUANTITY','COPY')", name="tracking_mode"),
        CheckConstraint("status in ('ACTIVE','DISCONTINUED','ARCHIVED')", name="status"),
        CheckConstraint("reorder_level >= 0 and reorder_qty >= 0", name="reorder_nonneg"),
        CheckConstraint("page_count is null or page_count > 0", name="page_count"),
    )

    @property
    def author_names(self) -> list[str]:
        return [ba.author.name for ba in self.authors]


class PriceHistory(UUIDPk, Base):
    __tablename__ = "price_history"
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"), index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"))
    field: Mapped[str] = mapped_column(String(30))
    old_value: Mapped[Decimal | None] = mapped_column()
    new_value: Mapped[Decimal | None] = mapped_column()
    reason: Mapped[str | None] = mapped_column(String(300))
    changed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    changed_at: Mapped[datetime] = mapped_column(server_default=func.now())


class SupplierProduct(UUIDPk, Base):
    __tablename__ = "supplier_products"
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"))
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    supplier_sku: Mapped[str | None] = mapped_column(String(60))
    last_cost: Mapped[Decimal | None] = mapped_column()
    last_purchased_at: Mapped[datetime | None] = mapped_column()
    __table_args__ = (UniqueConstraint("supplier_id", "book_id"),)
