# Ajanta Books ERP

A multi-outlet bookstore CRM + ERP: central catalog, warehouse and outlet inventory (quantity and
individual-copy tracking), purchasing, stock transfers, a keyboard/scanner-friendly POS with Indian GST
billing, returns and exchanges, customers and loyalty, registers and cash reconciliation, double-entry
accounting, school book lists with set-wise stock and author order emails, an owner's outlet-by-outlet
supervision view, dashboards and reports — with strict role- and location-based access control.

| Layer | Stack |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, Radix/shadcn-style components, TanStack Query, React Hook Form + Zod, Recharts |
| Backend | Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2, Alembic |
| Database | PostgreSQL 16/17 (Decimal money, FKs, check constraints, integrity triggers) |
| Tests | Pytest (89), Vitest + Testing Library (16), Playwright E2E (8) |
| Deploy | Docker / Docker Compose, nginx (SPA + API proxy), Caddy (TLS) |

Further reading: [Architecture](docs/ARCHITECTURE.md) · [Deployment & backups](docs/DEPLOYMENT.md) ·
[GST billing rules](docs/GST.md) · [Report definitions](docs/REPORTS.md) · [API conventions](docs/API.md)

---

## Quick start (Docker, everything included)

```bash
docker compose -p ajantabooks up -d --build
```

Open <http://localhost:8080>. The database starts empty. Either

* load **demo data** (local only — refuses to run when `APP_ENV=production`):

  ```bash
  docker compose -p ajantabooks exec backend python -m app.cli seed-demo
  ```

* or create the **first administrator** (prompts for a password):

  ```bash
  docker compose -p ajantabooks exec backend python -m app.cli create-admin --email you@yourstore.in --name "Your Name" --org-name "Your Bookstore Pvt Ltd" --state-code 27
  ```

  The web setup screen (`/setup`) is an alternative; it requires the `SETUP_TOKEN` from the server
  environment and only works while no administrator exists.

`docker-compose.yml` uses local-only defaults from `backend/.env.docker` and plain HTTP. Do not use it
for production — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Demo accounts (after `seed-demo`)

All use the password `Demo@Books2026` (override with `--password` / `DEMO_PASSWORD`).

| Email | Role | Scope |
|---|---|---|
| owner@ajantabooks.test | Super Admin / Owner | All locations |
| inventory@ajantabooks.test | Central Inventory Manager | All locations |
| accounts@ajantabooks.test | Accountant | All locations |
| auditor@ajantabooks.test | Auditor (read-only) | All locations |
| fort.manager@ajantabooks.test / fort.cashier@… | Store Manager / Cashier | Fort, Mumbai |
| pune.manager@… / pune.cashier@… | Store Manager / Cashier | FC Road, Pune |
| blr.manager@… / blr.cashier@… | Store Manager / Cashier | Church Street, Bengaluru (Karnataka GSTIN) |

The demo seeds a warehouse and three outlets (one in another state, for IGST), 45 titles including
copy-tracked collectibles and GST-rated stationery, purchase orders with partial and damaged receipts,
supplier invoices and payments, transfers (one with a damaged unit, one in transit, one awaiting approval),
~480 sales over 30 days with discounts, split payments, B2B and interstate invoices, returns, register
sessions with cash variances, and expenses. Everything is created through the real service layer, so stock,
invoices and journals reconcile.

---

## Local development

Prerequisites: Python 3.12, Node 20+, PostgreSQL 16+.

One-time setup:

```bash
cd backend
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
createdb ajanta_dev
cat > .env <<'ENV'
APP_ENV=development
DATABASE_URL=postgresql+psycopg://localhost:5432/ajanta_dev
SECRET_KEY=dev-secret-key-for-local-development-only-0123456789
COOKIE_SECURE=false
LOG_JSON=false
ENV
.venv/bin/alembic upgrade head
.venv/bin/python -m app.cli seed-demo          # or: create-admin
cd ../frontend && npm ci
```

Then, every time, one command runs the whole app:

```bash
cd frontend && npm run dev                      # http://localhost:5199
```

