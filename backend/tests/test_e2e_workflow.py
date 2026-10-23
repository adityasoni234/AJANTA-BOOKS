"""Requirement 18 (API level) and 17 (validation/failure states): one continuous business workflow
over HTTP — book setup → purchase → receipt → supplier invoice → transfer → sale with GST invoice →
partial return → register close → reports — then error-shape checks."""

from datetime import date
from decimal import Decimal as D

from tests.conftest import isbn


def test_end_to_end_business_workflow(world, client_for):
    owner, invm, acct = client_for("owner"), client_for("inv"), client_for("acct")
    mgr, cashier = client_for("fort_mgr"), client_for("fort_cashier")
    tax18 = next(t["id"] for t in owner.get("/tax-classes").json() if t["code"] == "GST18")
    tax0 = next(t["id"] for t in owner.get("/tax-classes").json() if t["code"] == "GST0")

    # 1. Catalog
    cat = owner.post("/categories", json={"name": "Poetry"}).json()
    book = invm.post("/books", json={"title": "Verses of the Western Ghats", "authors": ["R. Kavi"], "isbn13": isbn(900),
                                     "mrp": "400", "selling_price": "400", "tax_class_id": tax0, "category_id": cat["id"],
                                     "reorder_level": 3, "reorder_qty": 10}).json()
    diary = invm.post("/books", json={"title": "Poet's Diary", "mrp": "236", "selling_price": "236", "tax_class_id": tax18,
                                      "hsn_code": "4820"}).json()
    labels = invm.post("/labels", json={"book_ids": [book["id"], diary["id"]]}).json()
    assert {lbl["symbology"] for lbl in labels} == {"EAN13"}

    # 2. Purchase order → approval/issue → goods receipt (with freight) → supplier invoice
    po = invm.post("/purchase-orders", json={"supplier_id": str(world.supplier.id), "location_id": str(world.wh.id), "lines": [
        {"book_id": book["id"], "qty": 20, "unit_cost": "240"}, {"book_id": diary["id"], "qty": 10, "unit_cost": "120", "tax_rate": "18"}]}).json()
    invm.post(f"/purchase-orders/{po['id']}/submit")
    po = invm.post(f"/purchase-orders/{po['id']}/issue").json()
    assert po["status"] == "ISSUED"
    grn = invm.post("/goods-receipts", headers={"Idempotency-Key": "e2e-grn-0001"}, json={
        "location_id": str(world.wh.id), "po_id": po["id"], "freight": "120",
        "lines": [{"po_line_id": ln["id"], "qty_received": ln["qty_ordered"]} for ln in po["lines"]]}).json()
    assert grn["total_landed"] == "6120.00"
    si = acct.post("/supplier-invoices", json={"supplier_id": str(world.supplier.id), "invoice_number": "DIST/77",
                                               "invoice_date": str(date.today()), "grn_ids": [grn["id"]],
                                               "taxable_amount": "6120", "cgst": "108", "sgst": "108"}).json()
    assert si["total"] == "6336.00"

    # 3. Transfer warehouse → Fort (request, approve, dispatch, receive)
    t = mgr.post("/transfers", json={"source_location_id": str(world.wh.id), "dest_location_id": str(world.fort.id), "submit": True,
                                     "lines": [{"book_id": book["id"], "qty": 8}, {"book_id": diary["id"], "qty": 4}]}).json()
    invm.post(f"/transfers/{t['id']}/decision", json={"approve": True})
    t = invm.post(f"/transfers/{t['id']}/dispatch", json={}).json()
    t = mgr.post(f"/transfers/{t['id']}/receive", headers={"Idempotency-Key": "e2e-trf-0001"}, json={
        "lines": [{"line_id": ln["id"], "qty_received": ln["qty_dispatched"]} for ln in t["lines"]]}).json()
    assert t["status"] == "COMPLETED"

    # 4. Open register, scan by ISBN, sell with GST invoice and split tender
    reg = cashier.get(f"/registers?location_id={world.fort.id}").json()[0]
    session = cashier.post("/register-sessions", json={"register_id": reg["id"], "opening_float": "500"}).json()
    scanned = cashier.get(f"/books/lookup?code={isbn(900)}&location_id={world.fort.id}").json()
    assert scanned["book"]["stock_available"] == 8
    items = [{"book_id": book["id"], "qty": 2}, {"book_id": diary["id"], "qty": 1}]
    quote = cashier.post("/pos/quote", json={"location_id": str(world.fort.id), "items": items}).json()
    assert quote["grand_total"] == "1036.00" and quote["cgst_total"] == "18.00"
    sale = cashier.post("/pos/checkout", headers={"Idempotency-Key": "e2e-sale-0001"}, json={
        "location_id": str(world.fort.id), "register_session_id": session["id"], "items": items,
        "payments": [{"payment_method_id": str(world.methods["CASH"].id), "amount": "536", "tendered": "600"},
                     {"payment_method_id": str(world.methods["UPI"].id), "amount": "500", "reference": "UPI-E2E"}]}).json()
    inv = sale["invoice"]
    assert inv["doc_type"] == "TAX_INVOICE" and inv["seller"]["gstin"] and len(inv["number"]) <= 16
    assert sale["tax_summary"] and sale["amount_in_words"].startswith("Rupees One Thousand Thirty Six")

    # 5. Partial return of the diary (cash refund from the register)
    diary_line = next(ln for ln in sale["lines"] if ln["book_id"] == diary["id"])
    ret = cashier.post("/returns", headers={"Idempotency-Key": "e2e-ret-0001"}, json={
        "sale_id": sale["id"], "reason": "Duplicate gift", "refund_method_id": str(world.methods["CASH"].id),
        "register_session_id": session["id"], "lines": [{"sale_line_id": diary_line["id"], "qty": 1}]}).json()
    assert ret["refund_total"] == "236.00" and ret["credit_note"]["number"]

    # 6. Close register: expected = 500 float + 536 cash − 236 refund
    closed = cashier.post(f"/register-sessions/{session['id']}/close", json={"counted_cash": "800"}).json()
    assert closed["expected_cash"] == "800.00" and closed["variance"] == "0.00"

    # 7. Reports reflect everything
    summary = owner.get("/reports/sales-summary").json()
    assert summary["net_sales"] == "800.00" and summary["gst_collected"] == "0.00"
    gst = owner.get("/reports/gst-summary").json()["rows"]
    assert any(r["hsn_code"] == "4820" and D(r["taxable_value"]) == 0 for r in gst)
    stock = owner.get(f"/inventory?location_id={world.fort.id}").json()["items"]
    by_book = {s["book_id"]: s for s in stock}
    assert by_book[book["id"]]["on_hand"] == 6 and by_book[diary["id"]]["on_hand"] == 4
    assert owner.get("/inventory/reconciliation").json()["ok"] is True
    tb = owner.get("/reports/trial-balance").json()
    assert tb["balanced"]
    audit = owner.get("/audit-logs?action=pos.").json()["items"]
    assert any(a["action"] == "pos.sale_completed" for a in audit)


def test_structured_validation_errors(world, client_for):
    owner = client_for("owner")
    r = owner.post("/books", json={"title": ""})
    body = r.json()
    assert r.status_code == 422 and body["error"]["code"] == "validation_failed"
    assert body["error"]["request_id"] and isinstance(body["error"]["details"], list)
    locs = {tuple(d["loc"]) for d in body["error"]["details"]}
    assert ("body", "mrp") in locs and ("body", "tax_class_id") in locs
    r = owner.get("/books/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    r = owner.get("/reports/sales-summary?date_from=2026-01-10&date_to=2026-01-01")
    assert r.status_code == 422
    r = owner.post("/pos/checkout", json={})
    assert r.status_code == 422  # missing Idempotency-Key and body
    assert "X-Request-ID" in r.headers
