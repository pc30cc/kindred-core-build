#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# scripts/db/schema-diff.sh on two small throwaway databases: what it must
# report, what an allowlist entry may hide, and what it must not.
#
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=… \
#     bash scripts/ci/schema-diff-test.sh
#
# PGUSER must be allowed to create databases: the test creates and DROPS
# databases named sdt_*. Never point it at a server that holds anything you
# need.
#
#   literals      function bodies that differ only inside a string literal —
#                 in its spacing, in text that looks like a comment, in text
#                 that looks like a schema prefix — are different functions
#   parameters    a parameter's default or name differs: reported
#   allowlist     an entry covers its one object between its two definitions:
#                 another column of the same table, the same column changed
#                 again, the same function changed again — all reported
#   extensions    an extension's objects in `extensions` (Supabase) or in
#                 `public`: not a difference
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export PGOPTIONS='-c client_min_messages=warning'

url()   { printf 'postgresql://%s@/%s' "${PGUSER:-postgres}" "$1"; }
sql()   { psql "$(url "$1")" -v ON_ERROR_STOP=1 -qtAX "${@:2}"; }
ok()    { printf '✓ %s\n' "$*"; }
die()   { printf '✗ %s\n' "$*" >&2; [ -f "$WORK/out" ] && sed 's/^/    /' "$WORK/out" >&2; exit 1; }
diff_() { # schema-diff A → B with the allowlist in $WORK/allow; output in $WORK/out
  SOURCE_DATABASE_URL="$(url sdt_a)" TARGET_DATABASE_URL="$(url sdt_b)" SCHEMA_PARITY_ALLOWLIST="$WORK/allow" \
    bash "$ROOT/scripts/db/schema-diff.sh" > "$WORK/out" 2>&1
}
reports() { # $1 = line schema-diff must print
  grep -qxF "$1" "$WORK/out" || die "schema-diff did not report: $1"
}
fp() { # $1 = database, $2 = kind, $3 = key → its hash
  PGOPTIONS='-c default_transaction_read_only=on' psql "$(url "$1")" -qAtX -f "$ROOT/scripts/db/schema-fingerprint.sql" \
    | awk -F'\t' -v k="$2" -v key="$3" '$1 == k && $3 == key { print $4 }'
}

for db in sdt_a sdt_b; do sql postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"; done
# The fingerprint compares service_role's privileges; the chain creates the role.
sql postgres -c "DO \$\$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$"
# The same schema on both; citext where Supabase keeps extensions on one side.
sql sdt_a -c "CREATE EXTENSION citext"
sql sdt_b -c "CREATE SCHEMA extensions" -c "CREATE EXTENSION citext SCHEMA extensions"
for db in sdt_a sdt_b; do
  sql "$db" -c "SET search_path = public, extensions" -f - <<'SQL'
CREATE TABLE public.branding (id int PRIMARY KEY, name text, email citext);
CREATE FUNCTION public.f_lit() RETURNS text LANGUAGE sql AS $$ SELECT 'a b' $$;
CREATE FUNCTION public.f_dash() RETURNS text LANGUAGE sql AS $$ SELECT 'x -- y' $$;
CREATE FUNCTION public.f_prefix() RETURNS text LANGUAGE sql AS $$ SELECT 'public.t' $$;
CREATE FUNCTION public.f_default(a int DEFAULT 1) RETURNS int LANGUAGE sql AS $$ SELECT a $$;
CREATE FUNCTION public.f_name(a int) RETURNS int LANGUAGE sql AS $$ SELECT $1 $$;
CREATE FUNCTION public.f_reviewed() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION public.f_email(e citext) RETURNS citext LANGUAGE sql AS $$ SELECT e $$;
SQL
done
grep -v '^[^#]' "$ROOT/scripts/db/schema-parity-allowlist.txt" > "$WORK/allow"   # the header only
diff_ || die "identical schemas (citext in public on one side, in extensions on the other) were reported as different"
grep -q '0 unexpected difference(s), 0 reviewed' "$WORK/out" || die "identical schemas: unexpected summary"
ok "identical schemas, an extension in public on one side and in extensions on the other: no difference"

# ── literals ────────────────────────────────────────────────────────────
sql sdt_b -c "CREATE OR REPLACE FUNCTION public.f_lit() RETURNS text LANGUAGE sql AS \$\$ SELECT 'a  b' \$\$" \
          -c "CREATE OR REPLACE FUNCTION public.f_dash() RETURNS text LANGUAGE sql AS \$\$ SELECT 'x -- z' \$\$" \
          -c "CREATE OR REPLACE FUNCTION public.f_prefix() RETURNS text LANGUAGE sql AS \$\$ SELECT 't' \$\$"
