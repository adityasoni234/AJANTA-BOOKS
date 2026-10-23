"""Requirements 3, 5 (+ catalog/inventory behaviour): duplicate identifiers, GRN exactly-once,
adjustments, stocktakes, copies, reconciliation and ledger immutability."""

import io
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.models import Book, IndividualCopy, InventoryBalance, InventoryLedger, PurchaseOrder
from app.services import inventory as inv
from app.services import purchasing
from tests.conftest import isbn, receive


def _book_payload(world, **over):
    tax = next(iter([b.tax_class_id for b in world.books.values()]))
    return {"title": "Fresh Title", "authors": ["Someone"], "mrp": "300", "selling_price": "280", "tax_class_id": str(tax)} | over


def bal(db, loc, book) -> InventoryBalance:
    db.expire_all()
    return db.scalar(select(InventoryBalance).where(InventoryBalance.location_id == loc.id, InventoryBalance.book_id == book.id))


def test_duplicate_isbn_and_barcode_rejected_by_api(world, client_for):
    owner = client_for("owner")
    r = owner.post("/books", json=_book_payload(world, isbn13=world.books["novel"].isbn13))
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_isbn"
    # ISBN-10 of an existing ISBN-13 is the same book
    from app.services.identifiers import isbn13_to_10

    r = owner.post("/books", json=_book_payload(world, isbn10=isbn13_to_10(world.books["novel"].isbn13)))
    assert r.status_code == 409
    r = owner.post("/books", json=_book_payload(world, barcode=world.books["pen"].barcode))
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_barcode"
    r = owner.post("/books", json=_book_payload(world, isbn13="9780306406158"))
    assert r.status_code == 422  # bad checksum
    r = owner.post("/books", json=_book_payload(world, isbn13=isbn(77)))
    assert r.status_code == 201
    assert r.json()["barcode"] == isbn(77)  # ISBN used as scannable barcode by default
    r = owner.post("/books", json=_book_payload(world, title="No ISBN item"))
    assert r.status_code == 201 and r.json()["barcode"].startswith("200")


def test_duplicate_identifiers_rejected_by_database_constraints(world, db):
    novel = world.books["novel"]
    dup = Book(sku="DUP-1", barcode="X-UNIQUE-1", isbn13=novel.isbn13, title="dup", tax_class_id=novel.tax_class_id,
               mrp=Decimal(1), selling_price=Decimal(1))
    db.add(dup)
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
    db.add(Book(sku="DUP-2", barcode=novel.barcode, title="dup", tax_class_id=novel.tax_class_id, mrp=Decimal(1),
                selling_price=Decimal(1)))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_price_validation_and_history(world, client_for):
    owner = client_for("owner")
    r = owner.post("/books", json=_book_payload(world, selling_price="400"))
    assert r.status_code == 422  # selling price > MRP
    b = owner.post("/books", json=_book_payload(world)).json()
    upd = _book_payload(world, selling_price="250", change_reason="Festival pricing")
    assert owner.put(f"/books/{b['id']}", json=upd).status_code == 200
    hist = owner.get(f"/books/{b['id']}/price-history").json()
    assert any(h["field"] == "SELLING_PRICE" and h["new_value"] == "250.00" and h["reason"] == "Festival pricing" for h in hist)
    # Users without catalog.price_edit cannot change prices
    inv_mgr = client_for("inv")
    assert inv_mgr.put(f"/books/{b['id']}", json=_book_payload(world, selling_price="240")).status_code == 422


def test_lookup_by_isbn_barcode_sku_and_copy(world, client_for, db):
    owner = client_for("owner")
    novel = world.books["novel"]
    for code in (novel.isbn13, novel.sku, novel.barcode, novel.isbn10):
        assert owner.get(f"/books/lookup?code={code}").json()["book"]["id"] == str(novel.id)
    receive(db, world, world.wh, {"rare": 1})
    copy = db.scalar(select(IndividualCopy))
    r = owner.get(f"/books/lookup?code={copy.copy_code}").json()
    assert r["copy_id"] == str(copy.id) and r["book"]["id"] == str(world.books["rare"].id)
    assert owner.get("/books/lookup?code=0000").status_code == 404


