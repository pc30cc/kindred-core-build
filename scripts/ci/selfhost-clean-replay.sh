#!/usr/bin/env bash
# D.1 — official self-host clean replay.
#
# Applies database/migrations/*.sql in documented numeric order against a
# BRAND-NEW empty PostgreSQL database with ON_ERROR_STOP=1, recording the
# exit code and duration of every migration. Cutover files (080/081) are NOT
# part of this chain — they are applied separately at their documented
# cutover stages by scripts/ci/selfhost-cutover-replay.sh.
set -euo pipefail

DB="${1:?usage: selfhost-clean-replay.sh <dbname>}"
ADMIN_DSN="${ADMIN_DSN:-postgres://postgres:postgres@127.0.0.1:55432/postgres}"
DSN="${ADMIN_DSN%/*}/$DB"

psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS $DB;" >/dev/null
psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $DB;" >/dev/null

psql "$DSN" -v ON_ERROR_STOP=1 -qtA -c "SELECT version();"

# Supabase-compatible auth surface (GoTrue owns this in a real deployment).
psql "$DSN" -v ON_ERROR_STOP=1 -q -f scripts/ci/selfhost-auth-bootstrap.sql

printf '%-64s %8s %6s\n' MIGRATION MS EXIT
for f in database/migrations/*.sql; do
  start=$(date +%s%3N)
  set +e
  out=$(psql "$DSN" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1)
  code=$?
  set -e
  end=$(date +%s%3N)
  printf '%-64s %8s %6s\n' "$(basename "$f")" "$((end - start))" "$code"
  if [ "$code" -ne 0 ]; then echo "$out"; exit "$code"; fi
done
echo "clean replay OK: $DSN"
