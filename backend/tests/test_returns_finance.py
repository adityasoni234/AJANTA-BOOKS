"""Requirements 11–15: partial returns, register reconciliation, no double counting, balanced
immutable journals, and reports/exports reconciling to transactions."""

import csv
import io
import uuid
from datetime import date
from decimal import Decimal as D

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from app.models import (
    Account,
    ExpenseCategory,
    InventoryBalance,
    Invoice,
    JournalEntry,
    JournalLine,
    Return,
    Sale,
)
from app.services import finance, purchasing, sales
from app.services import inventory as inv
from tests.conftest import open_register, receive


def gl(db, key, location_id=None):
    q = select(func.coalesce(func.sum(JournalLine.debit - JournalLine.credit), 0)).where(
        JournalLine.account.has(system_key=key))
    if location_id:
        q = q.where(JournalLine.location_id == location_id)
    return D(db.scalar(q))


def sell(db, world, session, items, payments, *, key, customer_id=None, bill_discount=D(0), user="fort_cashier"):
    ctx = world.ctx(db, user)
    sale, _ = sales.checkout(db, ctx, idempotency_key=key, location_id=world.fort.id, register_session_id=session.id,
                             items=items, payments=payments, customer_id=customer_id, bill_discount=bill_discount,
                             discount_reason="test" if bill_discount else None)
    db.commit()
    db.refresh(sale)
    return sale


def test_partial_return_refund_and_stock_disposition(world, client_for, db):
    receive(db, world, world.fort, {"pen": 5}, cost=D("60"))
    session = open_register(db, world, "fort", "fort_cashier")
    # 3 pens @118 incl 18% with a bill discount of 4 -> exact proration through returns
    sale = sell(db, world, session, [{"book_id": world.books["pen"].id, "qty": 3}],
                [{"payment_method_id": world.methods["CASH"].id, "amount": D("350")}], key="ret-sale-1", bill_discount=D("4"))
    line = sale.lines[0]
    assert sale.grand_total == D("350.00")
    mgr = client_for("fort_mgr")
    body = {"sale_id": str(sale.id), "reason": "Ink leak", "refund_method_id": str(world.methods["CASH"].id),
            "register_session_id": str(session.id),
            "lines": [{"sale_line_id": str(line.id), "qty": 1, "disposition": "DAMAGED", "condition": "DAMAGED"}]}
    r1 = mgr.post("/returns", json=body, headers={"Idempotency-Key": "ret-0001"}).json()
    # retry is a no-op
    r1b = mgr.post("/returns", json=body, headers={"Idempotency-Key": "ret-0001"}).json()
    assert r1["id"] == r1b["id"] and r1b["replayed"]
    assert r1["status"] == "COMPLETED"
    expected_taxable = (line.taxable_value / 3).quantize(D("0.01"))
    assert D(r1["taxable_total"]) == expected_taxable
    assert r1["credit_note"]["number"].startswith("FRTC/")
    b = db.scalar(select(InventoryBalance).where(InventoryBalance.location_id == world.fort.id,
                                                 InventoryBalance.book_id == world.books["pen"].id))
    db.refresh(b)
    assert (b.on_hand, b.damaged) == (2, 1)
    # Restock the second; then the final unit returns the exact remainder incl. round-off
    body["lines"][0] |= {"disposition": "RESTOCK", "condition": "GOOD"}
    r2 = mgr.post("/returns", json=body, headers={"Idempotency-Key": "ret-0002"}).json()
    r3 = mgr.post("/returns", json=body, headers={"Idempotency-Key": "ret-0003"}).json()
    total_refunded = D(r1["refund_total"]) + D(r2["refund_total"]) + D(r3["refund_total"])
    assert total_refunded == sale.grand_total  # customer gets back exactly what they paid
    # Excess return is rejected
    r4 = mgr.post("/returns", json=body, headers={"Idempotency-Key": "ret-0004"})
    assert r4.status_code == 409 and r4.json()["error"]["code"] == "excess_return"
    db.refresh(b)
    assert (b.on_hand, b.damaged) == (4, 1)
    # GL: sales returns + output GST reversal equal the refunds; COGS reversed at original cost
    assert gl(db, "SALES_RETURNS") == sum((D(r["taxable_total"]) for r in (r1, r2, r3)), D(0))
    assert gl(db, "COGS") == D("0.00")
    assert inv.reconcile(db) == []


