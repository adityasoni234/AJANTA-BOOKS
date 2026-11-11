"""School book lists: Excel import, sets available, location scope, school orders and author order emails."""

import io
import uuid
from decimal import Decimal

from openpyxl import Workbook, load_workbook
from sqlalchemy import func, select

from app.models import (
    Author,
    Book,
    BookList,
    Permission,
    PurchaseOrder,
    Role,
    RolePermission,
    School,
    Supplier,
)
from app.services.bootstrap import ensure_reference_data
from tests.conftest import isbn, receive

HEADERS = ["School code", "School name", "Academic year", "Class", "Title", "Author", "Author email", "ISBN",
           "Publisher", "Qty per set", "MRP", "Purchase price", "GST %"]


def xlsx(rows: list[list], headers: list[str] = HEADERS) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def upload(client, path: str, content: bytes, name: str = "list.xlsx"):
    return client.post(path, files={"file": (name, content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})


def mmps_rows() -> list[list]:
    return [
        # existing catalog book matched by ISBN
        ["MMPS", "MM Public School", "2026-27", "11", "Monsoon Novel", "A. Writer", None, isbn(1), None, None, None, None, None],
        # new book, also used in class 12 (created once)
        ["MMPS", "MM Public School", "2026-27", "11", "Physics Part I", "H. C. Verma", "hcv@authors.test", isbn(10),
         "Bharati Bhawan", 1, 450, 300, 0],
        ["MMPS", "MM Public School", "2026-2027", "12", "Physics Part I", "H. C. Verma", "hcv@authors.test", isbn(10),
         None, None, 450, 300, "0%"],
        # new book without ISBN, two copies per set
        ["MMPS", "MM Public School", "2026-27", "12", "Organic Chemistry", "O. P. Tandon", "opt@authors.test", None,
         None, 2, 300, 200, "GST0"],
    ]


def test_template_is_a_valid_workbook(client_for):
    owner = client_for("owner")
    r = owner.get("/book-lists/import/template")
    assert r.status_code == 200
    ws = load_workbook(io.BytesIO(r.content)).worksheets[0]
    assert [c.value.rstrip("*") for c in ws[1]] == HEADERS
    # the untouched template has no rows, so it can't be imported by accident
    r = upload(owner, "/book-lists/import/preview", r.content)
    assert r.status_code == 422 and "no book rows" in r.json()["error"]["message"]


def test_import_creates_schools_lists_and_books_then_reimport_replaces(db, world, client_for):
    owner = client_for("owner")
    books_before = db.scalar(select(func.count()).select_from(Book))
    r = upload(owner, "/book-lists/import/preview", xlsx(mmps_rows()))
    assert r.status_code == 200, r.text
    p = r.json()
    assert (p["valid"], p["invalid"], p["new_books"]) == (4, 0, 2)
    assert [row["action"] for row in p["rows"]] == ["MATCHED", "NEW_BOOK", "NEW_BOOK", "NEW_BOOK"]
    assert p["rows"][0]["book_id"] == str(world.books["novel"].id)
    assert p["schools"] == [{"code": "MMPS", "name": "MM Public School", "action": "CREATE"}]
    assert [(lst["class_name"], lst["books"], lst["action"]) for lst in p["lists"]] == [("11", 2, "CREATE"), ("12", 2, "CREATE")]
    assert {a["author"]: a["action"] for a in p["author_emails"]} == {"H. C. Verma": "SET", "O. P. Tandon": "SET"}
    # preview writes nothing
    assert db.scalar(select(func.count()).select_from(School)) == 0

    r = upload(owner, "/book-lists/import/commit", xlsx(mmps_rows()))
    assert r.status_code == 200, r.text
    assert r.json() == {"schools_created": 1, "lists": 2, "books_created": 2, "rows": 4}
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Book)) == books_before + 2
    school = db.scalar(select(School).where(School.code == "MMPS"))
    lists = {lst.class_name: lst for lst in db.scalars(select(BookList).where(BookList.school_id == school.id))}
    assert lists["11"].academic_year == lists["12"].academic_year == "2026-27"
    assert [(it.book.title, it.qty_per_set) for it in lists["12"].items] == [("Physics Part I", 1), ("Organic Chemistry", 2)]
    assert lists["11"].items[1].book_id == lists["12"].items[0].book_id  # one catalog book used by both classes
    physics = lists["12"].items[0].book
    assert (physics.mrp, physics.purchase_price, physics.author_names) == (Decimal("450.00"), Decimal("300.00"), ["H. C. Verma"])
    assert db.scalar(select(Author.email).where(Author.name == "H. C. Verma")) == "hcv@authors.test"

    # Re-importing class 11 with one book replaces that list; books are now matched, not duplicated.
    again = [mmps_rows()[1]]
    p = upload(owner, "/book-lists/import/preview", xlsx(again)).json()
    assert p["rows"][0]["action"] == "MATCHED"
    assert p["lists"] == [{"school_code": "MMPS", "academic_year": "2026-27", "class_name": "11", "books": 1,
                           "action": "REPLACE", "current_books": 2}]
    assert upload(owner, "/book-lists/import/commit", xlsx(again)).json()["books_created"] == 0
    db.expire_all()
    assert [it.book.title for it in db.get(BookList, lists["11"].id).items] == ["Physics Part I"]
    # a book without ISBN is matched by exact title + author on re-import
    chem = [mmps_rows()[3]]
    assert upload(owner, "/book-lists/import/preview", xlsx(chem)).json()["rows"][0]["action"] == "MATCHED"


