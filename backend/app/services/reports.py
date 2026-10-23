"""Reporting queries. All functions take an explicit list of permitted location ids
(None = organisation-wide) so on-screen reports, dashboards and CSV exports share one code path.

Metric definitions (also documented in docs/REPORTS.md):
  gross_sales      Σ line price × qty of completed sales (pricing basis as configured)
  discounts        Σ line + bill discounts of completed sales
  invoice_value    Σ grand totals (incl. GST and round-off) of completed sales
  returns_value    Σ refunds of completed returns (incl. GST)
  net_sales        Σ taxable value of sales − Σ taxable value of returns  (ex-GST revenue)
  gst_collected    output GST on sales − GST reversed on returns
  cogs             Σ cost of sales at weighted-average cost − cost of returned goods
  gross_profit     net_sales − cogs   (flagged incomplete when any sale lacked cost data)
"""

import uuid
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import and_, case, func, literal, literal_column, or_, select
from sqlalchemy.orm import Session

from app.core.money import ZERO, D, r2
from app.models import (
    Account,
    Book,
    Category,
    Customer,
    Expense,
    ExpenseCategory,
    InventoryBalance,
    Invoice,
    JournalEntry,
    JournalLine,
    Location,
    Payment,
    PaymentMethod,
    PurchaseOrder,
    PurchaseOrderLine,
    RegisterSession,
    Return,
    ReturnLine,
    Sale,
    SaleLine,
    StockTransfer,
    Supplier,
    SupplierInvoice,
    User,
)
from app.models.org import ApprovalRequest, Organization
from app.services.settings import get_policy

LocIds = list[uuid.UUID] | None


def org_timezone(db: Session) -> str:
    org = db.scalar(select(Organization).limit(1))
    return org.timezone if org else "Asia/Kolkata"


def local_date(db: Session, column):
    return func.date(func.timezone(org_timezone(db), column))


def _loc(column, loc_ids: LocIds):
    return literal(True) if loc_ids is None else column.in_(loc_ids or [uuid.UUID(int=0)])


# ---------------------------------------------------------------- sales


def sales_summary(db: Session, d1: date, d2: date, loc_ids: LocIds) -> dict:
    sd = local_date(db, Sale.created_at)
    s = db.execute(
        select(func.count(), func.coalesce(func.sum(Sale.gross_amount), 0),
               func.coalesce(func.sum(Sale.line_discount_total + Sale.bill_discount), 0),
               func.coalesce(func.sum(Sale.grand_total), 0), func.coalesce(func.sum(Sale.taxable_total), 0),
               func.coalesce(func.sum(Sale.cgst_total + Sale.sgst_total + Sale.igst_total), 0),
               func.coalesce(func.sum(Sale.cogs_total), 0),
               func.count(case((Sale.cost_complete.is_(False), 1))),
               func.coalesce(func.sum(Sale.grand_total - Sale.amount_paid), 0))
        .where(Sale.status == "COMPLETED", sd >= d1, sd <= d2, _loc(Sale.location_id, loc_ids))).one()
    rd = local_date(db, Return.completed_at)
    r = db.execute(
        select(func.count(), func.coalesce(func.sum(Return.refund_total), 0), func.coalesce(func.sum(Return.taxable_total), 0),
               func.coalesce(func.sum(Return.cgst_total + Return.sgst_total + Return.igst_total), 0),
               func.coalesce(func.sum(Return.cogs_reversed), 0))
        .where(Return.status == "COMPLETED", rd >= d1, rd <= d2, _loc(Return.location_id, loc_ids))).one()
    voids = db.scalar(select(func.count()).select_from(Sale).where(
        Sale.status == "CANCELLED", sd >= d1, sd <= d2, _loc(Sale.location_id, loc_ids)))
    net_sales = D(s[4]) - D(r[2])
    cogs = D(s[6]) - D(r[4])
    tx = int(s[0])
    return {
        "transactions": tx, "gross_sales": D(s[1]), "discounts": D(s[2]), "invoice_value": D(s[3]),
        "returns_count": int(r[0]), "returns_value": D(r[1]), "net_sales": net_sales,
        "gst_collected": D(s[5]) - D(r[3]), "cogs": cogs, "gross_profit": net_sales - cogs,
        "gross_margin_pct": r2(((net_sales - cogs) / net_sales * 100) if net_sales else ZERO),
        "cost_incomplete_sales": int(s[7]), "profit_complete": int(s[7]) == 0,
        "avg_basket": r2(D(s[3]) / tx) if tx else ZERO, "voided": int(voids or 0), "receivables_created": D(s[8]),
    }


