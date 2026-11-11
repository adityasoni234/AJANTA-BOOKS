# Architecture

A modular monolith: one FastAPI application with domain modules, one PostgreSQL database, one React SPA.
No message brokers or caches — PostgreSQL transactions, row locks and constraints provide consistency.

## Backend modules

| Module | Routers (`app/api/v1`) | Services (`app/services`) |
|---|---|---|
| Auth & sessions | `auth.py` | `auth.py`, `mailer.py` |
| Users, roles, locations, settings, audit | `admin.py` | `permissions.py`, `settings.py`, `bootstrap.py`, `audit.py` |
| Catalog | `catalog.py` | `catalog.py`, `identifiers.py` |
| Inventory, copies, adjustments, stocktakes | `inventory.py` | `inventory.py` |
| Suppliers, POs, goods receipts, supplier invoices/payments/returns | `purchasing.py` | `purchasing.py` |
| Transfers | `transfers.py` | `transfers.py` |
| POS, registers, sales, invoices, voids | `pos.py` | `sales.py`, `gst.py`, `words.py` |
| Customers, receipts, returns/exchanges | `customers.py` | `returns.py`, `sales.py` |
| Expenses, accounts, journals, cashbook, bank reconciliation | `finance.py` | `finance.py`, `accounting.py` |
| Reports & dashboard | `reports.py` | `reports.py` |
| Approvals & notifications | `approvals.py` | `approvals.py`, `notify.py` |
| Outlet supervision (owner) | `outlets.py` | `reports.py` |
| Schools, class book lists, school orders | `schools.py` | `schools.py` (uses `purchasing.py`, `catalog.py`) |

Routers validate input (Pydantic), resolve the caller's permissions and location scope, and delegate to
services. Services own transactions' business rules; routers commit.

## Security model

* **Sessions:** opaque random token in an `HttpOnly` cookie; only an HMAC (keyed by `SECRET_KEY`) is stored.
  Idle timeout (default 2 h) and absolute expiry (12 h); logout, password change, deactivation and admin
  action revoke sessions. Passwords use **Argon2id**; policy requires ≥10 chars and 3 character classes.
* **CSRF:** double-submit token bound to the session (stored hashed) — every unsafe request needs
  `X-CSRF-Token`. Cookies are `SameSite=Lax`.
* **Brute force:** per-IP and per-email sliding-window limits, plus database-backed account lockout.
* **Authorization:** every protected endpoint declares permissions (`require(...)`); the user's role
  permissions are loaded from the database on each request, so role changes apply immediately.
  `test_every_protected_route_requires_auth` walks the OpenAPI spec to prove no route is unprotected.
* **Location isolation:** users have `all_locations` or explicit location assignments. Every location-owned
  query applies `ctx.loc_filter(...)`; explicit `location_id` parameters outside scope return **403**;
  objects fetched by id outside scope return **404** (existence is not disclosed). Reports and CSV exports
  share the same scoped functions.
* **Escalation guards:** users can only grant permissions/roles they hold, only assign locations in their
  scope, cannot edit their own role, and cannot approve their own requests.
* **Audit:** an append-only `audit_logs` table records security and business actions with actor, IP,
  request id and before/after details.

## Data model highlights

* `locations` (warehouse / outlet) hold address, state code, optional GSTIN and invoice prefix.
* `books` is the single organisation-wide catalog (ISBN-13/10, SKU and barcode each unique by index; ISBN is not
  the primary key). `inventory_balances` holds per-(location, book) stock buckets
  (`on_hand`, `reserved`, `damaged`, `quarantined`, `in_transit`), weighted-average cost, reorder level and
  price override. Check constraints forbid negative stock.
* `inventory_ledger` is the append-only movement journal (signed quantity per bucket, movement type,
  reference, actor, unit cost). Balances are updated in the **same transaction** as ledger rows; the
  `reconcile` service/CLI proves they agree and that copy counts match.
* `individual_copies` (unique `copy_code`) + `copy_events` track each physical copy for copy-tracked titles.
  Aggregate stock for those titles still lives in balances, so copies are never double counted.
* Sales: `sales` + `sale_lines` (per-line taxable value, CGST/SGST/IGST, unit cost), `invoices`
  (immutable tax documents incl. credit notes, seller/buyer snapshots), `payments` + `payment_allocations`.
* Returns: `returns` + `return_lines`, each linked to the original sale line.
* Accounting: `accounts` (chart; cash/bank flag), `journal_entries` + `journal_lines`.