def test_import_errors_block_the_whole_file(db, world, client_for):
    owner = client_for("owner")
    rows = [
        ["MMPS", "MM Public School", "2026-27", "11", "Physics Part I", "H. C. Verma", None, "9780306406158", None, None, 450, None, 0],
        ["MMPS", "MM Public School", "2026-27", "11", "Brand New Book", "Someone", None, None, None, None, None, None, None],
        ["MMPS", "Another Name", "2026-27", "11", "Monsoon Novel", "A. Writer", None, isbn(1), None, None, None, None, None],
        ["MMPS", "MM Public School", "2026-28", "11", "Monsoon Novel", "A. Writer", None, isbn(1), None, None, None, None, None],
        ["MMPS", "MM Public School", "2026-27", "12", "Monsoon Novel", "A. Writer", "not-an-email", isbn(1), None, 0, None, None, None],
        ["MMPS", "MM Public School", "2026-27", "11", "Monsoon Novel", "A. Writer", None, isbn(1), None, None, None, None, None],
        ["MMPS", "MM Public School", "2026-27", "11", "Monsoon Novel", "A. Writer", None, isbn(1), None, None, None, None, None],
        ["MMPS", "MM Public School", "2026-27", "11", "Gel Pen", "Pen Co", None, None, None, None, 10, None, 7],
    ]
    p = upload(owner, "/book-lists/import/preview", xlsx(rows)).json()
    errors = {row["row"]: " | ".join(row["errors"]) for row in p["rows"] if row["errors"]}
    assert "not a valid ISBN" in errors[2]
    assert "MRP is required" in errors[3] and "GST % is required" in errors[3]
    assert "use the same name" in errors[4]
    assert "consecutive years" in errors[5]
    assert "Invalid email" in errors[6] and "Qty per set" in errors[6]
    assert "already on row 7" in errors[8]
    assert "No single active tax class has GST 7%" in errors[9]
    assert 7 not in errors
    r = upload(owner, "/book-lists/import/commit", xlsx(rows))
    assert r.status_code == 422 and "Nothing was imported" in r.json()["error"]["message"]
    assert db.scalar(select(func.count()).select_from(School)) == 0


def test_import_rejects_wrong_files_and_columns(client_for):
    owner = client_for("owner")
    r = upload(owner, "/book-lists/import/preview", b"title,mrp\nX,1\n", name="list.csv")
    assert r.status_code == 422 and ".xlsx" in r.json()["error"]["message"]
    r = upload(owner, "/book-lists/import/preview", b"not a zip", name="list.xlsx")
    assert r.status_code == 422 and "Excel workbook" in r.json()["error"]["message"]
    r = upload(owner, "/book-lists/import/preview", xlsx([["MMPS"]], headers=["School code", "Titel"]))
    assert r.status_code == 422
    details = r.json()["error"]["details"]
    assert details["unknown_columns"] == ["Titel"] and "Title" in details["missing_columns"]


def _school_with_list(owner, world) -> tuple[str, str]:
    school = owner.post("/schools", json={"code": "mmps", "name": "MM Public School"}).json()
    assert school["code"] == "MMPS"
    lst = owner.post(f"/schools/{school['id']}/lists", json={"academic_year": "2026-27", "class_name": "11"}).json()
    r = owner.put(f"/book-lists/{lst['id']}/items", json={"items": [
        {"book_id": str(world.books["novel"].id), "qty_per_set": 1},
        {"book_id": str(world.books["notebook"].id), "qty_per_set": 2},
    ]})
    assert r.status_code == 200, r.text
    return school["id"], lst["id"]