def test_csv_import_preview_and_atomic_commit(world, client_for):
    owner = client_for("owner")
    csv = ("title,authors,isbn13,mrp,selling_price,tax_class,category\n"
           f"Import One,Ann;Bob,{isbn(501)},300,280,GST0,\n"
           f"Import Two,Cy,{isbn(502)},200,,GST0,\n"
           f"Bad Row,Dee,{world.books['novel'].isbn13},100,100,GST0,\n")
    r = owner.post("/books/import/preview", files={"file": ("b.csv", io.BytesIO(csv.encode()), "text/csv")})
    data = r.json()
    assert data["valid"] == 2 and data["invalid"] == 1
    r = owner.post("/books/import/commit", files={"file": ("b.csv", io.BytesIO(csv.encode()), "text/csv")})
    assert r.status_code == 422  # all-or-nothing
    good = "\n".join(csv.splitlines()[:3]) + "\n"
    r = owner.post("/books/import/commit", files={"file": ("b.csv", io.BytesIO(good.encode()), "text/csv")})
    assert r.status_code == 200 and r.json()["created"] == 2
    exported = owner.get("/books/export.csv").text
    assert "Import One" in exported and "Ann;Bob" in exported


def test_goods_receipt_increases_stock_exactly_once(world, client_for, db):
    owner = client_for("owner")
    po = owner.post("/purchase-orders", json={"supplier_id": str(world.supplier.id), "location_id": str(world.wh.id),
                                              "lines": [{"book_id": str(world.books["novel"].id), "qty": 10, "unit_cost": "300"}]}).json()
    assert owner.post(f"/purchase-orders/{po['id']}/submit").json()["status"] == "APPROVED"
    assert owner.post(f"/purchase-orders/{po['id']}/issue").json()["status"] == "ISSUED"
    line_id = po["lines"][0]["id"]
    body = {"location_id": str(world.wh.id), "po_id": po["id"], "lines": [{"po_line_id": line_id, "qty_received": 6}]}
    r1 = owner.post("/goods-receipts", json=body, headers={"Idempotency-Key": "grn-retry-001"})
    r2 = owner.post("/goods-receipts", json=body, headers={"Idempotency-Key": "grn-retry-001"})
    assert r1.status_code == 201 and r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"] and r2.json()["replayed"] is True
    assert bal(db, world.wh, world.books["novel"]).on_hand == 6
    assert db.scalar(select(func.count()).select_from(InventoryLedger).where(InventoryLedger.movement_type == "PURCHASE_RECEIPT")) == 1
    p = owner.get(f"/purchase-orders/{po['id']}").json()
    assert p["status"] == "PARTIALLY_RECEIVED" and p["lines"][0]["qty_outstanding"] == 4
    # Over-receipt is refused; backorder can then be received
    over = body | {"lines": [{"po_line_id": line_id, "qty_received": 5}]}
    assert owner.post("/goods-receipts", json=over, headers={"Idempotency-Key": "grn-over-001"}).status_code == 409
    rest = body | {"lines": [{"po_line_id": line_id, "qty_received": 3, "qty_damaged": 1}]}
    assert owner.post("/goods-receipts", json=rest, headers={"Idempotency-Key": "grn-rest-001"}).status_code == 201
    b = bal(db, world.wh, world.books["novel"])
    assert (b.on_hand, b.damaged) == (9, 1)
    assert owner.get(f"/purchase-orders/{po['id']}").json()["status"] == "RECEIVED"
    assert b.avg_cost == Decimal("300.0000")


