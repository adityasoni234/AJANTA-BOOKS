"""School book lists: sets available per location, Excel import, school orders and author order emails.

A school prescribes one book list per class and academic year. A *set* is one copy of every book on the
list (or `qty_per_set` copies where a book is needed more than once). Sets available at a location is the
smallest `floor(available / qty_per_set)` across the list, so it is limited by the scarcest book.

Ordering for a school raises real purchase orders, one per author (the book's first-listed author), so
receiving those orders is what raises stock and therefore sets available.
"""

import io
import re
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from string import Formatter

from email_validator import EmailNotValidError, validate_email
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils.exceptions import InvalidFileException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.models import (
    Author,
    Book,
    BookAuthor,
    BookList,
    BookListItem,
    InventoryBalance,
    Location,
    Organization,
    PurchaseOrder,
    PurchaseOrderLine,
    School,
    SchoolOrder,
    SchoolOrderClass,
    Setting,
    Supplier,
    TaxClass,
)
from app.services import catalog as catalog_svc
from app.services import purchasing as po_svc
from app.services.audit import audit
from app.services.identifiers import clean_isbn, isbn10_to_13, valid_isbn10, valid_isbn13
from app.services.numbering import local_today, next_code, next_number

ON_ORDER_STATUSES = ("APPROVED", "ISSUED", "PARTIALLY_RECEIVED")
EMAILABLE_STATUSES = ("APPROVED", "ISSUED", "PARTIALLY_RECEIVED")
SCHOOL_CODE_RE = re.compile(r"^[A-Z0-9-]{2,20}$")
MAX_QTY_PER_SET = 50


# ---------------------------------------------------------------- normalisation


def clean_text(value: str | None) -> str:
    return " ".join((value or "").split())