`npm run dev` applies any new database migrations, starts the backend on port 8765 (auto-reloading on code
changes, its log lines prefixed `[backend]`), waits until it is ready, then serves the frontend, which proxies
`/api` to it. Ctrl+C stops both. If a backend is already running on 8765 it is reused; if the backend can't start
(no `.venv`, PostgreSQL down, bad `.env`), `npm run dev` stops with the reason.
To use a backend you run yourself elsewhere, set `VITE_API_PROXY=http://127.0.0.1:<port>`; nothing is started then.
API docs (OpenAPI/Swagger) are served at <http://localhost:8765/api/docs>.
The dev ports (5199/8765) are deliberately unusual so they don't collide with other local projects on 5173/8000.

**Firebase (optional).** The frontend connects to a Firebase project when `frontend/.env.local` holds its web
config (copy `frontend/.env.example`; the file is gitignored). Only Firebase Analytics is used. All business data
is saved by the backend in PostgreSQL; the browser never writes to Firestore, whose rules stay closed. Without the
config, Firebase stays unconfigured. Docker builds from this folder pick up `.env.local` too.

### Operational CLI

```bash
python -m app.cli bootstrap              # idempotent reference data (roles, permissions, chart of accounts, tax classes)
python -m app.cli create-admin ...       # first administrator (ADMIN_PASSWORD env or interactive prompt)
python -m app.cli seed-demo              # demo data on an empty database (never in production)
python -m app.cli daily-jobs             # supplier-due reminders, expired-session cleanup (schedule daily)
python -m app.cli reconcile-inventory    # balances vs ledger vs copy registry; exit code 1 on discrepancy
python -m app.cli check-config           # print effective, non-secret configuration
```

### Migrations

```bash
cd backend
.venv/bin/alembic upgrade head                                   # apply
.venv/bin/alembic revision --autogenerate -m "describe change"   # create (review the file!)
```

`0001` creates the schema; `0002` adds the integrity triggers (append-only ledgers, immutable invoices and
sale totals, deferred balanced-journal check) and numbering sequences. The Docker entrypoint applies
migrations and the reference-data bootstrap on start (`RUN_MIGRATIONS=false` disables this).

---

## Tests

```bash
# Backend: needs a PostgreSQL database whose name contains "ajanta_test" (it is dropped and re-migrated)
createdb ajanta_test
cd backend && .venv/bin/ruff check app tests && .venv/bin/pytest
# TEST_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/ajanta_test overrides the default

# Frontend
cd frontend && npm run lint && npm run typecheck && npm test && npm run build

# End-to-end: recreates an isolated ajanta_e2e database, seeds demo data, starts backend + frontend
cd frontend && npx playwright install chromium && npm run e2e
# E2E_DATABASE_URL / E2E_API_PORT / E2E_WEB_PORT override defaults
```

What the suites cover (each maps to the acceptance requirements):

* **Auth & sessions** — login, generic errors, lockout, rate limiting, CSRF, idle and absolute expiry, logout,
  immediate effect of role changes and deactivation, password change revoking other sessions, one-time reset
  links, forced first-login password change, protected first-run setup.
* **RBAC & outlet isolation** — every protected route rejects anonymous access (walks the OpenAPI spec);
  cross-outlet reads by id (404), by filter and export (403), and cross-outlet mutations are refused;
  privilege-escalation attempts are blocked.
* **Catalog** — ISBN/barcode duplicates rejected by API *and* by database constraints, checksum validation,
  price history, CSV import (all-or-nothing) and export, scanner lookup, merge preserving history.
* **Inventory** — goods receipt exactly once under retries, over-receipt refused, landed-cost weighted
  average, approval thresholds, stocktake variances, copy lifecycle, append-only ledger, no negative stock.
* **Transfers** — reservation, dispatch → in-transit, partial/damaged receipt, idempotent receipts,
  discrepancy resolution (lost / returned), copy-level transfers, GL movement between locations.
* **POS** — server-authoritative pricing, invoice/stock/payment/journal invariants, idempotent checkout,
  10 concurrent buyers for 5 units (exactly 5 succeed), the same copy sold concurrently (exactly 1),
  IGST for interstate B2B, discount limits with single-use manager approval, void with reversal, credit sales
  with receipts, store credit.
