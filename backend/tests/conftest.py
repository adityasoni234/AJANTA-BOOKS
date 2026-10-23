"""Test fixtures. Uses an isolated PostgreSQL database (TEST_DATABASE_URL, default ajanta_test),
migrated with Alembic once per session (so DB triggers are exercised) and truncated per test."""

import os
import uuid
from dataclasses import dataclass
from decimal import Decimal

os.environ["APP_ENV"] = "test"
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://localhost:5432/ajanta_test"
)
os.environ.setdefault("SECRET_KEY", "test-secret-key-0123456789-abcdefghijklmnopqrstuvwxyz")
os.environ["COOKIE_SECURE"] = "false"
os.environ["LOG_LEVEL"] = "WARNING"
os.environ["LOG_JSON"] = "false"
os.environ["UPLOAD_DIR"] = os.path.join(os.path.dirname(__file__), ".uploads")

if "ajanta_test" not in os.environ["DATABASE_URL"] and os.environ.get("ALLOW_NON_TEST_DB") != "1":
    raise RuntimeError("Refusing to run tests against a database whose name does not contain 'ajanta_test'")

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

from app.api.deps import AuthContext  # noqa: E402
from app.core.db import get_engine, session_factory  # noqa: E402
from app.core.ratelimit import limiter  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    Base,
    Location,
    Organization,
    PaymentMethod,
    Register,
    Role,
    Supplier,
    TaxClass,
    User,
    UserLocation,
)
from app.services import finance, purchasing  # noqa: E402
from app.services.auth import set_password  # noqa: E402
from app.services.bootstrap import ensure_reference_data  # noqa: E402
from app.services.catalog import BookIn, create_book  # noqa: E402
from app.services.gst import gstin_checksum_char  # noqa: E402
from app.services.identifiers import ean13_check_digit  # noqa: E402
from app.services.settings import PolicySettings, save_policy  # noqa: E402

PASSWORD = "Test@Passw0rd!"
BACKEND = os.path.dirname(os.path.dirname(__file__))


@pytest.fixture(scope="session", autouse=True)
def migrated_db():
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    cfg = Config(os.path.join(BACKEND, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND, "alembic"))
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
def clean_db(migrated_db):
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    with get_engine().begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
        conn.execute(text("ALTER SEQUENCE journal_entry_seq RESTART; ALTER SEQUENCE payment_seq RESTART"))
    limiter.reset()
    yield


@pytest.fixture
def db():
    s = session_factory()()
    yield s
    s.rollback()
    s.close()


def gstin(state: str, pan: str = "AABCA1234F") -> str:
    first = f"{state}{pan}1Z"
    return first + gstin_checksum_char(first)


def isbn(n: int) -> str:
    body = f"97893{n:07d}"
    return body + ean13_check_digit(body)


def make_ctx(db, user: User) -> AuthContext:
    db.refresh(user)
    return AuthContext(user=user, session_id=uuid.uuid4(), permissions=set(user.role.permission_codes),
                       all_locations=user.all_locations, location_ids=set(user.location_ids))


@dataclass
class World:
    org: Organization
    wh: Location
    fort: Location
    pune: Location
    blr: Location
    users: dict
    books: dict
    supplier: Supplier
    registers: dict
    methods: dict

    def ctx(self, db, key: str) -> AuthContext:
        return make_ctx(db, db.get(User, self.users[key].id))