def test_sets_available_per_location_and_scope(db, world, client_for):
    owner = client_for("owner")
    school_id, list_id = _school_with_list(owner, world)
    receive(db, world, world.fort, {"novel": 5, "notebook": 7})
    receive(db, world, world.pune, {"novel": 9})

    detail = owner.get(f"/book-lists/{list_id}").json()
    assert [loc["code"] for loc in detail["locations"]] == ["WH", "BLR", "FORT", "PUNE"]
    sets = {s["location_id"]: s for s in detail["sets"]}
    assert sets[str(world.fort.id)]["available"] == 3      # notebooks: 7 // 2
    assert sets[str(world.pune.id)]["available"] == 0      # no notebooks at Pune
    notebook = next(i for i in detail["items"] if i["book_id"] == str(world.books["notebook"].id))
    assert {s["location_id"]: s["available"] for s in notebook["stock"]}[str(world.fort.id)] == 7

    # an approved purchase order counts as on order, not as stock
    po = owner.post("/purchase-orders", json={"supplier_id": str(world.supplier.id), "location_id": str(world.fort.id),
                                              "lines": [{"book_id": str(world.books["notebook"].id), "qty": 4, "unit_cost": "50"}]}).json()
    assert owner.post(f"/purchase-orders/{po['id']}/submit").json()["status"] == "APPROVED"
    sets = {s["location_id"]: s for s in owner.get(f"/book-lists/{list_id}").json()["sets"]}
    assert (sets[str(world.fort.id)]["available"], sets[str(world.fort.id)]["with_on_order"]) == (3, 5)

    # shop owner sees every school's list but only their own shop's stock
    fort_mgr = client_for("fort_mgr")
    assert [s["code"] for s in fort_mgr.get("/schools").json()] == ["MMPS"]
    mine = fort_mgr.get(f"/book-lists/{list_id}").json()
    assert [loc["code"] for loc in mine["locations"]] == ["FORT"] and mine["sets"][0]["available"] == 3
    assert fort_mgr.get(f"/book-lists/{list_id}", params={"location_id": str(world.pune.id)}).status_code == 403
    overview = fort_mgr.get(f"/schools/{school_id}").json()
    assert overview["lists"][0]["sets"] == [{"location_id": str(world.fort.id), "available": 3, "with_on_order": 5}]
    # shop staff can look up sets at the counter
    assert client_for("fort_cashier").get(f"/book-lists/{list_id}").json()["sets"][0]["available"] == 3


def test_only_managers_can_change_lists_or_order(world, client_for):
    owner = client_for("owner")
    school_id, list_id = _school_with_list(owner, world)
    for key in ("fort_mgr", "fort_cashier", "acct"):
        c = client_for(key)
        assert c.post("/schools", json={"code": "X1", "name": "Some School"}).status_code == 403
        assert c.put(f"/book-lists/{list_id}/items", json={"items": []}).status_code == 403
        assert upload(c, "/book-lists/import/preview", xlsx(mmps_rows())).status_code == 403
        assert c.get("/school-order-email-template").status_code == 403
        body = {"school_id": school_id, "location_id": str(world.fort.id), "classes": [{"list_id": list_id, "sets": 1}]}
        assert c.post("/school-orders/preview", json=body).status_code == 403
    assert client_for("inv").post("/schools", json={"code": "X1", "name": "Some School"}).status_code == 201
    assert owner.post("/schools", json={"code": "X1", "name": "Other"}).status_code == 409
    assert owner.post(f"/schools/{school_id}/lists", json={"academic_year": "2026-2027", "class_name": " 11 "}).status_code == 409


def _order_setup(db, world, owner) -> tuple[str, str]:
    assert upload(owner, "/book-lists/import/commit", xlsx(mmps_rows())).status_code == 200
    school = owner.get("/schools").json()[0]
    lists = {lst["class_name"]: lst for lst in owner.get(f"/schools/{school['id']}").json()["lists"]}
    return school["id"], lists["11"]["id"]


