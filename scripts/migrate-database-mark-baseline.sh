#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ONE-TIME, OPERATOR-RUN ONLY. Never invoked by CI.
#
# Marks every CURRENT database/migrations/*.sql filename as already
# applied in the ledger (public._schema_migrations) WITHOUT running any
# of them. Use this exactly once, before the first automated run of
# scripts/migrate-database.sh, on a database that already has this
# migration chain applied by hand (e.g. via SELF_HOST_GUIDE.md's manual
# `for f in database/migrations/*.sql; do psql ... -f "$f"; done`).
#
# Running this against a database that is NOT already at the current
# migration chain's head will leave it silently out of date — every file
# marked here is skipped forever after, whether or not it was really
# applied. If you are not certain your database is fully up to date,
# apply the chain manually first (SELF_HOST_GUIDE.md), THEN run this.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/dbname ./scripts/migrate-database-mark-baseline.sh
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (postgres connection string)}"

MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/database/migrations"

echo "This will mark every file below as ALREADY APPLIED, without running them:"
echo
ls "$MIGRATIONS_DIR"/*.sql | xargs -n1 basename
echo
read -r -p "Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
  CREATE TABLE IF NOT EXISTS public._schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
"

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

for f in "${files[@]}"; do
  base="$(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO public._schema_migrations (filename) VALUES ('$base') ON CONFLICT (filename) DO NOTHING"
done

echo "Marked ${#files[@]} file(s) as baseline. Future pushes will only apply NEW migration files."
