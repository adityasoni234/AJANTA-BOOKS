import csv
import io
import uuid
from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.db import get_db
from app.core.errors import Forbidden, ValidationFailed
from app.services import reports as rpt
from app.services.audit import audit
from app.services.numbering import local_today

router = APIRouter(tags=["reports"])

MAX_RANGE_DAYS = 400


def _range(db: Session, date_from: date | None, date_to: date | None) -> tuple[date, date]:
    today = local_today(db)
    d2 = date_to or today
    d1 = date_from or (d2 - timedelta(days=29))
    if d1 > d2:
        raise ValidationFailed("Start date must be before end date")
    if (d2 - d1).days > MAX_RANGE_DAYS:
        raise ValidationFailed(f"Date range is limited to {MAX_RANGE_DAYS} days")
    return d1, d2


def _csv(rows: list[dict], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    if rows:
        cols = [k for k in rows[0] if not isinstance(rows[0][k], (list, dict))]
        w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in cols})
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={filename}.csv"})


def _maybe_export(ctx: AuthContext, db: Session, fmt: str, rows: list[dict], name: str, payload, filters: dict):
    if fmt == "csv":
        if not ctx.has("reports.export"):
            raise Forbidden("Missing permission: reports.export", code="permission_denied")
        audit(db, ctx, "reports.exported", entity_type="report", entity_id=name,
              details={k: str(v) for k, v in filters.items()})
        db.commit()
        return _csv(rows, f"{name}_{date.today()}")
    return payload


FMT = Query("json", pattern=r"^(json|csv)$")


