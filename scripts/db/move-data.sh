#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Move all application data between two databases — Supabase → PostgreSQL,
# PostgreSQL → Supabase, or any other pair. See docs/DATABASE.md §6.
#
#   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... bash scripts/db/move-data.sh check
#   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... bash scripts/db/move-data.sh run
#
# check  Read-only on BOTH sides (every session is default_transaction_read_only).
#        Versions, pgvector, the migrations the target still lacks, whether
#        the target's schema matches the source's (scripts/db/schema-diff.sh),
#        whether every source column has a place on the target, the size of
#        the copy, and who is connected to the source. Writes nothing.
#
# run    The phases below, each saying what it changed when it fails:
#
#   1. preflight        read-only, as `check`.
#   2. target schema    scripts/migrate-database.sh on the TARGET. This CHANGES
#                       the target and is NOT undone by a later failure:
#                       migrations are forward-only. Re-running is safe — the
#                       ledger applies only what is missing.
#   3. schema match     read-only: the target must now present the source's
#                       schema (functions, triggers, constraints, columns,
#                       policies…), up to the reviewed differences in
#                       scripts/db/schema-parity-allowlist.txt.
#   4. confirmation     type `replace` (or YES=1).
#   5. source snapshot  per-table row count + content checksum of the source,
#                       then pg_dump --data-only, then the checksums again. If
#                       they moved, something wrote to the source during the
#                       dump: stop it (backend, EVERY worker, scheduled jobs,
#                       webhooks — §6 of the doc) and run again. Read-only.
#   6. load + validate  ONE transaction on the target: switch off the tables'
#                       own triggers (they would re-run side effects the source
#                       already holds, e.g. seeding billing rows for every
#                       loaded workspace), TRUNCATE public's tables, load the
#                       rows in foreign-key order with every foreign key
#                       ENFORCED, switch each trigger back to exactly the state
#                       it had, then — before COMMIT — check every foreign key
#                       again, every table's row count AND content checksum
#                       against the source, and every sequence against the rows
#                       it numbers. Needs the role that owns the tables (the one
#                       that ran the migrations; `postgres` on Supabase) — no
#                       superuser. Foreign keys between tables that reference
#                       each other in a cycle are deferred to the end of the
#                       load (and then put back as they were); all others are
#                       checked as each table is loaded. Any failure rolls the
#                       whole transaction back: the target's rows, triggers,
#                       foreign keys and the sequences its columns own are
#                       exactly what they were before this phase (TRUNCATE …
#                       RESTART IDENTITY makes their setval() part of the
#                       transaction). setval() on a sequence no column owns is
#                       never rolled back by PostgreSQL; the script records
#                       those first and sets them back after a failure.
#   7. final check      read-only, after COMMIT: counts and checksums of the
#                       committed target against the source, the schema match
#                       again, and the source's checksums again — if the source
#                       changed after the snapshot, those writes are not on the
#                       target and the move must be repeated with the source
#                       stopped.
#
# The TARGET's public data is replaced (its migration ledger,
# public._schema_migrations, is kept). The source is only ever read.
#
# Needs psql / pg_dump / pg_restore at least as new as the newer server — e.g.
# run it from the pgvector/pgvector:pg17 image (see the doc).
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  check|run) ;;
  *) echo "usage: SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... $0 check|run" >&2; exit 2 ;;
esac

