# Deployment, operations, backups

## Recommended topology

```
Internet ──HTTPS──▶ Caddy (TLS, HSTS) ──▶ frontend (nginx: SPA + /api proxy) ──▶ backend (FastAPI, 2 workers)
                                                                                    │
                                                                    Managed PostgreSQL (private network, TLS)
```

* The SPA and API share **one origin** (nginx proxies `/api`). Session cookies are first-party
  (`HttpOnly`, `Secure`, `SameSite=Lax`) and no CORS is required.
* PostgreSQL must **not** be reachable from the internet. Use a managed service (AWS RDS, Google Cloud SQL,
  Azure Database for PostgreSQL, DigitalOcean, Neon, Supabase…) with private networking or an IP allow-list
  restricted to the app host, `sslmode=require`, automated backups and point-in-time recovery.
* Required PostgreSQL extension: `pg_trgm` (created by the first migration; managed services allow it).
* Server major version: 16 or 17. Keep `pg_dump` (in the backend image: 17) ≥ the server's major version.

## Single-VM production with Docker Compose + Caddy

1. Provision a VM (2 vCPU / 4 GB is ample for several outlets), install Docker, point a DNS record
   (e.g. `erp.example.com`) at it, open ports 80/443 only.
2. Create a managed PostgreSQL database and user; note the connection URL.
3. On the VM:

   ```bash
   git clone <repo> ajanta && cd ajanta
   cp backend/.env.example backend/.env.production
   # edit backend/.env.production:
   #   APP_ENV=production
   #   DATABASE_URL=postgresql+psycopg://USER:PASS@HOST:5432/DB?sslmode=require
   #   SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(64))")
   #   COOKIE_SECURE=true
   #   TRUSTED_HOSTS=["erp.example.com"]
   #   PUBLIC_APP_URL=https://erp.example.com
   chmod 600 backend/.env.production
   DOMAIN=erp.example.com docker compose -f docker-compose.prod.yml up -d --build
   ```

   The backend refuses to start in production with a weak `SECRET_KEY` or insecure cookies.
   The entrypoint runs `alembic upgrade head` and the reference-data bootstrap on every start.

4. Create the first administrator:

   ```bash
   docker compose -f docker-compose.prod.yml exec backend python -m app.cli create-admin \
     --email owner@yourstore.in --name "Owner Name" --org-name "Your Bookstore Pvt Ltd" --state-code 27 --gstin <GSTIN>
   ```

   Then sign in, complete **Settings → Organisation & GST**, create outlets and warehouses, users and roles,
   tax classes, opening stock (Stock adjustments → *Opening stock* with cost) and opening balances
   (Accounting → manual journal), then tick *Opening balances entered* in Settings → Policies.

5. Schedule daily jobs (cron on the host):

   ```cron
   15 6 * * * cd /srv/ajanta && docker compose -f docker-compose.prod.yml exec -T backend python -m app.cli daily-jobs
   30 2 * * * cd /srv/ajanta && docker compose -f docker-compose.prod.yml exec -T backend python -m app.cli reconcile-inventory || echo "inventory discrepancy" | mail -s ERP admin@yourstore.in
   ```

### Alternative hosting

* **PaaS (Render, Railway, Fly.io, Azure Container Apps, Cloud Run):** deploy `backend/` and `frontend/` as two
  services. Keep the same-origin model by routing `/api/*` to the backend at the platform's router, or serve
  the frontend's nginx in front of the backend as above. If you *must* serve the SPA from another origin, set
  `CORS_ORIGINS=["https://app.example.com"]`, `COOKIE_SAMESITE=none` (requires `COOKIE_SECURE=true`) and
  ensure the platform forwards cookies — same-origin is strongly preferred.
* **Static SPA on a CDN:** `npm run build` → upload `frontend/dist`, and proxy `/api` to the backend at the CDN.

## Configuration reference

All settings are environment variables; see [`backend/.env.example`](../backend/.env.example). Required:
`DATABASE_URL`, `SECRET_KEY`. Invalid or missing configuration stops the process at start-up with a clear error.

## Observability

* `GET /health/live` — process is up. `GET /health/ready` — database reachable; reports the applied migration.
  Both are used by container health checks; point your uptime monitor at `/health/ready`.
* Structured JSON logs to stdout (`LOG_JSON=true`), one line per request with method, path, status, duration,
  `request_id` and `user_id`. Every response carries `X-Request-ID` (honours an incoming `X-Request-ID`), and
  error bodies include the same id — quote it in support tickets.
* Ship stdout to your platform's log store (CloudWatch, Cloud Logging, Loki, Datadog…). Alert on
  `level=ERROR`, 5xx rate and `/health/ready` failures. The uvicorn command can be wrapped with an APM agent
  (OpenTelemetry, Datadog, New Relic) without code changes.
* Business monitoring: `reconcile-inventory` exits non-zero on any ledger/balance/copy discrepancy; the trial
  balance report must always show *Balanced*.

## Backups and restore

**Managed database:** enable automated daily backups with point-in-time recovery (7–35 days retention).
In addition, keep periodic logical dumps off-site:

```bash
# Inside the backend container (has pg_dump 17) or any host with a matching client:
DATABASE_URL=postgresql://USER:PASS@HOST:5432/DB ./scripts/backup.sh /backups
```

`backup.sh` writes a compressed custom-format dump and verifies it is readable. Also back up the uploads
volume (`docker run --rm -v ajanta_uploads:/u -v $PWD:/b alpine tar czf /b/uploads.tgz -C /u .`).

**Restore (tested procedure):**

```bash
# 1. Create an EMPTY database (restore refuses to overwrite a non-empty one unless FORCE=1)
psql "$ADMIN_URL" -c "CREATE DATABASE ajanta_restore"
# 2. Restore and check
DATABASE_URL=postgresql://USER:PASS@HOST:5432/ajanta_restore ./scripts/restore.sh /backups/ajanta_YYYYMMDDTHHMMSSZ.dump
DATABASE_URL=... python -m app.cli reconcile-inventory      # must report no discrepancies
# 3. Point the backend at the restored database (DATABASE_URL) and restart.
```

This procedure was exercised end-to-end on the Docker stack (PostgreSQL 17): a seeded database was dumped,
restored into a fresh database, row counts and journal totals matched, inventory reconciled, and the
append-only triggers were present on the restored copy. Rehearse restores quarterly.

## Security checklist

* HTTPS only (Caddy adds HSTS); `COOKIE_SECURE=true`; `TRUSTED_HOSTS` set to your domain.
* Strong random `SECRET_KEY` (also keys session/CSRF token hashing — rotating it signs everyone out).
* Database not publicly reachable; least-privilege DB user (owner of the app schema only).
* Remove `SETUP_TOKEN` after first-run setup (or never set it and use the CLI).
* Review the audit log (Administration → Audit log) and roles periodically; deactivate leavers (this revokes
  their sessions immediately).
* nginx sends CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` and `Permissions-Policy`.
* Keep images patched: rebuild monthly (`docker compose build --pull`).

## Scaling notes

* The backend is stateless apart from uploads; run more replicas behind the proxy when needed (move uploads to
  shared storage and add edge rate limiting first). Stock integrity relies on database row locks and
  constraints, so multiple replicas are safe.
* `DB_POOL_SIZE`/`DB_MAX_OVERFLOW` per process × workers × replicas must stay below the database's
  connection limit (use PgBouncer in transaction mode for many replicas).
