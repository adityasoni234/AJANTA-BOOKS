# Report and dashboard definitions

All figures are computed from posted transactions by SQL queries restricted to the viewer's permitted
locations. Screens, dashboards and CSV exports call the same functions (`app/services/reports.py`), and the
test suite checks that they reconcile with each other and with the general ledger.

Dates are evaluated in the organisation's timezone (default Asia/Kolkata). Cancelled (voided) sales are excluded
from sales metrics; their reversal entries cancel them in the ledger.

| Metric | Definition |
|---|---|
| Gross sales | Σ unit price × qty on completed sales (in the configured pricing basis — incl. GST when prices are inclusive) |
| Discounts | Σ line + bill discounts on completed sales |
| Invoice value | Σ invoice totals incl. GST and round-off |
| Returns | Σ refunds on completed returns (incl. GST), by completion date |
| **Net sales** | Σ taxable value of sales − Σ taxable value of returns (ex-GST revenue; equals GL Sales − Sales Returns) |
| GST collected | output GST on sales − GST reversed on returns |
| COGS | Σ (qty × weighted-average cost at sale time) − cost of returned goods |
| Gross profit | Net sales − COGS. Flagged *incomplete* when any sale contained items without cost data |
| Operating expenses | Posted expense-account totals from the ledger (pending/rejected expenses excluded) |
| Net profit | GL revenue − COGS − operating expenses (profit & loss statement) |
| Inventory valuation | (on hand + damaged + quarantined) × weighted-average cost per location, plus in-transit at transfer cost; compared with the GL Inventory balance |
| Low / out of stock | available (on hand − reserved) ≤ reorder level / ≤ 0 (location override or book default) |
| Fast-moving | highest units sold in the last 30 days |
| Slow-moving | sold within the slow-moving window but stock exceeds 4× units sold |
| Dead stock | stock on hand, no sales and no stock movement within the dead-stock window |
| Excess stock | stock above reorder level × multiplier, or above 3× recent sales |
| Supplier aging | open supplier-invoice balances bucketed by days past due date |
| Receivables aging | unpaid balances of credit sales by days since sale |
| Cash flow | direct method: movements on cash/bank accounts grouped by source document |
| Balance sheet | GL balances as of a date; flagged *incomplete* until opening balances are confirmed in settings |
| Register variance | counted cash − (opening float + cash received − cash refunds − cash expenses) |

Sales revenue, cash collected and profit are reported separately and never substituted for one another.

## Outlet supervision

The **Outlets** section (sidebar) lists every location the viewer can access. Its figures use the same
functions as the table above, restricted to one location:

* **Today / This week / This month**: invoice value (incl. GST), bills, average bill, net sales, discounts and
  returns. Weeks start on Monday; the month starts on the 1st. Gross profit is shown only with
  `reports.financial`.
* **Stock ready to sell** = on hand − reserved; also reserved, damaged, quarantined and in-transit units, titles
  in stock, value at selling price and (financial access only) at weighted-average cost, and the same split by
  category.
* Low / out-of-stock and long-unsold counts, open counters, transfers in progress, approvals, books on order
  and expenses this month; best sellers, categories and staff by net sales this month; staff assigned to the
  location. Screens reload every 30 seconds.