def normalise_academic_year(value: str) -> str:
    """Accepts 2026-27 or 2026-2027 (also with '/'), returns 2026-27. The years must be consecutive."""
    v = clean_text(value).replace("/", "-").replace(" ", "")
    m = re.fullmatch(r"(\d{4})-(\d{2}|\d{4})", v)
    if not m:
        raise ValueError("Academic year must look like 2026-27")
    start, end = int(m.group(1)), m.group(2)
    end_full = int(end) if len(end) == 4 else (start // 100) * 100 + int(end)
    if len(end) == 2 and end_full < start:
        end_full += 100
    if end_full != start + 1:
        raise ValueError("Academic year must span two consecutive years, e.g. 2026-27")
    return f"{start}-{end_full % 100:02d}"


def normalise_school_code(value: str) -> str:
    code = clean_text(value).upper().replace(" ", "-")
    if not SCHOOL_CODE_RE.fullmatch(code):
        raise ValueError("School code must be 2–20 letters, digits or hyphens")
    return code


def normalise_email(value: str) -> str:
    try:
        return validate_email(value.strip(), check_deliverability=False).normalized
    except EmailNotValidError as e:
        raise ValueError(f"Invalid email address: {e}") from None


def class_label(class_name: str) -> str:
    return class_name if class_name.lower().startswith(("class", "grade", "std")) else f"Class {class_name}"


def primary_author(book: Book) -> Author | None:
    return book.authors[0].author if book.authors else None


# ---------------------------------------------------------------- stock and sets available


def viewer_locations(db: Session, ctx, location_id: uuid.UUID | None) -> list[Location]:
    """Locations whose stock the viewer may see: a single requested one, or every permitted active one."""
    if location_id is not None:
        ctx.ensure_location(location_id)
        loc = db.get(Location, location_id)
        if loc is None or not loc.is_active:
            raise NotFound("Location not found")
        return [loc]
    q = select(Location).where(Location.is_active.is_(True), ctx.loc_filter(Location.id))
    return list(db.scalars(q.order_by(Location.type.desc(), Location.name)))


def stock_matrix(db: Session, book_ids: set[uuid.UUID], location_ids: list[uuid.UUID]) -> dict:
    """{(location_id, book_id): available} where available = on hand − reserved."""
    if not book_ids or not location_ids:
        return {}
    rows = db.execute(
        select(InventoryBalance.location_id, InventoryBalance.book_id, InventoryBalance.on_hand - InventoryBalance.reserved)
        .where(InventoryBalance.book_id.in_(book_ids), InventoryBalance.location_id.in_(location_ids))
    )
    return {(loc, book): max(int(avail), 0) for loc, book, avail in rows}


def on_order_matrix(db: Session, book_ids: set[uuid.UUID], location_ids: list[uuid.UUID]) -> dict:
    """{(location_id, book_id): outstanding qty on approved/issued purchase orders}."""
    if not book_ids or not location_ids:
        return {}
    outstanding = PurchaseOrderLine.qty_ordered - PurchaseOrderLine.qty_received - PurchaseOrderLine.qty_cancelled
    rows = db.execute(
        select(PurchaseOrder.location_id, PurchaseOrderLine.book_id, func.sum(outstanding))
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
        .where(PurchaseOrder.status.in_(ON_ORDER_STATUSES), PurchaseOrder.location_id.in_(location_ids),
               PurchaseOrderLine.book_id.in_(book_ids))
        .group_by(PurchaseOrder.location_id, PurchaseOrderLine.book_id)
    )
    return {(loc, book): int(qty) for loc, book, qty in rows}


def sets_possible(items: list[BookListItem], qty_of) -> int | None:
    """Complete sets that `qty_of(book_id)` copies allow; None for an empty list (no set is defined)."""
    if not items:
        return None
    return min(qty_of(it.book_id) // it.qty_per_set for it in items)


def list_availability(db: Session, lst: BookList, locations: list[Location]) -> dict:
    loc_ids = [loc.id for loc in locations]
    book_ids = {it.book_id for it in lst.items}
    stock = stock_matrix(db, book_ids, loc_ids)
    on_order = on_order_matrix(db, book_ids, loc_ids)
    items = []
    for it in lst.items:
        b = it.book
        author = primary_author(b)
        items.append({
            "id": it.id, "book_id": b.id, "title": b.title, "isbn13": b.isbn13, "sku": b.sku,
            "author": author.name if author else None, "publisher": b.publisher.name if b.publisher else None,
            "mrp": b.mrp, "qty_per_set": it.qty_per_set, "book_status": b.status,
            "stock": [{"location_id": lid, "available": stock.get((lid, b.id), 0), "on_order": on_order.get((lid, b.id), 0)}
                      for lid in loc_ids],
        })
    sets = [{
        "location_id": lid,
        "available": sets_possible(lst.items, lambda bid, lid=lid: stock.get((lid, bid), 0)),
        "with_on_order": sets_possible(lst.items, lambda bid, lid=lid: stock.get((lid, bid), 0) + on_order.get((lid, bid), 0)),
    } for lid in loc_ids]
    return {"locations": [{"id": loc.id, "code": loc.code, "name": loc.name, "type": loc.type} for loc in locations],
            "items": items, "sets": sets}


def set_list_items(db: Session, lst: BookList, items: list[tuple[uuid.UUID, int]]) -> None:
    seen: set[uuid.UUID] = set()
    lst.items.clear()
    db.flush()
    for pos, (book_id, qty) in enumerate(items):
        book = db.get(Book, book_id)
        if book is None or book.merged_into_id is not None:
            raise ValidationFailed("Book not found")
        if book.id in seen:
            raise ValidationFailed(f"'{book.title}' appears more than once in the list")
        if not 1 <= qty <= MAX_QTY_PER_SET:
            raise ValidationFailed(f"Quantity per set for '{book.title}' must be between 1 and {MAX_QTY_PER_SET}")
        seen.add(book.id)
        lst.items.append(BookListItem(book_id=book.id, qty_per_set=qty, position=pos))
    db.flush()


# ---------------------------------------------------------------- order email template

TEMPLATE_KEY = "school_order_email_template"

PLACEHOLDERS: dict[str, str] = {
    "author_name": "Author the order is addressed to",
    "school_name": "School name",
    "school_code": "School code",
    "classes": "Classes this author's books are for, with number of sets",
    "academic_year": "Academic year, e.g. 2026-27",
    "po_number": "Purchase order number",
    "order_date": "Order date",
    "book_lines": "Numbered list of this author's books with ISBN and quantity",
    "total_quantity": "Total copies ordered from this author",
    "delivery_location": "Shop or warehouse the books must be delivered to",
    "delivery_address": "Delivery address of that location",
    "sender_name": "Name of the person opening the email",
    "org_name": "Your business name",
    "org_phone": "Your business phone",
    "org_email": "Your business email",
}

MULTILINE_PLACEHOLDERS = ("book_lines", "delivery_address")

DEFAULT_SUBJECT = "Book order {po_number}: {school_name}, {classes}"
DEFAULT_BODY = """Dear {author_name},

We would like to order the following books for {school_name}, {classes}, academic year {academic_year}.

{book_lines}

Total copies: {total_quantity}
Purchase order: {po_number} dated {order_date}

Please deliver to:
{delivery_location}
{delivery_address}

Kindly confirm availability and the expected delivery date.

Regards,
{sender_name}
{org_name}
{org_phone}
{org_email}"""


def check_placeholders(text: str) -> str:
    try:
        parts = list(Formatter().parse(text))
    except ValueError:
        raise ValueError("Unmatched '{' or '}'. Write {{ or }} for a literal brace.") from None
    for _, name, spec, conversion in parts:
        if name is None:
            continue
        if name not in PLACEHOLDERS or spec or conversion:
            raise ValueError(f"Unknown placeholder {{{name}}}. Allowed: " + ", ".join(f"{{{p}}}" for p in PLACEHOLDERS))
    return text


class EmailTemplate(BaseModel):
    subject: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=10, max_length=5000)

    @field_validator("subject")
    @classmethod
    def _subject(cls, v: str) -> str:
        v = v.strip()
        if "\n" in v or "\r" in v:
            raise ValueError("Subject must be a single line")
        check_placeholders(v)
        multiline = [p for p in MULTILINE_PLACEHOLDERS if f"{{{p}}}" in v]
        if multiline:
            raise ValueError(f"{{{multiline[0]}}} spans several lines and can only be used in the body")
        return v

    @field_validator("body")
    @classmethod
    def _body(cls, v: str) -> str:
        return check_placeholders(v.replace("\r\n", "\n").strip())


def get_template(db: Session) -> tuple[EmailTemplate, bool]:
    """Returns the saved template, or the predefined one; the flag says whether it has been customised."""
    row = db.get(Setting, TEMPLATE_KEY)
    if row is None:
        return EmailTemplate(subject=DEFAULT_SUBJECT, body=DEFAULT_BODY), False
    return EmailTemplate.model_validate(row.value), True


def save_template(db: Session, tpl: EmailTemplate, user_id: uuid.UUID) -> None:
    row = db.get(Setting, TEMPLATE_KEY)
    if row is None:
        db.add(Setting(key=TEMPLATE_KEY, value=tpl.model_dump(), updated_by=user_id))
    else:
        row.value, row.updated_by, row.updated_at = tpl.model_dump(), user_id, datetime.now(UTC)


def render_template(tpl: EmailTemplate, values: dict[str, str]) -> tuple[str, str]:
    return tpl.subject.format_map(values), tpl.body.format_map(values)


def _address(loc: Location) -> str:
    city_line = " ".join(x for x in (loc.city, loc.pincode) if x)
    lines = [loc.address_line1, loc.address_line2, ", ".join(x for x in (city_line, loc.state) if x)]
    if loc.phone:
        lines.append(f"Phone: {loc.phone}")
    return "\n".join(x for x in lines if x)


def _book_lines(lines: list[PurchaseOrderLine]) -> str:
    out = []
    for i, ln in enumerate(lines, start=1):
        isbn = f" (ISBN {ln.book.isbn13})" if ln.book.isbn13 else ""
        out.append(f"{i}. {ln.book.title}{isbn} - {ln.qty_ordered} {'copy' if ln.qty_ordered == 1 else 'copies'}")
    return "\n".join(out)


def sample_values() -> dict[str, str]:
    return {
        "author_name": "R. K. Sharma", "school_name": "Sample Public School", "school_code": "SPS",
        "classes": "Class 11 (40 sets), Class 12 (35 sets)", "academic_year": "2026-27", "po_number": "PO/2627/00042",
        "order_date": "10 Nov 2026", "book_lines": "1. Physics Part I (ISBN 9780306406157) - 75 copies\n2. Physics Part II - 75 copies",
        "total_quantity": "150", "delivery_location": "Fort, Mumbai", "delivery_address": "12 Example Road\nMumbai 400001, Maharashtra",
        "sender_name": "Your Name", "org_name": "Your Bookstore", "org_phone": "+91 22 0000 0000", "org_email": "orders@example.com",
    }


def po_email(db: Session, po: PurchaseOrder, sender_name: str) -> dict:
    if po.author_id is None or po.school_order_id is None:
        raise Conflict("This purchase order was not raised from a school order", code="not_school_order")
    author = db.get(Author, po.author_id)
    if not author.email:
        raise Conflict(f"Add an email address for {author.name} before emailing the order", code="author_email_missing")
    order = db.get(SchoolOrder, po.school_order_id)
    loc = db.get(Location, po.location_id)
    org = db.scalar(select(Organization).limit(1))
    po_books = {ln.book_id for ln in po.lines}
    classes = []
    for oc in order.classes:
        lst = db.get(BookList, oc.list_id)
        if po_books & {it.book_id for it in lst.items}:
            classes.append(f"{class_label(oc.class_name)} ({oc.sets} sets)")
    values = {
        "author_name": author.name, "school_name": order.school.name, "school_code": order.school.code,
        "classes": ", ".join(classes), "academic_year": order.academic_year, "po_number": po.number,
        "order_date": po.order_date.strftime("%d %b %Y"), "book_lines": _book_lines(po.lines),
        "total_quantity": str(sum(ln.qty_ordered for ln in po.lines)), "delivery_location": loc.name,
        "delivery_address": _address(loc), "sender_name": sender_name,
        "org_name": (org.trade_name or org.legal_name) if org else "", "org_phone": (org.phone or "") if org else "",
        "org_email": (org.email or "") if org else "",
    }
    subject, body = render_template(get_template(db)[0], values)
    return {"to": author.email, "author_name": author.name, "subject": subject, "body": body,
            "status": po.status, "email_opened_at": po.email_opened_at}


# ---------------------------------------------------------------- Excel import

# (column header, key, required). Headers are matched case-insensitively; a trailing '*' is ignored.
COLUMNS: list[tuple[str, str, bool]] = [
    ("School code", "school_code", True),
    ("School name", "school_name", True),
    ("Academic year", "academic_year", True),
    ("Class", "class_name", True),
    ("Title", "title", True),
    ("Author", "author", True),
    ("Author email", "author_email", False),
    ("ISBN", "isbn", False),
    ("Publisher", "publisher", False),
    ("Qty per set", "qty_per_set", False),
    ("MRP", "mrp", False),
    ("Purchase price", "purchase_price", False),
    ("GST %", "gst", False),
]
MAX_IMPORT_ROWS = 5000
_HEADER_KEYS = {h.lower(): k for h, k, _ in COLUMNS}


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return str(v).strip()


def read_workbook(content: bytes) -> list[tuple[int, dict[str, str]]]:
    """Rows of the first worksheet keyed by column key, with their spreadsheet row numbers."""
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except (InvalidFileException, zipfile.BadZipFile, KeyError, ValueError, OSError):
        raise ValidationFailed("The file must be an Excel workbook (.xlsx). Download the template to see the format.") from None
    try:
        rows = wb.worksheets[0].iter_rows(values_only=True)
        header = next(rows, None)
        if header is None:
            raise ValidationFailed("The first sheet is empty")
        keys: list[str | None] = []
        unknown, seen = [], set()
        for h in header:
            name = clean_text(_cell(h)).rstrip("*").strip().lower()
            if not name:
                keys.append(None)
                continue
            key = _HEADER_KEYS.get(name)
            if key is None:
                unknown.append(_cell(h))
            else:
                if key in seen:
                    raise ValidationFailed(f"Column '{_cell(h)}' appears twice")
                seen.add(key)
            keys.append(key)
        missing = [h for h, k, req in COLUMNS if req and k not in seen]
        if unknown or missing:
            raise ValidationFailed(
                "The sheet's columns don't match the template",
                details={"unknown_columns": unknown, "missing_columns": missing, "expected": [h for h, _, _ in COLUMNS]},
            )
        out = []
        for i, values in enumerate(rows, start=2):
            data = {k: _cell(v) for k, v in zip(keys, values, strict=False) if k}
            if not any(data.values()):
                continue
            if len(out) >= MAX_IMPORT_ROWS:
                raise ValidationFailed(f"Import is limited to {MAX_IMPORT_ROWS} rows per file")
            out.append((i, data))
        if not out:
            raise ValidationFailed("The sheet has no book rows")
        return out
    finally:
        wb.close()


def template_workbook() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Book list"
    ws.append([f"{h}*" if req else h for h, _, req in COLUMNS])
    for c in ws[1]:
        c.font = Font(bold=True)
        c.fill = PatternFill("solid", fgColor="E0E7FF")
    widths = [12, 30, 13, 10, 40, 24, 28, 17, 22, 11, 9, 14, 7]
    for col, w in zip("ABCDEFGHIJKLM", widths, strict=True):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A2"
    help_ws = wb.create_sheet("Instructions")
    help_ws.column_dimensions["A"].width = 20
    help_ws.column_dimensions["B"].width = 100
    rows = [
        ("Column", "How to fill it (columns marked * are required on every row)"),
        ("School code*", "Short code, e.g. MMPS. Letters, digits or hyphens. Same code = same school."),
        ("School name*", "Full school name. Must be the same on every row of that school code."),
        ("Academic year*", "e.g. 2026-27"),
        ("Class*", "e.g. 11, 12 Science. One list per school, year and class."),
        ("Title*", "Book title as printed."),
        ("Author*", "First author. Order emails go to this author."),
        ("Author email", "Author's email for order emails. Saved on the author; optional if already saved."),
        ("ISBN", "ISBN-10 or ISBN-13 (checked). Strongly recommended: books are matched to the catalog by ISBN; "
                 "without it, by exact title and author."),
        ("Publisher", "Used only when the book is new to the catalog."),
        ("Qty per set", "Copies of this book in one student set. Blank means 1."),
        ("MRP", "Required when the book is new to the catalog. Ignored for books already in the catalog."),
        ("Purchase price", "Your cost per copy for a new book; pre-fills purchase orders."),
        ("GST %", "Required for a new book: 0, 5, 12, 18 or 28 (or a tax class code such as GST0)."),
        ("", ""),
        ("Re-importing", "Importing a class again replaces that class's list with the rows in the file."),
        ("All-or-nothing", "If any row has an error, nothing is imported. Fix the rows shown and upload again."),
    ]
    for r in rows:
        help_ws.append(list(r))
    help_ws["A1"].font = help_ws["B1"].font = Font(bold=True)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _money(text: str, label: str) -> Decimal | None:
    if not text:
        return None
    try:
        v = Decimal(text.replace(",", "").replace("₹", "").strip())
    except InvalidOperation:
        raise ValueError(f"{label} is not a number") from None
    if v < 0 or v > Decimal("9999999"):
        raise ValueError(f"{label} must be between 0 and 99,99,999")
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


@dataclass
class ImportRow:
    row: int
    school_code: str = ""
    school_name: str = ""
    academic_year: str = ""
    class_name: str = ""
    title: str = ""
    author: str = ""
    author_email: str | None = None
    isbn13: str | None = None
    publisher: str | None = None
    qty_per_set: int = 1
    mrp: Decimal | None = None
    purchase_price: Decimal | None = None
    tax_class: TaxClass | None = None
    book: Book | None = None
    new_key: str | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def list_key(self) -> tuple[str, str, str]:
        return self.school_code, self.academic_year, self.class_name.lower()

    @property
    def book_key(self) -> str:
        return f"id:{self.book.id}" if self.book else f"new:{self.new_key}"


def _parse_gst(text: str, by_code: dict[str, TaxClass], by_rate: dict[Decimal, list[TaxClass]]) -> TaxClass:
    s = text.upper().replace(" ", "")
    if s in by_code:
        return by_code[s]
    num = s.removeprefix("GST").removesuffix("%")
    try:
        rate = Decimal(num).normalize()
    except InvalidOperation:
        raise ValueError(f"GST % '{text}' is not a rate or tax class code") from None
    matches = by_rate.get(rate, [])
    if len(matches) != 1:
        raise ValueError(f"No single active tax class has GST {text}%" if not matches
                         else f"Several tax classes have GST {text}%; use the tax class code instead")
    return matches[0]


def _parse_row(row_no: int, d: dict[str, str], by_code, by_rate) -> ImportRow:
    r = ImportRow(row=row_no)

    def take(fn, *args):
        try:
            return fn(*args)
        except ValueError as e:
            r.errors.append(str(e))
            return None

    r.school_code = take(normalise_school_code, d.get("school_code", "")) or clean_text(d.get("school_code")).upper()
    r.school_name = clean_text(d.get("school_name"))
    r.academic_year = take(normalise_academic_year, d.get("academic_year", "")) or ""
    r.class_name = clean_text(d.get("class_name"))
    r.title = clean_text(d.get("title"))
    r.author = clean_text(d.get("author"))
    r.publisher = clean_text(d.get("publisher")) or None
    for value, label, limit in ((r.school_name, "School name", 200), (r.class_name, "Class", 40),
                                (r.title, "Title", 300), (r.author, "Author", 200)):
        if not value:
            r.errors.append(f"{label} is required")
        elif len(value) > limit:
            r.errors.append(f"{label} is longer than {limit} characters")
    if r.publisher and len(r.publisher) > 200:
        r.errors.append("Publisher is longer than 200 characters")
    if d.get("author_email"):
        r.author_email = take(normalise_email, d["author_email"])
    if d.get("isbn"):
        raw = clean_isbn(d["isbn"])
        if len(raw) == 10 and valid_isbn10(raw):
            r.isbn13 = isbn10_to_13(raw)
        elif len(raw) == 13 and valid_isbn13(raw):
            r.isbn13 = raw
        else:
            r.errors.append(f"ISBN '{d['isbn']}' is not a valid ISBN-10 or ISBN-13")
    qty = d.get("qty_per_set", "")
    if qty:
        if not qty.isdigit() or not 1 <= int(qty) <= MAX_QTY_PER_SET:
            r.errors.append(f"Qty per set must be a whole number from 1 to {MAX_QTY_PER_SET}")
        else:
            r.qty_per_set = int(qty)
    r.mrp = take(_money, d.get("mrp", ""), "MRP")
    r.purchase_price = take(_money, d.get("purchase_price", ""), "Purchase price")
    if d.get("gst"):
        r.tax_class = take(_parse_gst, d["gst"], by_code, by_rate)
    return r


@dataclass
class ImportAnalysis:
    rows: list[ImportRow]
    schools: dict[str, dict]
    lists: dict[tuple[str, str, str], dict]
    new_books: dict[str, ImportRow]
    author_emails: dict[str, dict]

    @property
    def invalid(self) -> int:
        return sum(1 for r in self.rows if r.errors)

    def summary(self) -> dict:
        importable = {r.school_code for r in self.rows if not r.errors}
        return {
            "valid": len(self.rows) - self.invalid,
            "invalid": self.invalid,
            "new_books": len(self.new_books),
            "rows": [{
                "row": r.row, "school_code": r.school_code, "academic_year": r.academic_year, "class_name": r.class_name,
                "title": r.title, "author": r.author, "isbn13": r.isbn13, "qty_per_set": r.qty_per_set,
                "action": None if r.errors else ("MATCHED" if r.book else "NEW_BOOK"),
                "book_id": r.book.id if r.book else None, "book_title": r.book.title if r.book else None,
                "book_sku": r.book.sku if r.book else None, "errors": r.errors, "warnings": r.warnings,
            } for r in self.rows],
            "schools": [{"code": code, "name": s["name"], "action": "EXISTING" if s["existing"] else "CREATE"}
                        for code, s in sorted(self.schools.items()) if code in importable],
            "lists": [{"school_code": k[0], "academic_year": k[1], "class_name": v["class_name"], "books": len(v["rows"]),
                       "action": "REPLACE" if v["existing"] else "CREATE",
                       "current_books": len(v["existing"].items) if v["existing"] else 0}
                      for k, v in sorted(self.lists.items())],
            "author_emails": [{"author": a["name"], "email": a["email"], "current": a["current"],
                               "action": "UNCHANGED" if a["current"] == a["email"] else ("UPDATE" if a["current"] else "SET")}
                              for a in sorted(self.author_emails.values(), key=lambda a: a["name"].lower())],
        }


def analyse_import(db: Session, raw_rows: list[tuple[int, dict[str, str]]]) -> ImportAnalysis:
    taxes = list(db.scalars(select(TaxClass).where(TaxClass.is_active.is_(True))))
    by_code = {t.code.upper(): t for t in taxes}
    by_rate: dict[Decimal, list[TaxClass]] = {}
    for t in taxes:
        by_rate.setdefault(Decimal(t.rate).normalize(), []).append(t)
    rows = [_parse_row(n, d, by_code, by_rate) for n, d in raw_rows]

    # Catalog lookups in bulk: by ISBN, then by exact title (+ first author) for rows without an ISBN.
    isbns = {r.isbn13 for r in rows if r.isbn13}
    by_isbn: dict[str, Book] = {}
    if isbns:
        for b in db.scalars(select(Book).where(Book.merged_into_id.is_(None),
                                               or_(Book.isbn13.in_(isbns), Book.barcode.in_(isbns)))):
            for code in (b.isbn13, b.barcode):
                if code in isbns:
                    by_isbn.setdefault(code, b)
    titles = {r.title.lower() for r in rows if not r.isbn13 and r.title}
    by_title: dict[str, list[Book]] = {}
    if titles:
        for b in db.scalars(select(Book).where(Book.merged_into_id.is_(None), func.lower(Book.title).in_(titles))):
            by_title.setdefault(b.title.lower(), []).append(b)

    schools: dict[str, dict] = {}
    existing_schools = {s.code: s for s in db.scalars(select(School).where(
        School.code.in_({r.school_code for r in rows if r.school_code})))}
    lists: dict[tuple[str, str, str], dict] = {}
    new_books: dict[str, ImportRow] = {}
    author_emails: dict[str, dict] = {}

    for r in rows:
        if r.errors:
            continue
        # School consistency within the file and with the catalog of schools.
        s = schools.get(r.school_code)
        if s is None:
            ex = existing_schools.get(r.school_code)
            schools[r.school_code] = s = {"name": r.school_name, "existing": ex, "row": r.row}
            if ex and ex.name.lower() != r.school_name.lower():
                r.warnings.append(f"School {r.school_code} already exists as '{ex.name}'; that name is kept")
        elif s["name"].lower() != r.school_name.lower():
            r.errors.append(f"School {r.school_code} is named '{s['name']}' on row {s['row']}; use the same name")
            continue

        # Book: ISBN match, else exact title (+ author), else a new catalog book.
        if r.isbn13:
            r.book = by_isbn.get(r.isbn13)
        else:
            candidates = by_title.get(r.title.lower(), [])
            named = [b for b in candidates if primary_author(b) and primary_author(b).name.lower() == r.author.lower()]
            pool = named or [b for b in candidates if not b.authors]
            if len(pool) > 1:
                r.errors.append(f"{len(pool)} catalog books are titled '{r.title}' by {r.author}; add the ISBN to pick one")
                continue
            r.book = pool[0] if pool else None
        if r.book:
            if r.book.status != "ACTIVE":
                r.errors.append(f"Catalog book '{r.book.title}' ({r.book.sku}) is {r.book.status.lower()}")
                continue
            cat_author = primary_author(r.book)
            if cat_author is None:
                r.warnings.append(f"Catalog book has no author; {r.author} will be set as its author")
            elif cat_author.name.lower() != r.author.lower():
                r.warnings.append(f"Catalog author is {cat_author.name}; orders for this book go to {cat_author.name}")
            if r.mrp is not None and r.mrp != r.book.mrp:
                r.warnings.append(f"MRP in file ignored; catalog MRP is {r.book.mrp}")
        else:
            r.new_key = r.isbn13 or f"{r.title.lower()}|{r.author.lower()}"
            if r.mrp is None:
                r.errors.append("MRP is required for a book that is not in the catalog")
            if r.tax_class is None:
                r.errors.append("GST % is required for a book that is not in the catalog")
            if r.errors:
                continue
            first = new_books.get(r.new_key)
            if first is None:
                new_books[r.new_key] = r
            elif (first.mrp, first.tax_class.id, first.title.lower()) != (r.mrp, r.tax_class.id, r.title.lower()):
                r.errors.append(f"Same book as row {first.row} but with a different title, MRP or GST")
                continue

        # Author email (stored on the author named in the file).
        if r.author_email:
            a = author_emails.get(r.author.lower())
            if a is None:
                current = db.scalar(select(Author.email).where(func.lower(Author.name) == r.author.lower()))
                author_emails[r.author.lower()] = {"name": r.author, "email": r.author_email, "current": current, "row": r.row}
            elif a["email"] != r.author_email:
                r.errors.append(f"{r.author} has email {a['email']} on row {a['row']}; use one email per author")
                continue

        lst = lists.setdefault(r.list_key, {"class_name": r.class_name, "rows": [], "existing": None, "books": {}})
        if r.book_key in lst["books"]:
            r.errors.append(f"This book is already on row {lst['books'][r.book_key]} of the same class list")
            continue
        lst["books"][r.book_key] = r.row
        lst["rows"].append(r)

    for (code, year, cls_lower), lst in lists.items():
        ex = existing_schools.get(code)
        if ex:
            lst["existing"] = db.scalar(select(BookList).where(
                BookList.school_id == ex.id, BookList.academic_year == year, func.lower(BookList.class_name) == cls_lower))
    return ImportAnalysis(rows, schools, lists, new_books, author_emails)


def commit_import(db: Session, ctx, analysis: ImportAnalysis) -> dict:
    if analysis.invalid:
        bad = [{"row": r.row, "errors": r.errors} for r in analysis.rows if r.errors]
        raise ValidationFailed(f"{len(bad)} row(s) have errors; fix them and upload again. Nothing was imported.",
                               details=bad[:50])
    if analysis.new_books and not ctx.has("catalog.create"):
        ctx.require("catalog.create")

    school_ids: dict[str, uuid.UUID] = {}
    for code, s in analysis.schools.items():
        if s["existing"] is None:
            school = School(id=uuid.uuid4(), code=code, name=s["name"])
            db.add(school)
            db.flush()
            school_ids[code] = school.id
        else:
            school_ids[code] = s["existing"].id

    created_books: dict[str, uuid.UUID] = {}
    for key, r in analysis.new_books.items():
        data = catalog_svc.BookIn(title=r.title, authors=[r.author], publisher=r.publisher, isbn13=r.isbn13,
                                  tax_class_id=r.tax_class.id, mrp=r.mrp, selling_price=r.mrp,
                                  purchase_price=r.purchase_price)
        created_books[key] = catalog_svc.create_book(db, data, ctx.user_id).id

    for a in analysis.author_emails.values():
        author = catalog_svc.get_or_create_author(db, a["name"])
        author.email = a["email"]

    for r in analysis.rows:
        if r.book and not r.book.authors:
            r.book.authors = [BookAuthor(author_id=catalog_svc.get_or_create_author(db, r.author).id, position=0)]

    lists_written = 0
    for (code, year, _), lst in analysis.lists.items():
        book_list = lst["existing"]
        if book_list is None:
            book_list = BookList(id=uuid.uuid4(), school_id=school_ids[code], academic_year=year, class_name=lst["class_name"])
            db.add(book_list)
            db.flush()
        book_list.is_active = True
        set_list_items(db, book_list, [(r.book.id if r.book else created_books[r.new_key], r.qty_per_set) for r in lst["rows"]])
        lists_written += 1

    audit(db, ctx, "schools.lists_imported", entity_type="book_list",
          details={"schools": sorted(analysis.schools), "lists": lists_written, "new_books": len(created_books),
                   "rows": len(analysis.rows)})
    return {"schools_created": sum(1 for s in analysis.schools.values() if s["existing"] is None),
            "lists": lists_written, "books_created": len(created_books), "rows": len(analysis.rows)}


# ---------------------------------------------------------------- school orders


@dataclass
class OrderScope:
    school: School
    location: Location
    academic_year: str
    selections: list[tuple[BookList, int]]


def resolve_order_scope(db: Session, ctx, school_id: uuid.UUID, location_id: uuid.UUID,
                        classes: list[tuple[uuid.UUID, int]]) -> OrderScope:
    school = db.get(School, school_id)
    if school is None:
        raise NotFound("School not found")
    if not school.is_active:
        raise Conflict("This school is inactive")
    ctx.ensure_location(location_id)
    location = db.get(Location, location_id)
    if location is None or not location.is_active:
        raise ValidationFailed("Delivery location not found or inactive")
    if not classes:
        raise ValidationFailed("Choose at least one class")
    if len({lid for lid, _ in classes}) != len(classes):
        raise ValidationFailed("A class is selected more than once")
    selections = []
    for list_id, sets in classes:
        lst = db.get(BookList, list_id)
        if lst is None or lst.school_id != school.id:
            raise ValidationFailed("A selected class list does not belong to this school")
        if not lst.is_active:
            raise ValidationFailed(f"{class_label(lst.class_name)} ({lst.academic_year}) is archived")
        if not lst.items:
            raise ValidationFailed(f"{class_label(lst.class_name)} has no books on its list")
        if not 1 <= sets <= 100000:
            raise ValidationFailed("Number of sets must be between 1 and 100000")
        selections.append((lst, sets))
    years = {lst.academic_year for lst, _ in selections}
    if len(years) != 1:
        raise ValidationFailed("All selected classes must be from the same academic year")
    return OrderScope(school, location, years.pop(), selections)


def order_requirements(db: Session, scope: OrderScope) -> list[dict]:
    """Per book: copies required for the chosen sets, stock and on-order at the location, suggested order."""
    need: dict[uuid.UUID, dict] = {}
    for lst, sets in scope.selections:
        for it in lst.items:
            n = need.setdefault(it.book_id, {"book": it.book, "required": 0, "classes": []})
            n["required"] += sets * it.qty_per_set
            n["classes"].append(lst.class_name)
    book_ids = set(need)
    loc = [scope.location.id]
    stock, on_order = stock_matrix(db, book_ids, loc), on_order_matrix(db, book_ids, loc)
    out = []
    for book_id, n in need.items():
        b: Book = n["book"]
        author = primary_author(b)
        available, ordered = stock.get((scope.location.id, book_id), 0), on_order.get((scope.location.id, book_id), 0)
        problems = []
        if b.status != "ACTIVE":
            problems.append(f"Book is {b.status.lower()}")
        if author is None:
            problems.append("Book has no author")
        elif not author.email:
            problems.append(f"{author.name} has no email address")
        out.append({
            "book_id": b.id, "title": b.title, "isbn13": b.isbn13, "sku": b.sku, "classes": n["classes"],
            "author_id": author.id if author else None, "author_name": author.name if author else None,
            "author_email": author.email if author else None, "required": n["required"], "available": available,
            "on_order": ordered, "suggested": max(n["required"] - available - ordered, 0),
            "unit_cost": b.purchase_price, "tax_rate": b.tax_class.rate, "problems": problems,
        })
    out.sort(key=lambda x: ((x["author_name"] or "").lower(), x["title"].lower()))
    return out


def _supplier_for_author(db: Session, ctx, author: Author) -> Supplier:
    if author.supplier_id:
        sup = db.get(Supplier, author.supplier_id)
        if not sup.is_active:
            raise ValidationFailed(f"The supplier account linked to {author.name} ({sup.code}) is inactive")
        return sup
    code = next_code(db, "SUPPLIER", "S", 4)
    while db.scalar(select(Supplier.id).where(Supplier.code == code)):  # codes entered before the counter existed
        code = next_code(db, "SUPPLIER", "S", 4)
    sup = Supplier(code=code, name=author.name, email=author.email, phone=author.phone,
                   notes="Created automatically for school-book orders addressed to this author.")
    db.add(sup)
    db.flush()
    author.supplier_id = sup.id
    audit(db, ctx, "schools.author_supplier_created", entity_type="supplier", entity_id=sup.id,
          details={"author": author.name, "code": sup.code})
    return sup


def create_school_order(db: Session, ctx, scope: OrderScope, *, lines: list[dict], notes: str | None,
                        expected_date: date | None, idempotency_key: str) -> SchoolOrder:
    existing = db.scalar(select(SchoolOrder).where(SchoolOrder.idempotency_key == idempotency_key))
    if existing:
        return existing
    reqs = {r["book_id"]: r for r in order_requirements(db, scope)}
    chosen: dict[uuid.UUID, dict] = {}
    for ln in lines:
        req = reqs.get(ln["book_id"])
        if req is None:
            raise ValidationFailed("A book in the order is not on the selected class lists")
        if ln["book_id"] in chosen:
            raise ValidationFailed(f"'{req['title']}' appears more than once")
        if ln["qty"] > 0:
            chosen[ln["book_id"]] = ln
    if not chosen:
        raise ValidationFailed("Enter a quantity for at least one book")
    problems = [f"{reqs[b]['title']}: {p}" for b in chosen for p in reqs[b]["problems"]]
    if problems:
        raise ValidationFailed("Some books can't be ordered yet", details=problems)

    order = SchoolOrder(id=uuid.uuid4(), number=next_number(db, "SCHOOL_ORDER", prefix="SO"), school_id=scope.school.id,
                        academic_year=scope.academic_year, location_id=scope.location.id, notes=notes,
                        idempotency_key=idempotency_key, created_by=ctx.user_id)
    order.classes = [SchoolOrderClass(list_id=lst.id, class_name=lst.class_name, sets=sets) for lst, sets in scope.selections]
    db.add(order)
    db.flush()

    by_author: dict[uuid.UUID, list[dict]] = {}
    for book_id, ln in chosen.items():
        by_author.setdefault(reqs[book_id]["author_id"], []).append(ln)
    classes_text = ", ".join(f"{class_label(lst.class_name)} x{sets}" for lst, sets in scope.selections)
    for author_id, author_lines in sorted(by_author.items(), key=lambda kv: db.get(Author, kv[0]).name.lower()):
        author = db.get(Author, author_id)
        supplier = _supplier_for_author(db, ctx, author)
        po = PurchaseOrder(id=uuid.uuid4(), number=next_number(db, "PO"), supplier_id=supplier.id,
                           location_id=scope.location.id, order_date=local_today(db), expected_date=expected_date,
                           notes=f"School order {order.number}: {scope.school.name} ({scope.academic_year}) {classes_text}",
                           created_by=ctx.user_id, school_order_id=order.id, author_id=author.id)
        db.add(po)
        db.flush()
        po_svc.set_po_lines(db, po, [{"book_id": ln["book_id"], "qty": ln["qty"], "unit_cost": ln["unit_cost"],
                                      "tax_rate": reqs[ln["book_id"]]["tax_rate"]} for ln in author_lines])
        po_svc.submit_po(db, ctx, po)
        audit(db, ctx, "purchasing.po_created", entity_type="purchase_order", entity_id=po.id, location_id=po.location_id,
              details={"number": po.number, "total": po.total, "school_order": order.number, "status": po.status})
    audit(db, ctx, "schools.order_created", entity_type="school_order", entity_id=order.id, location_id=order.location_id,
          details={"number": order.number, "school": scope.school.code, "purchase_orders": len(by_author)})
    return order


# ---------------------------------------------------------------- validated inputs shared by the API


class SchoolFields(BaseModel):
    code: str
    name: str = Field(min_length=2, max_length=200)
    city: str | None = Field(default=None, max_length=100)
    contact_person: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    email: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=2000)
    is_active: bool = True

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        return normalise_school_code(v)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return clean_text(v)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str | None) -> str | None:
        return normalise_email(v) if v and v.strip() else None