def test_school_order_raises_one_po_per_author_and_email_draft(db, world, client_for):
    owner = client_for("owner")
    school_id, list_11 = _order_setup(db, world, owner)
    receive(db, world, world.wh, {"novel": 4})
    scope = {"school_id": school_id, "location_id": str(world.wh.id), "classes": [{"list_id": list_11, "sets": 10}]}
    prev = owner.post("/school-orders/preview", json=scope).json()
    lines = {ln["title"]: ln for ln in prev["lines"]}
    assert (lines["Monsoon Novel"]["required"], lines["Monsoon Novel"]["available"], lines["Monsoon Novel"]["suggested"]) == (10, 4, 6)
    assert lines["Monsoon Novel"]["problems"] == ["A. Writer has no email address"]
    assert lines["Physics Part I"]["unit_cost"] == "300.00" and lines["Physics Part I"]["problems"] == []

    order_lines = [{"book_id": ln["book_id"], "qty": ln["suggested"], "unit_cost": ln["unit_cost"] or "250"} for ln in prev["lines"]]
    body = {**scope, "lines": order_lines}
    r = owner.post("/school-orders", json=body, headers={"Idempotency-Key": f"so-{uuid.uuid4()}"})
    assert r.status_code == 422 and "A. Writer has no email address" in str(r.json()["error"]["details"])
    assert db.scalar(select(func.count()).select_from(PurchaseOrder)) == 0

    writer = next(a for a in owner.get("/authors", params={"q": "A. Writer"}).json())
    assert owner.put(f"/authors/{writer['id']}", json={"email": "Writer@Authors.test", "phone": "98200 00000"}).status_code == 200
    key = f"so-{uuid.uuid4()}"
    r = owner.post("/school-orders", json=body, headers={"Idempotency-Key": key})
    assert r.status_code == 201, r.text
    order = r.json()
    pos = {p["author_name"]: p for p in order["purchase_orders"]}
    assert set(pos) == {"A. Writer", "H. C. Verma"}
    assert all(p["status"] == "APPROVED" for p in pos.values())
    assert (pos["A. Writer"]["copies"], pos["H. C. Verma"]["copies"]) == (6, 10)
    # supplier accounts were created for the authors and linked for later orders
    db.expire_all()
    author = db.scalar(select(Author).where(Author.name == "H. C. Verma"))
    assert db.get(Supplier, author.supplier_id).email == "hcv@authors.test"
    # retrying with the same key does not raise more orders
    again = owner.post("/school-orders", json=body, headers={"Idempotency-Key": key}).json()
    assert again["id"] == order["id"] and db.scalar(select(func.count()).select_from(PurchaseOrder)) == 2

    po_id = pos["H. C. Verma"]["id"]
    draft = owner.get(f"/purchase-orders/{po_id}/author-email").json()
    assert draft["to"] == "hcv@authors.test" and draft["can_open"] is True
    assert draft["subject"] == f"Book order {pos['H. C. Verma']['number']}: MM Public School, Class 11 (10 sets)"
    assert "1. Physics Part I (ISBN " in draft["body"] and "- 10 copies" in draft["body"]
    assert "Please deliver to:\nWarehouse" in draft["body"] and "Regards,\nOwner" in draft["body"]
    assert owner.get(f"/purchase-orders/{po_id}").json()["email_opened_at"] is None
    assert owner.post(f"/purchase-orders/{po_id}/author-email/opened").status_code == 200
    detail = owner.get(f"/purchase-orders/{po_id}").json()
    assert detail["email_opened_at"] and detail["author_email"] == "hcv@authors.test"
    assert detail["school_order_number"] == order["number"]

    # a customised template is used for every order; bad placeholders are rejected
    tpl = {"subject": "Order {po_number} for {school_code}", "body": "Hello {author_name},\nDeliver to {delivery_location}.\n{book_lines}"}
    assert owner.put("/school-order-email-template", json=tpl).json()["customised"] is True
    draft = owner.get(f"/purchase-orders/{po_id}/author-email").json()
    assert draft["subject"] == f"Order {pos['H. C. Verma']['number']} for MMPS"
    assert draft["body"].startswith("Hello H. C. Verma,\nDeliver to Warehouse.")
    bad = owner.put("/school-order-email-template", json={**tpl, "body": "Hi {author} {0}"})
    assert bad.status_code == 422 and "Unknown placeholder {author}" in bad.text
    assert owner.put("/school-order-email-template", json={**tpl, "subject": "Books {book_lines}"}).status_code == 422
    assert owner.put("/school-order-email-template", json={**tpl, "body": "Hi {author_name"}).status_code == 422

    # cancelled orders can no longer be emailed
    owner.post(f"/purchase-orders/{po_id}/cancel", json={"reason": "school changed list"})
    assert owner.post(f"/purchase-orders/{po_id}/author-email/opened").status_code == 409