def sales_trend(db: Session, d1: date, d2: date, loc_ids: LocIds, by_location: bool = False) -> list[dict]:
    sd = local_date(db, Sale.created_at).label("d")
    cols = [sd, func.count(), func.sum(Sale.taxable_total), func.sum(Sale.grand_total)]
    group = [sd]
    if by_location:
        cols.insert(1, Location.name)
        group.append(Location.name)
    q = (select(*cols).join(Location, Location.id == Sale.location_id)
         .where(Sale.status == "COMPLETED", sd >= d1, sd <= d2, _loc(Sale.location_id, loc_ids))
         .group_by(*group).order_by(sd))
    rows = []
    for row in db.execute(q):
        if by_location:
            d, loc, n, net, billed = row
        else:
            (d, n, net, billed), loc = row, None
        rows.append({"date": d, "location": loc, "transactions": n, "net_sales": D(net), "invoice_value": D(billed)})
    # fill missing days (single series only)
    if not by_location:
        have = {r["date"]: r for r in rows}
        rows = []
        d = d1
        while d <= d2 and len(rows) < 400:
            rows.append(have.get(d, {"date": d, "location": None, "transactions": 0, "net_sales": ZERO, "invoice_value": ZERO}))
            d += timedelta(days=1)
    return rows


def sales_by(db: Session, d1: date, d2: date, loc_ids: LocIds, dim: str, limit: int = 500) -> list[dict]:
    """Net sales by a dimension: location | category | book | cashier | publisher."""
    sd = local_date(db, Sale.created_at)
    base_where = [Sale.status == "COMPLETED", sd >= d1, sd <= d2, _loc(Sale.location_id, loc_ids)]
    if dim == "location":
        key, label = Sale.location_id, Location.name
        q = (select(key, label, func.count(func.distinct(Sale.id)), func.sum(SaleLine.qty), func.sum(SaleLine.taxable_value),
                    func.sum(SaleLine.line_total), func.sum(SaleLine.unit_cost * SaleLine.qty))
             .join(Sale, Sale.id == SaleLine.sale_id).join(Location, Location.id == Sale.location_id))
    elif dim == "category":
        key, label = Book.category_id, func.coalesce(Category.name, "Uncategorised")
        q = (select(key, label, func.count(func.distinct(Sale.id)), func.sum(SaleLine.qty), func.sum(SaleLine.taxable_value),
                    func.sum(SaleLine.line_total), func.sum(SaleLine.unit_cost * SaleLine.qty))
             .join(Sale, Sale.id == SaleLine.sale_id).join(Book, Book.id == SaleLine.book_id)
             .outerjoin(Category, Category.id == Book.category_id))
    elif dim == "book":
        key, label = SaleLine.book_id, Book.title
        q = (select(key, label, func.count(func.distinct(Sale.id)), func.sum(SaleLine.qty), func.sum(SaleLine.taxable_value),
                    func.sum(SaleLine.line_total), func.sum(SaleLine.unit_cost * SaleLine.qty), Book.sku)
             .join(Sale, Sale.id == SaleLine.sale_id).join(Book, Book.id == SaleLine.book_id))
    elif dim == "cashier":
        key, label = Sale.created_by, User.full_name
        q = (select(key, label, func.count(func.distinct(Sale.id)), func.sum(SaleLine.qty), func.sum(SaleLine.taxable_value),
                    func.sum(SaleLine.line_total), func.sum(SaleLine.unit_cost * SaleLine.qty))
             .join(Sale, Sale.id == SaleLine.sale_id).join(User, User.id == Sale.created_by))
    else:
        raise ValueError("Unknown dimension")
    group = [key, label] + ([Book.sku] if dim == "book" else [])
    q = q.where(*base_where).group_by(*group).order_by(func.sum(SaleLine.taxable_value).desc()).limit(limit)
    out = []
    for row in db.execute(q):
        k, lab, tx, qty, net, billed, cost = row[:7]
        item = {"key": k, "label": lab, "transactions": int(tx), "units": int(qty or 0), "net_sales": D(net),
                "invoice_value": D(billed), "cogs": D(cost) if cost is not None else None}
        if dim == "book":
            item["sku"] = row[7]
        item["gross_profit"] = item["net_sales"] - item["cogs"] if item["cogs"] is not None else None
        out.append(item)
    return out


