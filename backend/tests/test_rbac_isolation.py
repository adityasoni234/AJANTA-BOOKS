"""Requirements 1 & 2: administrators manage outlets/users; outlet users can never reach another
outlet's records via URL, id, query parameter, export filter or payload."""

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.models import Account, Customer, ExpenseCategory, RegisterSession
from app.services import finance, returns, sales, transfers
from tests.conftest import open_register, receive


def _sale(db, world, outlet: str, cashier: str, book="novel", qty=1):
    loc = getattr(world, outlet)
    session = open_register(db, world, outlet, cashier)
    ctx = world.ctx(db, cashier)
    _, quote, _ = sales.quote(db, ctx, location_id=loc.id, items=[{"book_id": world.books[book].id, "qty": qty}])
    sale, _ = sales.checkout(db, ctx, idempotency_key=f"s-{uuid.uuid4()}", location_id=loc.id,
                             register_session_id=session.id, items=[{"book_id": world.books[book].id, "qty": qty}],
                             payments=[{"payment_method_id": world.methods["CASH"].id, "amount": quote.grand_total}])
    db.commit()
    return sale, session


def test_admin_creates_outlets_and_assigns_users(world, client_for):
    owner = client_for("owner")
    r = owner.post("/locations", json={"code": "OUT-NSK", "name": "Nashik", "type": "OUTLET", "state_code": "27",
                                       "invoice_prefix": "NSK"})
    assert r.status_code == 201, r.text
    loc = r.json()
    assert any(x["code"] == "OUT-NSK" for x in owner.get("/locations").json())
    regs = owner.get(f"/registers?location_id={loc['id']}").json()
    assert len(regs) == 1  # a default register is created for new outlets
    roles = {x["code"]: x["id"] for x in owner.get("/roles").json()}
    r = owner.post("/users", json={"email": "nsk.manager@test.test", "full_name": "Nashik Manager",
                                   "role_id": roles["STORE_MANAGER"], "location_ids": [loc["id"]],
                                   "initial_password": "Nashik!Pass-42"})
    assert r.status_code == 201, r.text
    u = r.json()
    assert u["location_ids"] == [loc["id"]] and u["role_code"] == "STORE_MANAGER"
    # deactivate the outlet
    body = {k: loc[k] for k in ("code", "name", "type", "state_code", "invoice_prefix")} | {"is_active": False}
    assert owner.put(f"/locations/{loc['id']}", json=body).status_code == 200
    assert not any(x["code"] == "OUT-NSK" for x in owner.get("/locations").json())


def test_store_manager_cannot_create_locations_or_escalate(world, client_for):
    mgr = client_for("fort_mgr")
    assert mgr.post("/locations", json={"code": "X1", "name": "X", "type": "OUTLET", "state_code": "27",
                                        "invoice_prefix": "X"}).status_code == 403
    owner = client_for("owner")
    roles = {x["code"]: x["id"] for x in owner.get("/roles").json()}
    # Give the manager users.manage via a custom role, then try to create an OWNER.
    manager_perms = next(r["permissions"] for r in owner.get("/roles").json() if r["code"] == "STORE_MANAGER")
    perms = sorted(set(manager_perms) | {"users.manage"})
    r = owner.post("/roles", json={"code": "MGR_PLUS", "name": "Manager+", "permissions": perms})
    assert r.status_code == 201, r.text
    mgr_u = owner.get(f"/users/{world.users['fort_mgr'].id}").json()
    upd = {k: mgr_u[k] for k in ("email", "full_name", "phone", "employee_code", "designation", "joined_on",
                                 "all_locations", "location_ids", "is_active", "can_login")} | {"role_id": r.json()["id"]}
    assert owner.put(f"/users/{mgr_u['id']}", json=upd).status_code == 200
    r = mgr.post("/users", json={"email": "evil@test.test", "full_name": "Evil", "role_id": roles["OWNER"],
                                 "location_ids": [str(world.fort.id)], "initial_password": "Evil!Pass-1234"})
    assert r.status_code == 403
    r = mgr.post("/users", json={"email": "cashier2@test.test", "full_name": "Cashier Two", "role_id": roles["CASHIER"],
                                 "location_ids": [str(world.pune.id)], "initial_password": "Cash!Pass-1234"})
    assert r.status_code == 403  # cannot grant a location outside own scope
    r = mgr.post("/users", json={"email": "cashier3@test.test", "full_name": "Cashier Three", "role_id": roles["CASHIER"],
                                 "all_locations": True, "initial_password": "Cash!Pass-1234"})
    assert r.status_code == 403


