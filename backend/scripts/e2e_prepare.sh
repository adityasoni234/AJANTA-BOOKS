#!/bin/sh
# Recreates the isolated end-to-end database and loads deterministic demo data.
# Refuses to touch any database whose name does not end in "_e2e".
set -eu
URL="${DATABASE_URL:?DATABASE_URL required}"
DB="$(echo "$URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
case "$DB" in *_e2e) ;; *) echo "Refusing: database '$DB' is not an *_e2e database" >&2; exit 1 ;; esac
ADMIN_URL="$(echo "$URL" | sed -E "s#/$DB#/postgres#; s#postgresql\+psycopg://#postgresql://#")"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
psql "$ADMIN_URL" -qc "CREATE DATABASE $DB"
.venv/bin/alembic upgrade head > /dev/null
.venv/bin/python -m app.cli seed-demo > /dev/null
echo "E2E database $DB ready"