def payments_by_method(db: Session, d1: date, d2: date, loc_ids: LocIds) -> list[dict]:
    pd = local_date(db, Payment.created_at)
    q = (select(PaymentMethod.code, PaymentMethod.name,
                func.coalesce(func.sum(case((Payment.direction == "IN", Payment.amount), else_=0)), 0),
                func.coalesce(func.sum(case((Payment.direction == "OUT", Payment.amount), else_=0)), 0), func.count())
         .join(PaymentMethod, PaymentMethod.id == Payment.payment_method_id)
         .where(Payment.purpose.in_(["SALE", "CUSTOMER_RECEIPT", "SALE_REFUND", "SALE_VOID"]), pd >= d1, pd <= d2,
                _loc(Payment.location_id, loc_ids))
         .group_by(PaymentMethod.code, PaymentMethod.name, PaymentMethod.sort_order).order_by(PaymentMethod.sort_order))
    return [{"code": c, "method": n, "collected": D(i), "refunded": D(o), "net": D(i) - D(o), "count": int(k)}
            for c, n, i, o, k in db.execute(q)]


# ---------------------------------------------------------------- GST


def gst_register(db: Session, d1: date, d2: date, loc_ids: LocIds) -> list[dict]:
    idate = local_date(db, Invoice.issued_at)
    q = (select(Invoice, Sale, Return).outerjoin(Sale, Sale.id == Invoice.sale_id).outerjoin(Return, Return.id == Invoice.return_id)
         .where(idate >= d1, idate <= d2, _loc(Invoice.location_id, loc_ids)).order_by(Invoice.issued_at).limit(50000))
    rows = []
    for inv, sale, ret in db.execute(q):
        src = sale or ret
        sign = Decimal(-1) if inv.doc_type == "CREDIT_NOTE" else Decimal(1)
        cancelled = inv.status == "CANCELLED"
        taxable = src.taxable_total
        cg, sg, ig = src.cgst_total, src.sgst_total, src.igst_total
        total = sale.grand_total if sale else ret.refund_total
        rows.append({
            "invoice_number": inv.number, "doc_type": inv.doc_type, "date": inv.issued_at, "status": inv.status,
            "customer": inv.buyer.get("name"), "customer_gstin": inv.buyer.get("gstin"),
            "supply_type": "B2B" if inv.buyer.get("gstin") else "B2C", "place_of_supply": inv.place_of_supply,
            "taxable_value": ZERO if cancelled else sign * taxable, "cgst": ZERO if cancelled else sign * cg,
            "sgst": ZERO if cancelled else sign * sg, "igst": ZERO if cancelled else sign * ig,
            "total": ZERO if cancelled else sign * total, "location_id": inv.location_id,
        })
    return rows


def gst_summary(db: Session, d1: date, d2: date, loc_ids: LocIds) -> list[dict]:
    """Rate/HSN-wise outward supplies net of credit notes (excludes cancelled invoices)."""
    sd = local_date(db, Sale.created_at)
    sales = db.execute(
        select(func.coalesce(SaleLine.hsn_code, literal_column("''")), SaleLine.tax_rate, func.sum(SaleLine.qty), func.sum(SaleLine.taxable_value),
               func.sum(SaleLine.cgst), func.sum(SaleLine.sgst), func.sum(SaleLine.igst))
        .join(Sale, Sale.id == SaleLine.sale_id)
        .where(Sale.status == "COMPLETED", sd >= d1, sd <= d2, _loc(Sale.location_id, loc_ids))
        .group_by(func.coalesce(SaleLine.hsn_code, literal_column("''")), SaleLine.tax_rate))
    rd = local_date(db, Return.completed_at)
    rets = db.execute(
        select(func.coalesce(SaleLine.hsn_code, literal_column("''")), SaleLine.tax_rate, func.sum(ReturnLine.qty), func.sum(ReturnLine.taxable_value),
               func.sum(ReturnLine.cgst), func.sum(ReturnLine.sgst), func.sum(ReturnLine.igst))
        .join(Return, Return.id == ReturnLine.return_id).join(SaleLine, SaleLine.id == ReturnLine.sale_line_id)
        .where(Return.status == "COMPLETED", rd >= d1, rd <= d2, _loc(Return.location_id, loc_ids))
        .group_by(func.coalesce(SaleLine.hsn_code, literal_column("''")), SaleLine.tax_rate))
    acc: dict[tuple, dict] = {}
    for sign, rows in ((1, sales), (-1, rets)):
        for hsn, rate, qty, tv, cg, sg, ig in rows:
            a = acc.setdefault((hsn, rate), {"hsn_code": hsn, "tax_rate": D(rate), "qty": 0, "taxable_value": ZERO,
                                             "cgst": ZERO, "sgst": ZERO, "igst": ZERO})
            a["qty"] += sign * int(qty or 0)
            a["taxable_value"] += sign * D(tv)
            a["cgst"] += sign * D(cg)
            a["sgst"] += sign * D(sg)
            a["igst"] += sign * D(ig)
    for a in acc.values():
        a["total_tax"] = a["cgst"] + a["sgst"] + a["igst"]
    return sorted(acc.values(), key=lambda a: (a["hsn_code"], a["tax_rate"]))


