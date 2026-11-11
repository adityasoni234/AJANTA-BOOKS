import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, File, Header, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require
from app.core.config import get_settings
from app.core.db import get_db
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.models import Author, BookList, Location, PurchaseOrder, School, SchoolOrder, User
from app.services import schools as svc
from app.services.audit import audit

router = APIRouter(tags=["schools"])


# ---------------------------------------------------------------- schools


def _school_out(s: School, lists: int | None = None) -> dict:
    return {"id": s.id, "code": s.code, "name": s.name, "city": s.city, "contact_person": s.contact_person,
            "phone": s.phone, "email": s.email, "notes": s.notes, "is_active": s.is_active, "lists": lists}


@router.get("/schools")
def list_schools(q: str | None = Query(None, max_length=100), include_inactive: bool = False,
                 _: AuthContext = Depends(require("schools.view")), db: Session = Depends(get_db)):
    counts = dict(db.execute(select(BookList.school_id, func.count()).where(BookList.is_active.is_(True))
                             .group_by(BookList.school_id)).all())
    stmt = select(School).order_by(School.name).limit(1000)
    if not include_inactive:
        stmt = stmt.where(School.is_active.is_(True))
    if q:
        stmt = stmt.where(School.name.ilike(f"%{q}%") | School.code.ilike(f"%{q}%"))
    return [_school_out(s, counts.get(s.id, 0)) for s in db.scalars(stmt)]


def _get_school(db: Session, school_id: uuid.UUID) -> School:
    s = db.get(School, school_id)
    if s is None:
        raise NotFound("School not found")
    return s


def _ensure_code_free(db: Session, code: str, exclude: uuid.UUID | None = None) -> None:
    q = select(School.id).where(School.code == code)
    if exclude:
        q = q.where(School.id != exclude)
    if db.scalar(q):
        raise Conflict(f"School code {code} is already in use", code="duplicate_school_code")


@router.post("/schools", status_code=201)
def create_school(body: svc.SchoolFields, ctx: AuthContext = Depends(require("schools.manage")), db: Session = Depends(get_db)):
    _ensure_code_free(db, body.code)
    s = School(id=uuid.uuid4(), **body.model_dump())
    db.add(s)
    db.flush()
    audit(db, ctx, "schools.created", entity_type="school", entity_id=s.id, details={"code": s.code})
    db.commit()
    return _school_out(s, 0)


@router.put("/schools/{school_id}")
def update_school(school_id: uuid.UUID, body: svc.SchoolFields, ctx: AuthContext = Depends(require("schools.manage")),
                  db: Session = Depends(get_db)):
    s = _get_school(db, school_id)
    _ensure_code_free(db, body.code, exclude=s.id)
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    audit(db, ctx, "schools.updated", entity_type="school", entity_id=s.id, details={"code": s.code})
    db.commit()
    return _school_out(s)


@router.get("/schools/{school_id}")
def get_school(school_id: uuid.UUID, location_id: uuid.UUID | None = None, include_archived: bool = False,
               ctx: AuthContext = Depends(require("schools.view")), db: Session = Depends(get_db)):
    """The school with every class list and the complete sets available at each location the viewer can see."""
    s = _get_school(db, school_id)
    locations = svc.viewer_locations(db, ctx, location_id)
    stmt = select(BookList).where(BookList.school_id == s.id)
    if not include_archived:
        stmt = stmt.where(BookList.is_active.is_(True))
    lists = []
    for lst in db.scalars(stmt.order_by(BookList.academic_year.desc(), BookList.class_name)):
        avail = svc.list_availability(db, lst, locations)
        lists.append({"id": lst.id, "academic_year": lst.academic_year, "class_name": lst.class_name,
                      "is_active": lst.is_active, "books": len(lst.items), "sets": avail["sets"]})
    orders = db.scalars(select(SchoolOrder).where(SchoolOrder.school_id == s.id, ctx.loc_filter(SchoolOrder.location_id))
                        .order_by(SchoolOrder.created_at.desc()).limit(50))
    return {"school": _school_out(s, len(lists)),
            "locations": [{"id": loc.id, "code": loc.code, "name": loc.name, "type": loc.type} for loc in locations],
            "lists": lists, "orders": [_order_summary(db, o) for o in orders]}


