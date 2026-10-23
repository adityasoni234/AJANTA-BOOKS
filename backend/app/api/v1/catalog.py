import csv
import io
import os
import uuid
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.config import get_settings
from app.core.db import get_db
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.models import (
    Author,
    Book,
    BookAuthor,
    Category,
    CopyEvent,
    IndividualCopy,
    InventoryBalance,
    InventoryLedger,
    Location,
    PriceHistory,
    Publisher,
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
    SupplierProduct,
    TaxClass,
    User,
)
from app.schemas.common import ORM, Page, PageParams, paginate
from app.services import catalog as svc
from app.services import inventory as inv
from app.services.audit import audit
from app.services.catalog import BookIn
from app.services.inventory import Ref

router = APIRouter(tags=["catalog"])


class TaxClassOut(ORM):
    id: uuid.UUID
    code: str
    name: str
    rate: Decimal
    is_exempt: bool
    is_active: bool


class CategoryOut(ORM):
    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None


class BookOut(BaseModel):
    id: uuid.UUID
    sku: str
    barcode: str
    isbn13: str | None
    isbn10: str | None
    title: str
    subtitle: str | None
    authors: list[str]
    publisher: str | None
    publisher_id: uuid.UUID | None
    edition: str | None
    publication_date: date | None
    language: str | None
    category_id: uuid.UUID | None
    category: str | None
    genre: str | None
    binding: str | None
    format: str | None
    page_count: int | None
    description: str | None
    tags: list[str]
    cover_url: str | None
    hsn_code: str | None
    tax_class_id: uuid.UUID
    tax_class: str
    tax_rate: Decimal
    mrp: Decimal
    selling_price: Decimal
    min_selling_price: Decimal | None
    purchase_price: Decimal | None
    default_supplier_id: uuid.UUID | None
    reorder_level: int
    reorder_qty: int
    tracking_mode: str
    status: str
    merged_into_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    # Optional per-location stock (when list is filtered by location)
    stock_on_hand: int | None = None
    stock_available: int | None = None
    location_price: Decimal | None = None


def book_out(b: Book, bal: InventoryBalance | None = None, include_cost: bool = True) -> BookOut:
    return BookOut(
        id=b.id, sku=b.sku, barcode=b.barcode, isbn13=b.isbn13, isbn10=b.isbn10, title=b.title, subtitle=b.subtitle,
        authors=b.author_names, publisher=b.publisher.name if b.publisher else None, publisher_id=b.publisher_id,
        edition=b.edition, publication_date=b.publication_date, language=b.language, category_id=b.category_id,
        category=b.category.name if b.category else None, genre=b.genre, binding=b.binding, format=b.format,
        page_count=b.page_count, description=b.description, tags=b.tags or [],
        cover_url=f"/api/v1/books/{b.id}/cover" if b.cover_image_path else None, hsn_code=b.hsn_code,
        tax_class_id=b.tax_class_id, tax_class=b.tax_class.name, tax_rate=b.tax_class.rate, mrp=b.mrp,
        selling_price=b.selling_price, min_selling_price=b.min_selling_price,
        purchase_price=b.purchase_price if include_cost else None, default_supplier_id=b.default_supplier_id,
        reorder_level=b.reorder_level, reorder_qty=b.reorder_qty, tracking_mode=b.tracking_mode, status=b.status,
        merged_into_id=b.merged_into_id, created_at=b.created_at, updated_at=b.updated_at,
        stock_on_hand=bal.on_hand if bal else None, stock_available=(bal.on_hand - bal.reserved) if bal else None,
        location_price=(bal.price_override if bal and bal.price_override is not None else b.selling_price),
    )


def _can_see_cost(ctx: AuthContext) -> bool:
    return ctx.has("purchasing.view") or ctx.has("reports.financial")


SORTS = {
    "title": Book.title, "-title": Book.title.desc(), "created": Book.created_at, "-created": Book.created_at.desc(),
    "price": Book.selling_price, "-price": Book.selling_price.desc(), "sku": Book.sku,
}


def _search_filter(q: str):
    term = q.strip()
    like = f"%{term}%"
    digits = term.replace("-", "").replace(" ", "")
    return or_(
        Book.title.ilike(like), Book.subtitle.ilike(like), Book.sku.ilike(like), Book.barcode == term,
        Book.isbn13 == digits, Book.isbn10 == digits.upper(),
        Book.id.in_(select(BookAuthor.book_id).join(Author).where(Author.name.ilike(like))),
        Book.publisher_id.in_(select(Publisher.id).where(Publisher.name.ilike(like))),
        Book.category_id.in_(select(Category.id).where(Category.name.ilike(like))),
    )