# ---------------------------------------------------------------- inventory


def inventory_valuation(db: Session, loc_ids: LocIds) -> dict:
    valued = InventoryBalance.on_hand + InventoryBalance.damaged + InventoryBalance.quarantined
    q = (select(Location.id, Location.name, Location.type, func.coalesce(func.sum(valued), 0),
                func.coalesce(func.sum(InventoryBalance.in_transit), 0),
                func.coalesce(func.sum(valued * func.coalesce(InventoryBalance.avg_cost, 0)), 0),
                func.coalesce(func.sum(InventoryBalance.on_hand * func.coalesce(InventoryBalance.price_override, Book.selling_price)), 0),
                func.count(case((and_(valued > 0, InventoryBalance.avg_cost.is_(None)), 1))))
         .select_from(InventoryBalance).join(Location, Location.id == InventoryBalance.location_id)
         .join(Book, Book.id == InventoryBalance.book_id)
         .where(_loc(InventoryBalance.location_id, loc_ids))
         .group_by(Location.id, Location.name, Location.type).order_by(Location.type.desc(), Location.name))
    # In-transit stock is valued at the cost recorded on the transfer line (destination side).
    from app.models import StockTransferLine

    transit_q = (select(StockTransfer.dest_location_id,
                        func.coalesce(func.sum((StockTransferLine.qty_dispatched - StockTransferLine.qty_received
                                                - StockTransferLine.qty_damaged - StockTransferLine.qty_lost
                                                - StockTransferLine.qty_returned) * func.coalesce(StockTransferLine.unit_cost, 0)), 0))
                 .join(StockTransfer, StockTransfer.id == StockTransferLine.transfer_id)
                 .where(StockTransfer.status.in_(["IN_TRANSIT", "PARTIALLY_RECEIVED", "DISCREPANCY"]),
                        _loc(StockTransfer.dest_location_id, loc_ids))
                 .group_by(StockTransfer.dest_location_id))
    transit_val = {lid: D(v) for lid, v in db.execute(transit_q)}
    rows = []
    for lid, name, typ, units, transit, cost, retail, missing in db.execute(q):
        rows.append({"location_id": lid, "location": name, "type": typ, "units": int(units), "in_transit_units": int(transit),
                     "cost_value": r2(cost), "in_transit_value": r2(transit_val.get(lid, ZERO)),
                     "retail_value": r2(retail), "items_missing_cost": int(missing)})
    total_cost = sum((r["cost_value"] + r["in_transit_value"] for r in rows), ZERO)
    gl = None
    if loc_ids is None:
        inv_acc = db.scalar(select(Account.id).where(Account.system_key == "INVENTORY"))
        gl = D(db.scalar(select(func.coalesce(func.sum(JournalLine.debit - JournalLine.credit), 0)).where(JournalLine.account_id == inv_acc)))
    return {"method": "Weighted average cost", "locations": rows, "total_cost_value": total_cost,
            "total_retail_value": sum((r["retail_value"] for r in rows), ZERO), "gl_inventory_balance": gl,
            "gl_difference": (gl - total_cost) if gl is not None else None,
            "complete": all(r["items_missing_cost"] == 0 for r in rows)}