# ---------------------------------------------------------------- class book lists


class ListIn(BaseModel):
    academic_year: str
    class_name: str = Field(min_length=1, max_length=40)
    is_active: bool = True

    @field_validator("academic_year")
    @classmethod
    def _year(cls, v: str) -> str:
        return svc.normalise_academic_year(v)

    @field_validator("class_name")
    @classmethod
    def _cls(cls, v: str) -> str:
        v = svc.clean_text(v)
        if not v:
            raise ValueError("Class is required")
        return v


def _ensure_list_unique(db: Session, school_id: uuid.UUID, body: ListIn, exclude: uuid.UUID | None = None) -> None:
    q = select(BookList.id).where(BookList.school_id == school_id, BookList.academic_year == body.academic_year,
                                  func.lower(BookList.class_name) == body.class_name.lower())
    if exclude:
        q = q.where(BookList.id != exclude)
    if db.scalar(q):
        raise Conflict(f"{svc.class_label(body.class_name)} already has a list for {body.academic_year}", code="duplicate_list")


@router.post("/schools/{school_id}/lists", status_code=201)
def create_list(school_id: uuid.UUID, body: ListIn, ctx: AuthContext = Depends(require("schools.manage")),
                db: Session = Depends(get_db)):
    s = _get_school(db, school_id)
    _ensure_list_unique(db, s.id, body)
    lst = BookList(id=uuid.uuid4(), school_id=s.id, **body.model_dump())
    db.add(lst)
    db.flush()
    audit(db, ctx, "schools.list_created", entity_type="book_list", entity_id=lst.id,
          details={"school": s.code, "class": lst.class_name, "year": lst.academic_year})
    db.commit()
    return {"id": lst.id}


def _get_list(db: Session, list_id: uuid.UUID) -> BookList:
    lst = db.get(BookList, list_id)
    if lst is None:
        raise NotFound("Book list not found")
    return lst


@router.put("/book-lists/{list_id}")
def update_list(list_id: uuid.UUID, body: ListIn, ctx: AuthContext = Depends(require("schools.manage")),
                db: Session = Depends(get_db)):
    lst = _get_list(db, list_id)
    _ensure_list_unique(db, lst.school_id, body, exclude=lst.id)
    lst.academic_year, lst.class_name, lst.is_active = body.academic_year, body.class_name, body.is_active
    audit(db, ctx, "schools.list_updated", entity_type="book_list", entity_id=lst.id, details=body.model_dump())
    db.commit()
    return {"id": lst.id}


@router.get("/book-lists/{list_id}")
def get_list(list_id: uuid.UUID, location_id: uuid.UUID | None = None, ctx: AuthContext = Depends(require("schools.view")),
             db: Session = Depends(get_db)):
    lst = _get_list(db, list_id)
    avail = svc.list_availability(db, lst, svc.viewer_locations(db, ctx, location_id))
    return {"id": lst.id, "school": _school_out(lst.school), "academic_year": lst.academic_year,
            "class_name": lst.class_name, "is_active": lst.is_active, **avail}


class ListItemIn(BaseModel):
    book_id: uuid.UUID
    qty_per_set: int = Field(ge=1, le=svc.MAX_QTY_PER_SET)


class ListItemsIn(BaseModel):
    items: list[ListItemIn] = Field(max_length=300)


@router.put("/book-lists/{list_id}/items")
def set_items(list_id: uuid.UUID, body: ListItemsIn, ctx: AuthContext = Depends(require("schools.manage")),
              db: Session = Depends(get_db)):
    lst = _get_list(db, list_id)
    svc.set_list_items(db, lst, [(i.book_id, i.qty_per_set) for i in body.items])
    audit(db, ctx, "schools.list_items_set", entity_type="book_list", entity_id=lst.id, details={"books": len(body.items)})
    db.commit()
    return {"id": lst.id, "books": len(lst.items)}


# ---------------------------------------------------------------- Excel import

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