@router.get("/reports/sales-summary")
def sales_summary(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
                  ctx: AuthContext = Depends(require("reports.view")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    s = rpt.sales_summary(db, d1, d2, ctx.scoped_location_ids(location_id))
    if not ctx.has("reports.financial"):
        for k in ("cogs", "gross_profit", "gross_margin_pct"):
            s[k] = None
    return {"period": {"from": d1, "to": d2}, **s}


@router.get("/reports/sales-by")
def sales_by(dim: str = Query(pattern=r"^(location|category|book|cashier)$"), date_from: date | None = None,
             date_to: date | None = None, location_id: uuid.UUID | None = None, format: str = FMT,
             ctx: AuthContext = Depends(require("reports.view")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    rows = rpt.sales_by(db, d1, d2, ctx.scoped_location_ids(location_id), dim)
    if not ctx.has("reports.financial"):
        for r in rows:
            r["cogs"] = r["gross_profit"] = None
    return _maybe_export(ctx, db, format, rows, f"sales_by_{dim}", {"rows": rows},
                         {"from": d1, "to": d2, "location": location_id, "dim": dim})


@router.get("/reports/sales-trend")
def sales_trend(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
                by_location: bool = False, format: str = FMT,
                ctx: AuthContext = Depends(require("reports.view")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    rows = rpt.sales_trend(db, d1, d2, ctx.scoped_location_ids(location_id), by_location)
    return _maybe_export(ctx, db, format, rows, "sales_trend", {"rows": rows}, {"from": d1, "to": d2})


@router.get("/reports/payments")
def payments(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
             format: str = FMT, ctx: AuthContext = Depends(require("reports.view")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    rows = rpt.payments_by_method(db, d1, d2, ctx.scoped_location_ids(location_id))
    return _maybe_export(ctx, db, format, rows, "payments_by_method", {"rows": rows}, {"from": d1, "to": d2})


@router.get("/reports/gst-register")
def gst_register(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
                 format: str = FMT, ctx: AuthContext = Depends(require_any("reports.financial", "finance.view")),
                 db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    rows = rpt.gst_register(db, d1, d2, ctx.scoped_location_ids(location_id))
    totals = {k: sum((r[k] for r in rows), Decimal(0)) for k in ("taxable_value", "cgst", "sgst", "igst", "total")}
    return _maybe_export(ctx, db, format, rows, "gst_sales_register", {"rows": rows, "totals": totals},
                         {"from": d1, "to": d2, "location": location_id})


@router.get("/reports/gst-summary")
def gst_summary(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
                format: str = FMT, ctx: AuthContext = Depends(require_any("reports.financial", "finance.view")),
                db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    rows = rpt.gst_summary(db, d1, d2, ctx.scoped_location_ids(location_id))
    return _maybe_export(ctx, db, format, rows, "gst_rate_hsn_summary",
                         {"rows": rows, "disclaimer": "Verify with your accountant before filing. No automatic GST filing is performed."},
                         {"from": d1, "to": d2})


@router.get("/reports/inventory-valuation")
def inventory_valuation(location_id: uuid.UUID | None = None, format: str = FMT,
                        ctx: AuthContext = Depends(require("reports.financial")), db: Session = Depends(get_db)):
    data = rpt.inventory_valuation(db, ctx.scoped_location_ids(location_id))
    return _maybe_export(ctx, db, format, data["locations"], "inventory_valuation", data, {"location": location_id})


@router.get("/reports/stock-analysis")
def stock_analysis(kind: str = Query(pattern=r"^(fast|slow|dead|excess|low|out)$"), location_id: uuid.UUID | None = None,
                   format: str = FMT, ctx: AuthContext = Depends(require_any("reports.view", "inventory.view")),
                   db: Session = Depends(get_db)):
    rows = rpt.stock_movement_analysis(db, ctx.scoped_location_ids(location_id), kind=kind)
    if not ctx.has("reports.financial"):
        for r in rows:
            r.pop("stock_value", None)
    return _maybe_export(ctx, db, format, rows, f"stock_{kind}", {"rows": rows}, {"kind": kind, "location": location_id})


@router.get("/reports/profit-loss")
def profit_loss(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
                ctx: AuthContext = Depends(require("reports.financial")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    return rpt.profit_and_loss(db, d1, d2, ctx.scoped_location_ids(location_id))


@router.get("/reports/cash-flow")
def cash_flow(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
              ctx: AuthContext = Depends(require("reports.financial")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    return rpt.cash_flow(db, d1, d2, ctx.scoped_location_ids(location_id))


@router.get("/reports/balance-sheet")
def balance_sheet(as_of: date | None = None, ctx: AuthContext = Depends(require("reports.financial", "accounting.view")),
                  db: Session = Depends(get_db)):
    if not ctx.all_locations:
        raise Forbidden("The balance sheet is organisation-wide")
    return rpt.balance_sheet(db, as_of or local_today(db))


@router.get("/reports/trial-balance")
def trial_balance(as_of: date | None = None, format: str = FMT, ctx: AuthContext = Depends(require("accounting.view")),
                  db: Session = Depends(get_db)):
    if not ctx.all_locations:
        raise Forbidden("The trial balance is organisation-wide")
    data = rpt.trial_balance(db, as_of or local_today(db))
    return _maybe_export(ctx, db, format, data["rows"], "trial_balance", data, {"as_of": as_of})


@router.get("/reports/supplier-aging")
def supplier_aging(location_id: uuid.UUID | None = None, format: str = FMT,
                   ctx: AuthContext = Depends(require_any("finance.view", "purchasing.view")), db: Session = Depends(get_db)):
    rows = rpt.supplier_aging(db, ctx.scoped_location_ids(location_id))
    return _maybe_export(ctx, db, format, rows, "supplier_aging", {"rows": rows}, {"location": location_id})


@router.get("/reports/receivables-aging")
def receivables_aging(location_id: uuid.UUID | None = None, format: str = FMT,
                      ctx: AuthContext = Depends(require("finance.view")), db: Session = Depends(get_db)):
    rows = rpt.receivables_aging(db, ctx.scoped_location_ids(location_id))
    return _maybe_export(ctx, db, format, rows, "receivables_aging", {"rows": rows}, {"location": location_id})


@router.get("/reports/expenses")
def expenses(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
             format: str = FMT, ctx: AuthContext = Depends(require("expenses.view")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    rows = rpt.expense_report(db, d1, d2, ctx.scoped_location_ids(location_id))
    return _maybe_export(ctx, db, format, rows, "expenses", {"rows": rows, "total": sum((r["amount"] for r in rows), Decimal(0))},
                         {"from": d1, "to": d2})


@router.get("/reports/registers")
def registers(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
              format: str = FMT, ctx: AuthContext = Depends(require("registers.manage")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    rows = rpt.register_report(db, d1, d2, ctx.scoped_location_ids(location_id))
    return _maybe_export(ctx, db, format, rows, "register_sessions", {"rows": rows}, {"from": d1, "to": d2})


# ---------------------------------------------------------------- dashboard


@router.get("/dashboard")
def dashboard(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
              ctx: AuthContext = Depends(require("dashboard.view")), db: Session = Depends(get_db)):
    d1, d2 = _range(db, date_from, date_to)
    loc_ids = ctx.scoped_location_ids(location_id)
    today = local_today(db)
    fin = ctx.has("reports.financial")
    period = rpt.sales_summary(db, d1, d2, loc_ids)
    today_s = rpt.sales_summary(db, today, today, loc_ids)
    if not fin:
        for s in (period, today_s):
            for k in ("cogs", "gross_profit", "gross_margin_pct"):
                s[k] = None
    out = {
        "period": {"from": d1, "to": d2}, "scope": "organisation" if loc_ids is None else "locations",
        "today": today_s, "summary": period,
        "trend": rpt.sales_trend(db, d1, d2, loc_ids),
        "payments": rpt.payments_by_method(db, d1, d2, loc_ids),
        "top_books": rpt.sales_by(db, d1, d2, loc_ids, "book", limit=8),
        "by_category": rpt.sales_by(db, d1, d2, loc_ids, "category", limit=8),
        "outlets": rpt.sales_by(db, d1, d2, loc_ids, "location"),
        "alerts": {"low": len(rpt.stock_movement_analysis(db, loc_ids, kind="low", limit=500)),
                   "out": len(rpt.stock_movement_analysis(db, loc_ids, kind="out", limit=500))},
        "low_stock": rpt.stock_movement_analysis(db, loc_ids, kind="low", limit=8),
        "dead_stock_count": len(rpt.stock_movement_analysis(db, loc_ids, kind="dead", limit=500)),
        "slow_moving": rpt.stock_movement_analysis(db, loc_ids, kind="slow", limit=5),
        "pending": rpt.pending_counts(db, loc_ids),
        "expenses": sum((r["amount"] for r in rpt.expense_report(db, d1, d2, loc_ids)), Decimal(0))
        if ctx.has("expenses.view") else None,
        "registers": [r for r in rpt.register_report(db, d1, d2, loc_ids) if r["status"] == "OPEN" or (r["variance"] or 0) != 0][:10]
        if ctx.has("registers.manage") else None,
    }
    if not fin:
        for key in ("top_books", "by_category", "outlets"):
            for r in out[key]:
                r["cogs"] = r["gross_profit"] = None
    from app.services.reports import inventory_valuation

    inv = inventory_valuation(db, loc_ids)
    out["inventory"] = {"locations": [{k: v for k, v in r.items() if fin or k not in ("cost_value", "in_transit_value")}
                                      for r in inv["locations"]],
                        "total_units": sum(r["units"] for r in inv["locations"]),
                        "total_cost_value": inv["total_cost_value"] if fin else None,
                        "total_retail_value": inv["total_retail_value"], "complete": inv["complete"]}
    if ctx.has("finance.view") or ctx.has("purchasing.view"):
        aging = rpt.supplier_aging(db, loc_ids)
        out["supplier_dues"] = {"total": sum((r["total"] for r in aging), Decimal(0)),
                                "overdue": sum((r["total"] - r["current"] for r in aging), Decimal(0)),
                                "top": aging[:5]}
        out["purchase_commitments"] = rpt.purchase_commitments(db, loc_ids)
    if fin and ctx.has("finance.view"):
        out["cash_positions"] = rpt.cash_positions(db, loc_ids)
    if fin:
        pl = rpt.profit_and_loss(db, d1, d2, loc_ids)
        out["profit"] = {"revenue": pl["revenue"], "cogs": pl["cogs"], "gross_profit": pl["gross_profit"],
                         "operating_expenses": pl["total_operating_expenses"], "net_profit": pl["net_profit"],
                         "complete": pl["complete"], "warnings": pl["warnings"]}
    return out
