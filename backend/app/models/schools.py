import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
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

from app.models.base import Base, Timestamps, UUIDPk, utcnow


class School(UUIDPk, Timestamps, Base):
    """A school whose prescribed book lists the organisation supplies (tie-up held by the owner)."""

    __tablename__ = "schools"
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(100))
    contact_person: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (CheckConstraint("code ~ '^[A-Z0-9-]{2,20}$'", name="code_format"),)


class BookList(UUIDPk, Timestamps, Base):
    """The set of books a school prescribes for one class in one academic year."""

    __tablename__ = "book_lists"
    school_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("schools.id"), index=True)
    academic_year: Mapped[str] = mapped_column(String(7))
    class_name: Mapped[str] = mapped_column(String(40))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    school: Mapped[School] = relationship(lazy="joined")
    items: Mapped[list["BookListItem"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="BookListItem.position"
    )

    __table_args__ = (
        CheckConstraint("academic_year ~ '^[0-9]{4}-[0-9]{2}$'", name="academic_year_format"),
        Index("uq_book_lists_school_year_class", "school_id", "academic_year", func.lower(class_name), unique=True),
    )


class BookListItem(UUIDPk, Base):
    __tablename__ = "book_list_items"
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("book_lists.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("books.id"), index=True)
    qty_per_set: Mapped[int] = mapped_column(Integer, default=1)
    position: Mapped[int] = mapped_column(Integer, default=0)

    book = relationship("Book", lazy="joined")

    __table_args__ = (
        UniqueConstraint("list_id", "book_id"),
        CheckConstraint("qty_per_set between 1 and 50", name="qty_per_set_range"),
    )


class SchoolOrder(UUIDPk, Base):
    """Groups the purchase orders (one per author) raised to stock a school's class sets at a location."""

    __tablename__ = "school_orders"
    number: Mapped[str] = mapped_column(String(40), unique=True)
    school_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("schools.id"), index=True)
    academic_year: Mapped[str] = mapped_column(String(7))
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)

    school: Mapped[School] = relationship(lazy="joined")
    classes: Mapped[list["SchoolOrderClass"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="SchoolOrderClass.class_name"
    )


class SchoolOrderClass(UUIDPk, Base):
    __tablename__ = "school_order_classes"
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("school_orders.id", ondelete="CASCADE"), index=True)
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("book_lists.id"))
    class_name: Mapped[str] = mapped_column(String(40))
    sets: Mapped[int] = mapped_column(Integer)

    __table_args__ = (
        UniqueConstraint("order_id", "list_id"),
        CheckConstraint("sets > 0", name="sets_pos"),
    )