def test_refund_above_threshold_needs_approval_and_original_invoice_link(world, client_for, db):
    receive(db, world, world.fort, {"rare": 1})
    session = open_register(db, world, "fort", "fort_cashier")
    sale = sell(db, world, session, [{"book_id": world.books["rare"].id, "qty": 1}],
                [{"payment_method_id": world.methods["CARD"].id, "amount": D("2500"), "reference": "C9"}], key="big-sale-1")
    cashier = client_for("fort_cashier")
    r = cashier.post("/returns", headers={"Idempotency-Key": "ret-big-1"}, json={
        "sale_id": str(sale.id), "reason": "Gift duplicate", "refund_method_id": str(world.methods["CARD"].id),
        "refund_reference": "RFND1", "lines": [{"sale_line_id": str(sale.lines[0].id), "qty": 1, "disposition": "QUARANTINE"}]}).json()
    assert r["status"] == "PENDING_APPROVAL"
    db.expire_all()
    assert db.scalar(select(InventoryBalance.on_hand).where(InventoryBalance.book_id == world.books["rare"].id)) == 0
    mgr = client_for("fort_mgr")
    mgr.post(f"/approvals/{r['approval_request_id']}/decision", json={"approve": True})
    done = mgr.get(f"/returns/{r['id']}").json()
    assert done["status"] == "COMPLETED"
    cn = db.scalar(select(Invoice).where(Invoice.return_id == uuid.UUID(r["id"])))
    orig = db.scalar(select(Invoice).where(Invoice.sale_id == sale.id))
    assert cn.doc_type == "CREDIT_NOTE" and cn.original_invoice_id == orig.id
    db.expire_all()
    b = db.scalar(select(InventoryBalance).where(InventoryBalance.book_id == world.books["rare"].id))
    assert b.quarantined == 1 and b.on_hand == 0
    assert inv.reconcile(db) == []


def test_exchange_flow(world, client_for, db):
    receive(db, world, world.fort, {"novel": 3, "pen": 5})
    session = open_register(db, world, "fort", "fort_cashier")
    sale = sell(db, world, session, [{"book_id": world.books["pen"].id, "qty": 1}],
                [{"payment_method_id": world.methods["CASH"].id, "amount": D("118")}], key="exch-sale-1")
    c = client_for("fort_cashier")
    ex = c.get("/exchange-method").json()["id"]
    ret = c.post("/returns", headers={"Idempotency-Key": "exch-ret-1"}, json={
        "sale_id": str(sale.id), "reason": "Exchange for novel", "refund_method_id": ex,
        "lines": [{"sale_line_id": str(sale.lines[0].id), "qty": 1}]}).json()
    assert ret["status"] == "COMPLETED"
    body = {"location_id": str(world.fort.id), "register_session_id": str(session.id), "exchange_return_id": ret["id"],
            "items": [{"book_id": str(world.books["novel"].id), "qty": 1}],
            "payments": [{"payment_method_id": ex, "amount": ret["refund_total"]},
                         {"payment_method_id": str(world.methods["CASH"].id), "amount": str(D("500") - D(ret["refund_total"]))}]}
    r = c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "exch-sale-2"})
    assert r.status_code == 201, r.text
    # the credit can only be used once
    assert c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "exch-sale-3"}).status_code in (409, 422)
    assert gl(db, "EXCHANGE_CLEARING") == 0


