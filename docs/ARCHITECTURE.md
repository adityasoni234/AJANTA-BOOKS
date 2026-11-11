# Architecture

One React single-page app on Firebase Hosting. Data lives in Cloud Firestore, sign-in uses Firebase Auth, and the
business logic runs in the browser in `frontend/src/server`. Every screen calls the same API paths it always did
(`api.get('/books')`), and `src/server/router.ts` answers them with a handler instead of a network request.

## Modules (`frontend/src/server`)

| File | Responsibility |
|---|---|
| `router.ts` | Path table, auth/permission context per request, Firebase error mapping |
| `store.ts` | Firestore access: live in-memory reference collections, sharded maps, queries, and `tx()` (unit of work over a transaction) |
| `ctx.ts` | Signed-in user: profile (`users/{uid}`), permissions, location scope, audit helper |
| `core.ts` | Decimal money, errors (same `{code, message, details}` shape as before), dates, ISBN/EAN, amount in words |
| `ledger.ts` | GST engine (pure), double-entry posting, daily/monthly summary totals |
| `stock.ts` | Inventory core: balances, movement ledger, weighted-average cost, individual copies |
| `admin.ts` | Sign-in, first-run setup, users, roles, locations, organisation and policy settings, audit log |
| `approvals.ts` | Approval center and derived notifications |
| `catalog.ts` | Books, master data, CSV import/export, merge, prices, covers |
| `inventory.ts` | Stock screens, adjustments, stocktakes, copies, labels, reconciliation |
| `sales.ts` | POS checkout, sales, voids, customers, receipts, returns/credit notes, registers |
| `purchasing.ts` | Suppliers, purchase orders, goods receipts, supplier invoices, payments, debit notes |
| `transfers.ts` | Stock transfer workflow |
| `finance.ts` | Accounts, journals, cashbook, fund transfers, bank reconciliation, expenses |
| `reports.ts` | Reports, dashboard, outlet supervision |
| `schools.ts` | Schools, class book lists, Excel import, school orders, author emails |
| `sample.ts` | Optional owner-only sample data |

## Data model

* **Reference collections** (small, read by everyone who needs them; kept in memory by a live listener):
  `organization`, `settings`, `locations`, `roles`, `users`, `tax_classes`, `payment_methods`, `accounts`,
  `expense_categories`, `categories`, `publishers`, `authors`, `suppliers`, `registers`, `schools`, `book_lists`.
* **Sharded maps** (many small records packed into a fixed number of documents, so loading them is cheap):
  `books/{shard}`, `customers/{shard}`, and stock balances `stock/{locationId}~{shard}`.
* **Record collections** (one document per record, lines embedded): `sales`, `returns`, `payments`,
  `purchase_orders`, `goods_receipts`, `supplier_invoices`, `supplier_returns`, `transfers`, `adjustments`,
  `stocktakes`, `copies`, `expenses`, `journals`, `stock_moves`, `register_sessions`, `school_orders`,
  `approvals`, `audit_logs`, `price_history`, `customer_ledger`.
* **Summaries:** `daily/{loc}~{date}` and `monthly/{loc}~{yyyy-mm}` hold sales, returns, payments, GST by
  HSN/rate, units by book and category, and debit/credit per account — added to in the same transaction as each
  posting, so reports and financial statements read a few documents.
* **Counters:** `counters/{scope}~{type}~{fy}` give gapless numbers (invoice numbers per outlet per year, PO, GRN…).

## Consistency

Each business action is one Firestore transaction (`tx()`): reads happen first (with pending writes visible to
later reads), then every write is applied together. Concurrent sales of the same book at the same outlet touch the
same stock document, so Firestore retries one of them and stock can never go negative. Idempotency keys are stored
as `idempotency/{kind}~{key}` inside the same transaction, so a retried request returns the original result.

## Security model

* **Sign-in:** Firebase Auth (email + password). The user's profile `users/{uid}` holds the role's permission
  codes (`perms`), `all_locations` or `location_ids`, `is_active` and `can_login`.
* **Rules** (`firestore.rules.template`): each collection requires the matching permission; location-owned
  records must belong to one of the user's locations; ledgers are create-only; users can't raise their own
  permissions or grant permissions they don't hold; each business's data lives under `orgs/{businessId}` and `members/{uid}` ties a login to one business, so one
  business can't read or write another's; at most `MAX_BUSINESSES` businesses can register (a counter in
  `platform/enroll` that the rules only let go up by one, within the limit, in the same write as the new business).
* **Known limit:** calculations (prices, GST, totals) run in the browser. The rules restrict *who* may write what
  and where, but not every figure inside an allowed write. See the README's limitations.