## Integrity guarantees enforced by the database (`alembic/versions/0002`)

* `inventory_ledger`, `audit_logs`, `journal_entries`, `journal_lines`, `copy_events`, `customer_ledger`,
  `sale_lines`, `return_lines` reject UPDATE and DELETE.
* `invoices`: only `status` may change (ISSUED → CANCELLED); numbers and content are immutable.
* `sales`: monetary columns, location, customer and idempotency key are frozen after insert.
* A **deferred constraint trigger** rejects, at commit, any journal entry whose debits ≠ credits or that has
  fewer than two lines.

## Concurrency and idempotency

* Stock rows are locked with `SELECT … FOR UPDATE` in a deterministic order before any change; availability
  is re-checked under the lock (tested with 10 concurrent buyers for 5 units). Copies are locked individually
  (tested with concurrent sales of one copy).
* Checkout, goods receipts, returns, supplier payments, customer receipts, transfer receipts and expenses accept
  an `Idempotency-Key` header stored under a unique constraint: a retry returns the original result and never
  repeats stock, payment or journal effects. The UI keeps one key per submission until success.
* Workflow transitions (approve/dispatch/receive/void/close) lock the parent row and validate state, so double
  clicks cannot dispatch or receive twice.
* Invoice and credit-note numbers come from row-locked per-outlet, per-financial-year sequences (gapless, never
  reused, ≤16 characters). Journal and payment numbers use PostgreSQL sequences (unique, may have gaps).

## Accounting posting rules

Weighted-average cost per location. All entries are system-posted and balanced:

| Event | Debit | Credit |
|---|---|---|
| Goods receipt | Inventory (landed cost) | Goods Received Not Invoiced |
| Supplier invoice | GRNI (+ purchase price variance), Input CGST/SGST/IGST | Accounts Payable |
| Supplier payment | Accounts Payable | Cash/Bank |
| Supplier return (debit note) | Accounts Payable | Inventory |
| Sale | Cash / UPI / Card clearing / Bank / Store credit / Exchange clearing / AR | Sales, Output GST, Round-off |
| …cost of sale | COGS | Inventory |
| Return / credit note | Sales Returns, Output GST, Round-off | Refund account; Inventory ↔ COGS at original cost |
| Void | exact reversal of the sale entry | |
| Stock adjustment | Inventory / Shrinkage (or Opening Balance Equity for opening stock) | |
| Transfer dispatch | Inventory (destination) | Inventory (source) |
| Transfer loss | Shrinkage | Inventory |
| Expense | Expense account | Cash/Bank |
| Register close variance | Cash Over/Short | Cash (or reverse) |
| Loyalty redemption / store-credit goodwill | Loyalty Rewards | Store Credit liability |

Corrections are made by reversal entries or through the source document (void, return, adjustment); posted
entries are never edited.

## School book lists

* A **school** (organisation-wide, owned by the main owner) has one **book list** per class and academic year;
  each list item says how many copies of a book one student set needs (`qty_per_set`).
* **Complete sets** at a location = min over the list of `floor((on_hand − reserved) / qty_per_set)`. "With on
  order" adds outstanding quantities on approved/issued purchase orders for that location. Viewers see only the
  locations in their scope (a shop owner sees their shop; the owner sees all).
* **Excel import** (`.xlsx`, first sheet, template columns) is validated in full before anything is written:
  ISBN checksums, academic year, school-name consistency, duplicates within a class, one email per author, and
  MRP + GST for books not yet in the catalog. Books match by ISBN, else by exact title + first author. Commit
  re-validates and runs in one transaction; re-importing a class replaces that class's list.
* **School order** = chosen classes × number of sets at one delivery location. Suggested quantity per book is
  `required − available − on order`, editable before creating. One purchase order is raised per **first
  author** (a supplier account is created and linked to the author on their first order) and submitted through
  the normal approval rules. Receiving those purchase orders is the only thing that raises stock and sets.
* **Order email**: the server renders a stored template (placeholders validated on save) for a purchase order;
  the browser opens it as a `mailto:` draft. The server records `email_opened_at` only; it never claims the
  email was sent.

## Frontend

* Route-level code splitting; TanStack Query for server state; React Hook Form + Zod for forms.
* All money values arrive as decimal **strings** (never floats) and are only formatted for display; the POS
  displays the server's authoritative quote and never computes totals itself.
* Accessibility: labelled controls (`Field` auto-associates labels), keyboard-navigable comboboxes, focus
  rings, skip link, ARIA live/alert regions for errors, error boundary per page.
