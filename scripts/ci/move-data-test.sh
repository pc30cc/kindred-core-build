#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# scripts/db/move-data.sh against throwaway databases on one server: what it
# promises on success, on every kind of failure, and on a retry.
#
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=… \
#     bash scripts/ci/move-data-test.sh
#
# PGUSER must be a superuser: the test creates and DROPS databases named
# mvt_* and roles named mvt_* on that server. Never point it at a server that
# holds anything you need.
#
#   check            writes nothing: both databases are set to refuse writes
#                    and their schema, rows and write counters are compared.
#   success          source -> empty target (phase 3 builds its schema), and
#                    every row compared independently of the script's own
#                    checksum (row text, not jsonb).
#   retry            the same move again over the now-populated target.
#   failures         an orphan under a NOT VALID foreign key; a source sequence
#                    behind its rows (fails after setval ran) with a sequence
#                    no column owns; a reviewed type difference that rounds a
#                    value (caught only by the content checksum); a writer on
#                    the source during the dump. After each: exit 1, and the
#                    target's rows, triggers, constraints and sequences
#                    exactly as before.
#   Supabase-like    a target owned by a non-superuser BYPASSRLS role with
#                    FORCE RLS tables, built by phase 3 as that role; then the
#                    reverse move out of it.
#   refusals         a source role RLS would filter, a target role that does
#                    not own the tables, the same database twice.
#   confirmation     declined (or no answer) on an empty target: not one
#                    object created — the migrations wait for the answer too.
#   foreign rows     a target table holding rows the source has no table for:
#                    refused by check and run before anything is written;
#                    once empty it gets as far as the schema match, which says
#                    the migrations stayed applied and no data was copied.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
writer=
trap '[ -n "$writer" ] && kill "$writer" 2> /dev/null; rm -rf "$WORK"' EXIT
export PGOPTIONS='-c client_min_messages=warning'

url()   { printf 'postgresql://%s@/%s' "${2:-${PGUSER:-postgres}}" "$1"; }
sql()   { psql "$(url "$1")" -v ON_ERROR_STOP=1 -qtAX "${@:2}"; }
admin() { sql postgres "$@"; }
ok()    { printf '✓ %s\n' "$*"; }
die()   { printf '✗ %s\n' "$*" >&2; [ -f "$WORK/out" ] && sed 's/^/    /' "$WORK/out" >&2; exit 1; }

move() { # $1 = check|run, $2 = source url, $3 = target url, then VAR=value…
  local mode="$1" src="$2" dst="$3"; shift 3
  env "$@" YES=1 SOURCE_DATABASE_URL="$src" TARGET_DATABASE_URL="$dst" \
    bash "$ROOT/scripts/db/move-data.sh" "$mode" > "$WORK/out" 2>&1
}
expect_refusal() { # $1 = what, $2 = message regex, then move arguments
  local what="$1" re="$2"; shift 2
  if move "$@"; then die "$what: move-data succeeded"; fi
  grep -qE "$re" "$WORK/out" || die "$what: exit 1, but not with /$re/"
}

# Everything a failed move must leave as it was: every row as text, trigger
# modes, constraint flags, sequence positions.
state() {
  sql "$1" -c "SET TimeZone = 'UTC'" -f - <<'SQL'
SELECT format('SELECT %L || ''|'' || count(*) || ''|'' || coalesce(md5(string_agg(t::text, E''\n'' ORDER BY t::text)), ''-'') FROM public.%I t;', relname, relname)
  FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> '_schema_migrations' ORDER BY relname
\gexec
SELECT 'trigger|' || c.relname || '.' || t.tgname || '=' || t.tgenabled::text
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal ORDER BY 1;
SELECT 'constraint|' || conrelid::regclass::text || '.' || conname || '=' || condeferrable::text || '/' || condeferred::text || '/' || convalidated::text
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1;
SELECT 'sequence|' || sequencename || '=' || coalesce(last_value::text, 'null')
  FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1;
SQL
}
rows() { state "$1" | grep -v -E '^(trigger|constraint|sequence)\|'; }
same_rows() { # $1, $2 = databases
  rows "$1" > "$WORK/rows.a"; rows "$2" > "$WORK/rows.b"
  diff "$WORK/rows.a" "$WORK/rows.b" > "$WORK/rows.diff" || { cat "$WORK/rows.diff" >&2; die "$1 and $2 hold different rows"; }
}
unchanged_after() { # $1 = database, $2 = saved state
  state "$1" > "$WORK/state.after"
  diff "$2" "$WORK/state.after" > "$WORK/state.diff" || { cat "$WORK/state.diff" >&2; die "$1 changed although the move failed"; }
}

