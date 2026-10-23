#!/bin/sh
# Applies migrations and idempotent reference data before starting the API.
set -e
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Applying database migrations…"
  alembic upgrade head
  python -m app.cli bootstrap
fi
exec "$@"
