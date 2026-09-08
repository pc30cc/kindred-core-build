#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Applies any NOT-YET-APPLIED file in database/migrations/*.sql, in
# filename order, against $DATABASE_URL. Safe to run on every push:
# a ledger table (public._schema_migrations) records every filename this
# script has successfully applied, so a second run only picks up files
# added since the last run — it never re-executes a migration already on
# the target database, which matters because not every migration in this
# chain is safely re-runnable (some CREATE POLICY / ALTER TABLE statements
# have no IF NOT EXISTS guard).
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/dbname ./scripts/migrate-database.sh
#
# First-time setup on a database that already has some/all of this chain
# applied by hand (e.g. via the SELF_HOST_GUIDE.md manual instructions):
# see docs/AUTO_MIGRATIONS.md — you must seed the ledger with the
# filenames already applied BEFORE the first automated run, or this
# script will try to re-run them and fail on the first non-idempotent
# statement it hits.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (postgres connection string)}"

MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/database/migrations"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
  CREATE TABLE IF NOT EXISTS public._schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
"

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
IFS=$'\n' files=($(printf '%s\n' "${files[@]}" | sort))
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  echo "No migration files found under $MIGRATIONS_DIR" >&2
  exit 1
fi

applied_count=0
skipped_count=0

for f in "${files[@]}"; do
  base="$(basename "$f")"
  already="$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM public._schema_migrations WHERE filename = '$base'")"
  if [ "$already" = "1" ]; then
    skipped_count=$((skipped_count + 1))
    continue
  fi

  echo "── applying $base"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO public._schema_migrations (filename) VALUES ('$base')"
  applied_count=$((applied_count + 1))
done

echo "Done. Applied: $applied_count, already up to date: $skipped_count."
