#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# scripts/db/baseline-verify.sh against throwaway databases on one server.
#
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=… \
#     bash scripts/ci/baseline-verify-test.sh
#
# PGUSER must be a superuser: the test creates and DROPS databases named
# blt_* and _baseline_* on that server.
#
#   prefix      a database built by hand through file 120, no ledger: files
#               up to 120 applied or unverifiable, everything after pending,
#               nothing partial or drift; `report` writes nothing.
#   refusals    `mark` refuses while an unverifiable file before the last
#               applied one is undecided, and writes nothing.
#   mark        with those decided, `mark` records exactly the first 120;
#               migrate-database.sh then applies the other files and the
#               result has the same schema as a database built from scratch.
#   partial / drift
#               a full database with a trigger dropped and a function body
#               edited: the two files are reported, `mark` refuses.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export PGOPTIONS='-c client_min_messages=warning'

url()   { printf 'postgresql://%s@/%s' "${PGUSER:-postgres}" "$1"; }
sql()   { psql "$(url "$1")" -v ON_ERROR_STOP=1 -qtAX "${@:2}"; }
admin() { sql postgres "$@"; }
ok()    { printf '✓ %s\n' "$*"; }
die()   { printf '✗ %s\n' "$*" >&2; [ -f "$WORK/out" ] && sed 's/^/    /' "$WORK/out" | tail -40 >&2; exit 1; }
verify() { # $1 = report|mark, $2 = target database, then VAR=value…
  local mode="$1" db="$2"; shift 2
  env "$@" REFERENCE_ADMIN_URL="$(url postgres)" TARGET_DATABASE_URL="$(url "$db")" \
    bash "$ROOT/scripts/db/baseline-verify.sh" "$mode" > "$WORK/out" 2>&1
}
verdict() { awk -v f="$1" '$1 == f { print $2 }' "$WORK/out"; }
ledger() { # rows in the ledger, or "none" without one
  if [ "$(sql "$1" -c "SELECT to_regclass('public._schema_migrations') IS NULL")" = t ]; then echo none
  else sql "$1" -c "SELECT count(*) FROM public._schema_migrations"; fi
}

