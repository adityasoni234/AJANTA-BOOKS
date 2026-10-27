# API conventions

* Base path: `/api/v1`. Interactive docs: `/api/docs` (Swagger) and `/api/redoc`; schema at
  `/api/openapi.json`. Health: `/health/live`, `/health/ready`.
* **Authentication:** `POST /api/v1/auth/login` sets the `ab_session` (HttpOnly) and `ab_csrf` cookies and
  returns the user, permissions, permitted locations and `csrf_token`. `GET /auth/me` returns the same.
* **CSRF:** every POST/PUT/PATCH/DELETE must send `X-CSRF-Token: <csrf_token>`.
* **Idempotency:** money- and stock-moving creates require `Idempotency-Key: <uuid>` (8–80 chars):
  `POST /pos/checkout`, `/goods-receipts`, `/returns`, `/supplier-payments`, `/supplier-returns`,
  `/customers/{id}/receipts`, `/transfers/{id}/receive`, `/transfers/{id}/resolve`; optional for `/expenses`.
  Repeating a request with the same key returns the original result (`"replayed": true` where applicable).
* **Money** is always a decimal string (`"1234.50"`); quantities are integers.
* **Pagination:** `?page=1&page_size=25` (max 200) → `{ "items": [...], "total", "page", "page_size" }`.
* **Exports:** report endpoints accept `?format=csv` (requires `reports.export`) with the same filters and
  scope as the JSON response.
* **Errors:** non-2xx responses have a stable shape:

  ```json
  { "error": { "code": "insufficient_stock", "message": "Insufficient stock for 'X': available 2, requested 3",
               "details": { "book_id": "…" }, "request_id": "9f2c…" } }
  ```

  | Status | Typical codes |
  |---|---|
  | 401 | `not_authenticated`, `session_expired`, `invalid_credentials`, `account_locked` |
  | 403 | `permission_denied`, `location_denied`, `csrf_failed`, `password_change_required`, `discount_approval_required`, `self_approval` |
  | 404 | `not_found` (also for records outside your location scope) |
  | 409 | `conflict`, `insufficient_stock`, `copy_unavailable`, `excess_return`, `register_closed`, `credit_limit` |
  | 422 | `validation_failed` (with per-field `details`), `payment_incomplete` |
  | 429 | `rate_limited` |

* Every response carries `X-Request-ID` for log correlation.

## Main resources

| Area | Endpoints |
|---|---|
| Auth | `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/change-password`, `/auth/password-reset/request`, `/auth/password-reset/confirm`, `/auth/sessions`, `/setup` |
| Admin | `/users`, `/roles`, `/permissions`, `/locations`, `/organization`, `/settings/policy`, `/settings/integrations`, `/audit-logs` |
| Catalog | `/books` (+ `/lookup`, `/check-duplicates`, `/import/preview`, `/import/commit`, `/export.csv`, `/{id}/merge`, `/{id}/cover`, `/{id}/price-history`, `/{id}/inventory-history`, `/{id}/location-settings`), `/categories`, `/tax-classes`, `/publishers`, `/authors` |
| Inventory | `/inventory`, `/inventory/summary`, `/inventory/ledger`, `/inventory/reconciliation`, `/inventory/adjustments`, `/inventory/stocktakes`, `/copies`, `/labels` |
| Purchasing | `/suppliers` (+ `/statement`), `/purchase-orders` (+ `/submit`, `/decision`, `/issue`, `/cancel`), `/goods-receipts`, `/supplier-invoices`, `/supplier-payments`, `/supplier-returns` |
| Transfers | `/transfers` (+ `/submit`, `/decision`, `/dispatch`, `/receive`, `/resolve`, `/cancel`) |
| POS & sales | `/payment-methods`, `/registers`, `/register-sessions` (+ `/close`), `/pos/quote`, `/pos/checkout`, `/pos/discount-approvals`, `/sales`, `/sales/{id}`, `/sales/by-invoice/{number}`, `/sales/{id}/void` |
| Customers & returns | `/customers` (+ `/history`, `/ledger`, `/redeem-points`, `/receipts`), `/returns`, `/exchange-method` |
| Finance | `/accounts`, `/journals` (+ `/reverse`), `/cashbook`, `/fund-transfers`, `/bank-reconciliations`, `/expenses` (+ `/receipt`), `/expense-categories` |
| Reports | `/dashboard`, `/reports/sales-summary`, `/sales-by`, `/sales-trend`, `/payments`, `/gst-register`, `/gst-summary`, `/inventory-valuation`, `/stock-analysis`, `/profit-loss`, `/cash-flow`, `/balance-sheet`, `/trial-balance`, `/supplier-aging`, `/receivables-aging`, `/expenses`, `/registers` |
| Workflow | `/approvals` (+ `/decision`), `/notifications`, `/notifications/read` |