def stock_movement_analysis(db: Session, loc_ids: LocIds, *, kind: str, limit: int = 200) -> list[dict]:
    """fast | slow | dead | excess | low | out."""
    policy = get_policy(db)
    today = date.today()
    if kind in ("low", "out"):
        reorder = func.coalesce(InventoryBalance.reorder_level, Book.reorder_level)
        avail = InventoryBalance.on_hand - InventoryBalance.reserved
        cond = and_(avail <= 0, Book.status == "ACTIVE") if kind == "out" else and_(avail > 0, reorder > 0, avail <= reorder)
        q = (select(InventoryBalance, Book, Location).join(Book, Book.id == InventoryBalance.book_id)
             .join(Location, Location.id == InventoryBalance.location_id)
             .where(cond, _loc(InventoryBalance.location_id, loc_ids), Location.is_active.is_(True))
             .order_by(avail, Book.title).limit(limit))
        return [{"book_id": b.id, "title": b.title, "sku": b.sku, "location": loc.name, "location_id": loc.id,
                 "available": bal.on_hand - bal.reserved, "on_hand": bal.on_hand,
                 "reorder_level": bal.reorder_level if bal.reorder_level is not None else b.reorder_level,
                 "reorder_qty": bal.reorder_qty if bal.reorder_qty is not None else b.reorder_qty,
                 "in_transit": bal.in_transit} for bal, b, loc in db.execute(q)]
    days = {"fast": 30, "slow": policy.slow_moving_days, "dead": policy.dead_stock_days, "excess": 90}[kind]
    since = today - timedelta(days=days)
    sd = local_date(db, Sale.created_at)
    sold = (select(SaleLine.book_id.label("book_id"), Sale.location_id.label("location_id"),
                   func.sum(SaleLine.qty).label("qty"), func.max(Sale.created_at).label("last_sale"))
            .join(Sale, Sale.id == SaleLine.sale_id)
            .where(Sale.status == "COMPLETED", sd >= since, _loc(Sale.location_id, loc_ids))
            .group_by(SaleLine.book_id, Sale.location_id).subquery())
    base = (select(InventoryBalance, Book, Location, func.coalesce(sold.c.qty, 0), sold.c.last_sale)
            .join(Book, Book.id == InventoryBalance.book_id).join(Location, Location.id == InventoryBalance.location_id)
            .outerjoin(sold, and_(sold.c.book_id == InventoryBalance.book_id, sold.c.location_id == InventoryBalance.location_id))
            .where(_loc(InventoryBalance.location_id, loc_ids), Location.is_active.is_(True)))
    if kind == "fast":
        q = base.where(sold.c.qty > 0).order_by(sold.c.qty.desc()).limit(limit)
    elif kind == "dead":
        q = base.where(InventoryBalance.on_hand > 0, sold.c.qty.is_(None),
                       InventoryBalance.updated_at < func.now() - timedelta(days=days)).order_by(Book.title).limit(limit)
    elif kind == "slow":
        q = base.where(InventoryBalance.on_hand > 0, func.coalesce(sold.c.qty, 0) > 0,
                       func.coalesce(sold.c.qty, 0) * 4 < InventoryBalance.on_hand).order_by(func.coalesce(sold.c.qty, 0)).limit(limit)
    else:  # excess: stock above N× reorder level, or > 90 days of cover at current run-rate
        reorder = func.coalesce(InventoryBalance.reorder_level, Book.reorder_level)
        q = base.where(InventoryBalance.on_hand > 0, or_(
            and_(reorder > 0, InventoryBalance.on_hand > reorder * policy.excess_stock_multiplier),
            and_(func.coalesce(sold.c.qty, 0) > 0, InventoryBalance.on_hand > func.coalesce(sold.c.qty, 0) * 3)))\
            .order_by(InventoryBalance.on_hand.desc()).limit(limit)
    out = []
    for bal, b, loc, qty, last in db.execute(q):
        out.append({"book_id": b.id, "title": b.title, "sku": b.sku, "location": loc.name, "location_id": loc.id,
                    "on_hand": bal.on_hand, f"sold_{days}d": int(qty), "units_sold": int(qty), "window_days": days,
                    "last_sale": last, "stock_value": r2((bal.avg_cost or 0) * bal.on_hand) if bal.avg_cost is not None else None})
    return out


