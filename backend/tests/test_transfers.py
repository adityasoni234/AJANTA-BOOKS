"""Requirement 6: transfers account correctly for source, destination and in-transit inventory."""

from decimal import Decimal

from sqlalchemy import select

from app.models import IndividualCopy, InventoryBalance, JournalLine
from app.services import inventory as inv
from tests.conftest import receive


def b(db, loc, book):
    db.expire_all()
    return db.scalar(select(InventoryBalance).where(InventoryBalance.location_id == loc.id, InventoryBalance.book_id == book.id))


def _inventory_gl_by_location(db):
    rows = db.execute(select(JournalLine.location_id, JournalLine.debit - JournalLine.credit)
                      .join(JournalLine.account).where(JournalLine.account.has(system_key="INVENTORY")))
    out = {}
    for loc, amt in rows:
        out[loc] = out.get(loc, Decimal(0)) + amt
    return out


def test_full_transfer_lifecycle_with_discrepancy(world, client_for, db):
    receive(db, world, world.wh, {"novel": 20}, cost=Decimal("300"))
    mgr = client_for("fort_mgr")
    t = mgr.post("/transfers", json={"source_location_id": str(world.wh.id), "dest_location_id": str(world.fort.id),
                                     "lines": [{"book_id": str(world.books["novel"].id), "qty": 10}], "submit": True}).json()
    assert t["status"] == "REQUESTED" and t["approval_request_id"]
    # Store manager cannot approve; inventory manager can
    assert mgr.post(f"/transfers/{t['id']}/decision", json={"approve": True}).status_code == 403
    invm = client_for("inv")
    t = invm.post(f"/transfers/{t['id']}/decision", json={"approve": True}).json()
    assert t["status"] == "APPROVED"
    src = b(db, world.wh, world.books["novel"])
    assert (src.on_hand, src.reserved, src.available) == (20, 10, 10)
    # Destination cannot dispatch
    assert mgr.post(f"/transfers/{t['id']}/dispatch", json={}).status_code == 403
    line = t["lines"][0]
    t = invm.post(f"/transfers/{t['id']}/dispatch", json={"lines": [{"line_id": line["id"], "qty": 9}]}).json()
    assert t["status"] == "IN_TRANSIT"
    # double dispatch impossible
    assert invm.post(f"/transfers/{t['id']}/dispatch", json={}).status_code == 409
    src, dst = b(db, world.wh, world.books["novel"]), b(db, world.fort, world.books["novel"])
    assert (src.on_hand, src.reserved) == (11, 0)
    assert (dst.on_hand, dst.in_transit) == (0, 9)
    # Partial receipt with damage (idempotent)
    body = {"lines": [{"line_id": line["id"], "qty_received": 6, "qty_damaged": 1}]}
    r1 = mgr.post(f"/transfers/{t['id']}/receive", json=body, headers={"Idempotency-Key": "trf-rcv-0001"})
    r2 = mgr.post(f"/transfers/{t['id']}/receive", json=body, headers={"Idempotency-Key": "trf-rcv-0001"})
    assert r1.status_code == 200 and r2.status_code == 200
    dst = b(db, world.fort, world.books["novel"])
    assert (dst.on_hand, dst.damaged, dst.in_transit) == (6, 1, 2)
    assert r2.json()["status"] == "PARTIALLY_RECEIVED"
    # Cannot receive more than outstanding
    assert mgr.post(f"/transfers/{t['id']}/receive", json={"lines": [{"line_id": line["id"], "qty_received": 3}]},
                    headers={"Idempotency-Key": "trf-rcv-0002"}).status_code == 409
    # Final receipt of 1 more -> 1 missing -> DISCREPANCY
    r = mgr.post(f"/transfers/{t['id']}/receive", json={"lines": [{"line_id": line["id"], "qty_received": 1}], "final": True},
                 headers={"Idempotency-Key": "trf-rcv-0003"})
    assert r.json()["status"] == "DISCREPANCY"
    r = invm.post(f"/transfers/{t['id']}/resolve", json={"lines": [{"line_id": line["id"], "action": "LOST"}]},
                  headers={"Idempotency-Key": "trf-res-0001"})
    assert r.status_code == 200 and r.json()["status"] == "COMPLETED"
    dst = b(db, world.fort, world.books["novel"])
    assert (dst.on_hand, dst.damaged, dst.in_transit) == (7, 1, 0)
    ln = r.json()["lines"][0]
    assert (ln["qty_dispatched"], ln["qty_received"], ln["qty_damaged"], ln["qty_lost"]) == (9, 7, 1, 1)
    # GL: inventory moved at cost between locations; 1 unit written off
    gl = _inventory_gl_by_location(db)
    assert gl[world.wh.id] == Decimal("3300.00")  # 20*300 - 9*300
    assert gl[world.fort.id] == Decimal("2400.00")  # 8 units remain at fort (7 sellable + 1 damaged)
    assert inv.reconcile(db) == []