@router.get("/books", response_model=Page[BookOut])
def list_books(q: str | None = Query(None, max_length=100), category_id: uuid.UUID | None = None,
               publisher_id: uuid.UUID | None = None, status: str | None = None, tracking_mode: str | None = None,
               location_id: uuid.UUID | None = None, in_stock: bool | None = None, sort: str = "title",
               params: PageParams = Depends(), ctx: AuthContext = Depends(require("catalog.view")),
               db: Session = Depends(get_db)):
    stmt = select(Book).where(Book.merged_into_id.is_(None))
    if q:
        stmt = stmt.where(_search_filter(q))
    if category_id:
        stmt = stmt.where(or_(Book.category_id == category_id,
                              Book.category_id.in_(select(Category.id).where(Category.parent_id == category_id))))
    if publisher_id:
        stmt = stmt.where(Book.publisher_id == publisher_id)
    if status:
        stmt = stmt.where(Book.status == status)
    else:
        stmt = stmt.where(Book.status != "ARCHIVED")
    if tracking_mode:
        stmt = stmt.where(Book.tracking_mode == tracking_mode)
    if location_id:
        ctx.ensure_location(location_id)
        if in_stock:
            stmt = stmt.where(Book.id.in_(select(InventoryBalance.book_id).where(
                InventoryBalance.location_id == location_id, InventoryBalance.on_hand - InventoryBalance.reserved > 0)))
    stmt = stmt.order_by(SORTS.get(sort, Book.title), Book.id)
    rows, total = paginate(db, stmt, params)
    bals = {}
    if location_id and rows:
        bals = {b.book_id: b for b in db.scalars(select(InventoryBalance).where(
            InventoryBalance.location_id == location_id, InventoryBalance.book_id.in_([r.id for r in rows])))}
    cost = _can_see_cost(ctx)
    return Page(items=[book_out(b, bals.get(b.id), cost) for b in rows], total=total, page=params.page,
                page_size=params.page_size)


class LookupOut(BaseModel):
    book: BookOut
    copy_id: uuid.UUID | None = None
    copy_code: str | None = None
    copy_status: str | None = None
    copy_location_id: uuid.UUID | None = None
    copy_condition: str | None = None


@router.get("/books/lookup", response_model=LookupOut)
def lookup(code: str = Query(min_length=1, max_length=60), location_id: uuid.UUID | None = None,
           ctx: AuthContext = Depends(require("catalog.view")), db: Session = Depends(get_db)):
    """Barcode/ISBN/SKU/copy-code lookup used by scanners."""
    book, copy = svc.lookup_code(db, code)
    bal = None
    if location_id:
        ctx.ensure_location(location_id)
        bal = db.scalar(select(InventoryBalance).where(InventoryBalance.location_id == location_id,
                                                       InventoryBalance.book_id == book.id))
    out = LookupOut(book=book_out(book, bal, _can_see_cost(ctx)))
    if copy and (ctx.can_access(copy.location_id) or ctx.has("catalog.edit")):
        out.copy_id, out.copy_code, out.copy_status = copy.id, copy.copy_code, copy.status
        out.copy_location_id, out.copy_condition = copy.location_id, copy.condition
    return out


class StockRow(BaseModel):
    location_id: uuid.UUID
    location_name: str
    location_type: str
    on_hand: int
    reserved: int
    available: int
    damaged: int
    quarantined: int
    in_transit: int
    reorder_level: int | None
    price_override: Decimal | None
    avg_cost: Decimal | None = None


class BookDetail(BookOut):
    stock: list[StockRow]
    suppliers: list[dict]
    default_supplier_name: str | None = None