# ---------------------------------------------------------------- finance


def _account_totals(db: Session, d1: date | None, d2: date, loc_ids: LocIds, types: list[str]) -> list[dict]:
    q = (select(Account.id, Account.code, Account.name, Account.type, Account.system_key,
                func.coalesce(func.sum(JournalLine.debit), 0), func.coalesce(func.sum(JournalLine.credit), 0))
         .join(JournalLine, JournalLine.account_id == Account.id).join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
         .where(Account.type.in_(types), JournalEntry.entry_date <= d2, _loc(JournalLine.location_id, loc_ids))
         .group_by(Account.id, Account.code, Account.name, Account.type, Account.system_key).order_by(Account.code))
    if d1:
        q = q.where(JournalEntry.entry_date >= d1)
    return [{"account_id": i, "code": c, "name": n, "type": t, "system_key": k, "debit": D(dr), "credit": D(cr)}
            for i, c, n, t, k, dr, cr in db.execute(q)]


def profit_and_loss(db: Session, d1: date, d2: date, loc_ids: LocIds) -> dict:
    rows = _account_totals(db, d1, d2, loc_ids, ["INCOME", "EXPENSE"])
    income = [{**r, "amount": r["credit"] - r["debit"]} for r in rows if r["type"] == "INCOME"]
    expense = [{**r, "amount": r["debit"] - r["credit"]} for r in rows if r["type"] == "EXPENSE"]
    revenue = sum((r["amount"] for r in income), ZERO)
    cogs = sum((r["amount"] for r in expense if r["system_key"] == "COGS"), ZERO)
    opex = [r for r in expense if r["system_key"] != "COGS"]
    total_opex = sum((r["amount"] for r in opex), ZERO)
    s = sales_summary(db, d1, d2, loc_ids)
    return {"period": {"from": d1, "to": d2}, "income": income, "revenue": revenue, "cogs": cogs,
            "gross_profit": revenue - cogs, "operating_expenses": opex, "total_operating_expenses": total_opex,
            "net_profit": revenue - cogs - total_opex, "complete": s["profit_complete"],
            "warnings": ([f"{s['cost_incomplete_sales']} sale(s) had items without cost data; COGS and profit are understated."]
                         if not s["profit_complete"] else [])}


CASH_FLOW_GROUPS = {
    "SALE": "Receipts from customers", "CUSTOMER_RECEIPT": "Receipts from customers",
    "RETURN": "Refunds to customers", "SALE_VOID": "Refunds to customers", "SUPPLIER_PAYMENT": "Payments to suppliers",
    "EXPENSE": "Operating expenses paid", "REGISTER_CLOSE": "Cash over / short", "MANUAL": "Other / manual entries",
    "FUND_TRANSFER": "Transfers between accounts",
}


def cash_flow(db: Session, d1: date, d2: date, loc_ids: LocIds) -> dict:
    cash_ids = list(db.scalars(select(Account.id).where(Account.is_cash_or_bank.is_(True))))
    q = (select(JournalEntry.source_type, func.coalesce(func.sum(JournalLine.debit), 0), func.coalesce(func.sum(JournalLine.credit), 0))
         .join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
         .where(JournalLine.account_id.in_(cash_ids), JournalEntry.entry_date >= d1, JournalEntry.entry_date <= d2,
                _loc(JournalLine.location_id, loc_ids))
         .group_by(JournalEntry.source_type))
    groups: dict[str, dict] = defaultdict(lambda: {"inflow": ZERO, "outflow": ZERO})
    for st, dr, cr in db.execute(q):
        g = groups[CASH_FLOW_GROUPS.get(st, "Other")]
        g["inflow"] += D(dr)
        g["outflow"] += D(cr)
    opening = D(db.scalar(select(func.coalesce(func.sum(JournalLine.debit - JournalLine.credit), 0))
                          .join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
                          .where(JournalLine.account_id.in_(cash_ids), JournalEntry.entry_date < d1,
                                 _loc(JournalLine.location_id, loc_ids))))
    lines = [{"activity": k, **v, "net": v["inflow"] - v["outflow"]} for k, v in sorted(groups.items())]
    net = sum((x["net"] for x in lines), ZERO)
    return {"period": {"from": d1, "to": d2}, "opening_cash": opening, "lines": lines, "net_change": net,
            "closing_cash": opening + net, "method": "Direct method from cash & bank account postings"}