def test_landed_cost_allocation_and_weighted_average(world, db):
    receive(db, world, world.wh, {"novel": 10}, cost=Decimal("200"))
    ctx = world.ctx(db, "owner")
    purchasing.receive_goods(db, ctx, idempotency_key="landed-1", location_id=world.wh.id, supplier_id=world.supplier.id,
                             po_id=None, lines=[{"book_id": world.books["novel"].id, "qty_received": 10, "unit_cost": "300"}],
                             freight=Decimal("100"), other_charges=Decimal("0"), supplier_ref=None, notes=None)
    db.commit()
    b = bal(db, world.wh, world.books["novel"])
    # (10*200 + 10*310) / 20 = 255
    assert b.on_hand == 20 and b.avg_cost == Decimal("255.0000")


def test_po_approval_threshold(world, client_for, db):
    from app.services.settings import get_policy, save_policy

    p = get_policy(db)
    p.po_approval_threshold = Decimal("1000")
    save_policy(db, p, None)
    db.commit()
    # A role that can create but not approve POs
    owner = client_for("owner")
    r = owner.post("/roles", json={"code": "BUYER", "name": "Buyer", "permissions": ["purchasing.view", "purchasing.create", "suppliers.view"]})
    payload = owner.get(f"/users/{world.users['inv'].id}").json()
    upd = {k: payload[k] for k in ("email", "full_name", "phone", "employee_code", "designation", "joined_on",
                                   "all_locations", "location_ids", "is_active", "can_login")} | {"role_id": r.json()["id"]}
    owner.put(f"/users/{payload['id']}", json=upd)
    buyer = client_for("inv")
    po = buyer.post("/purchase-orders", json={"supplier_id": str(world.supplier.id), "location_id": str(world.wh.id),
                                              "lines": [{"book_id": str(world.books["novel"].id), "qty": 10, "unit_cost": "300"}]}).json()
    assert buyer.post(f"/purchase-orders/{po['id']}/submit").json()["status"] == "PENDING_APPROVAL"
    assert buyer.post(f"/purchase-orders/{po['id']}/issue").status_code == 409
    appr = owner.get("/approvals").json()["items"]
    assert len(appr) == 1 and appr[0]["can_decide"]
    assert owner.post(f"/approvals/{appr[0]['id']}/decision", json={"approve": True}).status_code == 200
    assert db.get(PurchaseOrder, uuid.UUID(po["id"])).status == "APPROVED"


def test_adjustments_require_approval_above_threshold_and_post_journal(world, client_for, db):
    receive(db, world, world.fort, {"novel": 10}, cost=Decimal("300"))
    mgr = client_for("fort_mgr")
    r = mgr.post("/inventory/adjustments", json={"location_id": str(world.fort.id), "reason_code": "LOSS",
                                                 "lines": [{"book_id": str(world.books["novel"].id), "qty": 5}]})
    assert r.status_code == 201 and r.json()["status"] == "PENDING_APPROVAL"
    assert bal(db, world.fort, world.books["novel"]).on_hand == 10
    owner = client_for("owner")
    req = owner.get("/approvals").json()["items"][0]
    owner.post(f"/approvals/{req['id']}/decision", json={"approve": True})
    assert bal(db, world.fort, world.books["novel"]).on_hand == 5
    # Damage moves stock between buckets without leaving inventory
    r = mgr.post("/inventory/adjustments", json={"location_id": str(world.fort.id), "reason_code": "DAMAGE",
                                                 "lines": [{"book_id": str(world.books["novel"].id), "qty": 1}]})
    assert r.json()["status"] == "POSTED"
    b = bal(db, world.fort, world.books["novel"])
    assert (b.on_hand, b.damaged) == (4, 1)
    # cannot remove more than on hand
    r = owner.post("/inventory/adjustments", json={"location_id": str(world.fort.id), "reason_code": "LOSS",
                                                   "lines": [{"book_id": str(world.books["novel"].id), "qty": 50}]})
    assert r.status_code == 409


