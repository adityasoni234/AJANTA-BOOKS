# Ajanta Books ERP

A multi-outlet bookstore CRM + ERP: central catalog, warehouse and outlet inventory (quantity and
individual-copy tracking), purchasing, stock transfers, a keyboard/scanner-friendly POS with Indian GST
billing, returns and exchanges, customers and loyalty, registers and cash reconciliation, double-entry
accounting, school book lists with set-wise stock and author order emails, an owner's outlet-by-outlet
supervision view, dashboards and reports — with role- and location-based access control.

**Live:** <https://ajantabooks-840e7.web.app> (Firebase Hosting, project `ajantabooks-840e7`).

| Layer | Stack |
|---|---|
| App | React 19, TypeScript, Vite, Tailwind CSS 4, Radix components, TanStack Query, React Hook Form + Zod, Recharts |
| Data | Cloud Firestore (all records), Firebase Auth (email + password sign-in), Firestore security rules |
| Business logic | `frontend/src/server/` — runs in the browser and answers the same API paths every screen calls |
| Hosting | Firebase Hosting (free Spark plan; no server to run) |
| Tests | Vitest + Testing Library (16) |

Further reading: [Architecture](docs/ARCHITECTURE.md) · [Deployment](docs/DEPLOYMENT.md) ·
[GST billing rules](docs/GST.md) · [Report definitions](docs/REPORTS.md) · [API paths](docs/API.md)

---

## How it works

Every screen calls `api.get('/books')`, `api.post('/pos/checkout')` and so on. Those calls are answered in the
browser by `frontend/src/server/*`, which reads and writes Firestore:

* **One transaction per business action.** A sale updates stock, the movement ledger, the invoice counter,
  payments, the journal, the register session and the daily totals together, or not at all.
* **Money is exact** (decimal arithmetic, rounded to paise half-up); GST is computed by the app, never taken
  from the page.
* **Security rules** (`firestore.rules.template`) check the signed-in user's role permissions and location
  scope on every read and write; ledgers (stock movements, journals, audit log) can't be edited or deleted.
* **Reports read summaries.** Each posting also adds to per-location daily and monthly totals, so a month of
  figures costs a few document reads instead of thousands (the free plan allows 50,000 reads/day).

## First-time setup (live site)

1. Open the site. While no owner exists it shows **First-time setup**.
2. Create the business and the **owner account**. Only the email in `SETUP_EMAIL` (see below) may do this.
3. Optional: on the dashboard, **Load sample data** adds a warehouse, three outlets, 12 books with opening
   stock and 4 customers. It creates no logins.
4. Add stores under **Administration → Outlets & warehouses**, and their staff logins under
   **Administration → Users** (pick a role, the store, and a starting password; they change it on first sign-in).

## Local development

One-time:

```bash
cd frontend && npm install
npm install -g firebase-tools        # Firebase CLI (emulators, deploy)
brew install openjdk@21              # Java, needed by the Firestore emulator
```

Create `frontend/.env.local` (never committed) from `frontend/.env.example`, with the Firebase web config and:

```
SETUP_EMAIL=you@example.com          # the only email allowed to run first-time setup
```

Then:

```bash
cd frontend && npm run dev           # http://localhost:5199
```

`npm run dev` starts the **Firebase emulators** (Auth + Firestore, local data only) and the app. Nothing touches
the real project. Ctrl+C stops both. `VITE_FIREBASE_EMULATORS=false npm run dev` uses the real project instead.

## Deploy

```bash
cd frontend && npm run build && cd .. && firebase deploy --only hosting,firestore
```

This publishes the site, the security rules (rendered from `firestore.rules.template` with `SETUP_EMAIL`) and
the Firestore indexes. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Checks

```bash
cd frontend && npm run lint && npm run typecheck && npm test && npm run build
```

The Playwright browser tests in `frontend/e2e/` were written for the previous Python server and seeded demo
data; they need rewriting against the emulators before they can run again.

---

## Project layout

```
frontend/
  src/server/      in-browser backend on Firestore: router, data layer, GST & accounting engine, and one module
                   per area (admin, catalog, inventory, sales/POS, purchasing, transfers, finance, reports, schools)
  src/pages/       screens grouped by area
  src/components/  ui primitives, layout shell, shared table/filter/search components
  src/lib/         api client, auth context, hooks, query helpers
  vite-plugin-firebase-emulators.ts   starts the emulators with npm run dev
firestore.rules.template   security rules (scripts/render-rules.mjs fills in SETUP_EMAIL)
firestore.indexes.json     composite indexes for location-scoped queries
firebase.json              hosting, rules, indexes, emulator ports
docs/                      architecture, deployment, GST, reports, API
```

---

## Genuine limitations (read before production)

* **Business rules run in the browser.** Security rules enforce who may read or write each record and at which
  location, and keep ledgers append-only, but within what a role is allowed to change, a technically skilled
  user could write incorrect totals. A server (Cloud Functions, which needs the paid Blaze plan) would close this.
* **Free-plan quotas:** 50,000 reads, 20,000 writes per day. A busy bookstore fits; very large catalogs or heavy
  reporting may not.
* **Database location:** the Firestore database is in the US (nam5); each save is a round trip from India.
* **Images** (covers, expense receipts) are compressed and kept in Firestore, since Firebase Storage needs Blaze.
* **GST compliance is not certified.** Configurable rates, inclusive/exclusive pricing, CGST/SGST vs IGST,
  per-line rounding and credit notes are implemented; your accountant must verify them. **No e-invoicing,
  e-way bills or GSTR filing integration exists.**
* **No offline POS.** The POS needs a connection.
* **School order emails open in your own mail app**; the system records that the draft was opened, never that it was sent.
* **Payment gateways, WhatsApp, SMS and SMTP are not integrated.** Card/UPI are recorded with the terminal
  reference. Password-reset emails are sent by Firebase Auth.
* **Sessions are managed by Firebase Auth:** there is no list of other devices; deactivating a user stops them on
  their next action.
* **Accounting scope:** weighted-average costing; no period close, multi-currency, TDS/TCS or bank-statement import.
  The balance sheet is flagged incomplete until opening balances are confirmed in settings.
* **Single organisation.**