def get_book(book_id: uuid.UUID, ctx: AuthContext = Depends(require("catalog.view")), db: Session = Depends(get_db)):
    b = svc.get_book(db, book_id)
    cost = _can_see_cost(ctx)
    stock_q = (select(InventoryBalance, Location).join(Location, Location.id == InventoryBalance.location_id)
               .where(InventoryBalance.book_id == b.id, ctx.loc_filter(Location.id)).order_by(Location.type.desc(), Location.name))
    stock = [
        StockRow(location_id=loc.id, location_name=loc.name, location_type=loc.type, on_hand=bal.on_hand,
                 reserved=bal.reserved, available=bal.on_hand - bal.reserved, damaged=bal.damaged,
                 quarantined=bal.quarantined, in_transit=bal.in_transit, reorder_level=bal.reorder_level,
                 price_override=bal.price_override, avg_cost=bal.avg_cost if cost else None)
        for bal, loc in db.execute(stock_q)
    ]
    suppliers = []
    if ctx.has("suppliers.view"):
        for sp, sup in db.execute(select(SupplierProduct, Supplier).join(Supplier).where(SupplierProduct.book_id == b.id)):
            suppliers.append({"supplier_id": str(sup.id), "name": sup.name, "supplier_sku": sp.supplier_sku,
                              "last_cost": str(sp.last_cost) if (sp.last_cost is not None and cost) else None,
                              "last_purchased_at": sp.last_purchased_at.isoformat() if sp.last_purchased_at else None})
    base = book_out(b, None, cost).model_dump()
    sup = db.get(Supplier, b.default_supplier_id) if b.default_supplier_id else None
    return BookDetail(**base, stock=stock, suppliers=suppliers, default_supplier_name=sup.name if sup else None)


@router.post("/books", response_model=BookOut, status_code=201)
def create_book(body: BookIn, ctx: AuthContext = Depends(require("catalog.create")), db: Session = Depends(get_db)):
    book = svc.create_book(db, body, ctx.user_id)
    audit(db, ctx, "catalog.book_created", entity_type="book", entity_id=book.id,
          details={"title": book.title, "sku": book.sku, "isbn13": book.isbn13})
    db.commit()
    db.refresh(book)
    return book_out(book)


class BookUpdateIn(BookIn):
    change_reason: str | None = Field(default=None, max_length=300)


@router.put("/books/{book_id}", response_model=BookOut)
def update_book(book_id: uuid.UUID, body: BookUpdateIn, ctx: AuthContext = Depends(require("catalog.edit")),
                db: Session = Depends(get_db)):
    book = svc.get_book(db, book_id)
    if body.status == "ARCHIVED" and book.status != "ARCHIVED":
        ctx.require("catalog.archive")
    before = book_out(book).model_dump(mode="json")
    svc.update_book(db, book, body, ctx.user_id, can_edit_price=ctx.has("catalog.price_edit"),
                    reason=body.change_reason)
    db.flush()
    db.refresh(book)
    after = book_out(book).model_dump(mode="json")
    changed = {k: {"from": before[k], "to": after[k]} for k in after if before.get(k) != after[k] and k != "updated_at"}
    audit(db, ctx, "catalog.book_updated", entity_type="book", entity_id=book.id, details={"changes": changed})
    db.commit()
    return book_out(book)


class DuplicateCheckIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    authors: list[str] = []
    isbn13: str | None = None
    exclude_id: uuid.UUID | None = None


@router.post("/books/check-duplicates", response_model=list[BookOut])
def check_duplicates(body: DuplicateCheckIn, ctx: AuthContext = Depends(require("catalog.view")),
                     db: Session = Depends(get_db)):
    return [book_out(b, None, False) for b in svc.find_duplicates(db, title=body.title, authors=body.authors,
                                                                    isbn13=body.isbn13, exclude_id=body.exclude_id)]


class MergeIn(BaseModel):
    into_book_id: uuid.UUID
    reason: str = Field(min_length=3, max_length=300)


