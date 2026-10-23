import uuid
from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.models import (
    Author,
    Book,
    BookAuthor,
    Category,
    IndividualCopy,
    InventoryBalance,
    PriceHistory,
    Publisher,
    Supplier,
    TaxClass,
)
from app.services.identifiers import (
    clean_isbn,
    internal_ean13,
    isbn10_to_13,
    isbn13_to_10,
    valid_ean13,
    valid_isbn10,
    valid_isbn13,
)
from app.services.numbering import next_code
from app.services.settings import get_policy


class BookIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    subtitle: str | None = Field(default=None, max_length=300)
    authors: list[str] = Field(default_factory=list, max_length=20)
    publisher: str | None = Field(default=None, max_length=200)
    isbn13: str | None = None
    isbn10: str | None = None
    barcode: str | None = Field(default=None, max_length=40)
    edition: str | None = Field(default=None, max_length=60)
    publication_date: date | None = None
    language: str | None = Field(default=None, max_length=40)
    category_id: uuid.UUID | None = None
    genre: str | None = Field(default=None, max_length=80)
    binding: str | None = Field(default=None, max_length=40)
    format: str | None = Field(default=None, max_length=40)
    page_count: int | None = Field(default=None, gt=0, lt=100000)
    description: str | None = Field(default=None, max_length=5000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    hsn_code: str | None = Field(default="4901", pattern=r"^\d{4,8}$")
    tax_class_id: uuid.UUID
    mrp: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    selling_price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    min_selling_price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    purchase_price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    default_supplier_id: uuid.UUID | None = None
    reorder_level: int = Field(default=0, ge=0)
    reorder_qty: int = Field(default=0, ge=0)
    tracking_mode: str = Field(default="QUANTITY", pattern=r"^(QUANTITY|COPY)$")
    status: str = Field(default="ACTIVE", pattern=r"^(ACTIVE|DISCONTINUED|ARCHIVED)$")

    @field_validator("isbn13", "isbn10", "barcode", mode="before")
    @classmethod
    def _blank(cls, v):
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("authors", "tags")
    @classmethod
    def _names(cls, v: list[str]) -> list[str]:
        seen, out = set(), []
        for n in v:
            n = " ".join(n.split())
            if n and n.lower() not in seen:
                seen.add(n.lower())
                out.append(n[:200])
        return out

    @model_validator(mode="after")
    def _identifiers_and_prices(self):
        if self.isbn13:
            self.isbn13 = clean_isbn(self.isbn13)
            if not valid_isbn13(self.isbn13):
                raise ValueError("Invalid ISBN-13 (checksum or format)")
        if self.isbn10:
            self.isbn10 = clean_isbn(self.isbn10)
            if not valid_isbn10(self.isbn10):
                raise ValueError("Invalid ISBN-10 (checksum or format)")
        if self.isbn10 and not self.isbn13:
            self.isbn13 = isbn10_to_13(self.isbn10)
        elif self.isbn13 and not self.isbn10:
            self.isbn10 = isbn13_to_10(self.isbn13)
        elif self.isbn10 and self.isbn13 and isbn10_to_13(self.isbn10) != self.isbn13:
            raise ValueError("ISBN-10 and ISBN-13 refer to different books")
        if self.selling_price > self.mrp:
            raise ValueError("Selling price cannot exceed MRP")
        if self.min_selling_price is not None and self.min_selling_price > self.selling_price:
            raise ValueError("Minimum selling price cannot exceed selling price")
        return self


def get_or_create_publisher(db: Session, name: str | None) -> uuid.UUID | None:
    if not name:
        return None
    name = " ".join(name.split())
    p = db.scalar(select(Publisher).where(func.lower(Publisher.name) == name.lower()))
    if p is None:
        p = Publisher(name=name)
        db.add(p)
        db.flush()
    return p.id


def get_or_create_author(db: Session, name: str) -> Author:
    a = db.scalar(select(Author).where(func.lower(Author.name) == name.lower()))
    if a is None:
        a = Author(name=name)
        db.add(a)
        db.flush()
    return a


def _check_barcode_unique(db: Session, barcode: str, exclude_id: uuid.UUID | None) -> None:
    q = select(Book.id).where(or_(Book.barcode == barcode, Book.isbn13 == barcode, Book.sku == barcode))
    if exclude_id:
        q = q.where(Book.id != exclude_id)
    if db.scalar(q.limit(1)) is not None:
        raise Conflict("This barcode is already assigned to another book", code="duplicate_barcode")
    if db.scalar(select(IndividualCopy.id).where(IndividualCopy.copy_code == barcode).limit(1)):
        raise Conflict("This barcode is already used by an individual copy", code="duplicate_barcode")


def _check_isbn_unique(db: Session, data: BookIn, exclude_id: uuid.UUID | None) -> None:
    if data.isbn13:
        q = select(Book).where(or_(Book.isbn13 == data.isbn13, Book.barcode == data.isbn13))
        if exclude_id:
            q = q.where(Book.id != exclude_id)
        dup = db.scalar(q.limit(1))
        if dup:
            raise Conflict(f"ISBN {data.isbn13} already exists ('{dup.title}', SKU {dup.sku})", code="duplicate_isbn",
                           details={"book_id": str(dup.id)})


def _validate_refs(db: Session, data: BookIn) -> None:
    tc = db.get(TaxClass, data.tax_class_id)
    if tc is None or not tc.is_active:
        raise ValidationFailed("Tax class not found or inactive")
    if data.category_id and db.get(Category, data.category_id) is None:
        raise ValidationFailed("Category not found")
    if data.default_supplier_id and db.get(Supplier, data.default_supplier_id) is None:
        raise ValidationFailed("Supplier not found")


def generate_barcode(db: Session) -> str:
    prefix = get_policy(db).barcode_prefix
    seq = next_code(db, "BARCODE", "", width=1)
    return internal_ean13(prefix, int(seq))


def _set_authors(db: Session, book: Book, names: list[str]) -> None:
    book.authors = [BookAuthor(author_id=get_or_create_author(db, n).id, position=i) for i, n in enumerate(names)]


def _record_price(db: Session, book_id, field: str, old, new, actor_id, reason: str | None = None, location_id=None):
    if old != new:
        db.add(PriceHistory(book_id=book_id, field=field, old_value=old, new_value=new, changed_by=actor_id,
                            reason=reason, location_id=location_id))


PRICE_FIELDS = ("mrp", "selling_price", "min_selling_price", "purchase_price")


def create_book(db: Session, data: BookIn, actor_id: uuid.UUID | None) -> Book:
    _validate_refs(db, data)
    _check_isbn_unique(db, data, None)
    barcode = data.barcode or data.isbn13 or generate_barcode(db)
    if data.barcode and data.barcode.isdigit() and len(data.barcode) == 13 and not valid_ean13(data.barcode):
        raise ValidationFailed("Barcode looks like an EAN-13 but has an invalid check digit")
    _check_barcode_unique(db, barcode, None)
    policy = get_policy(db)
    book = Book(
        id=uuid.uuid4(), sku=next_code(db, "SKU", f"{policy.sku_prefix}-", width=6), barcode=barcode,
        isbn13=data.isbn13, isbn10=data.isbn10, title=data.title.strip(), subtitle=data.subtitle,
        publisher_id=get_or_create_publisher(db, data.publisher), edition=data.edition,
        publication_date=data.publication_date, language=data.language, category_id=data.category_id,
        genre=data.genre, binding=data.binding, format=data.format, page_count=data.page_count,
        description=data.description, tags=data.tags, hsn_code=data.hsn_code, tax_class_id=data.tax_class_id,
        mrp=data.mrp, selling_price=data.selling_price, min_selling_price=data.min_selling_price,
        purchase_price=data.purchase_price, default_supplier_id=data.default_supplier_id,
        reorder_level=data.reorder_level, reorder_qty=data.reorder_qty, tracking_mode=data.tracking_mode,
        status=data.status, created_by=actor_id, updated_by=actor_id,
    )
    db.add(book)
    db.flush()
    _set_authors(db, book, data.authors)
    for f in PRICE_FIELDS:
        _record_price(db, book.id, f.upper(), None, getattr(data, f), actor_id, "Initial price")
    db.flush()
    return book


def has_stock(db: Session, book_id: uuid.UUID) -> bool:
    q = select(func.coalesce(func.sum(InventoryBalance.on_hand + InventoryBalance.damaged + InventoryBalance.quarantined
                                      + InventoryBalance.in_transit), 0)).where(InventoryBalance.book_id == book_id)
    return (db.scalar(q) or 0) > 0


def update_book(db: Session, book: Book, data: BookIn, actor_id: uuid.UUID | None, *, can_edit_price: bool,
                reason: str | None = None) -> Book:
    _validate_refs(db, data)
    _check_isbn_unique(db, data, book.id)
    if book.merged_into_id:
        raise Conflict("This book was merged into another record and can no longer be edited")
    price_changed = any(getattr(book, f) != getattr(data, f) for f in PRICE_FIELDS)
    if price_changed and not can_edit_price:
        raise ValidationFailed("You do not have permission to change prices", code="permission_denied")
    if data.tracking_mode != book.tracking_mode and has_stock(db, book.id):
        raise Conflict("Tracking mode can only change while the book has no stock anywhere")
    new_barcode = data.barcode or book.barcode
    if new_barcode != book.barcode:
        _check_barcode_unique(db, new_barcode, book.id)
    for f in PRICE_FIELDS:
        _record_price(db, book.id, f.upper(), getattr(book, f), getattr(data, f), actor_id, reason)
    book.barcode = new_barcode
    for f in ("isbn13", "isbn10", "subtitle", "edition", "publication_date", "language", "category_id", "genre",
              "binding", "format", "page_count", "description", "tags", "hsn_code", "tax_class_id",
              "default_supplier_id", "reorder_level", "reorder_qty", "tracking_mode", "status", *PRICE_FIELDS):
        setattr(book, f, getattr(data, f))
    book.title = data.title.strip()
    book.publisher_id = get_or_create_publisher(db, data.publisher)
    book.updated_by = actor_id
    _set_authors(db, book, data.authors)
    db.flush()
    return book


def find_duplicates(db: Session, *, title: str, authors: list[str], isbn13: str | None,
                    exclude_id: uuid.UUID | None = None) -> list[Book]:
    conds = [func.similarity(Book.title, title) > 0.6]
    if isbn13:
        conds.append(Book.isbn13 == isbn13)
    q = select(Book).where(or_(*conds), Book.merged_into_id.is_(None)).limit(10)
    if exclude_id:
        q = q.where(Book.id != exclude_id)
    candidates = list(db.scalars(q).unique())
    if authors:
        lower = {a.lower() for a in authors}
        candidates.sort(key=lambda b: -len(lower & {n.lower() for n in b.author_names}))
    return candidates


def lookup_code(db: Session, code: str) -> tuple[Book, IndividualCopy | None]:
    code = code.strip()
    if not code:
        raise NotFound("Empty code")
    copy = db.scalar(select(IndividualCopy).where(IndividualCopy.copy_code == code.upper()))
    if copy:
        return db.get(Book, copy.book_id), copy
    norm = clean_isbn(code)
    q = select(Book).where(
        or_(Book.barcode == code, Book.sku == code.upper(), Book.isbn13 == norm, Book.isbn10 == norm)
    ).where(Book.merged_into_id.is_(None))
    book = db.scalar(q.limit(1))
    if book is None and len(norm) == 10 and valid_isbn10(norm):
        book = db.scalar(select(Book).where(Book.isbn13 == isbn10_to_13(norm)))
    if book is None:
        raise NotFound(f"No book found for code '{code}'")
    return book, None


def get_book(db: Session, book_id: uuid.UUID) -> Book:
    b = db.get(Book, book_id)
    if b is None:
        raise NotFound("Book not found")
    return b