def test_register_reconciliation_and_variance(world, client_for, db):
    receive(db, world, world.fort, {"novel": 5, "pen": 5})
    session = open_register(db, world, "fort", "fort_cashier", float_=D("1000"))
    sale = sell(db, world, session, [{"book_id": world.books["novel"].id, "qty": 2}],
                [{"payment_method_id": world.methods["CASH"].id, "amount": D("1000"), "tendered": D("1000")}], key="reg-1")
    sell(db, world, session, [{"book_id": world.books["pen"].id, "qty": 1}],
         [{"payment_method_id": world.methods["UPI"].id, "amount": D("118"), "reference": "U"}], key="reg-2")
    mgr = client_for("fort_mgr")
    rr = mgr.post("/returns", headers={"Idempotency-Key": "reg-ret-1"}, json={
        "sale_id": str(sale.id), "reason": "Customer return", "refund_method_id": str(world.methods["CASH"].id),
        "register_session_id": str(session.id), "lines": [{"sale_line_id": str(sale.lines[0].id), "qty": 1}]})
    assert rr.status_code == 201, rr.text
    cash = db.scalar(select(Account).where(Account.system_key == "CASH"))
    cat = db.scalar(select(ExpenseCategory).limit(1))
    finance.create_expense(db, world.ctx(db, "fort_mgr"), idempotency_key="reg-exp-1", location_id=world.fort.id,
                           category_id=cat.id, expense_date=date.today(), amount=D("50"), description="Tea", vendor=None,
                           paid_from_account_id=cash.id, register_session_id=session.id, reference=None)
    db.commit()
    detail = client_for("fort_cashier").get(f"/register-sessions/{session.id}").json()
    # 1000 float + 1000 cash sale - 500 cash refund - 50 cash expense
    assert detail["summary"]["expected_cash"] == "1450.00"
    closed = client_for("fort_cashier").post(f"/register-sessions/{session.id}/close", json={"counted_cash": "1420"}).json()
    assert closed["variance"] == "-30.00" and closed["status"] == "CLOSED"
    assert gl(db, "CASH_OVER_SHORT") == D("30.00")
    # GL cash for the outlet equals counted cash minus the float (float was not posted as an entry)
    assert gl(db, "CASH", world.fort.id) == D("420.00")
    # managers are notified of large discrepancies
    assert client_for("fort_cashier").post(f"/register-sessions/{session.id}/close", json={"counted_cash": "1"}).status_code == 409


def test_supplier_invoice_payment_and_expenses_not_double_counted(world, client_for, db):
    owner = client_for("owner")
    acct = client_for("acct")
    grn = receive(db, world, world.wh, {"novel": 10}, cost=D("300"))
    assert gl(db, "INVENTORY") == D("3000.00") and gl(db, "GRNI") == D("-3000.00")
    si = acct.post("/supplier-invoices", json={"supplier_id": str(world.supplier.id), "invoice_number": "SUP-1",
                                               "invoice_date": str(date.today()), "grn_ids": [str(grn.id)],
                                               "taxable_amount": "3000", "cgst": "0", "sgst": "0", "igst": "0"}).json()
    assert si["total"] == "3000.00" and si["balance_due"] == "3000.00"
    # The same GRN cannot be invoiced twice; the same invoice number cannot be recorded twice
    again = acct.post("/supplier-invoices", json={"supplier_id": str(world.supplier.id), "invoice_number": "SUP-2",
                                                  "invoice_date": str(date.today()), "grn_ids": [str(grn.id)], "taxable_amount": "3000"})
    assert again.status_code == 409
    assert gl(db, "GRNI") == 0 and gl(db, "AP") == D("-3000.00")
    bank = world.methods["BANK"]
    pay = {"supplier_id": str(world.supplier.id), "location_id": str(world.wh.id), "payment_method_id": str(bank.id),
           "amount": "1000", "reference": "NEFT", "payment_date": str(date.today()),
           "allocations": [{"supplier_invoice_id": si["id"], "amount": "1000"}]}
    p1 = acct.post("/supplier-payments", json=pay, headers={"Idempotency-Key": "spay-0001"}).json()
    p2 = acct.post("/supplier-payments", json=pay, headers={"Idempotency-Key": "spay-0001"}).json()
    assert p1["id"] == p2["id"] and p2["replayed"]
    over = pay | {"amount": "2500", "allocations": [{"supplier_invoice_id": si["id"], "amount": "2500"}]}
    assert acct.post("/supplier-payments", json=over, headers={"Idempotency-Key": "spay-0002"}).status_code == 422
    assert gl(db, "AP") == D("-2000.00") and gl(db, "BANK") == D("-1000.00")
    aging = acct.get("/reports/supplier-aging").json()["rows"]
    assert D(aging[0]["total"]) == D("2000.00")
    # Expenses hit P&L once (on posting), and cash flow once
    cat = db.scalar(select(ExpenseCategory).where(ExpenseCategory.name == "Rent"))
    bank_acc = db.scalar(select(Account).where(Account.system_key == "BANK"))
    acct.post("/expenses", json={"location_id": str(world.fort.id), "category_id": str(cat.id), "expense_date": str(date.today()),
                                 "amount": "8000", "description": "Rent", "paid_from_account_id": str(bank_acc.id)},
              headers={"Idempotency-Key": "exp-rent-1"})
    acct.post("/expenses", json={"location_id": str(world.fort.id), "category_id": str(cat.id), "expense_date": str(date.today()),
                                 "amount": "8000", "description": "Rent", "paid_from_account_id": str(bank_acc.id)},
              headers={"Idempotency-Key": "exp-rent-1"})
    pl = owner.get("/reports/profit-loss").json()
    assert D(pl["total_operating_expenses"]) == D("8000.00")
    cf = owner.get("/reports/cash-flow").json()
    lines = {x["activity"]: x for x in cf["lines"]}
    assert D(lines["Operating expenses paid"]["outflow"]) == D("8000.00")
    assert D(lines["Payments to suppliers"]["outflow"]) == D("1000.00")
    # Expense approval threshold for managers
    mgr = client_for("fort_mgr")
    e = mgr.post("/expenses", json={"location_id": str(world.fort.id), "category_id": str(cat.id), "expense_date": str(date.today()),
                                    "amount": "6000", "description": "Repairs", "paid_from_account_id": str(bank_acc.id)}).json()
    assert e["status"] == "PENDING_APPROVAL"
    assert D(owner.get("/reports/profit-loss").json()["total_operating_expenses"]) == D("8000.00")


