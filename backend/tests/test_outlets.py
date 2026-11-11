"""Owner's outlet supervision: per-location figures, reconciliation with reports, and location scope."""

from decimal import Decimal as D

from tests.conftest import open_register, receive


def _sell(world, client, session_id, items: dict[str, int], key: str):
    body = {"location_id": str(world.fort.id), "register_session_id": str(session_id),
            "items": [{"book_id": str(world.books[k].id), "qty": q} for k, q in items.items()]}
    quote = client.post("/pos/quote", json={"location_id": body["location_id"], "items": body["items"]}).json()
    body["payments"] = [{"payment_method_id": str(world.methods["CASH"].id), "amount": quote["grand_total"]}]
    r = client.post("/pos/checkout", json=body, headers={"Idempotency-Key": key})
    assert r.status_code == 201, r.text
    return r.json()


def test_outlet_overview_figures_match_reports(db, world, client_for):
    receive(db, world, world.fort, {"novel": 6, "pen": 10}, cost=D("50"))
    receive(db, world, world.pune, {"novel": 2})
    session = open_register(db, world, "fort", "fort_cashier")
    sale = _sell(world, client_for("fort_cashier"), session.id, {"novel": 2, "pen": 1}, "outlet-sale-0001")

    owner = client_for("owner")
    o = owner.get(f"/outlets/{world.fort.id}/overview").json()
    report = owner.get("/reports/sales-summary", params={"location_id": str(world.fort.id)}).json()
    for period in ("today", "week", "month"):
        assert o["sales"][period]["invoice_value"] == sale["grand_total"] == "1118.00"
        assert o["sales"][period]["transactions"] == 1
    assert o["sales"]["today"]["net_sales"] == report["net_sales"]
    # 6 novels + 10 pens received, 2 + 1 sold
    assert (o["stock"]["available"], o["stock"]["titles_available"]) == (13, 2)
    assert o["stock"]["retail_value"] == "3062.00"  # 4 novels x 500 + 9 pens x 118, at selling price
    cats = {c["category"]: c["units"] for c in o["stock_by_category"]}
    assert cats == {"Uncategorised": 13}
    assert [b["label"] for b in o["top_books_month"]] == ["Monsoon Novel", "Gel Pen"]
    assert [c["label"] for c in o["cashiers_month"]] == ["Fortcashier"]
    assert o["open_registers"][0]["cashier"] == "Fortcashier"
    assert {s["full_name"] for s in o["staff"]} == {"Fortmgr", "Fortcashier"}
    assert o["stock"]["cost_value"] is not None and o["sales"]["today"]["gross_profit"] is not None

    summary = owner.get("/outlets/summary").json()
    rows = {r["location"]["code"]: r for r in summary["locations"]}
    assert list(rows) == ["WH", "BLR", "FORT", "PUNE"]
    assert rows["FORT"]["sales"]["today"]["invoice_value"] == "1118.00"
    assert rows["PUNE"]["sales"]["today"]["transactions"] == 0 and rows["PUNE"]["stock"]["available"] == 2
    assert rows["FORT"]["open_registers"] == 1


def test_outlet_view_respects_location_scope_and_financial_access(db, world, client_for):
    receive(db, world, world.fort, {"novel": 3}, cost=D("50"))
    mgr = client_for("fort_mgr")
    assert [r["location"]["code"] for r in mgr.get("/outlets/summary").json()["locations"]] == ["FORT"]
    assert mgr.get(f"/outlets/{world.fort.id}/overview").status_code == 200
    assert mgr.get(f"/outlets/{world.pune.id}/overview").status_code == 403
    # store managers have no confidential financial reports: no cost or profit figures
    o = mgr.get(f"/outlets/{world.fort.id}/overview").json()
    assert o["stock"]["cost_value"] is None and o["sales"]["month"]["gross_profit"] is None
    assert all(c["cost_value"] is None for c in o["stock_by_category"])
    # cashiers have no dashboard access at all
    assert client_for("fort_cashier").get("/outlets/summary").status_code == 403