SOURCE="${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
TARGET="${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# "a, b, c, …" — at most ten names, then how many more.
short() { awk -F', ' '{ o = $1; for (i = 2; i <= NF && i <= 10; i++) o = o ", " $i; if (NF > 10) o = o " … and " NF - 10 " more"; print o }' <<< "$1"; }
say()  { printf '\n── %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
# Read-only query: the session itself refuses to write.
# row_security=off: a session that RLS would filter fails instead — a count or
# checksum is never silently taken over a subset of the rows. The output
# settings are pinned so that a database-level setting on either side
# (bytea_output, IntervalStyle, …) cannot make equal values hash differently.
STABLE_OUTPUT='-c TimeZone=UTC -c extra_float_digits=1 -c bytea_output=hex -c IntervalStyle=postgres -c DateStyle=ISO,MDY'
ro()   { PGOPTIONS="-c default_transaction_read_only=on -c row_security=off $STABLE_OUTPUT" \
           psql "$1" -v ON_ERROR_STOP=1 -qtAX -c "$2"; }

TABLES_SQL="
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND c.relname <> '_schema_migrations'
   ORDER BY 1"
COLUMNS_SQL="
  SELECT c.relname || '.' || a.attname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND c.relname <> '_schema_migrations'"

# One row per table: name|rows|checksum. The checksum is over each row as
# jsonb (key order normalized, so column order does not matter) restricted to
# the columns the SOURCE has, with pgvector values as real[] (identical text on
# any pgvector version), sorted — independent of physical row order.
checksum_sql() { # $1 = url, $2 = file with the source's table.column list
  # One catalog read per side: every column it has, and which are vectors.
  ro "$1" "SELECT c.relname, a.attname, (ty.typname = 'vector')::int
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
             JOIN pg_type ty ON ty.oid = a.atttypid
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')" > "$WORK/side_columns"
  awk -F'|' -v q="'" '
    FILENAME == ARGV[1] { src[$0] = 1; next }                     # source table.column
    FILENAME == ARGV[2] { order[++n] = $0; want[$0] = 1; next }   # tables, in order
    ($1 in want) {
      if (!(($1 "." $2) in src)) extra[$1] = extra[$1] (extra[$1] == "" ? "" : ",") q $2 q
      if ($3 == 1) vec[$1] = vec[$1] " " $2
    }
    END {
      for (i = 1; i <= n; i++) {
        t = order[i]; e = "to_jsonb(t)"
        if (extra[t] != "") e = "(" e " - ARRAY[" extra[t] "]::text[])"
        m = split(vec[t], vs, " ")
        for (j = 1; j <= m; j++) e = "((" e " - " q vs[j] q ") || jsonb_build_object(" q vs[j] q ", t.\"" vs[j] "\"::real[]))"
        printf "%sSELECT %s, count(*), coalesce(md5(string_agg(h, %s ORDER BY h)), %s) FROM (SELECT md5((%s)::text) AS h FROM public.\"%s\" t) x\n", (i > 1 ? "UNION ALL " : ""), q t q, q q, q "-" q, e, t
      }
    }' "$2" "$WORK/tables" "$WORK/side_columns"
}
# Writes one line per table to $3 and refuses to go on unless there is
# exactly one per table — a failed query must never read as "no rows".
checksums() { # $1 = url, $2 = source columns file, $3 = output file
  checksum_sql "$1" "$2" > "$WORK/checksum.sql"
  PGOPTIONS="-c default_transaction_read_only=on -c row_security=off $STABLE_OUTPUT" \
    psql "$1" -v ON_ERROR_STOP=1 -qtAX -f "$WORK/checksum.sql" | LC_ALL=C sort > "$3"
  [ "$(wc -l < "$3")" = "$(wc -l < "$WORK/tables")" ] || fail "Could not checksum every table on $(ro "$1" "SELECT current_database()") ($(wc -l < "$3") of $(wc -l < "$WORK/tables"))."
}

# ── 1. preflight (read-only) ────────────────────────────────────────────
say "1. Preflight — read-only on both sides"
src_ver="$(ro "$SOURCE" "SHOW server_version_num")"
dst_ver="$(ro "$TARGET" "SHOW server_version_num")"
dump_ver="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
echo "source: PostgreSQL $((src_ver / 10000))   target: PostgreSQL $((dst_ver / 10000))   pg_dump: $dump_ver"
[ "$dump_ver" -ge "$((src_ver / 10000))" ] || fail "pg_dump $dump_ver is older than the source server; use a client at least as new. Nothing was written."
if [ "$(ro "$SOURCE" "SELECT system_identifier || '/' || current_database() FROM pg_control_system()")" = \
     "$(ro "$TARGET" "SELECT system_identifier || '/' || current_database() FROM pg_control_system()")" ]; then
  fail "SOURCE and TARGET are the same database. Nothing was written."
fi
src_vec="$(ro "$SOURCE" "SELECT count(*) FROM pg_extension WHERE extname = 'vector'")"
dst_vec_avail="$(ro "$TARGET" "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'")"
if [ "$src_vec" = 1 ] && [ "$dst_vec_avail" = 0 ]; then
  fail "The source uses pgvector and the target server cannot install it: knowledge-base embeddings would have nowhere to go. Use a server with pgvector (e.g. pgvector/pgvector:pg17). Nothing was written."
fi

# What the copy needs from each role, checked before anything is written: on
# the source, to read every row (an RLS-filtered dump would be a silent
# partial copy); on the target, to own the tables (TRUNCATE, switching their
# triggers) and to load past RLS. Supabase's `postgres` has both
# (table owner + BYPASSRLS); no superuser is needed.
RLS_BLOCKED_SQL="
  SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, pg_roles r
   WHERE r.rolname = current_user AND n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND c.relrowsecurity AND NOT (r.rolsuper OR r.rolbypassrls)
     AND (c.relforcerowsecurity OR NOT pg_has_role(current_user, c.relowner, 'USAGE'))"
blocked="$(ro "$SOURCE" "$RLS_BLOCKED_SQL")"
[ -z "$blocked" ] || fail "The source role ($(ro "$SOURCE" "SELECT current_user")) would see only the rows row-level security lets it see in: $(short "$blocked"). Connect as the tables' owner without FORCE RLS, a BYPASSRLS role (postgres on Supabase) or a superuser. Nothing was written."
unreadable="$(ro "$SOURCE" "SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT has_table_privilege(c.oid, 'SELECT')")"
[ -z "$unreadable" ] || fail "The source role cannot read: $(short "$unreadable"). Nothing was written."
# The target's tables exist once its migrations have run: checked here when
# they already exist, otherwise right after phase 2 builds them.
target_role_checked=0
check_target_role() { # $1 = what was already written, for the failure message
  local notowned blocked
  notowned="$(ro "$TARGET" "SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S') AND NOT pg_has_role(current_user, c.relowner, 'USAGE')")"
  [ -z "$notowned" ] || fail "The target role ($(ro "$TARGET" "SELECT current_user")) does not own: $(short "$notowned") — it could not empty the tables, switch their triggers or set the sequences. Connect as the role that ran the migrations. $1"
  blocked="$(ro "$TARGET" "$RLS_BLOCKED_SQL")"
  [ -z "$blocked" ] || fail "Row-level security on the target would refuse the load into: $(short "$blocked"). Connect as the tables' owner, a BYPASSRLS role or a superuser. $1"
  target_role_checked=1
  echo "roles: the target role owns every table and sequence and is not held back by RLS"
}
echo "roles: the source role reads every row"
if [ "$(ro "$TARGET" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')")" != 0 ]; then
  check_target_role "Nothing was written."
fi

shopt -s nullglob
files=("$ROOT"/database/migrations/*.sql); shopt -u nullglob
printf '%s\n' "${files[@]##*/}" | LC_ALL=C sort > "$WORK/migrations"
if [ "$(ro "$TARGET" "SELECT to_regclass('public._schema_migrations') IS NOT NULL")" = t ]; then
  ro "$TARGET" "SELECT filename FROM public._schema_migrations" | LC_ALL=C sort > "$WORK/applied"
else
  : > "$WORK/applied"
fi
pending="$(LC_ALL=C comm -23 "$WORK/migrations" "$WORK/applied" | wc -l | tr -d ' ')"
echo "target: $pending of ${#files[@]} migration(s) not applied yet"

ro "$SOURCE" "$TABLES_SQL" > "$WORK/tables"
ro "$SOURCE" "$COLUMNS_SQL" | LC_ALL=C sort > "$WORK/source_columns"
echo "source: $(wc -l < "$WORK/tables" | tr -d ' ') tables, $(ro "$SOURCE" "SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')") in public"
echo "source sessions other than this one (stop the application before 'run'):"
ro "$SOURCE" "SELECT '  ' || coalesce(nullif(application_name, ''), '?') || ' as ' || usename || ': ' || count(*) || ' (' || count(*) FILTER (WHERE state = 'active') || ' active)'
               FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
               GROUP BY application_name, usename ORDER BY 1" || true

schema_ready=0
if [ "$pending" = 0 ]; then
  schema_ready=1
  ro "$TARGET" "$COLUMNS_SQL" | LC_ALL=C sort > "$WORK/target_columns"
  missing="$(LC_ALL=C comm -23 "$WORK/source_columns" "$WORK/target_columns" || true)"
  [ -z "$missing" ] || fail "These source columns do not exist on the target, so their data has nowhere to go:
$(echo "$missing" | sed 's/^/  /')
Add them with a migration (database/migrations). Nothing was written."
  echo "columns: every source column has a place on the target"
  echo "schema: comparing (scripts/db/schema-diff.sh)…"
  if ! SOURCE_DATABASE_URL="$SOURCE" TARGET_DATABASE_URL="$TARGET" bash "$ROOT/scripts/db/schema-diff.sh" > "$WORK/schema-diff"; then
    sed 's/^/  /' "$WORK/schema-diff" | head -60 >&2
    fail "The target's schema does not match the source's (above). Nothing was written."
  fi
  echo "schema: matches, up to the reviewed differences"
else
  echo "schema: compared after the target's migrations are applied (phase 2 of 'run')"
fi

if [ "$MODE" = check ]; then
  say "Check complete — nothing was written to either database"
  exit 0
fi

# ── 2. target schema ────────────────────────────────────────────────────
if [ "$pending" != 0 ]; then
  say "2. Target schema — applying $pending migration(s). This changes the target and is not undone if a later phase fails; re-running is safe."
  DATABASE_URL="$TARGET" bash "$ROOT/scripts/migrate-database.sh" || fail "A migration failed (output above). The files before it are applied and recorded in public._schema_migrations. The failing file is not recorded, and it may be PARTLY applied: scripts/migrate-database.sh runs each file statement by statement, not as one transaction (some cannot run in one, e.g. CREATE INDEX CONCURRENTLY). No data was copied. Fix the cause; if the failing file is not safe to run twice, undo the statements of it that did apply before running again."
else
  say "2. Target schema — already complete"
fi

# ── 3. schema match ─────────────────────────────────────────────────────
if [ "$schema_ready" = 0 ]; then
  say "3. Schema match — read-only"
  ro "$TARGET" "$COLUMNS_SQL" | LC_ALL=C sort > "$WORK/target_columns"
  missing="$(LC_ALL=C comm -23 "$WORK/source_columns" "$WORK/target_columns" || true)"
  [ -z "$missing" ] || fail "These source columns do not exist on the target:
$(echo "$missing" | sed 's/^/  /')
The target's schema was built (phase 2) but no data was written. Add them with a migration and run again."
  if ! SOURCE_DATABASE_URL="$SOURCE" TARGET_DATABASE_URL="$TARGET" bash "$ROOT/scripts/db/schema-diff.sh" > "$WORK/schema-diff"; then
    sed 's/^/  /' "$WORK/schema-diff" | head -60 >&2
    fail "The target's schema does not match the source's (above). The target's schema was built (phase 2) but no data was written."
  fi
  echo "ok"
fi

[ "$target_role_checked" = 1 ] || check_target_role "The target's schema was built (phase 2) but no data was written."

# ── 4. confirmation ─────────────────────────────────────────────────────
if [ "${YES:-}" != "1" ]; then
  echo
  echo "Every row in the TARGET's public schema will be replaced with the SOURCE's data."
  read -r -p "Type 'replace' to continue: " answer
  [ "$answer" = "replace" ] || fail "Aborted at confirmation. No data was written (the target's schema is as phase 2 left it)."
fi

# ── 5. source snapshot ──────────────────────────────────────────────────
say "5. Source snapshot — read-only"
checksums "$SOURCE" "$WORK/source_columns" "$WORK/source_before"
pg_dump "$SOURCE" --data-only --schema=public --exclude-table='public._schema_migrations' \
  --load-via-partition-root --no-owner --no-privileges --format=custom --file="$WORK/data.dump" 2> "$WORK/dump.err" \
  || { cat "$WORK/dump.err" >&2; fail "pg_dump failed (above). Nothing was written to the target."; }
# Its warnings about circular foreign keys are what phase 6 defers; anything
# else it says is shown.
grep -v -E 'circular foreign-key constraints|^pg_dump: (detail|hint):' "$WORK/dump.err" >&2 || true
checksums "$SOURCE" "$WORK/source_columns" "$WORK/source_after"
if ! diff -q "$WORK/source_before" "$WORK/source_after" > /dev/null; then
  echo "tables that changed while the dump ran:" >&2
  diff "$WORK/source_before" "$WORK/source_after" | grep '^>' | cut -d'|' -f1 | sed 's/^> /  /' >&2 || true
  fail "Something wrote to the source during the dump. Stop the backend, every worker and scheduled job (docs/DATABASE.md §6), then run again. No data was written to the target."
fi
echo "dump: $(du -h "$WORK/data.dump" | cut -f1), $(awk -F'|' '{s += $2} END {print s}' "$WORK/source_before") rows, the source did not change while it ran"

# ── 6. load + validate, one transaction ─────────────────────────────────
say "6. Load and validate — one transaction on the target"
all_tables="$(ro "$TARGET" "SELECT string_agg(format('public.%I', relname), ', ') FROM ($TABLES_SQL) t(relname)")"
TRIGGERS_SQL="
  SELECT format('ALTER TABLE public.%I DISABLE TRIGGER %I;', c.relname, t.tgname) AS off,
         format('ALTER TABLE public.%I ENABLE %sTRIGGER %I;', c.relname,
                CASE t.tgenabled WHEN 'A' THEN 'ALWAYS ' WHEN 'R' THEN 'REPLICA ' ELSE '' END, t.tgname) AS on_
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND NOT c.relispartition
   ORDER BY c.relname, t.tgname"
ro "$TARGET" "SELECT off FROM ($TRIGGERS_SQL) x" > "$WORK/triggers_off"
ro "$TARGET" "SELECT on_ FROM ($TRIGGERS_SQL) x" > "$WORK/triggers_on"
# Foreign keys between tables that reference each other in a cycle
# (workspace_subscriptions <-> billing_subscription_periods, …) cannot be
# satisfied one table at a time. Only those are made DEFERRABLE INITIALLY
# DEFERRED for the load, checked by SET CONSTRAINTS ALL IMMEDIATE before the
# validation, and put back exactly as they were — all inside the transaction.
# Every other foreign key is checked as each table's rows go in.
CYCLIC_FKS_SQL="
  WITH RECURSIVE e AS (
    SELECT DISTINCT conrelid AS a, confrelid AS b FROM pg_constraint
     WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND conrelid <> confrelid
  ), reach(a, b) AS (
    SELECT a, b FROM e UNION SELECT r.a, e.b FROM reach r JOIN e ON e.a = r.b
  )
  SELECT format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED;', con.conrelid::regclass, con.conname) AS defer,
         format('ALTER TABLE %s ALTER CONSTRAINT %I NOT DEFERRABLE;', con.conrelid::regclass, con.conname) AS restore
    FROM pg_constraint con
   WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace AND con.conrelid <> con.confrelid
     AND NOT con.condeferrable
     AND EXISTS (SELECT 1 FROM reach r WHERE r.a = con.confrelid AND r.b = con.conrelid)
   ORDER BY 1"
ro "$TARGET" "SELECT defer FROM ($CYCLIC_FKS_SQL) x" > "$WORK/fks_defer"
ro "$TARGET" "SELECT restore FROM ($CYCLIC_FKS_SQL) x" > "$WORK/fks_restore"
checksum_sql "$TARGET" "$WORK/source_columns" > "$WORK/target_checksum.sql"
# Sequences: TRUNCATE … RESTART IDENTITY resets the ones a column owns inside
# the transaction, which makes the dump's setval() on them roll back with it.
# setval() on a sequence no column owns is never rolled back, so those are
# recorded here and put back if the load fails.
ro "$TARGET" "SELECT format('SELECT setval(%L, %s, %s);', format('public.%I', s.sequencename), coalesce(s.last_value, s.start_value), CASE WHEN s.last_value IS NULL THEN 'false' ELSE 'true' END)
                FROM pg_sequences s
               WHERE s.schemaname = 'public'
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = format('public.%I', s.sequencename)::regclass
                                    AND d.refobjsubid > 0 AND d.deptype IN ('a', 'i'))
               ORDER BY 1" > "$WORK/free_sequences"
{
  echo "\\set ON_ERROR_STOP on"
  echo "BEGIN;"
  echo "SET LOCAL TimeZone = 'UTC'; SET LOCAL extra_float_digits = 1; SET LOCAL bytea_output = hex;"
  echo "SET LOCAL IntervalStyle = postgres; SET LOCAL DateStyle = 'ISO, MDY';"
  # Switch off exactly the user triggers that are on, and back on in the
  # same mode (O / A / R) afterwards; a trigger that was disabled stays so.
  cat "$WORK/triggers_off"
  cat "$WORK/fks_defer"
  echo "TRUNCATE $all_tables RESTART IDENTITY;"
  pg_restore --data-only --no-owner --no-privileges --file=- "$WORK/data.dump"
  echo "SET LOCAL search_path = public, pg_catalog;"
  # the deferred foreign keys are checked here, on every loaded row
  echo "SET CONSTRAINTS ALL IMMEDIATE;"
  cat "$WORK/fks_restore"
  cat "$WORK/triggers_on"
  # every foreign key the target enforces, checked on the loaded rows
  cat <<'SQL'
DO $fk$
DECLARE c record; n bigint; bad text := '';
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass AS tbl, con.confrelid::regclass AS ref,
           (SELECT string_agg(format('t.%I', a.attname), ', ' ORDER BY k.i) FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
           (SELECT string_agg(format('t.%I IS NOT NULL', a.attname), ' AND ') FROM unnest(con.conkey) k(n)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS notnull,
           (SELECT string_agg(format('r.%I = t.%I', ra.attname, ta.attname), ' AND ') FROM unnest(con.conkey, con.confkey) k(tn, rn)
              JOIN pg_attribute ta ON ta.attrelid = con.conrelid AND ta.attnum = k.tn
              JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rn) AS joincond
      FROM pg_constraint con JOIN pg_namespace ns ON ns.oid = con.connamespace
     WHERE con.contype = 'f' AND ns.nspname = 'public' AND con.convalidated
  LOOP
    EXECUTE format('SELECT count(*) FROM %s t WHERE %s AND NOT EXISTS (SELECT 1 FROM %s r WHERE %s)',
                   c.tbl, c.notnull, c.ref, c.joincond) INTO n;
    IF n > 0 THEN bad := bad || format(E'\n  %s: %s row(s) of %s point at no %s row', c.conname, n, c.tbl, c.ref); END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'move-data: foreign keys broken by the loaded rows:%', bad; END IF;
END
$fk$;
SQL
  # every sequence must be ahead of the rows it numbers
  cat <<'SQL'
DO $seq$
DECLARE s record; mx bigint; nxt bigint; bad text := '';
BEGIN
  FOR s IN
    SELECT d.objid::regclass AS seq, d.refobjid::regclass AS tbl, a.attname AS col
      FROM pg_depend d
      JOIN pg_class sc ON sc.oid = d.objid AND sc.relkind = 'S'
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      JOIN pg_class tc ON tc.oid = d.refobjid JOIN pg_namespace ns ON ns.oid = tc.relnamespace
     WHERE d.deptype IN ('a', 'i') AND ns.nspname = 'public'
  LOOP
    EXECUTE format('SELECT max(%I)::bigint FROM %s', s.col, s.tbl) INTO mx;
    EXECUTE format('SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM %s', s.seq) INTO nxt;
    IF mx IS NOT NULL AND nxt <= mx THEN
      bad := bad || format(E'\n  %s: next value %s, but %s.%s already holds %s', s.seq, nxt, s.tbl, s.col, mx);
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'move-data: sequences behind their rows:%', bad; END IF;
END
$seq$;
SQL
  # every table's row count and content checksum must equal the source's
  echo "CREATE TEMP TABLE move_expected (tbl text PRIMARY KEY, n bigint, h text) ON COMMIT DROP;"
  echo "COPY move_expected FROM stdin WITH (DELIMITER '|');"
  cat "$WORK/source_before"
  echo "\\."
  echo "CREATE TEMP TABLE move_actual (tbl text PRIMARY KEY, n bigint, h text) ON COMMIT DROP;"
  echo "INSERT INTO move_actual"
  cat "$WORK/target_checksum.sql"
  echo ";"
  cat <<'SQL'
DO $content$
DECLARE bad text;
BEGIN
  SELECT string_agg(format(E'\n  %s: source %s rows / %s, target %s rows / %s', coalesce(e.tbl, a.tbl), e.n, e.h, a.n, a.h), '' ORDER BY coalesce(e.tbl, a.tbl))
    INTO bad
    FROM move_expected e FULL JOIN move_actual a ON a.tbl = e.tbl
   WHERE e.n IS DISTINCT FROM a.n OR e.h IS DISTINCT FROM a.h;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'move-data: loaded rows differ from the source:%', bad; END IF;
END
$content$;
SQL
  echo "COMMIT;"
} > "$WORK/load.sql"

if ! psql "$TARGET" -q -f "$WORK/load.sql" > "$WORK/load.out" 2> "$WORK/load.err"; then
  # the error and its detail lines, without PL/pgSQL context
  awk '/ERROR:/ { on = 1 } on && !/^(CONTEXT|PL\/pgSQL|SQL statement)/' "$WORK/load.err" | head -40 | sed 's/^/  /' >&2
  restored=""
  if [ -s "$WORK/free_sequences" ]; then
    if psql "$TARGET" -v ON_ERROR_STOP=1 -qtAX -f "$WORK/free_sequences" > /dev/null; then
      restored=" $(wc -l < "$WORK/free_sequences" | tr -d ' ') sequence(s) no column owns were set back to their earlier values."
    else
      restored=" WARNING: could not set back the sequences no column owns; their earlier values were: $(tr '\n' ' ' < "$WORK/free_sequences")"
    fi
  fi
  fail "Load or validation failed (above). The transaction was rolled back: the target's rows, triggers, foreign keys and sequences are as they were before this phase, and its schema as phase 2 left it.$restored Nothing was committed."
fi
psql "$TARGET" -v ON_ERROR_STOP=1 -qtAX -c "ANALYZE $all_tables" > /dev/null
echo "committed: every foreign key holds, every sequence is ahead of its rows, every table's rows match the source, every trigger is back as it was"

# ── 7. final check (read-only) ──────────────────────────────────────────
say "7. Final check — read-only"
checksums "$TARGET" "$WORK/source_columns" "$WORK/target_final"
if ! diff -q "$WORK/source_before" "$WORK/target_final" > /dev/null; then
  diff "$WORK/source_before" "$WORK/target_final" | grep '^[<>]' | sed 's/^/  /' >&2 || true
  fail "The committed target differs from the source snapshot (above: < source, > target; table|rows|checksum). Phase 6 checked the same thing before COMMIT, so something wrote to the target since. Do not start the application on it; find the writer and run again."
fi
SOURCE_DATABASE_URL="$SOURCE" TARGET_DATABASE_URL="$TARGET" bash "$ROOT/scripts/db/schema-diff.sh" > /dev/null \
  || fail "The target's schema no longer matches the source's."
checksums "$SOURCE" "$WORK/source_columns" "$WORK/source_end"
if ! diff -q "$WORK/source_before" "$WORK/source_end" > /dev/null; then
  echo "tables that changed on the source after the snapshot:" >&2
  diff "$WORK/source_before" "$WORK/source_end" | grep '^>' | cut -d'|' -f1 | sed 's/^> /  /' >&2 || true
  fail "The source was written to after the snapshot; those writes are NOT on the target. Stop every writer and run again."
fi
echo "ok — $(wc -l < "$WORK/source_before" | tr -d ' ') tables, $(awk -F'|' '{s += $2} END {print s}' "$WORK/source_before") rows, identical content; the source did not change"

say "Done"
echo "Point DATABASE_URL at the target, keep PLATFORM_SIGNING_SECRET and PLUGIN_SECRETS_MASTER_KEY unchanged, then start the application."