@pytest.fixture
def world(db) -> World:
    ensure_reference_data(db)
    org = Organization(legal_name="Test Books Pvt Ltd", trade_name="Test Books", gstin=gstin("27"),
                       gst_registration_type="REGULAR", state_code="27")
    db.add(org)
    save_policy(db, PolicySettings(credit_sales_enabled=True, loyalty_enabled=True), None)
    wh = Location(code="WH", name="Warehouse", type="WAREHOUSE", state_code="27", invoice_prefix="WH")
    fort = Location(code="FORT", name="Fort", type="OUTLET", state_code="27", invoice_prefix="FRT", gstin=gstin("27"))
    pune = Location(code="PUNE", name="Pune", type="OUTLET", state_code="27", invoice_prefix="PNQ", gstin=gstin("27"))
    blr = Location(code="BLR", name="Bengaluru", type="OUTLET", state_code="29", invoice_prefix="BLR", gstin=gstin("29"))
    db.add_all([wh, fort, pune, blr])
    db.flush()
    registers = {k: Register(location_id=loc.id, name="Counter 1") for k, loc in (("fort", fort), ("pune", pune), ("blr", blr))}
    db.add_all(registers.values())
    roles = {r.code: r for r in db.scalars(select(Role))}

    def user(key, role, locs=(), all_locs=False):
        u = User(email=f"{key}@test.test", full_name=key.title(), role_id=roles[role].id, all_locations=all_locs)
        u.location_links = [UserLocation(location_id=loc.id) for loc in locs]
        set_password(db, u, PASSWORD)
        db.add(u)
        return u

    users = {
        "owner": user("owner", "OWNER", all_locs=True),
        "inv": user("inv", "INVENTORY_MANAGER", all_locs=True),
        "acct": user("acct", "ACCOUNTANT", all_locs=True),
        "auditor": user("auditor", "AUDITOR", all_locs=True),
        "fort_mgr": user("fortmgr", "STORE_MANAGER", [fort]),
        "fort_cashier": user("fortcashier", "CASHIER", [fort]),
        "pune_mgr": user("punemgr", "STORE_MANAGER", [pune]),
        "pune_cashier": user("punecashier", "CASHIER", [pune]),
        "blr_cashier": user("blrcashier", "CASHIER", [blr]),
    }
    db.flush()
    sup = Supplier(code="S0001", name="Test Distributor", state_code="27", payment_terms_days=30)
    db.add(sup)
    db.flush()
    tc = {t.code: t for t in db.scalars(select(TaxClass))}
    owner_id = users["owner"].id
    books = {
        "novel": create_book(db, BookIn(title="Monsoon Novel", authors=["A. Writer"], isbn13=isbn(1), mrp=Decimal("500"),
                                        selling_price=Decimal("500"), min_selling_price=Decimal("400"),
                                        tax_class_id=tc["GST0"].id, reorder_level=2), owner_id),
        "pen": create_book(db, BookIn(title="Gel Pen", mrp=Decimal("118"), selling_price=Decimal("118"),
                                      tax_class_id=tc["GST18"].id, hsn_code="9608"), owner_id),
        "notebook": create_book(db, BookIn(title="Notebook", mrp=Decimal("112"), selling_price=Decimal("112"),
                                           tax_class_id=tc["GST12"].id, hsn_code="4820"), owner_id),
        "rare": create_book(db, BookIn(title="Signed First Edition", isbn13=isbn(2), mrp=Decimal("2500"),
                                       selling_price=Decimal("2500"), tax_class_id=tc["GST0"].id, tracking_mode="COPY"), owner_id),
    }
    methods = {m.code: m for m in db.scalars(select(PaymentMethod))}
    db.commit()
    return World(org=org, wh=wh, fort=fort, pune=pune, blr=blr, users=users, books=books, supplier=sup,
                 registers=registers, methods=methods)


def receive(db, world: World, location: Location, items: dict[str, int], *, cost: Decimal | None = None, key=None):
    """Receive stock (without PO) through the real GRN service."""
    ctx = world.ctx(db, "owner")
    lines = [{"book_id": world.books[k].id, "qty_received": q,
              "unit_cost": cost if cost is not None else (world.books[k].mrp * Decimal("0.6")).quantize(Decimal("0.01"))}
             for k, q in items.items()]
    grn, _ = purchasing.receive_goods(db, ctx, idempotency_key=key or f"grn-{uuid.uuid4()}", location_id=location.id,
                                      supplier_id=world.supplier.id, po_id=None, lines=lines, freight=Decimal(0),
                                      other_charges=Decimal(0), supplier_ref=None, notes=None)
    db.commit()
    return grn


def open_register(db, world: World, key: str, user_key: str, float_=Decimal("1000")):
    s = finance.open_session(db, world.ctx(db, user_key), world.registers[key].id, float_)
    db.commit()
    return s


class ApiClient(TestClient):
    """TestClient that logs in and sends the CSRF header on unsafe requests."""

    csrf: str | None = None

    def login(self, email: str, password: str = PASSWORD):
        r = self.post("/api/v1/auth/login", json={"email": email, "password": password})
        if r.status_code == 200:
            self.csrf = r.json()["csrf_token"]
        return r

    def request(self, method, url, *args, headers=None, **kwargs):
        headers = dict(headers or {})
        if self.csrf and method.upper() not in ("GET", "HEAD", "OPTIONS"):
            headers.setdefault("X-CSRF-Token", self.csrf)
        if url.startswith("/") and not url.startswith("/api/") and not url.startswith("/health"):
            url = "/api/v1" + url
        return super().request(method, url, *args, headers=headers, **kwargs)


@pytest.fixture
def client_for(world):
    clients = []

    def _make(user_key: str) -> ApiClient:
        c = ApiClient(app, raise_server_exceptions=True)
        r = c.login(world.users[user_key].email)
        assert r.status_code == 200, r.text
        clients.append(c)
        return c

    yield _make
    for c in clients:
        c.close()


@pytest.fixture
def anon():
    with ApiClient(app) as c:
        yield c