@router.post("/books/{book_id}/merge", response_model=BookOut)
def merge_book(book_id: uuid.UUID, body: MergeIn, ctx: AuthContext = Depends(require("catalog.merge")),
               db: Session = Depends(get_db)):
    """Merge a duplicate record into the surviving book. Stock moves via ledger entries; copies are
    re-pointed; the duplicate is archived and keeps its transaction history."""
    if not ctx.all_locations:
        raise ValidationFailed("Merging requires organisation-wide access")
    src = db.scalar(select(Book).where(Book.id == book_id).with_for_update(of=Book))
    dst = db.scalar(select(Book).where(Book.id == body.into_book_id).with_for_update(of=Book))
    if src is None or dst is None:
        raise NotFound("Book not found")
    if src.id == dst.id or src.merged_into_id or dst.merged_into_id:
        raise Conflict("Invalid merge (same book or already merged)")
    if src.tracking_mode != dst.tracking_mode:
        raise Conflict("Both books must use the same tracking mode")
    open_po = db.scalar(select(func.count()).select_from(PurchaseOrderLine).join(PurchaseOrder).where(
        PurchaseOrderLine.book_id == src.id,
        PurchaseOrder.status.in_(["DRAFT", "PENDING_APPROVAL", "APPROVED", "ISSUED", "PARTIALLY_RECEIVED"])))
    if open_po:
        raise Conflict("The duplicate has open purchase orders; close or receive them first")
    bal_rows = list(db.scalars(select(InventoryBalance).where(InventoryBalance.book_id == src.id)))
    pairs = [(b.location_id, src.id) for b in bal_rows] + [(b.location_id, dst.id) for b in bal_rows]
    locked = inv.lock_balances(db, pairs)
    ref = Ref("MERGE", src.id, src.sku)
    for b in bal_rows:
        s, d = locked[(b.location_id, src.id)], locked[(b.location_id, dst.id)]
        if s.in_transit or s.reserved:
            raise Conflict("The duplicate has stock in transit or reserved; complete transfers first")
        moved = inv.valued_qty(s)
        if moved:
            inv.receive_cost(d, moved, s.avg_cost)
        for bucket in inv.VALUED_BUCKETS:
            qty = getattr(s, inv.BUCKET_FIELD[bucket])
            if qty:
                inv.apply(db, s, bucket=bucket, delta=-qty, movement_type="MERGE_OUT", ref=ref, actor_id=ctx.user_id,
                          unit_cost=s.avg_cost)
                inv.apply(db, d, bucket=bucket, delta=qty, movement_type="MERGE_IN", ref=ref, actor_id=ctx.user_id,
                          unit_cost=s.avg_cost)
    for c in db.scalars(select(IndividualCopy).where(IndividualCopy.book_id == src.id).with_for_update(of=IndividualCopy)):
        db.add(CopyEvent(copy_id=c.id, event_type="MERGED", from_location_id=c.location_id, to_location_id=c.location_id,
                         from_status=c.status, to_status=c.status, ref_type="MERGE", ref_id=src.id,
                         note=f"Merged into {dst.sku}", actor_id=ctx.user_id))
        c.book_id = dst.id
    existing_sup = set(db.scalars(select(SupplierProduct.supplier_id).where(SupplierProduct.book_id == dst.id)))
    for sp in db.scalars(select(SupplierProduct).where(SupplierProduct.book_id == src.id)):
        if sp.supplier_id in existing_sup:
            db.delete(sp)
        else:
            sp.book_id = dst.id
    src.status = "ARCHIVED"
    src.merged_into_id = dst.id
    src.updated_by = ctx.user_id
    audit(db, ctx, "catalog.book_merged", entity_type="book", entity_id=src.id,
          details={"into": str(dst.id), "reason": body.reason, "source_sku": src.sku, "target_sku": dst.sku})
    db.commit()
    db.refresh(dst)
    return book_out(dst)


class PriceOverrideIn(BaseModel):
    location_id: uuid.UUID
    price_override: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    reorder_level: int | None = Field(default=None, ge=0)
    reorder_qty: int | None = Field(default=None, ge=0)
    reason: str | None = Field(default=None, max_length=300)


@router.put("/books/{book_id}/location-settings")
def set_location_settings(book_id: uuid.UUID, body: PriceOverrideIn,
                          ctx: AuthContext = Depends(require_any("catalog.price_edit", "inventory.settings")),
                          db: Session = Depends(get_db)):
    ctx.ensure_location(body.location_id)
    book = svc.get_book(db, book_id)
    bal = inv.lock_balance(db, body.location_id, book.id)
    if body.price_override != bal.price_override:
        ctx.require("catalog.price_edit")
        if body.price_override is not None and body.price_override > book.mrp:
            raise ValidationFailed("Location price cannot exceed MRP")
        db.add(PriceHistory(book_id=book.id, location_id=body.location_id, field="LOCATION_PRICE",
                            old_value=bal.price_override, new_value=body.price_override, changed_by=ctx.user_id,
                            reason=body.reason))
        bal.price_override = body.price_override
    if (body.reorder_level, body.reorder_qty) != (bal.reorder_level, bal.reorder_qty):
        ctx.require("inventory.settings")
        bal.reorder_level, bal.reorder_qty = body.reorder_level, body.reorder_qty
    audit(db, ctx, "catalog.location_settings", entity_type="book", entity_id=book.id, location_id=body.location_id,
          details=body.model_dump(mode="json"))
    db.commit()
    return {"message": "Saved"}