def test_every_journal_balances_and_posted_entries_are_immutable(world, client_for, db):
    receive(db, world, world.fort, {"novel": 3, "pen": 3})
    session = open_register(db, world, "fort", "fort_cashier")
    sell(db, world, session, [{"book_id": world.books["novel"].id, "qty": 1}, {"book_id": world.books["pen"].id, "qty": 2}],
         [{"payment_method_id": world.methods["CASH"].id, "amount": D("736")}], key="je-1")
    unbalanced = db.execute(text(
        "select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)")).all()
    assert unbalanced == []
    assert db.scalar(select(func.count()).select_from(JournalEntry)) >= 2
    # DB rejects unbalanced postings at commit
    acc = db.scalar(select(Account).where(Account.system_key == "CASH"))
    je_id = uuid.uuid4()
    db.add(JournalEntry(id=je_id, number="JV-TEST-1", entry_date=date.today(), source_type="MANUAL"))
    db.flush()
    db.add(JournalLine(entry_id=je_id, account_id=acc.id, debit=D("10"), credit=D("0")))
    db.add(JournalLine(entry_id=je_id, account_id=acc.id, debit=D("0"), credit=D("9")))
    with pytest.raises(DBAPIError):
        db.commit()
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE journal_lines SET debit = debit + 1"))
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE sales SET grand_total = 1"))
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE invoices SET number = 'X'"))
    db.rollback()
    # Manual journals: authorised users only, must balance, corrections by reversal
    acct = client_for("acct")
    bank = db.scalar(select(Account).where(Account.system_key == "BANK"))
    cap = db.scalar(select(Account).where(Account.system_key == "OWNER_CAPITAL"))
    bad = {"entry_date": str(date.today()), "memo": "Capital", "lines": [
        {"account_id": str(bank.id), "debit": "100"}, {"account_id": str(cap.id), "credit": "90"}]}
    assert acct.post("/journals", json=bad).status_code == 422
    good = bad | {"lines": [{"account_id": str(bank.id), "debit": "100"}, {"account_id": str(cap.id), "credit": "100"}]}
    je = acct.post("/journals", json=good).json()
    assert client_for("fort_mgr").post("/journals", json=good).status_code == 403
    rev = acct.post(f"/journals/{je['id']}/reverse", json={"reason": "Typo"}).json()
    assert rev["reversal_of_id"] == je["id"]
    assert acct.post(f"/journals/{je['id']}/reverse", json={"reason": "Again"}).status_code == 409
    tb = acct.get("/reports/trial-balance").json()
    assert tb["balanced"] is True


