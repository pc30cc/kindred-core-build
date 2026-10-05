#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Copy all application data from one database to another — Supabase →
# PostgreSQL, PostgreSQL → Supabase, or any other pair. See docs/DATABASE.md.
#
#   SOURCE_DATABASE_URL=postgresql://...  TARGET_DATABASE_URL=postgresql://... \
#     bash scripts/db/move-data.sh
#
# How it works, and why this way:
#   1. The TARGET's schema is built by database/migrations
#      (scripts/migrate-database.sh), never copied from the source. Supabase
#      keeps extensions in an `extensions` schema and plain PostgreSQL keeps
#      them in `public`; a schema dump carries those paths with it and breaks
#      on the other side. Built natively, each side has its own layout.
#   2. Only DATA moves: pg_dump --data-only of schema public, loaded with
#      session_replication_role=replica (no triggers, no FK checks during the
#      load — the rows were consistent at the source) inside ONE transaction:
#      it all lands or nothing does. Partitioned tables load through their
#      root. Sequences come along (setval).
#   3. Before anything is written, every source table and column must exist
#      on the target. A gap aborts the run with the list — nothing is lost
#      silently.
#   4. After the load, the row count of every table is compared.
#
# The TARGET's public data is REPLACED (its migration ledger,
# public._schema_migrations, is kept). The source is only read. Stop the
# application (or put it in maintenance) for the duration, so the copy is a
# consistent snapshot of a database nobody is writing to.
#
# Needs psql / pg_dump / pg_restore at least as new as the newer server —
# e.g. run it from the postgres:17 image:
#   docker run --rm -it -v "$PWD":/app -w /app \
#     -e SOURCE_DATABASE_URL -e TARGET_DATABASE_URL postgres:17 \
#     bash scripts/db/move-data.sh
#
# Set YES=1 to skip the confirmation prompt.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

SOURCE="${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
TARGET="${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n── %s\n' "$*"; }
q() { psql "$1" -v ON_ERROR_STOP=1 -qtAX -c "$2"; }

say "Connecting"
src_ver="$(q "$SOURCE" "SHOW server_version_num")"
dst_ver="$(q "$TARGET" "SHOW server_version_num")"
dump_ver="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
echo "source: PostgreSQL $((src_ver / 10000))   target: PostgreSQL $((dst_ver / 10000))   pg_dump: $dump_ver"
if [ "$dump_ver" -lt "$((src_ver / 10000))" ]; then
  echo "pg_dump $dump_ver is older than the source server; use a client at least as new (see the header)." >&2
  exit 1
fi
if [ "$(q "$SOURCE" "SELECT current_database() || '@' || inet_server_addr()::text || ':' || inet_server_port()")" = \
     "$(q "$TARGET" "SELECT current_database() || '@' || inet_server_addr()::text || ':' || inet_server_port()")" ]; then
  echo "SOURCE and TARGET are the same database." >&2
  exit 1
fi

say "Building the target schema from database/migrations"
DATABASE_URL="$TARGET" bash "$ROOT/scripts/migrate-database.sh"

say "Checking that every source table and column exists on the target"
if ! q "$TARGET" "SELECT 1 FROM pg_extension WHERE extname = 'vector'" | grep -q 1 \
   && q "$SOURCE" "SELECT 1 FROM pg_extension WHERE extname = 'vector'" | grep -q 1; then
  echo "The source has pgvector and the target does not: knowledge-base embeddings cannot be copied." >&2
  echo "Install pgvector on the target (or use an image that ships it, e.g. pgvector/pgvector:pg17)," >&2
  echo "apply database/migrations/250_postgres_portability.sql to it again, then run this again." >&2
  exit 1
fi
COLUMNS_SQL="
  SELECT c.relname || '.' || a.attname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND c.relname <> '_schema_migrations'
   ORDER BY 1"
# Sorted here, bytewise: the two servers' collations may order rows differently.
q "$SOURCE" "$COLUMNS_SQL" | LC_ALL=C sort > "$WORK/source_columns"
q "$TARGET" "$COLUMNS_SQL" | LC_ALL=C sort > "$WORK/target_columns"
missing="$(LC_ALL=C comm -23 "$WORK/source_columns" "$WORK/target_columns" || true)"
if [ -n "$missing" ]; then
  echo "These source columns do not exist on the target, so their data has nowhere to go:" >&2
  echo "$missing" | sed 's/^/  /' >&2
  echo "Add them with a migration (database/migrations) and run again. Nothing was written." >&2
  exit 1
fi
echo "ok — $(wc -l < "$WORK/source_columns") columns"

if [ "${YES:-}" != "1" ]; then
  echo
  echo "Every row in the TARGET's public schema will be replaced with the SOURCE's data."
  read -r -p "Type 'replace' to continue: " answer
  [ "$answer" = "replace" ] || { echo "Aborted; nothing was written."; exit 1; }
fi

say "Dumping source data"
pg_dump "$SOURCE" --data-only --schema=public --exclude-table='public._schema_migrations' \
  --load-via-partition-root --no-owner --no-privileges --format=custom --file="$WORK/data.dump"
ls -lh "$WORK/data.dump" | awk '{print "dump size: " $5}'

say "Loading into the target (one transaction)"
TABLES_SQL="
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND c.relname <> '_schema_migrations'"
all_tables="$(q "$TARGET" "$TABLES_SQL")"
{
  echo "SET session_replication_role = replica;"
  echo "TRUNCATE $all_tables RESTART IDENTITY CASCADE;"
  pg_restore --data-only --no-owner --no-privileges --file=- "$WORK/data.dump"
} > "$WORK/load.sql"
psql "$TARGET" -v ON_ERROR_STOP=1 -q --single-transaction -f "$WORK/load.sql" > /dev/null
q "$TARGET" "ANALYZE" > /dev/null

say "Comparing row counts"
COUNT_SQL="
  SELECT c.relname, (xpath('/row/n/text()',
           query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND c.relname <> '_schema_migrations'
   ORDER BY 1"
q "$SOURCE" "$COUNT_SQL" | LC_ALL=C sort > "$WORK/source_counts"
# The target's counts for the source's tables only (it may have more tables).
q "$TARGET" "$COUNT_SQL" | LC_ALL=C sort \
  | awk -F'|' 'NR == FNR { keep[$1] = 1; next } ($1 in keep)' "$WORK/source_counts" - > "$WORK/target_counts"
if diff -q "$WORK/source_counts" "$WORK/target_counts" > /dev/null; then
  total="$(awk -F'|' '{s += $2} END {print s}' "$WORK/source_counts")"
  echo "ok — $(wc -l < "$WORK/source_counts") tables, $total rows, every count matches"
else
  echo "Row counts differ (source < > target):" >&2
  diff "$WORK/source_counts" "$WORK/target_counts" >&2 || true
  exit 1
fi

say "Done"
echo "Point DATABASE_URL at the target and keep PLATFORM_SIGNING_SECRET unchanged, then start the application."