def balance_sheet(db: Session, as_of: date) -> dict:
    policy = get_policy(db)
    rows = _account_totals(db, None, as_of, None, ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"])
    assets = [{**r, "amount": r["debit"] - r["credit"]} for r in rows if r["type"] == "ASSET"]
    liabilities = [{**r, "amount": r["credit"] - r["debit"]} for r in rows if r["type"] == "LIABILITY"]
    equity = [{**r, "amount": r["credit"] - r["debit"]} for r in rows if r["type"] == "EQUITY"]
    earnings = sum((r["credit"] - r["debit"] for r in rows if r["type"] in ("INCOME", "EXPENSE")), ZERO)
    ta = sum((a["amount"] for a in assets), ZERO)
    tl = sum((a["amount"] for a in liabilities), ZERO)
    te = sum((a["amount"] for a in equity), ZERO) + earnings
    return {"as_of": as_of, "assets": assets, "liabilities": liabilities, "equity": equity,
            "current_earnings": earnings, "total_assets": ta, "total_liabilities": tl, "total_equity": te,
            "balanced": ta == tl + te, "complete": policy.opening_balances_configured,
            "warnings": [] if policy.opening_balances_configured else [
                "Opening balances have not been confirmed in settings. The balance sheet reflects only transactions "
                "recorded in this system and is not a complete statement of financial position."]}


def trial_balance(db: Session, as_of: date) -> dict:
    rows = _account_totals(db, None, as_of, None, ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"])
    out = []
    for r in rows:
        net = r["debit"] - r["credit"]
        out.append({**r, "balance_debit": net if net > 0 else ZERO, "balance_credit": -net if net < 0 else ZERO})
    td = sum((r["balance_debit"] for r in out), ZERO)
    tc = sum((r["balance_credit"] for r in out), ZERO)
    return {"as_of": as_of, "rows": out, "total_debit": td, "total_credit": tc, "balanced": td == tc}


def supplier_aging(db: Session, loc_ids: LocIds) -> list[dict]:
    today = date.today()
    due = SupplierInvoice.total - SupplierInvoice.amount_paid
    age = today - SupplierInvoice.due_date

    def bucket(lo, hi=None):
        cond = and_(age >= lo, age <= hi) if hi is not None else age >= lo
        return func.coalesce(func.sum(case((cond, due), else_=0)), 0)

    q = (select(Supplier.id, Supplier.name, func.coalesce(func.sum(case((age <= 0, due), else_=0)), 0),
                bucket(1, 30), bucket(31, 60), bucket(61, 90), bucket(91), func.sum(due), func.min(SupplierInvoice.due_date))
         .join(Supplier, Supplier.id == SupplierInvoice.supplier_id)
         .where(SupplierInvoice.status.in_(["OPEN", "PARTIALLY_PAID"]), _loc(SupplierInvoice.location_id, loc_ids))
         .group_by(Supplier.id, Supplier.name).order_by(func.sum(due).desc()))
    return [{"supplier_id": i, "supplier": n, "current": D(c), "d1_30": D(a), "d31_60": D(b), "d61_90": D(e),
             "d90_plus": D(f), "total": D(t), "oldest_due": od} for i, n, c, a, b, e, f, t, od in db.execute(q)]


def receivables_aging(db: Session, loc_ids: LocIds) -> list[dict]:
    today = date.today()
    due = Sale.grand_total - Sale.amount_paid
    age = today - local_date(db, Sale.created_at)
    q = (select(Customer.id, Customer.name, Customer.phone,
                func.coalesce(func.sum(case((age <= 30, due), else_=0)), 0),
                func.coalesce(func.sum(case((and_(age > 30, age <= 60), due), else_=0)), 0),
                func.coalesce(func.sum(case((age > 60, due), else_=0)), 0), func.sum(due))
         .join(Customer, Customer.id == Sale.customer_id)
         .where(Sale.status == "COMPLETED", Sale.grand_total > Sale.amount_paid, _loc(Sale.location_id, loc_ids))
         .group_by(Customer.id, Customer.name, Customer.phone).order_by(func.sum(due).desc()))
    return [{"customer_id": i, "customer": n, "phone": p, "d0_30": D(a), "d31_60": D(b), "d60_plus": D(c), "total": D(t)}
            for i, n, p, a, b, c, t in db.execute(q)]


def expense_report(db: Session, d1: date, d2: date, loc_ids: LocIds) -> list[dict]:
    q = (select(Location.name, ExpenseCategory.name, func.count(), func.sum(Expense.amount))
         .join(Location, Location.id == Expense.location_id).join(ExpenseCategory, ExpenseCategory.id == Expense.category_id)
         .where(Expense.status == "POSTED", Expense.expense_date >= d1, Expense.expense_date <= d2,
                _loc(Expense.location_id, loc_ids))
         .group_by(Location.name, ExpenseCategory.name).order_by(Location.name, func.sum(Expense.amount).desc()))
    return [{"location": loc, "category": c, "count": int(n), "amount": D(a)} for loc, c, n, a in db.execute(q)]


def register_report(db: Session, d1: date, d2: date, loc_ids: LocIds) -> list[dict]:
    od = local_date(db, RegisterSession.opened_at)
    q = (select(RegisterSession, Location.name, User.full_name).join(Location, Location.id == RegisterSession.location_id)
         .join(User, User.id == RegisterSession.opened_by)
         .where(od >= d1, od <= d2, _loc(RegisterSession.location_id, loc_ids)).order_by(RegisterSession.opened_at.desc()))
    return [{"session_id": s.id, "location": loc, "register": s.register.name, "cashier": u, "status": s.status,
             "opened_at": s.opened_at, "closed_at": s.closed_at, "opening_float": s.opening_float,
             "expected_cash": s.expected_cash, "counted_cash": s.counted_cash, "variance": s.variance}
            for s, loc, u in db.execute(q)]


def purchase_commitments(db: Session, loc_ids: LocIds) -> dict:
    outstanding = PurchaseOrderLine.qty_ordered - PurchaseOrderLine.qty_received - PurchaseOrderLine.qty_cancelled
    value = outstanding * PurchaseOrderLine.unit_cost * (1 - PurchaseOrderLine.discount_pct / 100)
    row = db.execute(select(func.count(func.distinct(PurchaseOrder.id)), func.coalesce(func.sum(outstanding), 0),
                            func.coalesce(func.sum(value), 0))
                     .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
                     .where(PurchaseOrder.status.in_(["APPROVED", "ISSUED", "PARTIALLY_RECEIVED"]),
                            _loc(PurchaseOrder.location_id, loc_ids))).one()
    return {"open_orders": int(row[0]), "units_outstanding": int(row[1]), "value_outstanding": r2(row[2])}


def pending_counts(db: Session, loc_ids: LocIds) -> dict:
    transfers = db.scalar(select(func.count()).select_from(StockTransfer).where(
        StockTransfer.status.in_(["REQUESTED", "APPROVED", "IN_TRANSIT", "PARTIALLY_RECEIVED", "DISCREPANCY"]),
        or_(_loc(StockTransfer.source_location_id, loc_ids), _loc(StockTransfer.dest_location_id, loc_ids))))
    approvals = db.scalar(select(func.count()).select_from(ApprovalRequest).where(
        ApprovalRequest.status == "PENDING", or_(_loc(ApprovalRequest.location_id, loc_ids),
                                                 ApprovalRequest.location_id.is_(None) if loc_ids is None else literal(False))))
    open_sessions = db.scalar(select(func.count()).select_from(RegisterSession).where(
        RegisterSession.status == "OPEN", _loc(RegisterSession.location_id, loc_ids)))
    return {"transfers": int(transfers or 0), "approvals": int(approvals or 0), "open_register_sessions": int(open_sessions or 0)}


def cash_positions(db: Session, loc_ids: LocIds) -> list[dict]:
    q = (select(Account.id, Account.name, Account.system_key, Location.name,
                func.coalesce(func.sum(JournalLine.debit - JournalLine.credit), 0))
         .join(JournalLine, JournalLine.account_id == Account.id)
         .outerjoin(Location, Location.id == JournalLine.location_id)
         .where(Account.is_cash_or_bank.is_(True), _loc(JournalLine.location_id, loc_ids))
         .group_by(Account.id, Account.name, Account.system_key, Location.name).order_by(Account.name, Location.name))
    return [{"account_id": i, "account": n, "system_key": k, "location": loc or "Organisation", "balance": D(b)}
            for i, n, k, loc, b in db.execute(q) if D(b) != 0]