class PriceHistoryOut(ORM):
    id: uuid.UUID
    field: str
    old_value: Decimal | None
    new_value: Decimal | None
    reason: str | None
    location_id: uuid.UUID | None
    changed_by_name: str | None = None
    changed_at: datetime


@router.get("/books/{book_id}/price-history", response_model=list[PriceHistoryOut])
def price_history(book_id: uuid.UUID, ctx: AuthContext = Depends(require("catalog.view")), db: Session = Depends(get_db)):
    svc.get_book(db, book_id)
    q = (select(PriceHistory, User.full_name).outerjoin(User, User.id == PriceHistory.changed_by)
         .where(PriceHistory.book_id == book_id).order_by(PriceHistory.changed_at.desc()).limit(200))
    if not _can_see_cost(ctx):
        q = q.where(PriceHistory.field != "PURCHASE_PRICE")
    q = q.where(or_(PriceHistory.location_id.is_(None), ctx.loc_filter(PriceHistory.location_id)))
    out = []
    for ph, name in db.execute(q):
        o = PriceHistoryOut.model_validate(ph)
        o.changed_by_name = name
        out.append(o)
    return out


class LedgerOut(ORM):
    id: int
    location_id: uuid.UUID
    location_name: str | None = None
    copy_id: uuid.UUID | None
    bucket: str
    qty_delta: int
    movement_type: str
    ref_type: str | None
    ref_id: uuid.UUID | None
    ref_number: str | None
    unit_cost: Decimal | None
    note: str | None
    actor_name: str | None = None
    created_at: datetime


@router.get("/books/{book_id}/inventory-history", response_model=Page[LedgerOut])
def inventory_history(book_id: uuid.UUID, location_id: uuid.UUID | None = None, params: PageParams = Depends(),
                      ctx: AuthContext = Depends(require("inventory.view")), db: Session = Depends(get_db)):
    svc.get_book(db, book_id)
    stmt = (select(InventoryLedger, Location.name, User.full_name)
            .join(Location, Location.id == InventoryLedger.location_id)
            .outerjoin(User, User.id == InventoryLedger.actor_id)
            .where(InventoryLedger.book_id == book_id, ctx.loc_filter(InventoryLedger.location_id))
            .order_by(InventoryLedger.id.desc()))
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(InventoryLedger.location_id == location_id)
    rows, total = paginate(db, stmt, params, scalars=False)
    cost = _can_see_cost(ctx)
    items = []
    for led, lname, aname in rows:
        o = LedgerOut.model_validate(led)
        o.location_name, o.actor_name = lname, aname
        if not cost:
            o.unit_cost = None
        items.append(o)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


# ---------------------------------------------------------------- cover image

ALLOWED_IMAGE = {b"\xff\xd8\xff": ".jpg", b"\x89PNG\r\n\x1a\n": ".png", b"RIFF": ".webp"}


@router.post("/books/{book_id}/cover", response_model=BookOut)
async def upload_cover(book_id: uuid.UUID, file: UploadFile = File(...),
                       ctx: AuthContext = Depends(require("catalog.edit")), db: Session = Depends(get_db)):
    s = get_settings()
    book = svc.get_book(db, book_id)
    data = await file.read(s.max_upload_bytes + 1)
    if len(data) > s.max_upload_bytes:
        raise ValidationFailed("Image is too large")
    ext = next((e for sig, e in ALLOWED_IMAGE.items() if data.startswith(sig)), None)
    if ext is None or (ext == ".webp" and data[8:12] != b"WEBP"):
        raise ValidationFailed("Only JPEG, PNG or WebP images are allowed")
    os.makedirs(os.path.join(s.upload_dir, "covers"), exist_ok=True)
    rel = os.path.join("covers", f"{book.id}{ext}")
    with open(os.path.join(s.upload_dir, rel), "wb") as fh:
        fh.write(data)
    book.cover_image_path = rel
    audit(db, ctx, "catalog.cover_uploaded", entity_type="book", entity_id=book.id)
    db.commit()
    db.refresh(book)
    return book_out(book)


