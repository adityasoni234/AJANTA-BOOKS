"""Owner's outlet supervision: every permitted location side by side, and a full view of one location.

All figures come from the same report functions as the dashboard and reports, restricted to the location,
so an outlet's numbers always reconcile with the organisation totals.
"""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require
from app.core.db import get_db
from app.core.errors import NotFound
from app.models import Location, RegisterSession, User, UserLocation
from app.services import reports as rpt
from app.services.numbering import local_today

router = APIRouter(tags=["outlets"])

PROFIT_KEYS = ("cogs", "gross_profit", "gross_margin_pct")


def _periods(today: date) -> dict[str, tuple[date, date]]:
    return {"today": (today, today), "week": (today - timedelta(days=today.weekday()), today),
            "month": (today.replace(day=1), today)}


def _sales(db: Session, ctx: AuthContext, d1: date, d2: date, loc_ids: list[uuid.UUID]) -> dict:
    s = rpt.sales_summary(db, d1, d2, loc_ids)
    if not ctx.has("reports.financial"):
        for k in PROFIT_KEYS:
            s[k] = None
    return s


def _stock_value(db: Session, ctx: AuthContext, loc_ids: list[uuid.UUID]) -> dict:
    rows = rpt.inventory_valuation(db, loc_ids)["locations"]
    row = rows[0] if rows else {"units": 0, "retail_value": 0, "cost_value": 0, "in_transit_units": 0, "items_missing_cost": 0}
    fin = ctx.has("reports.financial")
    return {"units": row["units"], "retail_value": row["retail_value"], "cost_value": row["cost_value"] if fin else None,
            "items_missing_cost": row["items_missing_cost"] if fin else None}


def _location_out(loc: Location) -> dict:
    return {"id": loc.id, "code": loc.code, "name": loc.name, "type": loc.type, "is_active": loc.is_active,
            "city": loc.city, "state": loc.state, "address_line1": loc.address_line1, "address_line2": loc.address_line2,
            "pincode": loc.pincode, "phone": loc.phone, "email": loc.email, "gstin": loc.gstin}


@router.get("/outlets/summary")
def outlets_summary(ctx: AuthContext = Depends(require("dashboard.view")), db: Session = Depends(get_db)):
    """One row per location the viewer may see: today / this week / this month, stock and alerts."""
    today = local_today(db)
    periods = _periods(today)
    locs = db.scalars(select(Location).where(Location.is_active.is_(True), ctx.loc_filter(Location.id))
                      .order_by(Location.type.desc(), Location.name))
    out = []
    for loc in locs:
        ids = [loc.id]
        pending = rpt.pending_counts(db, ids)
        out.append({
            "location": _location_out(loc),
            "sales": {k: {f: s[f] for f in ("transactions", "invoice_value", "net_sales", "returns_value")}
                      for k, (d1, d2) in periods.items() for s in [rpt.sales_summary(db, d1, d2, ids)]},
            "stock": {**_stock_value(db, ctx, ids), **rpt.stock_buckets(db, ids)},
            "alerts": {"low": len(rpt.stock_movement_analysis(db, ids, kind="low", limit=1000)),
                       "out": len(rpt.stock_movement_analysis(db, ids, kind="out", limit=1000))},
            "open_registers": pending["open_register_sessions"], "pending_transfers": pending["transfers"],
            "pending_approvals": pending["approvals"],
        })
    return {"as_of": today, "periods": {k: {"from": a, "to": b} for k, (a, b) in periods.items()}, "locations": out}


@router.get("/outlets/{location_id}/overview")
def outlet_overview(location_id: uuid.UUID, ctx: AuthContext = Depends(require("dashboard.view")),
                    db: Session = Depends(get_db)):
    ctx.ensure_location(location_id)
    loc = db.get(Location, location_id)
    if loc is None:
        raise NotFound("Location not found")
    ids = [loc.id]
    today = local_today(db)
    periods = _periods(today)
    month_from, _ = periods["month"]
    fin = ctx.has("reports.financial")

    def strip_profit(rows: list[dict]) -> list[dict]:
        if not fin:
            for r in rows:
                r["cogs"] = r["gross_profit"] = None
        return rows

    open_sessions = db.execute(
        select(RegisterSession, User.full_name).join(User, User.id == RegisterSession.opened_by)
        .where(RegisterSession.location_id == loc.id, RegisterSession.status == "OPEN")
        .order_by(RegisterSession.opened_at)).all()
    staff = None
    if ctx.has("users.view"):
        staff_rows = db.execute(
            select(User).join(UserLocation, UserLocation.user_id == User.id)
            .where(UserLocation.location_id == loc.id, User.is_active.is_(True)).order_by(User.full_name)).scalars()
        staff = [{"id": u.id, "full_name": u.full_name, "email": u.email, "role": u.role.name, "designation": u.designation,
                  "last_login_at": u.last_login_at} for u in staff_rows]
    out = {
        "location": _location_out(loc),
        "as_of": today,
        "periods": {k: {"from": a, "to": b} for k, (a, b) in periods.items()},
        "sales": {k: _sales(db, ctx, d1, d2, ids) for k, (d1, d2) in periods.items()},
        "trend": rpt.sales_trend(db, today - timedelta(days=29), today, ids),
        "payments_month": rpt.payments_by_method(db, month_from, today, ids),
        "top_books_month": strip_profit(rpt.sales_by(db, month_from, today, ids, "book", limit=10)),
        "categories_month": strip_profit(rpt.sales_by(db, month_from, today, ids, "category", limit=10)),
        "cashiers_month": strip_profit(rpt.sales_by(db, month_from, today, ids, "cashier", limit=10)),
        "stock": {**_stock_value(db, ctx, ids), **rpt.stock_buckets(db, ids)},
        "stock_by_category": [{**r, "cost_value": r["cost_value"] if fin else None} for r in rpt.stock_by_category(db, ids)],
        "low_stock": rpt.stock_movement_analysis(db, ids, kind="low", limit=15),
        "out_of_stock": rpt.stock_movement_analysis(db, ids, kind="out", limit=15),
        "alerts": {"low": len(rpt.stock_movement_analysis(db, ids, kind="low", limit=1000)),
                   "out": len(rpt.stock_movement_analysis(db, ids, kind="out", limit=1000)),
                   "dead": len(rpt.stock_movement_analysis(db, ids, kind="dead", limit=1000))},
        "pending": rpt.pending_counts(db, ids),
        "open_registers": [{"session_id": s.id, "register": s.register.name, "cashier": name, "opened_at": s.opened_at,
                            "opening_float": s.opening_float} for s, name in open_sessions],
        "staff": staff,
    }
    if ctx.has("purchasing.view"):
        out["purchase_commitments"] = rpt.purchase_commitments(db, ids)
    if ctx.has("expenses.view"):
        out["expenses_month"] = sum((r["amount"] for r in rpt.expense_report(db, month_from, today, ids)), 0)
    return out