async def _read_upload(file: UploadFile) -> bytes:
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise ValidationFailed("Upload an Excel .xlsx file (Excel: File → Save As → Excel Workbook)")
    limit = get_settings().max_upload_bytes
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise ValidationFailed(f"File is larger than {limit // (1024 * 1024)} MB")
    return content


@router.get("/book-lists/import/template")
def import_template(_: AuthContext = Depends(require("schools.manage"))):
    return Response(svc.template_workbook(), media_type=XLSX,
                    headers={"Content-Disposition": "attachment; filename=school_book_list_template.xlsx"})


@router.post("/book-lists/import/preview")
async def import_preview(file: UploadFile = File(...), _: AuthContext = Depends(require("schools.manage")),
                         db: Session = Depends(get_db)):
    analysis = svc.analyse_import(db, svc.read_workbook(await _read_upload(file)))
    return analysis.summary()


@router.post("/book-lists/import/commit")
async def import_commit(file: UploadFile = File(...), ctx: AuthContext = Depends(require("schools.manage")),
                        db: Session = Depends(get_db)):
    """Re-validates the uploaded file and imports it in one transaction (all-or-nothing)."""
    analysis = svc.analyse_import(db, svc.read_workbook(await _read_upload(file)))
    result = svc.commit_import(db, ctx, analysis)
    db.commit()
    return result


# ---------------------------------------------------------------- school orders


class OrderClassIn(BaseModel):
    list_id: uuid.UUID
    sets: int = Field(ge=1, le=100000)


class OrderScopeIn(BaseModel):
    school_id: uuid.UUID
    location_id: uuid.UUID
    classes: list[OrderClassIn] = Field(min_length=1, max_length=50)


class OrderLineIn(BaseModel):
    book_id: uuid.UUID
    qty: int = Field(ge=0, le=100000)
    unit_cost: Decimal = Field(ge=0, max_digits=14, decimal_places=4)


class OrderIn(OrderScopeIn):
    lines: list[OrderLineIn] = Field(min_length=1, max_length=500)
    notes: str | None = Field(default=None, max_length=2000)
    expected_date: date | None = None


def _scope(db: Session, ctx: AuthContext, body: OrderScopeIn) -> svc.OrderScope:
    return svc.resolve_order_scope(db, ctx, body.school_id, body.location_id, [(c.list_id, c.sets) for c in body.classes])


@router.post("/school-orders/preview")
def order_preview(body: OrderScopeIn, ctx: AuthContext = Depends(require("schools.manage", "purchasing.create")),
                  db: Session = Depends(get_db)):
    scope = _scope(db, ctx, body)
    return {"school": _school_out(scope.school), "location": {"id": scope.location.id, "name": scope.location.name},
            "academic_year": scope.academic_year, "lines": svc.order_requirements(db, scope)}


def _po_brief(db: Session, po: PurchaseOrder) -> dict:
    author = db.get(Author, po.author_id) if po.author_id else None
    return {"id": po.id, "number": po.number, "status": po.status, "total": po.total,
            "supplier_name": po.supplier.name, "author_id": po.author_id, "author_name": author.name if author else None,
            "author_email": author.email if author else None, "email_opened_at": po.email_opened_at,
            "books": len(po.lines), "copies": sum(ln.qty_ordered for ln in po.lines),
            "received": sum(ln.qty_received for ln in po.lines)}


def _order_summary(db: Session, o: SchoolOrder) -> dict:
    loc = db.get(Location, o.location_id)
    creator = db.get(User, o.created_by)
    return {"id": o.id, "number": o.number, "school_id": o.school_id, "school_name": o.school.name,
            "school_code": o.school.code, "academic_year": o.academic_year, "location_id": o.location_id,
            "location_name": loc.name, "notes": o.notes, "created_at": o.created_at,
            "created_by_name": creator.full_name if creator else None,
            "classes": [{"list_id": c.list_id, "class_name": c.class_name, "sets": c.sets} for c in o.classes]}


def _order_out(db: Session, o: SchoolOrder) -> dict:
    pos = db.scalars(select(PurchaseOrder).where(PurchaseOrder.school_order_id == o.id).order_by(PurchaseOrder.number))
    return {**_order_summary(db, o), "purchase_orders": [_po_brief(db, p) for p in pos]}