@router.get("/books/{book_id}/cover")
def get_cover(book_id: uuid.UUID, _: AuthContext = Depends(require("catalog.view")), db: Session = Depends(get_db)):
    book = svc.get_book(db, book_id)
    if not book.cover_image_path:
        raise NotFound("No cover image")
    root = os.path.realpath(get_settings().upload_dir)
    path = os.path.realpath(os.path.join(root, book.cover_image_path))
    if not path.startswith(root + os.sep) or not os.path.exists(path):
        raise NotFound("No cover image")
    return FileResponse(path, headers={"Cache-Control": "private, max-age=300"})


# ---------------------------------------------------------------- CSV import / export

CSV_COLUMNS = ["title", "subtitle", "authors", "publisher", "isbn13", "isbn10", "barcode", "edition", "language",
               "category", "binding", "format", "page_count", "hsn_code", "tax_class", "mrp", "selling_price",
               "min_selling_price", "purchase_price", "reorder_level", "reorder_qty", "tracking_mode", "tags"]


def _parse_row(db: Session, row: dict, tax_classes: dict, categories: dict) -> BookIn:
    def dec(k):
        v = (row.get(k) or "").strip()
        if not v:
            return None
        try:
            return Decimal(v)
        except InvalidOperation:
            raise ValueError(f"{k}: not a number")

    tc = (row.get("tax_class") or "GST0").strip().upper()
    if tc not in tax_classes:
        raise ValueError(f"tax_class: unknown code '{tc}'")
    cat = (row.get("category") or "").strip()
    cat_id = None
    if cat:
        if cat.lower() not in categories:
            raise ValueError(f"category: unknown '{cat}'")
        cat_id = categories[cat.lower()]
    data = {
        "title": (row.get("title") or "").strip(),
        "subtitle": (row.get("subtitle") or "").strip() or None,
        "authors": [a for a in (row.get("authors") or "").split(";") if a.strip()],
        "publisher": (row.get("publisher") or "").strip() or None,
        "isbn13": row.get("isbn13"), "isbn10": row.get("isbn10"), "barcode": row.get("barcode"),
        "edition": (row.get("edition") or "").strip() or None,
        "language": (row.get("language") or "").strip() or None,
        "category_id": cat_id,
        "binding": (row.get("binding") or "").strip() or None,
        "format": (row.get("format") or "").strip() or None,
        "page_count": int(row["page_count"]) if (row.get("page_count") or "").strip() else None,
        "hsn_code": (row.get("hsn_code") or "").strip() or "4901",
        "tax_class_id": tax_classes[tc],
        "mrp": dec("mrp"), "selling_price": dec("selling_price") if dec("selling_price") is not None else dec("mrp"),
        "min_selling_price": dec("min_selling_price"), "purchase_price": dec("purchase_price"),
        "reorder_level": int(row.get("reorder_level") or 0), "reorder_qty": int(row.get("reorder_qty") or 0),
        "tracking_mode": (row.get("tracking_mode") or "QUANTITY").strip().upper(),
        "tags": [t for t in (row.get("tags") or "").split(";") if t.strip()],
    }
    return BookIn.model_validate(data)


def _validate_csv(db: Session, content: bytes) -> list[dict]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValidationFailed("File must be UTF-8 encoded CSV")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "title" not in reader.fieldnames or "mrp" not in reader.fieldnames:
        raise ValidationFailed("CSV must include at least 'title' and 'mrp' columns", details={"expected": CSV_COLUMNS})
    tax_classes = {t.code: t.id for t in db.scalars(select(TaxClass).where(TaxClass.is_active.is_(True)))}
    categories = {c.name.lower(): c.id for c in db.scalars(select(Category))}
    results, seen_isbn, seen_barcode = [], {}, {}
    for i, row in enumerate(reader, start=2):
        if i > 5001:
            raise ValidationFailed("Import is limited to 5000 rows per file")
        errors, warnings, parsed = [], [], None
        try:
            parsed = _parse_row(db, row, tax_classes, categories)
        except ValidationError as e:
            errors += [f"{'.'.join(str(x) for x in err['loc']) or 'row'}: {err['msg']}" for err in e.errors()]
        except (ValueError, KeyError) as e:
            errors.append(str(e))
        if parsed:
            if parsed.isbn13:
                if parsed.isbn13 in seen_isbn:
                    errors.append(f"Duplicate ISBN within file (row {seen_isbn[parsed.isbn13]})")
                seen_isbn[parsed.isbn13] = i
                dup = db.scalar(select(Book).where(or_(Book.isbn13 == parsed.isbn13, Book.barcode == parsed.isbn13)))
                if dup:
                    errors.append(f"ISBN already in catalog: {dup.title} ({dup.sku})")
            if parsed.barcode:
                if parsed.barcode in seen_barcode:
                    errors.append(f"Duplicate barcode within file (row {seen_barcode[parsed.barcode]})")
                seen_barcode[parsed.barcode] = i
                if db.scalar(select(Book.id).where(or_(Book.barcode == parsed.barcode, Book.isbn13 == parsed.barcode))):
                    errors.append("Barcode already in catalog")
            if not parsed.isbn13 and svc.find_duplicates(db, title=parsed.title, authors=parsed.authors, isbn13=None):
                warnings.append("Possible duplicate title already in catalog")
        results.append({"row": i, "title": row.get("title"), "isbn13": parsed.isbn13 if parsed else row.get("isbn13"),
                        "errors": errors, "warnings": warnings,
                        "data": parsed.model_dump(mode="json") if parsed and not errors else None})
    return results


