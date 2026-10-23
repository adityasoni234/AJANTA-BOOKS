"""Requirements 4, 7, 8, 9, 10 (integration): copies sold once, concurrency, checkout invariants,
idempotent retries, GST selection, split payments, discount approvals, voids, credit sales, exchanges."""

import threading
import uuid
from decimal import Decimal as D

from sqlalchemy import func, select

from app.core.db import session_factory
from app.models import (
    Customer,
    IndividualCopy,
    InventoryBalance,
    InventoryLedger,
    Invoice,
    JournalEntry,
    JournalLine,
    Payment,
    PaymentAllocation,
    Sale,
)
from app.services import inventory as inv
from app.services import sales
from tests.conftest import gstin, make_ctx, open_register, receive


def onhand(db, loc, book):
    db.expire_all()
    return db.scalar(select(InventoryBalance.on_hand).where(InventoryBalance.location_id == loc.id,
                                                            InventoryBalance.book_id == book.id))


def checkout_body(world, session, items, payments, **extra):
    return {"location_id": str(world.fort.id), "register_session_id": str(session.id),
            "items": items, "payments": payments} | extra


def test_checkout_creates_invoice_stock_payments_and_balanced_journal(world, client_for, db):
    receive(db, world, world.fort, {"novel": 5, "pen": 5}, cost=D("50"))
    session = open_register(db, world, "fort", "fort_cashier")
    c = client_for("fort_cashier")
    q = c.post("/pos/quote", json={"location_id": str(world.fort.id), "items": [
        {"book_id": str(world.books["novel"].id), "qty": 2}, {"book_id": str(world.books["pen"].id), "qty": 1}]}).json()
    # novel 2 x 500 (exempt) + pen 118 incl. 18% -> 100 + 9 + 9
    assert q["taxable_total"] == "1100.00" and q["cgst_total"] == "9.00" and q["sgst_total"] == "9.00"
    assert q["grand_total"] == "1118.00" and q["doc_type"] == "TAX_INVOICE"
    body = checkout_body(world, session, [{"book_id": str(world.books["novel"].id), "qty": 2},
                                          {"book_id": str(world.books["pen"].id), "qty": 1}],
                         [{"payment_method_id": str(world.methods["CASH"].id), "amount": "600", "tendered": "1000"},
                          {"payment_method_id": str(world.methods["UPI"].id), "amount": "518", "reference": "UPI123"}])
    r = c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-chk-0001"})
    assert r.status_code == 201, r.text
    sale = r.json()
    assert sale["invoice"]["number"] == "FRT/" + sale["invoice"]["number"].split("/")[1] + "/000001"
    assert sale["grand_total"] == "1118.00" and sale["balance_due"] == "0.00"
    cash = next(p for p in sale["payments"] if p["method_kind"] == "CASH")
    assert cash["change_given"] == "400.00"
    assert onhand(db, world.fort, world.books["novel"]) == 3 and onhand(db, world.fort, world.books["pen"]) == 4
    sid = uuid.UUID(sale["id"])
    assert db.scalar(select(func.count()).select_from(InventoryLedger).where(InventoryLedger.ref_id == sid,
                                                                             InventoryLedger.movement_type == "SALE")) == 2
    assert db.scalar(select(func.sum(PaymentAllocation.amount)).where(PaymentAllocation.sale_id == sid)) == D("1118.00")
    je = db.scalar(select(JournalEntry).where(JournalEntry.source_type == "SALE", JournalEntry.source_id == sid))
    by_key = {}
    for ln in je.lines:
        by_key[ln.account.system_key] = by_key.get(ln.account.system_key, D(0)) + ln.debit - ln.credit
    assert by_key["SALES"] == D("-1100.00") and by_key["OUTPUT_CGST"] == D("-9.00") and by_key["OUTPUT_SGST"] == D("-9.00")
    assert by_key["CASH"] == D("600.00") and by_key["UPI_CLEARING"] == D("518.00")
    assert by_key["COGS"] == D("150.00") and by_key["INVENTORY"] == D("-150.00")
    assert sum(ln.debit for ln in je.lines) == sum(ln.credit for ln in je.lines)