# ── databases ───────────────────────────────────────────────────────────
for db in mvt_src mvt_dst mvt_supa mvt_fresh; do admin -c "DROP DATABASE IF EXISTS $db"; done
admin -c "DROP ROLE IF EXISTS mvt_supa" -c "DROP ROLE IF EXISTS mvt_reader"
admin -c "CREATE DATABASE mvt_src" -c "CREATE DATABASE mvt_dst"
DATABASE_URL="$(url mvt_src)" bash "$ROOT/scripts/migrate-database.sh" > "$WORK/migrate.log" 2>&1 \
  || { tail -20 "$WORK/migrate.log" >&2; die "building the source failed"; }
sql mvt_src -f "$ROOT/scripts/ci/move-data-seed.sql"
SRC="$(url mvt_src)"; DST="$(url mvt_dst)"
ok "source: the chain plus $(rows mvt_src | awk -F'|' '{ s += $2 } END { print s }') rows"

# ── check writes nothing ────────────────────────────────────────────────
# Rows inserted, updated or deleted in the database's own tables, catalogs
# included. Statistics reach the view up to a second after a session ends, so
# wait for them. Left out: shared catalogs (ALTER DATABASE writes one), and
# pg_statistic with its TOAST table, which autovacuum's ANALYZE of the freshly
# seeded tables rewrites in the background whatever the sessions do.
counters() { sleep 1.5; sql "$1" -c "SELECT pg_stat_force_next_flush()" > /dev/null; sleep 0.5
             sql "$1" -c "SELECT string_agg(s.relid::regclass::text || '=' || (s.n_tup_ins + s.n_tup_upd + s.n_tup_del), ' ' ORDER BY s.relid)
                            FROM pg_stat_all_tables s JOIN pg_class c ON c.oid = s.relid
                           WHERE NOT c.relisshared
                             AND c.oid NOT IN ('pg_catalog.pg_statistic'::regclass,
                                               (SELECT reltoastrelid FROM pg_class WHERE oid = 'pg_catalog.pg_statistic'::regclass))"; }
check_is_read_only() {
  for db in mvt_src mvt_dst; do admin -c "ALTER DATABASE $db SET default_transaction_read_only = on"; done
  { state mvt_src; state mvt_dst; psql "$SRC" -qAtX -f "$ROOT/scripts/db/schema-fingerprint.sql"; psql "$DST" -qAtX -f "$ROOT/scripts/db/schema-fingerprint.sql"; } > "$WORK/before"
  local c1 c2; c1="$(counters mvt_src)/$(counters mvt_dst)"
  move check "$SRC" "$DST" || die "check failed"
  { state mvt_src; state mvt_dst; psql "$SRC" -qAtX -f "$ROOT/scripts/db/schema-fingerprint.sql"; psql "$DST" -qAtX -f "$ROOT/scripts/db/schema-fingerprint.sql"; } > "$WORK/after"
  c2="$(counters mvt_src)/$(counters mvt_dst)"
  for db in mvt_src mvt_dst; do admin -c "ALTER DATABASE $db RESET default_transaction_read_only"; done
  diff -q "$WORK/before" "$WORK/after" > /dev/null || die "check changed a database"
  [ "$c1" = "$c2" ] || die "check wrote rows: $(diff <(tr ' ' '\n' <<< "$c1") <(tr ' ' '\n' <<< "$c2") | grep '^[<>]' | tr '\n' ' ')"
  grep -q 'nothing was written to either database' "$WORK/out" || die "check did not say it wrote nothing"
}
check_is_read_only
ok "check against an empty target: read-only (both databases refused writes; schema, rows and write counters unchanged)"

# ── success, then a retry over the populated target ─────────────────────
move run "$SRC" "$DST" || die "move into an empty target failed"
grep -q '^ok — ' "$WORK/out" || die "no final confirmation"
same_rows mvt_src mvt_dst
ok "success: empty target built by phase 3, every row identical (row text compared outside the script)"
[ "$(sql mvt_dst -c "SELECT count(*) FROM workspace_subscriptions WHERE current_period_id IS NOT NULL")" = 1 ] || die "the subscription <-> period cycle did not arrive"
[ "$(sql mvt_dst -c "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND condeferrable AND connamespace = 'public'::regnamespace")" = \
  "$(sql mvt_src -c "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND condeferrable AND connamespace = 'public'::regnamespace")" ] \
  || die "foreign keys deferred for the load were not put back"
ok "rows that reference each other in a cycle loaded; the deferred foreign keys are NOT DEFERRABLE again"

check_is_read_only
ok "check against a populated target: read-only"

sql mvt_src -c "INSERT INTO contacts (workspace_id, name) VALUES ('00000000-0000-0000-0000-0000000000c2', 'added before the retry')"
move run "$SRC" "$DST" || die "the repeated move failed"
same_rows mvt_src mvt_dst
ok "retry: the same move over the populated target, rows identical again"

# ── failures leave the target exactly as it was ─────────────────────────
# Trigger modes other than the default must survive a failed load too.
for db in mvt_src mvt_dst; do
  sql "$db" -c "ALTER TABLE public.workspaces ENABLE ALWAYS TRIGGER trg_billing_v2_seed_new_workspace" \
            -c "ALTER TABLE public.conversation_messages DISABLE TRIGGER trg_channel_enqueue_outbound"
done

# 1. an orphan under a NOT VALID foreign key: refused while the rows load
sql mvt_src -c "BEGIN" -c "ALTER TABLE conversations DROP CONSTRAINT conversations_contact_id_fkey" \
  -c "INSERT INTO conversations (id, workspace_id, contact_id, subject) VALUES ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000beef', 'orphan')" \
  -c "ALTER TABLE conversations ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL NOT VALID" -c "COMMIT"
sql mvt_dst -c "ALTER TABLE conversations DROP CONSTRAINT conversations_contact_id_fkey" \
  -c "ALTER TABLE conversations ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL NOT VALID"
state mvt_dst > "$WORK/saved"
expect_refusal "orphan row" 'violates foreign key constraint "conversations_contact_id_fkey"' run "$SRC" "$DST"
grep -q 'Nothing of the copy was committed. No migration was run on the target.' "$WORK/out" || die "no rollback statement, or it did not say that no migration ran"
unchanged_after mvt_dst "$WORK/saved"
ok "failure (orphan under a NOT VALID foreign key): exit 1, target unchanged — rows, triggers, constraints, sequences"
sql mvt_src -c "DELETE FROM conversations WHERE id = '00000000-0000-0000-0000-0000000000f9'"
for db in mvt_src mvt_dst; do sql "$db" -c "ALTER TABLE conversations VALIDATE CONSTRAINT conversations_contact_id_fkey"; done

# 2. a sequence behind its rows on the source: fails AFTER the dump's setval()
#    ran — on owned sequences and on one no column owns
for db in mvt_src mvt_dst; do sql "$db" -c "CREATE SEQUENCE public.mvt_free_counter"; done
sql mvt_src -c "SELECT setval('mvt_free_counter', 300)" -c "SELECT setval('bot_visits_id_seq', 10)" > /dev/null
sql mvt_dst -c "SELECT setval('mvt_free_counter', 123)" -c "SELECT setval('bot_visits_id_seq', 7777)" > /dev/null
state mvt_dst > "$WORK/saved"
expect_refusal "sequence behind its rows" 'bot_visits_id_seq: next value 11, but bot_visits.id already holds' run "$SRC" "$DST"
grep -q 'sequence(s) no column owns were set back' "$WORK/out" || die "the free sequence was not reported as set back"
unchanged_after mvt_dst "$WORK/saved"
ok "failure after setval (sequence behind its rows): exit 1, target unchanged — owned sequences rolled back, the free one set back"
sql mvt_src -c "SELECT setval('bot_visits_id_seq', (SELECT max(id) FROM bot_visits))" > /dev/null

# 3. a reviewed schema difference that changes data: only the content
#    checksum can see it
sql mvt_dst -c "ALTER TABLE visitor_sessions ALTER COLUMN geo_latitude TYPE real"
{ cat "$ROOT/scripts/db/schema-parity-allowlist.txt"; printf 'column\tvisitor_sessions\ttest: a reviewed type difference that rounds data\n'; } > "$WORK/allow"
state mvt_dst > "$WORK/saved"
expect_refusal "rounded value" 'loaded rows differ from the source:' run "$SRC" "$DST" SCHEMA_PARITY_ALLOWLIST="$WORK/allow"
grep -q 'visitor_sessions: source 1 rows' "$WORK/out" || die "the content mismatch did not name visitor_sessions"
unchanged_after mvt_dst "$WORK/saved"
ok "failure (content differs after load): exit 1, target unchanged"
sql mvt_dst -c "ALTER TABLE visitor_sessions ALTER COLUMN geo_latitude TYPE double precision"

# 4. a writer on the source during the dump
state mvt_dst > "$WORK/saved"
( for i in $(seq 1 3000); do
    [ -f "$WORK/stop" ] && break
    sql mvt_src -c "INSERT INTO conversation_messages (conversation_id, sender_type, body) VALUES ('00000000-0000-0000-0000-0000000000f1', 'contact', 'live $i')" > /dev/null 2>&1 || true
    sleep 0.02
  done ) &
writer=$!
sleep 1
expect_refusal "source written during the dump" 'Something wrote to the source' run "$SRC" "$DST"
touch "$WORK/stop"; wait "$writer"; writer=
grep -q 'conversation_messages' "$WORK/out" || die "the changed table was not named"
unchanged_after mvt_dst "$WORK/saved"
ok "failure (source written during the dump): exit 1, target unchanged"

# and after all that, the move still works — and restores the trigger modes
move run "$SRC" "$DST" || die "the move after the failures failed"
same_rows mvt_src mvt_dst
[ "$(sql mvt_dst -c "SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgname IN ('trg_billing_v2_seed_new_workspace', 'trg_channel_enqueue_outbound')")" = AD ] \
  || die "trigger modes not kept (want ALWAYS / DISABLED)"
ok "retry after the failures: rows identical; an ALWAYS trigger and a DISABLED one kept their modes"
for db in mvt_src mvt_dst; do
  sql "$db" -c "ALTER TABLE public.workspaces ENABLE TRIGGER trg_billing_v2_seed_new_workspace" \
            -c "ALTER TABLE public.conversation_messages ENABLE TRIGGER trg_channel_enqueue_outbound" \
            -c "DROP SEQUENCE mvt_free_counter"
done

# ── a Supabase-like target: no superuser, BYPASSRLS, owns the tables ────
admin -c "CREATE ROLE mvt_supa LOGIN NOSUPERUSER BYPASSRLS PASSWORD '${PGPASSWORD:-mvt}'" \
      -c "GRANT anon, authenticated, service_role TO mvt_supa" \
      -c "CREATE DATABASE mvt_supa OWNER mvt_supa"
# Supabase ships these; creating them needs a superuser.
sql mvt_supa -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" \
             -c "CREATE EXTENSION IF NOT EXISTS btree_gist" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" \
             -c "ALTER SCHEMA public OWNER TO mvt_supa"
if [ "$(admin -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'")" = 1 ]; then
  sql mvt_supa -c "CREATE EXTENSION IF NOT EXISTS vector"
fi
SUPA="$(url mvt_supa mvt_supa)"
[ "$(psql "$SUPA" -qtAX -c "SELECT rolsuper::text || rolbypassrls::text FROM pg_roles WHERE rolname = current_user")" = falsetrue ] || die "mvt_supa is not a plain BYPASSRLS role"
move run "$SRC" "$SUPA" || die "move into the Supabase-like target failed"
same_rows mvt_src mvt_supa
[ "$(sql mvt_supa -c "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity")" -gt 0 ] || die "no FORCE RLS table on the target"
ok "Supabase-like target (non-superuser BYPASSRLS owner, FORCE RLS tables, schema built by phase 3 as that role): rows identical"

sql mvt_supa -c "INSERT INTO contacts (workspace_id, name) VALUES ('00000000-0000-0000-0000-0000000000c2', 'written on the Supabase-like side')"
move run "$SUPA" "$DST" || die "move out of the Supabase-like database failed"
same_rows mvt_supa mvt_dst
ok "the reverse move, out of the Supabase-like database as its BYPASSRLS owner: rows identical"

# ── refusals before anything is written ─────────────────────────────────
admin -c "CREATE ROLE mvt_reader LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PGPASSWORD:-mvt}'"
sql mvt_supa -c "GRANT USAGE ON SCHEMA public TO mvt_reader" -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO mvt_reader"
state mvt_dst > "$WORK/saved"
expect_refusal "source role under RLS" 'would see only the rows row-level security lets it see' check "$(url mvt_supa mvt_reader)" "$DST"
expect_refusal "target role that owns nothing" 'does not own:' run "$SRC" "$(url mvt_supa mvt_reader)"
expect_refusal "same database twice" 'SOURCE and TARGET are the same database' run "$DST" "$DST?application_name=other"
unchanged_after mvt_dst "$WORK/saved"
ok "refused before writing: a source role RLS would filter, a target role that does not own the tables, the same database twice"

# ── confirmation comes before the first write ───────────────────────────
admin -c "CREATE DATABASE mvt_fresh"
FRESH="$(url mvt_fresh)"
public_objects() { sql mvt_fresh -c "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace"; }
for answer in no EOF; do
  if [ "$answer" = EOF ]; then input=/dev/null; else input="$WORK/answer"; printf '%s\n' "$answer" > "$input"; fi
  if SOURCE_DATABASE_URL="$SRC" TARGET_DATABASE_URL="$FRESH" bash "$ROOT/scripts/db/move-data.sh" run < "$input" > "$WORK/out" 2>&1; then
    die "confirmation answered '$answer': move-data went ahead"
  fi
  grep -q 'Aborted at confirmation. Nothing was written to the target.' "$WORK/out" || die "confirmation answered '$answer': no abort message"
  grep -qE 'phase 3: [0-9]+ migration\(s\)' "$WORK/out" || die "the confirmation did not list the migrations it would apply"
  [ "$(public_objects)" = 0 ] || die "confirmation answered '$answer': the target was changed"
done
ok "confirmation declined, or not given, on an empty target: it asked before any migration and not one object was created"

# ── rows in a table the source does not have ────────────────────────────
sql mvt_fresh -c "CREATE TABLE public.legacy_notes (id int)" -c "INSERT INTO public.legacy_notes VALUES (1), (2)"
state mvt_fresh > "$WORK/saved"
expect_refusal "foreign rows (check)" 'hold rows and the source has no table of that name: legacy_notes \(2 rows\)' check "$SRC" "$FRESH"
expect_refusal "foreign rows (run)" 'legacy_notes \(2 rows\).*Nothing was written' run "$SRC" "$FRESH"
unchanged_after mvt_fresh "$WORK/saved"
[ "$(public_objects)" = 1 ] || die "a refused move changed the target"
ok "a target table holding rows the source has no table for: check and run refuse before writing anything"
sql mvt_fresh -c "DELETE FROM public.legacy_notes"
expect_refusal "an empty foreign table" "does not match the source's.*No data was copied from the source\. The [0-9]+ migration\(s\) phase 3 applied stay applied" run "$SRC" "$FRESH"
[ "$(sql mvt_fresh -c "SELECT count(*) FROM public._schema_migrations")" -gt 0 ] || die "the migrations the message reports were not recorded"
ok "an empty one gets as far as the schema match, which says the migrations stayed applied and no data was copied"

for db in mvt_src mvt_dst mvt_supa mvt_fresh; do admin -c "DROP DATABASE $db"; done
admin -c "DROP ROLE mvt_supa" -c "DROP ROLE mvt_reader"
echo "move-data: all scenarios passed"
