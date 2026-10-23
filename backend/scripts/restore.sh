#!/bin/sh
# Restore a backup into an EMPTY database (refuses if tables exist unless FORCE=1).
# Usage: DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/restore.sh backups/ajanta_X.dump
set -eu
FILE="$1"
URL="$(echo "$DATABASE_URL" | sed 's#postgresql+psycopg://#postgresql://#')"
COUNT="$(psql "$URL" -tAc "select count(*) from information_schema.tables where table_schema='public'")"
if [ "$COUNT" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Target database is not empty ($COUNT tables). Restore into a fresh database, or set FORCE=1." >&2
  exit 1
fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$URL" "$FILE"
psql "$URL" -tAc "select 'alembic revision: ' || version_num from alembic_version"
echo "Restore complete. Run: python -m app.cli reconcile-inventory"
