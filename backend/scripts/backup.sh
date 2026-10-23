#!/bin/sh
# Logical backup of the PostgreSQL database (custom format, compressed).
# Usage: DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/backup.sh [output-dir]
set -eu
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
URL="$(echo "$DATABASE_URL" | sed 's#postgresql+psycopg://#postgresql://#')"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/ajanta_${STAMP}.dump"
pg_dump --format=custom --no-owner --no-privileges --compress=9 --file="$FILE" "$URL"
pg_restore --list "$FILE" > /dev/null   # verify the archive is readable
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