def test_stocktake_posts_variances(world, client_for, db):
    receive(db, world, world.fort, {"novel": 10, "pen": 20})
    owner = client_for("owner")
    st = owner.post("/inventory/stocktakes", json={"location_id": str(world.fort.id)}).json()
    owner.post(f"/inventory/stocktakes/{st['id']}/counts", json=[
        {"code": world.books["novel"].isbn13, "counted_qty": 8}, {"book_id": str(world.books["pen"].id), "counted_qty": 21}])
    r = owner.post(f"/inventory/stocktakes/{st['id']}/post").json()
    assert r["status"] == "POSTED" and r["adjustment_status"] == "POSTED"
    assert bal(db, world.fort, world.books["novel"]).on_hand == 8
    assert bal(db, world.fort, world.books["pen"]).on_hand == 21


def test_copy_tracking_and_reconciliation(world, db, client_for):
    receive(db, world, world.wh, {"rare": 3})
    b = bal(db, world.wh, world.books["rare"])
    copies = list(db.scalars(select(IndividualCopy).where(IndividualCopy.book_id == world.books["rare"].id)))
    assert b.on_hand == 3 and len(copies) == 3 and len({c.copy_code for c in copies}) == 3
    assert inv.reconcile(db) == []
    # Copy-tracked stock is counted once in aggregate inventory
    summary = client_for("owner").get("/inventory/summary").json()
    wh = next(s for s in summary if s["location_id"] == str(world.wh.id))
    assert wh["on_hand"] == 3
    # Adjust a specific copy to damaged
    ctx = world.ctx(db, "owner")
    inv.create_adjustment(db, ctx, location_id=world.wh.id, reason_code="DAMAGE",
                          lines=[{"book_id": world.books["rare"].id, "qty": 1, "copy_ids": [copies[0].id]}], notes=None)
    db.commit()
    db.refresh(copies[0])
    assert copies[0].status == "DAMAGED"
    assert inv.reconcile(db) == []
    detail = client_for("owner").get(f"/copies/{copies[0].id}").json()
    assert [e["event_type"] for e in detail["events"]] == ["CREATED", "ADJ_DAMAGE"]


def test_ledger_and_audit_are_append_only(world, db):
    receive(db, world, world.wh, {"novel": 1})
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE inventory_ledger SET qty_delta = 100"))
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("DELETE FROM inventory_ledger"))
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("DELETE FROM audit_logs"))
    db.rollback()


def test_negative_stock_blocked_by_database(world, db):
    receive(db, world, world.wh, {"novel": 1})
    with pytest.raises(IntegrityError):
        db.execute(text("UPDATE inventory_balances SET on_hand = -1"))
    db.rollback()


def test_book_merge_moves_stock_and_preserves_history(world, client_for, db):
    owner = client_for("owner")
    dup = owner.post("/books", json=_book_payload(world, title="Monsoon Novel (dup)")).json()
    receive(db, world, world.wh, {"novel": 2})
    from app.services import purchasing as pur

    pur.receive_goods(db, world.ctx(db, "owner"), idempotency_key="dup-grn", location_id=world.wh.id,
                      supplier_id=world.supplier.id, po_id=None, lines=[{"book_id": dup["id"], "qty_received": 3, "unit_cost": "100"}],
                      freight=Decimal(0), other_charges=Decimal(0), supplier_ref=None, notes=None)
    db.commit()
    r = owner.post(f"/books/{dup['id']}/merge", json={"into_book_id": str(world.books["novel"].id), "reason": "Duplicate record"})
    assert r.status_code == 200
    assert bal(db, world.wh, world.books["novel"]).on_hand == 5
    merged = db.get(Book, uuid.UUID(dup["id"]))
    assert merged.status == "ARCHIVED" and merged.merged_into_id == world.books["novel"].id
    assert db.scalar(select(func.count()).select_from(InventoryLedger).where(InventoryLedger.book_id == merged.id)) >= 2
    assert inv.reconcile(db) == []