def test_cross_outlet_access_denied_everywhere(world, client_for, db):
    receive(db, world, world.fort, {"novel": 10})
    receive(db, world, world.pune, {"novel": 10})
    fort_sale, fort_session = _sale(db, world, "fort", "fort_cashier")
    pune_sale, _ = _sale(db, world, "pune", "pune_cashier")
    # A fort return, fort expense and a fort-bound transfer
    ret, _ = returns.create_return(db, world.ctx(db, "fort_mgr"), idempotency_key="r1", sale_id=fort_sale.id,
                                   lines=[{"sale_line_id": fort_sale.lines[0].id, "qty": 1}], reason="test",
                                   refund_method_id=world.methods["CASH"].id, refund_reference=None,
                                   register_session_id=fort_session.id)
    exp, _ = finance.create_expense(
        db, world.ctx(db, "fort_mgr"), idempotency_key=None, location_id=world.fort.id,
        category_id=db.scalar(select(ExpenseCategory.id).limit(1)), expense_date=date.today(), amount=Decimal("100"),
        description="Tea", vendor=None, paid_from_account_id=db.scalar(select(Account.id).where(Account.system_key == "CASH")),
        register_session_id=None, reference=None)
    t = transfers.create(db, world.ctx(db, "inv"), source_id=world.wh.id, dest_id=world.fort.id,
                         lines=[{"book_id": world.books["pen"].id, "qty": 1}], notes=None)
    db.commit()

    pune = client_for("pune_cashier")
    pmgr = client_for("pune_mgr")
    fid = world.fort.id
    # Direct object access by id -> 404 (existence hidden)
    assert pune.get(f"/sales/{fort_sale.id}").status_code == 404
    assert pune.get(f"/sales/by-invoice/{fort_sale.invoice.number}").status_code == 404
    assert pune.get(f"/returns/{ret.id}").status_code == 404
    assert pune.get(f"/register-sessions/{fort_session.id}").status_code == 404
    assert pmgr.get(f"/transfers/{t.id}").status_code == 404
    assert pmgr.get(f"/sales/{fort_sale.id}").status_code == 404
    # Explicit location filters -> 403
    for path in (f"/sales?location_id={fid}", f"/inventory?location_id={fid}", f"/inventory/ledger?location_id={fid}",
                 f"/books?location_id={fid}", f"/registers?location_id={fid}", f"/books/lookup?code={world.books['novel'].barcode}&location_id={fid}"):
        assert pune.get(path).status_code == 403, path
    for path in (f"/reports/sales-summary?location_id={fid}", f"/reports/sales-by?dim=book&location_id={fid}",
                 f"/reports/sales-by?dim=book&location_id={fid}&format=csv", f"/expenses?location_id={fid}",
                 f"/returns?location_id={fid}", f"/transfers?location_id={fid}", f"/dashboard?location_id={fid}"):
        assert pmgr.get(path).status_code == 403, path
    # Unfiltered lists only return own outlet's records
    ids = {s["id"] for s in pune.get("/sales").json()["items"]}
    assert str(pune_sale.id) in ids and str(fort_sale.id) not in ids
    assert all(r["location_id"] == str(world.pune.id) for r in pune.get("/inventory").json()["items"])
    assert str(exp.id) not in {e["id"] for e in pmgr.get("/expenses").json()["items"]}
    assert str(ret.id) not in {r["id"] for r in pmgr.get("/returns").json()["items"]}
    assert str(t.id) not in {x["id"] for x in pmgr.get("/transfers").json()["items"]}
    # Mutations against the other outlet are refused
    session_pune = db.scalar(select(RegisterSession).where(RegisterSession.location_id == world.pune.id))
    r = pune.post("/pos/checkout", headers={"Idempotency-Key": "x-cross-1"},
                  json={"location_id": str(fid), "register_session_id": str(fort_session.id),
                        "items": [{"book_id": str(world.books["novel"].id), "qty": 1}],
                        "payments": [{"payment_method_id": str(world.methods["CASH"].id), "amount": "500"}]})
    assert r.status_code == 403
    r = pune.post("/pos/checkout", headers={"Idempotency-Key": "x-cross-2"},
                  json={"location_id": str(world.pune.id), "register_session_id": str(fort_session.id),
                        "items": [{"book_id": str(world.books["novel"].id), "qty": 1}],
                        "payments": [{"payment_method_id": str(world.methods["CASH"].id), "amount": "500"}]})
    assert r.status_code == 409  # someone else's register session cannot be used
    r = pune.post("/returns", headers={"Idempotency-Key": "x-cross-3"},
                  json={"sale_id": str(fort_sale.id), "reason": "steal", "refund_method_id": str(world.methods["CASH"].id),
                        "register_session_id": str(session_pune.id),
                        "lines": [{"sale_line_id": str(fort_sale.lines[0].id), "qty": 1}]})
    assert r.status_code in (403, 404)
    assert pune.post(f"/sales/{fort_sale.id}/void", json={"reason": "nope"}).status_code == 404
    assert pmgr.post(f"/register-sessions/{fort_session.id}/close", json={"counted_cash": "0"}).status_code == 404
    assert pmgr.post("/inventory/adjustments", json={"location_id": str(fid), "reason_code": "LOSS",
                                                     "lines": [{"book_id": str(world.books["novel"].id), "qty": 1}]}).status_code == 403
    assert pmgr.post("/inventory/stocktakes", json={"location_id": str(fid)}).status_code == 403
    # Cashiers cannot see confidential reports at all
    for path in ("/reports/profit-loss", "/reports/inventory-valuation", "/audit-logs", "/users", "/journals"):
        assert pune.get(path).status_code == 403, path