for db in blt_prefix blt_full blt_mixed _baseline_build _baseline_state; do admin -c "DROP DATABASE IF EXISTS $db"; done
LC_ALL=C ls "$ROOT"/database/migrations/*.sql > "$WORK/files"
total="$(wc -l < "$WORK/files" | tr -d ' ')"

# ── prefix: built by hand through file 120, no ledger ───────────────────
admin -c "CREATE DATABASE blt_prefix"
head -120 "$WORK/files" | while read -r f; do sql blt_prefix -f "$f" > /dev/null; done
last="$(sed -n 120p "$WORK/files" | xargs basename)"; next="$(sed -n 121p "$WORK/files" | xargs basename)"
verify report blt_prefix || die "report failed"
grep -q 'nothing was written to the target' "$WORK/out" || die "report did not say it wrote nothing"
[ "$(ledger blt_prefix)" = none ] || die "report created a ledger"
grep -Eq '(^| )(partial|drift): [0-9]' "$WORK/out" && die "partial or drift reported on an untouched prefix"
awk -v last="$last" -v n=0 '
  $2 ~ /^(applied|pending|unverifiable)$/ { n++; if (n <= 120 && $2 == "pending") bad = bad " " $1; if (n > 120 && $2 == "applied") bad = bad " " $1 }
  END { if (bad != "") { print "wrong side of file 120:" bad > "/dev/stderr"; exit 1 } }' "$WORK/out" || die "verdicts do not split at file 120"
[ "$(verdict "$last")" = applied ] || [ "$(verdict "$last")" = unverifiable ] || die "$last: $(verdict "$last")"
[ "$(verdict "$next")" = pending ] || die "$next: $(verdict "$next"), expected pending"
ok "prefix (built by hand through $last): files up to it applied or unverifiable, from $next on pending, nothing partial or drift; report wrote nothing"

# ── refusals ────────────────────────────────────────────────────────────
if YES=1 verify mark blt_prefix; then die "mark succeeded with undecided unverifiable files"; fi
grep -q 'List each in ASSUME_APPLIED' "$WORK/out" || die "mark refused for another reason"
[ "$(ledger blt_prefix)" = none ] || die "a refused mark wrote to the ledger"
grep '^  [0-9]' "$WORK/out" | tr -d ' ' > "$WORK/undecided"
[ -s "$WORK/undecided" ] || die "no undecided files listed"
ok "mark refuses while $(wc -l < "$WORK/undecided" | tr -d ' ') unverifiable file(s) before the last applied one are undecided, and writes nothing"

# ── mark, then migrate-database.sh does the rest ────────────────────────
verify mark blt_prefix YES=1 ASSUME_APPLIED="$(tr '\n' ' ' < "$WORK/undecided")" || die "mark failed"
[ "$(ledger blt_prefix)" = 120 ] || die "mark recorded $(ledger blt_prefix) files, expected 120"
[ "$(sql blt_prefix -c "SELECT max(filename) FROM public._schema_migrations")" = "$last" ] || die "mark recorded a file after $last"
DATABASE_URL="$(url blt_prefix)" bash "$ROOT/scripts/migrate-database.sh" > "$WORK/out" 2>&1 || die "migrate-database.sh failed after mark"
grep -q "Applied: $((total - 120)), already up to date: 120\." "$WORK/out" || die "migrate-database.sh did not apply exactly the rest"
SOURCE_DATABASE_URL="$(url _baseline_build)" TARGET_DATABASE_URL="$(url blt_prefix)" bash "$ROOT/scripts/db/schema-diff.sh" > "$WORK/out" 2>&1 \
  || die "after mark + migrate the schema differs from a database built from scratch"
ok "mark recorded exactly the first 120 files; migrate-database.sh applied the other $((total - 120)); the schema equals a fresh build"

# ── partial / drift ─────────────────────────────────────────────────────
admin -c "CREATE DATABASE blt_full"
DATABASE_URL="$(url blt_full)" bash "$ROOT/scripts/migrate-database.sh" > /dev/null 2>&1 || die "building the full chain failed"
sql blt_full -c "DELETE FROM public._schema_migrations"
admin -c "CREATE DATABASE blt_mixed TEMPLATE blt_full"
verify report blt_full || die "report on the full chain failed"
grep -Eq '(^| )(pending|partial|drift): [0-9]' "$WORK/out" && die "a full chain reported pending, partial or drift"
ok "the whole chain: every file applied or unverifiable"
sql blt_mixed -c "DROP TRIGGER trg_billing_notify_payment_recorded ON public.billing_payments" \
              -c "CREATE OR REPLACE FUNCTION public.data_retention_touch() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN NEW.updated_at := now(); RETURN NEW; END \$f\$"
verify report blt_mixed || die "report failed"
[ "$(verdict 156_billing_lifecycle_notifications.sql)" = partial ] || die "the dropped trigger did not make 156 partial"
[ "$(verdict 169_data_retention.sql)" = drift ] || die "the edited function did not make 169 drift"
grep -q 'trigger billing_payments.trg_billing_notify_payment_recorded' "$WORK/out" || die "the missing trigger was not named"
if YES=1 verify mark blt_mixed; then die "mark succeeded on a partial / drift database"; fi
grep -q 'partial or drift' "$WORK/out" || die "mark refused for another reason"
[ "$(ledger blt_mixed)" = 0 ] || die "a refused mark wrote to the ledger"
ok "a dropped trigger reads as partial, an edited function as drift; mark refuses and writes nothing"

for db in blt_prefix blt_full blt_mixed _baseline_build _baseline_state; do admin -c "DROP DATABASE IF EXISTS $db"; done
echo "baseline-verify: all scenarios passed"