* **Returns & finance** — exact partial-return proration (refunds sum to the amount paid), dispositions,
  refund approvals, credit-note linkage, exchanges, register expected cash and variance posting,
  no double counting of supplier invoices/payments/expenses, balanced and immutable journals,
  reports/dashboard/CSV/GL reconciliation, inventory valuation equals GL.
* **School book lists** — Excel import (catalog matching by ISBN or title + author, new books, all-or-nothing
  validation, re-import replaces a class list), complete sets per location limited by the scarcest book,
  on-order counts, shop-owner location scope, one purchase order per author with idempotent retries, order
  email rendering and template validation, receiving raising sets available, permission upgrade safety.
* **Outlet supervision** — per-outlet today/week/month figures equal the sales reports; stock state, category
  and staff breakdowns; a shop manager sees only their outlet and no cost or profit figures.
* **E2E (Playwright)** — book → PO → GRN → transfer → POS sale with GST invoice → return → reports;
  cashier navigation and access limits; sign-out; cross-user discount approval; school list Excel import →
  order → author email; shop owner's school view limited to their shop; every outlet (including a newly
  opened one) in the owner's sidebar with overview, stock, sales and staff tabs.

---

## Project layout

```
backend/
  app/
    api/v1/        HTTP routers (auth, admin, catalog, inventory, purchasing, transfers, pos, customers, finance, reports, approvals, schools, outlets)
    services/      business logic (inventory ledger, gst engine, accounting, sales, returns, transfers, purchasing, reports…)
    models/        SQLAlchemy models
    core/          config, db, security, errors, logging, middleware
    cli.py, seed.py
  alembic/         migrations (0001 schema, 0002 integrity triggers, 0003 school book lists)
  tests/           pytest suite
  scripts/         entrypoint, backup, restore, e2e database prep
frontend/
  src/pages/       screens grouped by domain
  src/components/  ui primitives, layout shell, shared table/filter/search components
  src/lib/         api client, auth context, hooks, query helpers
  e2e/             Playwright specs
deploy/            Caddyfile
docs/              architecture, deployment, GST, reports, API
```

---

## Genuine limitations (read before production)

* **GST compliance is not certified.** The engine implements configurable rates, inclusive/exclusive pricing,
  CGST/SGST vs IGST by place of supply, per-line rounding and credit notes. Your accountant must verify tax
  classification (e.g. printed books under HSN 4901 are commonly nil-rated), invoice format and registration
  details. **No e-invoicing (IRN/QR), e-way bills or GSTR filing integration exists.**
* **No offline POS.** The POS needs a live connection to the server; stock is authoritative centrally.
* **School order emails open in your own mail app** (a pre-filled `mailto:` draft). The system records when a
  draft was opened but cannot know whether you sent it, so it never marks an order as emailed or sent.
  Very long orders may exceed what some mail apps accept in a link; the dialog offers Copy text for those.
* **Payment gateways, WhatsApp and SMS are not integrated.** Card/UPI payments are recorded with the terminal
  reference; nothing claims to verify or deliver them. Email works only when SMTP is configured.
* **Accounting scope:** weighted-average costing; no period close/lock, multi-currency, TDS/TCS, or
  bank-statement import (bank reconciliation compares a statement balance with the books). The balance sheet
  is flagged incomplete until opening balances are entered and confirmed in settings.
* **Single organisation.** Multiple warehouses are supported in the data model (location type), but not
  multiple legal entities.
* **Rate limiting is per backend process.** The database-backed account lockout works across instances; add
  edge rate limiting (load balancer / CDN / WAF) when scaling horizontally.
* **Uploads (covers, receipts) are stored on a local volume.** Use a persistent volume, and back it up with
  the database; object storage is not yet integrated.
* **Credit sales:** a return against a sale that still has an outstanding balance is blocked until the balance
  is collected; credit notes are not applied to receivables automatically.
* **Exchange credit** must be used in full on the replacement sale (unused credit must be refunded as a
  separate return).
* **Customer segments** use fixed thresholds (VIP ≥ ₹20,000 or 15 visits; lapsed after 180 days).
* **Demo history** is created by back-dating seeded transactions, which requires a database role allowed to
  set `session_replication_role` (local/dev only).