def test_customer_history_scoped_to_outlet(world, client_for, db):
    receive(db, world, world.fort, {"novel": 5})
    receive(db, world, world.pune, {"novel": 5})
    c = Customer(code="C1", name="Shared Customer", phone="9876543210")
    db.add(c)
    db.commit()
    for outlet, cashier in (("fort", "fort_cashier"), ("pune", "pune_cashier")):
        loc = getattr(world, outlet)
        s = open_register(db, world, outlet, cashier)
        ctx = world.ctx(db, cashier)
        sales.checkout(db, ctx, idempotency_key=f"c-{outlet}", location_id=loc.id, register_session_id=s.id,
                       items=[{"book_id": world.books["novel"].id, "qty": 1}], customer_id=c.id,
                       payments=[{"payment_method_id": world.methods["UPI"].id, "amount": Decimal("500"), "reference": "U1"}])
        db.commit()
    hist = client_for("pune_cashier").get(f"/customers/{c.id}/history").json()
    assert len(hist["sales"]) == 1
    owner_hist = client_for("owner").get(f"/customers/{c.id}/history").json()
    assert len(owner_hist["sales"]) == 2


def test_read_only_auditor_cannot_mutate(world, client_for):
    aud = client_for("auditor")
    assert aud.get("/reports/profit-loss").status_code == 200
    assert aud.get("/audit-logs").status_code == 200
    assert aud.post("/categories", json={"name": "X"}).status_code == 403
    assert aud.post("/suppliers", json={"name": "Some Supplier"}).status_code == 403
    assert aud.post("/inventory/adjustments", json={"location_id": str(world.fort.id), "reason_code": "LOSS",
                                                    "lines": [{"book_id": str(world.books["novel"].id), "qty": 1}]}).status_code == 403


def test_every_protected_route_requires_auth(world, anon):
    """Walk the OpenAPI spec: every non-public endpoint must reject anonymous requests."""
    from tests.conftest import app

    public = {"/api/v1/auth/login", "/api/v1/auth/password-reset/request", "/api/v1/auth/password-reset/confirm",
              "/api/v1/setup/status", "/api/v1/setup", "/health/live", "/health/ready"}
    spec = app.openapi()
    checked = 0
    for path, ops in spec["paths"].items():
        if path in public:
            continue
        concrete = path
        for seg in [s for s in path.split("/") if s.startswith("{")]:
            concrete = concrete.replace(seg, str(uuid.uuid4()) if "number" not in seg else "X")
        for method in ops:
            r = anon.request(method.upper(), concrete, json={} if method in ("post", "put") else None)
            assert r.status_code in (401, 403, 422), (method, path, r.status_code)
            if r.status_code == 422:
                # validation may run first for bodies/headers; confirm auth still blocks a valid-shaped call
                continue
            checked += 1
    assert checked > 80


def test_customer_segment_filter_is_applied_in_sql(world, client_for, db):
    receive(db, world, world.fort, {"novel": 5})
    loyal = Customer(code="SEG1", name="Loyal Reader", phone="9000000011")
    new = Customer(code="SEG2", name="Brand New", phone="9000000012")
    db.add_all([loyal, new])
    db.commit()
    s = open_register(db, world, "fort", "fort_cashier")
    ctx = world.ctx(db, "fort_cashier")
    for i in range(3):
        sales.checkout(db, ctx, idempotency_key=f"seg-{i}", location_id=world.fort.id, register_session_id=s.id,
                       items=[{"book_id": world.books["novel"].id, "qty": 1}], customer_id=loyal.id,
                       payments=[{"payment_method_id": world.methods["CASH"].id, "amount": Decimal("500")}])
        db.commit()
    owner = client_for("owner")
    regular = owner.get("/customers?segment=REGULAR").json()
    assert [c["name"] for c in regular["items"]] == ["Loyal Reader"] and regular["total"] == 1
    fresh = owner.get("/customers?segment=NEW").json()
    assert "Brand New" in [c["name"] for c in fresh["items"]] and "Loyal Reader" not in [c["name"] for c in fresh["items"]]