@router.post("/books/import/preview")
async def import_preview(file: UploadFile = File(...), ctx: AuthContext = Depends(require("catalog.import")),
                         db: Session = Depends(get_db)):
    content = await file.read(get_settings().max_upload_bytes + 1)
    if len(content) > get_settings().max_upload_bytes:
        raise ValidationFailed("File too large")
    rows = _validate_csv(db, content)
    return {"rows": rows, "valid": sum(1 for r in rows if not r["errors"]), "invalid": sum(1 for r in rows if r["errors"])}


@router.post("/books/import/commit")
async def import_commit(file: UploadFile = File(...), ctx: AuthContext = Depends(require("catalog.import", "catalog.create")),
                        db: Session = Depends(get_db)):
    """Re-validates the file server-side and imports all rows atomically (all-or-nothing)."""
    content = await file.read(get_settings().max_upload_bytes + 1)
    if len(content) > get_settings().max_upload_bytes:
        raise ValidationFailed("File too large")
    rows = _validate_csv(db, content)
    bad = [r for r in rows if r["errors"]]
    if bad:
        raise ValidationFailed(f"{len(bad)} row(s) have errors; fix them and re-upload", details=bad[:50])
    created = [svc.create_book(db, BookIn.model_validate(r["data"]), ctx.user_id).id for r in rows]
    audit(db, ctx, "catalog.imported", entity_type="book", details={"count": len(created)})
    db.commit()
    return {"created": len(created)}