if diff_; then die "literal differences: schema-diff exited 0"; fi
reports "changed  function  f_lit()"
reports "changed  function  f_dash()"
reports "changed  function  f_prefix()"
ok "literals: 'a b' / 'a  b', 'x -- y' / 'x -- z', 'public.t' / 't' — each reported"
for f in f_lit f_dash f_prefix; do
  sql sdt_b -c "CREATE OR REPLACE FUNCTION public.$f() RETURNS text LANGUAGE sql AS \$\$ $(sql sdt_a -c "SELECT prosrc FROM pg_proc WHERE oid = 'public.$f()'::regprocedure") \$\$"
done

# ── parameters ──────────────────────────────────────────────────────────
sql sdt_b -c "CREATE OR REPLACE FUNCTION public.f_default(a int DEFAULT 2) RETURNS int LANGUAGE sql AS \$\$ SELECT a \$\$" \
          -c "DROP FUNCTION public.f_name(int)" -c "CREATE FUNCTION public.f_name(b int) RETURNS int LANGUAGE sql AS \$\$ SELECT \$1 \$\$"
if diff_; then die "parameter differences: schema-diff exited 0"; fi
reports "changed  function  f_default(integer)"
reports "changed  function  f_name(integer)"
[ "$(grep -c '^changed\|^missing\|^extra' "$WORK/out")" = 2 ] || die "parameter differences: expected exactly the two functions"
ok "parameters: a different default, a different name — each reported"
sql sdt_b -c "CREATE OR REPLACE FUNCTION public.f_default(a int DEFAULT 1) RETURNS int LANGUAGE sql AS \$\$ SELECT a \$\$" \
          -c "DROP FUNCTION public.f_name(int)" -c "CREATE FUNCTION public.f_name(a int) RETURNS int LANGUAGE sql AS \$\$ SELECT \$1 \$\$"
diff_ || die "after putting the parameters back, the schemas still differ"

# ── allowlist: exactly one object, between exactly two definitions ──────
sql sdt_b -c "ALTER TABLE public.branding ADD COLUMN lock boolean NOT NULL DEFAULT false" \
          -c "CREATE OR REPLACE FUNCTION public.f_reviewed() RETURNS int LANGUAGE sql AS \$\$ SELECT 2 \$\$"
{ cat "$WORK/allow"
  printf 'column\tbranding.lock\t-\t%s\ttest: the reviewed column\n' "$(fp sdt_b column branding.lock)"
  printf 'function\tf_reviewed()\t%s\t%s\ttest: the reviewed function\n' "$(fp sdt_a function 'f_reviewed()')" "$(fp sdt_b function 'f_reviewed()')"
} > "$WORK/allow.reviewed"
mv "$WORK/allow.reviewed" "$WORK/allow"
diff_ || die "the two allowlisted differences were reported"
grep -q '0 unexpected difference(s), 2 reviewed' "$WORK/out" || die "allowlisted differences: unexpected summary"
ok "allowlist: the reviewed column and the reviewed function, as listed — reviewed"

sql sdt_b -c "ALTER TABLE public.branding ALTER COLUMN name TYPE varchar(40)"
if diff_; then die "an unrelated column of the allowlisted table: schema-diff exited 0"; fi
reports "changed  column  branding.name"
ok "allowlist: another column of the same table changed — reported"
sql sdt_b -c "ALTER TABLE public.branding ALTER COLUMN name TYPE text"

sql sdt_b -c "ALTER TABLE public.branding ALTER COLUMN lock SET DEFAULT true"
if diff_; then die "the allowlisted column changed again: schema-diff exited 0"; fi
reports "extra  column  branding.lock"
ok "allowlist: the reviewed column with another definition — reported"
sql sdt_b -c "ALTER TABLE public.branding ALTER COLUMN lock SET DEFAULT false"

sql sdt_b -c "CREATE OR REPLACE FUNCTION public.f_reviewed() RETURNS int LANGUAGE sql AS \$\$ SELECT 3 \$\$"
if diff_; then die "the allowlisted function changed again: schema-diff exited 0"; fi
reports "changed  function  f_reviewed()"
ok "allowlist: the reviewed function changed again — reported"

for db in sdt_a sdt_b; do sql postgres -c "DROP DATABASE $db"; done
echo "schema-diff: all scenarios passed"