def test_server_ignores_client_prices_and_totals(world, client_for, db):
    receive(db, world, world.fort, {"novel": 2})
    session = open_register(db, world, "fort", "fort_cashier")
    c = client_for("fort_cashier")
    body = checkout_body(world, session, [{"book_id": str(world.books["novel"].id), "qty": 1, "unit_price": "1", "grand_total": "1"}],
                         [{"payment_method_id": str(world.methods["CASH"].id), "amount": "1"}])
    r = c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-chk-cheat"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "payment_incomplete" or r.status_code == 403
    assert onhand(db, world.fort, world.books["novel"]) == 2


def test_retried_checkout_is_idempotent(world, client_for, db):
    receive(db, world, world.fort, {"novel": 5})
    session = open_register(db, world, "fort", "fort_cashier")
    c = client_for("fort_cashier")
    body = checkout_body(world, session, [{"book_id": str(world.books["novel"].id), "qty": 1}],
                         [{"payment_method_id": str(world.methods["CASH"].id), "amount": "500"}])
    ids = {c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-chk-retry-1"}).json()["id"] for _ in range(3)}
    assert len(ids) == 1
    assert onhand(db, world.fort, world.books["novel"]) == 4
    assert db.scalar(select(func.count()).select_from(Sale)) == 1
    assert db.scalar(select(func.count()).select_from(Payment)) == 1
    assert db.scalar(select(func.count()).select_from(Invoice)) == 1


def test_concurrent_sales_cannot_oversell(world, db):
    receive(db, world, world.fort, {"novel": 5})
    session = open_register(db, world, "fort", "fort_cashier")
    results: list[str] = []
    barrier = threading.Barrier(10)

    def worker(i):
        s = session_factory()()
        try:
            from app.models import User

            ctx = make_ctx(s, s.get(User, world.users["fort_cashier"].id))
            barrier.wait()
            sales.checkout(s, ctx, idempotency_key=f"conc-{i}", location_id=world.fort.id, register_session_id=session.id,
                           items=[{"book_id": world.books["novel"].id, "qty": 1}],
                           payments=[{"payment_method_id": world.methods["CASH"].id, "amount": D("500")}])
            s.commit()
            results.append("ok")
        except Exception as e:  # noqa: BLE001
            s.rollback()
            results.append(type(e).__name__)
        finally:
            s.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("ok") == 5
    assert all(r in ("ok", "Conflict") for r in results)
    assert onhand(db, world.fort, world.books["novel"]) == 0
    assert inv.reconcile(db) == []
    numbers = list(db.scalars(select(Invoice.number)))
    assert len(numbers) == len(set(numbers)) == 5


def test_individual_copy_cannot_be_sold_twice(world, client_for, db):
    receive(db, world, world.fort, {"rare": 2})
    copy = db.scalar(select(IndividualCopy).order_by(IndividualCopy.copy_code))
    session = open_register(db, world, "fort", "fort_cashier")
    c = client_for("fort_cashier")
    body = checkout_body(world, session, [{"copy_id": str(copy.id), "qty": 1}],
                         [{"payment_method_id": str(world.methods["CARD"].id), "amount": "2500", "reference": "C1"}])
    assert c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-copy-1"}).status_code == 201
    r = c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-copy-2"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "copy_unavailable"
    # the same copy twice in one cart
    other = db.scalar(select(IndividualCopy).where(IndividualCopy.id != copy.id))
    body2 = checkout_body(world, session, [{"copy_id": str(other.id)}, {"copy_id": str(other.id)}],
                          [{"payment_method_id": str(world.methods["CARD"].id), "amount": "5000", "reference": "C2"}])
    assert c.post("/pos/checkout", json=body2, headers={"Idempotency-Key": "idem-copy-3"}).status_code == 422
    db.expire_all()
    assert db.get(IndividualCopy, copy.id).status == "SOLD"
    assert onhand(db, world.fort, world.books["rare"]) == 1
    assert inv.reconcile(db) == []


def test_concurrent_sale_of_same_copy(world, db):
    receive(db, world, world.fort, {"rare": 1})
    copy = db.scalar(select(IndividualCopy))
    session = open_register(db, world, "fort", "fort_cashier")
    results = []
    barrier = threading.Barrier(4)

    def worker(i):
        s = session_factory()()
        try:
            from app.models import User

            ctx = make_ctx(s, s.get(User, world.users["fort_cashier"].id))
            barrier.wait()
            sales.checkout(s, ctx, idempotency_key=f"cc-{i}", location_id=world.fort.id, register_session_id=session.id,
                           items=[{"copy_id": copy.id}],
                           payments=[{"payment_method_id": world.methods["CARD"].id, "amount": D("2500"), "reference": "x"}])
            s.commit()
            results.append("ok")
        except Exception as e:  # noqa: BLE001
            s.rollback()
            results.append(type(e).__name__)
        finally:
            s.close()

    ts = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert results.count("ok") == 1


def test_interstate_b2b_sale_uses_igst(world, client_for, db):
    receive(db, world, world.fort, {"pen": 3})
    cust = Customer(code="CB2B", name="Karnataka School", gstin=gstin("29", "AAFCB4321Q"), state_code="29")
    db.add(cust)
    db.commit()
    session = open_register(db, world, "fort", "fort_cashier")
    c = client_for("fort_cashier")
    body = checkout_body(world, session, [{"book_id": str(world.books["pen"].id), "qty": 1}],
                         [{"payment_method_id": str(world.methods["BANK"].id), "amount": "118", "reference": "NEFT1"}],
                         customer_id=str(cust.id))
    s = c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-igst-1"}).json()
    assert s["is_interstate"] is True and s["igst_total"] == "18.00" and s["cgst_total"] == "0.00"
    assert s["invoice"]["place_of_supply"] == "29" and s["invoice"]["buyer"]["gstin"] == cust.gstin


def test_discount_limits_and_approval_flow(world, client_for, db):
    receive(db, world, world.fort, {"novel": 5})
    session = open_register(db, world, "fort", "fort_cashier")
    c = client_for("fort_cashier")
    items = [{"book_id": str(world.books["novel"].id), "qty": 1}]
    within = checkout_body(world, session, items, [{"payment_method_id": str(world.methods["CASH"].id), "amount": "450"}],
                           bill_discount="50", discount_reason="Member")
    assert c.post("/pos/checkout", json=within, headers={"Idempotency-Key": "idem-disc-1"}).status_code == 201
    big = checkout_body(world, session, items, [{"payment_method_id": str(world.methods["CASH"].id), "amount": "425"}],
                        bill_discount="75", discount_reason="Damaged corner")
    r = c.post("/pos/checkout", json=big, headers={"Idempotency-Key": "idem-disc-2"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "discount_approval_required"
    # below minimum selling price (400) also needs approval
    req = c.post("/pos/discount-approvals", json={"location_id": str(world.fort.id), "items": items, "bill_discount": "75",
                                                  "reason": "Damaged corner"}).json()
    mgr = client_for("fort_mgr")
    assert c.post(f"/approvals/{req['id']}/decision", json={"approve": True}).status_code == 403  # cashier can't approve
    assert mgr.post(f"/approvals/{req['id']}/decision", json={"approve": True}).status_code == 200
    big["discount_approval_id"] = req["id"]
    assert c.post("/pos/checkout", json=big, headers={"Idempotency-Key": "idem-disc-3"}).status_code == 201
    # approval is single-use
    assert c.post("/pos/checkout", json=big, headers={"Idempotency-Key": "idem-disc-4"}).status_code == 403


def test_void_sale_restocks_refunds_and_reverses_journal(world, client_for, db):
    receive(db, world, world.fort, {"novel": 2}, cost=D("300"))
    session = open_register(db, world, "fort", "fort_cashier")
    c = client_for("fort_cashier")
    sale = c.post("/pos/checkout", headers={"Idempotency-Key": "idem-void-1"}, json=checkout_body(
        world, session, [{"book_id": str(world.books["novel"].id), "qty": 1}],
        [{"payment_method_id": str(world.methods["CASH"].id), "amount": "500"}])).json()
    r = c.post(f"/sales/{sale['id']}/void", json={"reason": "Wrong item"})
    assert r.json()["status"] == "PENDING_APPROVAL"  # cashier lacks pos.void
    mgr = client_for("fort_mgr")
    req = mgr.get("/approvals").json()["items"][0]
    assert mgr.post(f"/approvals/{req['id']}/decision", json={"approve": True}).status_code == 200
    s = mgr.get(f"/sales/{sale['id']}").json()
    assert s["status"] == "CANCELLED" and s["invoice"]["status"] == "CANCELLED"
    assert onhand(db, world.fort, world.books["novel"]) == 2
    net = db.scalar(select(func.sum(JournalLine.debit - JournalLine.credit)).join(JournalEntry)
                    .where(JournalEntry.source_id == uuid.UUID(sale["id"])).where(JournalLine.account.has(system_key="SALES")))
    assert net == 0
    # invoice number is never reused
    sale2 = c.post("/pos/checkout", headers={"Idempotency-Key": "idem-void-2"}, json=checkout_body(
        world, session, [{"book_id": str(world.books["novel"].id), "qty": 1}],
        [{"payment_method_id": str(world.methods["CASH"].id), "amount": "500"}])).json()
    assert sale2["invoice"]["number"] != sale["invoice"]["number"]
    assert inv.reconcile(db) == []


def test_credit_sale_and_customer_receipt(world, client_for, db):
    receive(db, world, world.fort, {"novel": 3})
    cust = Customer(code="CR1", name="Credit Customer", phone="9999988888", credit_limit=D("800"))
    db.add(cust)
    db.commit()
    session = open_register(db, world, "fort", "fort_mgr")
    mgr = client_for("fort_mgr")
    cashier = client_for("fort_cashier")
    body = checkout_body(world, session, [{"book_id": str(world.books["novel"].id), "qty": 1}],
                         [{"payment_method_id": str(world.methods["CASH"].id), "amount": "100"}], customer_id=str(cust.id))
    assert cashier.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-cr-0"}).status_code == 403
    s = mgr.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-cr-1"})
    assert s.status_code == 201 and s.json()["balance_due"] == "400.00"
    over = checkout_body(world, session, [{"book_id": str(world.books["novel"].id), "qty": 1}], [], customer_id=str(cust.id))
    assert mgr.post("/pos/checkout", json=over, headers={"Idempotency-Key": "idem-cr-2"}).json()["error"]["code"] == "credit_limit"
    rec = {"location_id": str(world.fort.id), "payment_method_id": str(world.methods["UPI"].id), "amount": "400",
           "reference": "UPI9", "allocations": [{"sale_id": s.json()["id"], "amount": "400"}]}
    r1 = mgr.post(f"/customers/{cust.id}/receipts", json=rec, headers={"Idempotency-Key": "idem-rcpt-1"})
    r2 = mgr.post(f"/customers/{cust.id}/receipts", json=rec, headers={"Idempotency-Key": "idem-rcpt-1"})
    assert r1.json()["id"] == r2.json()["id"] and r2.json()["replayed"]
    assert mgr.get(f"/sales/{s.json()['id']}").json()["balance_due"] == "0.00"
    ar = db.scalar(select(func.sum(JournalLine.debit - JournalLine.credit)).where(JournalLine.account.has(system_key="AR")))
    assert ar == 0


def test_register_must_be_open_and_store_credit_payment(world, client_for, db):
    receive(db, world, world.fort, {"pen": 3})
    c = client_for("fort_cashier")
    sess = open_register(db, world, "fort", "fort_cashier")
    c.post(f"/register-sessions/{sess.id}/close", json={"counted_cash": "1000"})
    body = checkout_body(world, sess, [{"book_id": str(world.books["pen"].id), "qty": 1}],
                         [{"payment_method_id": str(world.methods["CASH"].id), "amount": "118"}])
    assert c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-closed-1"}).json()["error"]["code"] == "register_closed"
    sess2 = open_register(db, world, "fort", "fort_cashier")
    cust = Customer(code="SC1", name="Credit Holder", phone="9000000001")
    db.add(cust)
    db.commit()
    owner = client_for("owner")
    assert owner.post(f"/customers/{cust.id}/ledger", json={"kind": "STORE_CREDIT", "delta": "100", "note": "Goodwill"}).status_code == 200
    body = checkout_body(world, sess2, [{"book_id": str(world.books["pen"].id), "qty": 1}],
                         [{"payment_method_id": str(world.methods["STORE_CREDIT"].id), "amount": "118"}], customer_id=str(cust.id))
    assert c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-sc-1"}).json()["error"]["code"] == "insufficient_store_credit"
    body["payments"] = [{"payment_method_id": str(world.methods["STORE_CREDIT"].id), "amount": "100"},
                        {"payment_method_id": str(world.methods["CASH"].id), "amount": "18"}]
    assert c.post("/pos/checkout", json=body, headers={"Idempotency-Key": "idem-sc-2"}).status_code == 201
    assert sales.customer_balance(db, cust.id, "STORE_CREDIT") == 0