@router.get("/books/import/template")
def import_template(_: AuthContext = Depends(require("catalog.import"))):
    sample = io.StringIO()
    w = csv.writer(sample)
    w.writerow(CSV_COLUMNS)
    w.writerow(["The Example Book", "", "Jane Author;John Author", "Example Press", "9780306406157", "", "", "1st",
                "English", "Fiction", "Paperback", "", "320", "4901", "GST0", "499.00", "449.00", "", "300.00",
                "5", "10", "QUANTITY", "bestseller;classic"])
    return StreamingResponse(iter([sample.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=book_import_template.csv"})


@router.get("/books/export.csv")
def export_books(q: str | None = None, status: str | None = None,
                 ctx: AuthContext = Depends(require("catalog.import", "reports.export")), db: Session = Depends(get_db)):
    stmt = select(Book).where(Book.merged_into_id.is_(None)).order_by(Book.title).limit(get_settings().max_export_rows)
    if q:
        stmt = stmt.where(_search_filter(q))
    if status:
        stmt = stmt.where(Book.status == status)
    cost = _can_see_cost(ctx)

    def gen():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["sku", "barcode", *CSV_COLUMNS, "status"])
        yield buf.getvalue()
        for b in db.scalars(stmt).unique():
            buf.seek(0)
            buf.truncate()
            w.writerow([b.sku, b.barcode, b.title, b.subtitle or "", ";".join(b.author_names),
                        b.publisher.name if b.publisher else "", b.isbn13 or "", b.isbn10 or "", b.barcode,
                        b.edition or "", b.language or "", b.category.name if b.category else "", b.binding or "",
                        b.format or "", b.page_count or "", b.hsn_code or "", b.tax_class.code, b.mrp, b.selling_price,
                        b.min_selling_price or "", (b.purchase_price or "") if cost else "", b.reorder_level,
                        b.reorder_qty, b.tracking_mode, ";".join(b.tags or []), b.status])
            yield buf.getvalue()

    audit(db, ctx, "catalog.exported", entity_type="book")
    db.commit()
    return StreamingResponse(gen(), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=catalog_{date.today()}.csv"})


# ---------------------------------------------------------------- master data


@router.get("/tax-classes", response_model=list[TaxClassOut])
def tax_classes(_: AuthContext = Depends(require("catalog.view")), db: Session = Depends(get_db)):
    return list(db.scalars(select(TaxClass).order_by(TaxClass.rate)))


class TaxClassIn(BaseModel):
    code: str = Field(min_length=2, max_length=30, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=2, max_length=100)
    rate: Decimal = Field(ge=0, le=50, max_digits=5, decimal_places=2)
    is_exempt: bool = False
    is_active: bool = True


@router.post("/tax-classes", response_model=TaxClassOut, status_code=201)
def create_tax_class(body: TaxClassIn, ctx: AuthContext = Depends(require("settings.manage")), db: Session = Depends(get_db)):
    if db.scalar(select(TaxClass).where(TaxClass.code == body.code)):
        raise Conflict("Tax class code already exists")
    tc = TaxClass(**body.model_dump())
    db.add(tc)
    audit(db, ctx, "settings.tax_class_created", entity_type="tax_class", details=body.model_dump(mode="json"))
    db.commit()
    return tc


@router.put("/tax-classes/{tc_id}", response_model=TaxClassOut)
def update_tax_class(tc_id: uuid.UUID, body: TaxClassIn, ctx: AuthContext = Depends(require("settings.manage")),
                     db: Session = Depends(get_db)):
    tc = db.get(TaxClass, tc_id)
    if tc is None:
        raise NotFound("Tax class not found")
    before = TaxClassOut.model_validate(tc).model_dump(mode="json")
    for k, v in body.model_dump().items():
        setattr(tc, k, v)
    audit(db, ctx, "settings.tax_class_updated", entity_type="tax_class", entity_id=tc.id,
          details={"before": before, "after": body.model_dump(mode="json")})
    db.commit()
    return tc


@router.get("/categories", response_model=list[CategoryOut])
def categories(_: AuthContext = Depends(require("catalog.view")), db: Session = Depends(get_db)):
    return list(db.scalars(select(Category).order_by(Category.name)))


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: uuid.UUID | None = None


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(body: CategoryIn, ctx: AuthContext = Depends(require("catalog.master_data")), db: Session = Depends(get_db)):
    if body.parent_id:
        parent = db.get(Category, body.parent_id)
        if parent is None:
            raise ValidationFailed("Parent category not found")
        if parent.parent_id is not None:
            raise ValidationFailed("Only two category levels (category / subcategory) are supported")
    c = Category(name=" ".join(body.name.split()), parent_id=body.parent_id)
    db.add(c)
    db.flush()
    audit(db, ctx, "catalog.category_created", entity_type="category", entity_id=c.id, details=body.model_dump(mode="json"))
    db.commit()
    return c


@router.put("/categories/{cat_id}", response_model=CategoryOut)
def rename_category(cat_id: uuid.UUID, body: CategoryIn, ctx: AuthContext = Depends(require("catalog.master_data")),
                    db: Session = Depends(get_db)):
    c = db.get(Category, cat_id)
    if c is None:
        raise NotFound("Category not found")
    if body.parent_id == c.id:
        raise ValidationFailed("A category cannot be its own parent")
    c.name, c.parent_id = " ".join(body.name.split()), body.parent_id
    audit(db, ctx, "catalog.category_updated", entity_type="category", entity_id=c.id, details=body.model_dump(mode="json"))
    db.commit()
    return c


@router.get("/publishers")
def publishers(q: str | None = Query(None, max_length=100), _: AuthContext = Depends(require("catalog.view")),
               db: Session = Depends(get_db)):
    stmt = select(Publisher).order_by(Publisher.name).limit(50)
    if q:
        stmt = stmt.where(Publisher.name.ilike(f"%{q}%"))
    return [{"id": p.id, "name": p.name} for p in db.scalars(stmt)]


@router.get("/authors")
def authors(q: str | None = Query(None, max_length=100), _: AuthContext = Depends(require("catalog.view")),
            db: Session = Depends(get_db)):
    stmt = select(Author).order_by(Author.name).limit(50)
    if q:
        stmt = stmt.where(Author.name.ilike(f"%{q}%"))
    return [{"id": a.id, "name": a.name} for a in db.scalars(stmt)]


# Registered last so static /books/... paths above take precedence over the id route.
router.get("/books/{book_id}", response_model=BookDetail)(get_book)