def test_order_scope_validation(db, world, client_for):
    owner = client_for("owner")
    school_id, list_11 = _order_setup(db, world, owner)
    other = owner.post("/schools", json={"code": "OTH", "name": "Other School"}).json()
    other_list = owner.post(f"/schools/{other['id']}/lists", json={"academic_year": "2025-26", "class_name": "9"}).json()
    base = {"school_id": school_id, "location_id": str(world.fort.id)}
    r = owner.post("/school-orders/preview", json={**base, "classes": [{"list_id": other_list["id"], "sets": 5}]})
    assert r.status_code == 422 and "does not belong" in r.json()["error"]["message"]
    r = owner.post("/school-orders/preview", json={**base, "classes": [{"list_id": list_11, "sets": 1}, {"list_id": list_11, "sets": 2}]})
    assert r.status_code == 422
    lst_old = owner.post(f"/schools/{school_id}/lists", json={"academic_year": "2025-26", "class_name": "11"}).json()
    owner.put(f"/book-lists/{lst_old['id']}/items", json={"items": [{"book_id": str(world.books["novel"].id), "qty_per_set": 1}]})
    r = owner.post("/school-orders/preview", json={**base, "classes": [{"list_id": list_11, "sets": 1}, {"list_id": lst_old["id"], "sets": 1}]})
    assert r.status_code == 422 and "same academic year" in r.json()["error"]["message"]
    # a book that isn't on the chosen lists can't be slipped into the order
    body = {**base, "classes": [{"list_id": list_11, "sets": 1}],
            "lines": [{"book_id": str(world.books["pen"].id), "qty": 1, "unit_cost": "10"}]}
    r = owner.post("/school-orders", json=body, headers={"Idempotency-Key": f"so-{uuid.uuid4()}"})
    assert r.status_code == 422 and "not on the selected class lists" in r.json()["error"]["message"]


def test_receiving_school_order_raises_sets_available(db, world, client_for):
    owner = client_for("owner")
    school_id, list_id = _school_with_list(owner, world)
    writer = owner.get("/authors", params={"q": "A. Writer"}).json()[0]
    owner.put(f"/authors/{writer['id']}", json={"email": "writer@authors.test"})
    # the notebook has no author yet, so give the list a second authored book instead
    owner.put(f"/book-lists/{list_id}/items", json={"items": [{"book_id": str(world.books["novel"].id), "qty_per_set": 1}]})
    scope = {"school_id": school_id, "location_id": str(world.fort.id), "classes": [{"list_id": list_id, "sets": 3}]}
    prev = owner.post("/school-orders/preview", json=scope).json()
    lines = [{"book_id": ln["book_id"], "qty": ln["suggested"], "unit_cost": "250"} for ln in prev["lines"]]
    order = owner.post("/school-orders", json={**scope, "lines": lines}, headers={"Idempotency-Key": f"so-{uuid.uuid4()}"}).json()
    po = owner.get(f"/purchase-orders/{order['purchase_orders'][0]['id']}").json()
    owner.post(f"/purchase-orders/{po['id']}/issue")
    before = owner.get(f"/book-lists/{list_id}", params={"location_id": str(world.fort.id)}).json()["sets"][0]
    assert (before["available"], before["with_on_order"]) == (0, 3)
    r = owner.post("/goods-receipts", json={"location_id": str(world.fort.id), "po_id": po["id"],
                                            "lines": [{"po_line_id": po["lines"][0]["id"], "qty_received": 3}]},
                   headers={"Idempotency-Key": f"grn-{uuid.uuid4()}"})
    assert r.status_code == 201, r.text
    after = owner.get(f"/book-lists/{list_id}", params={"location_id": str(world.fort.id)}).json()["sets"][0]
    assert (after["available"], after["with_on_order"]) == (3, 3)


def test_upgrade_grants_new_permissions_without_undoing_customisation(db, world):
    cashier = db.scalar(select(Role).where(Role.code == "CASHIER"))
    # simulate a database from before school lists existed, where an admin also removed customers.manage
    db.query(RolePermission).filter(RolePermission.permission_code.in_(["schools.view", "schools.manage"])).delete()
    db.query(Permission).filter(Permission.code.in_(["schools.view", "schools.manage"])).delete()
    db.query(RolePermission).filter(RolePermission.role_id == cashier.id,
                                    RolePermission.permission_code == "customers.manage").delete()
    db.commit()
    db.expire_all()  # a real upgrade runs in a fresh process
    ensure_reference_data(db)
    db.commit()
    db.expire_all()
    codes = db.get(Role, cashier.id).permission_codes
    assert "schools.view" in codes and "customers.manage" not in codes
    owner = db.scalar(select(Role).where(Role.code == "OWNER"))
    assert {"schools.view", "schools.manage"} <= owner.permission_codes