@router.post("/school-orders", status_code=201)
def create_order(body: OrderIn, idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=80),
                 ctx: AuthContext = Depends(require("schools.manage", "purchasing.create")), db: Session = Depends(get_db)):
    scope = _scope(db, ctx, body)
    order = svc.create_school_order(db, ctx, scope, lines=[ln.model_dump() for ln in body.lines], notes=body.notes,
                                    expected_date=body.expected_date, idempotency_key=idempotency_key)
    db.commit()
    return _order_out(db, order)


@router.get("/school-orders/{order_id}")
def get_order(order_id: uuid.UUID, ctx: AuthContext = Depends(require("schools.view", "purchasing.view")),
              db: Session = Depends(get_db)):
    o = db.get(SchoolOrder, order_id)
    if o is None:
        raise NotFound("School order not found")
    ctx.ensure_resource(o.location_id)
    return _order_out(db, o)


# ---------------------------------------------------------------- order email template and drafts


def _template_out(db: Session) -> dict:
    tpl, customised = svc.get_template(db)
    return {**tpl.model_dump(), "customised": customised,
            "placeholders": [{"name": k, "description": v} for k, v in svc.PLACEHOLDERS.items()],
            "default": {"subject": svc.DEFAULT_SUBJECT, "body": svc.DEFAULT_BODY}}


@router.get("/school-order-email-template")
def get_email_template(_: AuthContext = Depends(require("schools.manage")), db: Session = Depends(get_db)):
    return _template_out(db)


@router.put("/school-order-email-template")
def save_email_template(body: svc.EmailTemplate, ctx: AuthContext = Depends(require("schools.manage")),
                        db: Session = Depends(get_db)):
    svc.save_template(db, body, ctx.user_id)
    audit(db, ctx, "schools.email_template_saved", entity_type="setting", entity_id=svc.TEMPLATE_KEY)
    db.commit()
    return _template_out(db)


@router.post("/school-order-email-template/preview")
def preview_email_template(body: svc.EmailTemplate, _: AuthContext = Depends(require("schools.manage"))):
    subject, text = svc.render_template(body, svc.sample_values())
    return {"subject": subject, "body": text}


def _school_po(db: Session, ctx: AuthContext, po_id: uuid.UUID, lock: bool = False) -> PurchaseOrder:
    q = select(PurchaseOrder).where(PurchaseOrder.id == po_id)
    if lock:
        q = q.with_for_update(of=PurchaseOrder)
    po = db.scalar(q)
    if po is None:
        raise NotFound("Purchase order not found")
    ctx.ensure_resource(po.location_id)
    return po


@router.get("/purchase-orders/{po_id}/author-email")
def author_email_draft(po_id: uuid.UUID, ctx: AuthContext = Depends(require("purchasing.create")),
                       db: Session = Depends(get_db)):
    """The order email for the PO's author, rendered from the saved template. Nothing is sent by the server."""
    po = _school_po(db, ctx, po_id)
    return {**svc.po_email(db, po, ctx.user.full_name), "can_open": po.status in svc.EMAILABLE_STATUSES}


@router.post("/purchase-orders/{po_id}/author-email/opened")
def author_email_opened(po_id: uuid.UUID, ctx: AuthContext = Depends(require("purchasing.create")),
                        db: Session = Depends(get_db)):
    """Records that the user opened the draft in their mail app. The system cannot know whether it was sent."""
    po = _school_po(db, ctx, po_id, lock=True)
    if po.status not in svc.EMAILABLE_STATUSES:
        raise Conflict(f"Order emails can't be opened for a purchase order that is {po.status.lower().replace('_', ' ')}")
    draft = svc.po_email(db, po, ctx.user.full_name)
    po.email_opened_at = datetime.now(UTC)
    audit(db, ctx, "purchasing.po_email_opened", entity_type="purchase_order", entity_id=po.id, location_id=po.location_id,
          details={"number": po.number, "to_domain": draft["to"].split("@")[-1]})
    db.commit()
    return {"email_opened_at": po.email_opened_at}