def test_transfer_reservation_blocks_overselling_and_cancel_releases(world, client_for, db):
    receive(db, world, world.wh, {"pen": 5})
    invm = client_for("inv")
    t = invm.post("/transfers", json={"source_location_id": str(world.wh.id), "dest_location_id": str(world.pune.id),
                                      "lines": [{"book_id": str(world.books["pen"].id), "qty": 5}], "submit": True}).json()
    assert t["status"] == "APPROVED"  # requester can approve at source -> auto-approved
    t2 = invm.post("/transfers", json={"source_location_id": str(world.wh.id), "dest_location_id": str(world.fort.id),
                                       "lines": [{"book_id": str(world.books["pen"].id), "qty": 1}], "submit": True})
    assert t2.status_code == 409  # nothing available: all reserved
    assert invm.post(f"/transfers/{t['id']}/cancel", json={"reason": "No longer needed"}).json()["status"] == "CANCELLED"
    assert b(db, world.wh, world.books["pen"]).reserved == 0


def test_return_to_source_resolution(world, client_for, db):
    receive(db, world, world.wh, {"pen": 4}, cost=Decimal("50"))
    invm = client_for("inv")
    t = invm.post("/transfers", json={"source_location_id": str(world.wh.id), "dest_location_id": str(world.pune.id),
                                      "lines": [{"book_id": str(world.books["pen"].id), "qty": 4}], "submit": True}).json()
    t = invm.post(f"/transfers/{t['id']}/dispatch", json={}).json()
    pmgr = client_for("pune_mgr")
    lid = t["lines"][0]["id"]
    pmgr.post(f"/transfers/{t['id']}/receive", json={"lines": [{"line_id": lid, "qty_received": 2}], "final": True},
              headers={"Idempotency-Key": "rts-rcv-001"})
    r = invm.post(f"/transfers/{t['id']}/resolve", json={"lines": [{"line_id": lid, "action": "RETURN"}]},
                  headers={"Idempotency-Key": "rts-res-001"})
    assert r.json()["status"] == "COMPLETED"
    assert b(db, world.wh, world.books["pen"]).on_hand == 2
    assert b(db, world.pune, world.books["pen"]).on_hand == 2
    assert inv.reconcile(db) == []


def test_copy_tracked_transfer_moves_specific_copies(world, client_for, db):
    receive(db, world, world.wh, {"rare": 2})
    invm = client_for("inv")
    copies = list(db.scalars(select(IndividualCopy).order_by(IndividualCopy.copy_code)))
    t = invm.post("/transfers", json={"source_location_id": str(world.wh.id), "dest_location_id": str(world.fort.id),
                                      "lines": [{"book_id": str(world.books["rare"].id), "qty": 1}], "submit": True}).json()
    lid = t["lines"][0]["id"]
    t = invm.post(f"/transfers/{t['id']}/dispatch", json={"lines": [{"line_id": lid, "qty": 1, "copy_ids": [str(copies[1].id)]}]}).json()
    db.expire_all()
    assert db.get(IndividualCopy, copies[1].id).status == "IN_TRANSIT"
    assert db.get(IndividualCopy, copies[0].id).status == "AVAILABLE"
    mgr = client_for("fort_mgr")
    r = mgr.post(f"/transfers/{t['id']}/receive", json={"lines": [{"line_id": lid, "qty_received": 1, "copy_ids_received": [str(copies[0].id)]}]},
                 headers={"Idempotency-Key": "copy-rcv-001"})
    assert r.status_code == 422  # wrong copy scanned
    r = mgr.post(f"/transfers/{t['id']}/receive", json={"lines": [{"line_id": lid, "qty_received": 1, "copy_ids_received": [str(copies[1].id)]}]},
                 headers={"Idempotency-Key": "copy-rcv-002"})
    assert r.json()["status"] == "COMPLETED"
    db.expire_all()
    c = db.get(IndividualCopy, copies[1].id)
    assert c.status == "AVAILABLE" and c.location_id == world.fort.id
    assert inv.reconcile(db) == []