def test_reports_and_exports_reconcile_to_transactions(world, client_for, db):
    receive(db, world, world.fort, {"novel": 10, "pen": 10}, cost=D("60"))
    receive(db, world, world.pune, {"novel": 10})
    s1 = open_register(db, world, "fort", "fort_cashier")
    s2 = open_register(db, world, "pune", "pune_cashier")
    sale = sell(db, world, s1, [{"book_id": world.books["novel"].id, "qty": 2}, {"book_id": world.books["pen"].id, "qty": 1}],
                [{"payment_method_id": world.methods["UPI"].id, "amount": D("1118"), "reference": "U"}], key="rep-1")
    ctx = world.ctx(db, "pune_cashier")
    sales.checkout(db, ctx, idempotency_key="rep-2", location_id=world.pune.id, register_session_id=s2.id,
                   items=[{"book_id": world.books["novel"].id, "qty": 1}],
                   payments=[{"payment_method_id": world.methods["CASH"].id, "amount": D("500")}])
    db.commit()
    rr = client_for("fort_mgr").post("/returns", headers={"Idempotency-Key": "rep-ret-1"}, json={
        "sale_id": str(sale.id), "reason": "Customer return", "refund_method_id": str(world.methods["UPI"].id), "refund_reference": "R",
        "lines": [{"sale_line_id": str(sale.lines[0].id), "qty": 1}]})
    assert rr.status_code == 201, rr.text
    owner = client_for("owner")
    summary = owner.get("/reports/sales-summary").json()
    db_taxable = db.scalar(select(func.sum(Sale.taxable_total)).where(Sale.status == "COMPLETED"))
    db_ret = db.scalar(select(func.sum(Return.taxable_total)).where(Return.status == "COMPLETED"))
    assert D(summary["net_sales"]) == db_taxable - db_ret == D("1100.00")
    # GL revenue agrees with the sales report
    assert -(gl(db, "SALES") + gl(db, "SALES_RETURNS")) == D(summary["net_sales"])
    assert D(summary["gst_collected"]) == -(gl(db, "OUTPUT_CGST") + gl(db, "OUTPUT_SGST") + gl(db, "OUTPUT_IGST"))
    pl = owner.get("/reports/profit-loss").json()
    assert D(pl["cogs"]) == D(summary["cogs"])
    # Dashboard uses the same numbers; outlet scope narrows them
    dash = owner.get("/dashboard").json()
    assert dash["summary"]["net_sales"] == summary["net_sales"]
    fort_mgr_dash = client_for("fort_mgr").get("/dashboard").json()
    assert D(fort_mgr_dash["summary"]["net_sales"]) == D("600.00")
    # CSV export equals the JSON report
    rows = owner.get("/reports/sales-by?dim=location").json()["rows"]
    exported = list(csv.DictReader(io.StringIO(owner.get("/reports/sales-by?dim=location&format=csv").text)))
    assert {r["label"]: r["net_sales"] for r in rows} == {r["label"]: r["net_sales"] for r in exported}
    # Exports respect scope: a pune user exporting sees only pune
    pune_mgr = client_for("pune_mgr")
    pune_rows = list(csv.DictReader(io.StringIO(pune_mgr.get("/reports/sales-by?dim=location&format=csv").text)))
    assert [r["label"] for r in pune_rows] == ["Pune"]
    # GST register nets credit notes; inventory valuation equals the GL inventory balance
    reg = owner.get("/reports/gst-register").json()
    assert D(reg["totals"]["taxable_value"]) == D(summary["net_sales"])
    val = owner.get("/reports/inventory-valuation").json()
    assert D(val["gl_difference"]) == 0
    bs = owner.get("/reports/balance-sheet").json()
    assert bs["balanced"] is True and bs["complete"] is False and bs["warnings"]


def test_supplier_return_reduces_stock_and_payable(world, client_for, db):
    grn = receive(db, world, world.wh, {"novel": 5}, cost=D("300"))
    ctx = world.ctx(db, "inv")
    sr, _ = purchasing.return_to_supplier(db, ctx, idempotency_key="srn-001", supplier_id=world.supplier.id,
                                          location_id=world.wh.id, grn_id=grn.id, reason="Misprint",
                                          lines=[{"book_id": world.books["novel"].id, "qty": 2, "from_bucket": "ON_HAND"}])
    db.commit()
    assert sr.value == D("600.00")
    db.expire_all()
    assert db.scalar(select(InventoryBalance.on_hand).where(InventoryBalance.book_id == world.books["novel"].id)) == 3
    assert gl(db, "AP") == D("600.00")  # debit note pending against supplier
    assert inv.reconcile(db) == []
