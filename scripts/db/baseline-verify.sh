#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Which files of database/migrations a database ALREADY holds — decided from
# its catalog, file by file — and, only on request, record exactly those in
# its ledger (public._schema_migrations) so scripts/migrate-database.sh
# applies the rest. Replaces marking every file as applied without looking.
#
#   REFERENCE_ADMIN_URL=postgresql://postgres@scratch-host/postgres \
#   TARGET_DATABASE_URL=postgresql://…  bash scripts/db/baseline-verify.sh report
#   … the same …                        bash scripts/db/baseline-verify.sh mark
#
# REFERENCE_ADMIN_URL  a superuser on a THROWAWAY server (the same major
#                      version as the target, with pgvector if the target has
#                      it). Two databases are (re)created there:
#                      _baseline_build and _baseline_state.
# TARGET_DATABASE_URL  the database to judge. `report` opens it read-only.
# TARGET_FINGERPRINT_FILE
#                      instead of TARGET_DATABASE_URL for `report`: the output
#                      of `psql "$URL" -qAtX -f scripts/db/schema-fingerprint.sql`
#                      taken elsewhere, read-only.
#
# How it decides. The reference database is built by applying the files one
# by one; after each, scripts/db/schema-fingerprint.sql records every object
# the file added, changed or removed (functions with their bodies, triggers,
# constraints, columns, indexes, policies, service_role grants, …). Each such
# change is then looked up on the target:
#   consistent  the target holds this change, or a later file's change to the
#               same object (it was applied and then superseded)
#   pending     the target holds the object as it was BEFORE this file
#   neutral     the target's state is explained either way (e.g. an object a
#               later file drops, absent on the target)
#   drift       the target's version matches no file's — changed by hand
# and each file gets a verdict:
#   applied       at least one consistent change, none pending, no drift
#   pending       pending changes only
#   partial       both — the file stopped half-way or was edited by hand
#   drift         a change of this file matches nothing on the target
#   unverifiable  nothing the catalog can show: data-only or role-only files,
#                 or every change superseded either way. Read the file and
#                 decide: `mark` records one only when it is named in
#                 ASSUME_APPLIED="file.sql other.sql", and refuses while one
#                 before the last applied file is in neither ASSUME_APPLIED
#                 nor RUN_AGAIN (left for migrate-database.sh to run).
# Objects in reviewed groups (scripts/db/schema-parity-allowlist.txt, or
# SCHEMA_PARITY_ALLOWLIST) are left out of the verdicts.
#
# `mark` records the `applied` files (and the ASSUME_APPLIED ones) and
# nothing else, after confirmation (type `mark`, or YES=1). It refuses when a
# file is partial or drift, or when a pending file comes before an applied
# one — migrate-database.sh would then run an old file after newer ones.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  report|mark) ;;
  *) echo "usage: REFERENCE_ADMIN_URL=… TARGET_DATABASE_URL=… $0 report|mark" >&2; exit 2 ;;
esac
ADMIN="${REFERENCE_ADMIN_URL:?REFERENCE_ADMIN_URL is required (a superuser on a throwaway server)}"
if [ "$MODE" = mark ] || [ -z "${TARGET_FINGERPRINT_FILE:-}" ]; then
  TARGET="${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FP="$ROOT/scripts/db/schema-fingerprint.sql"
ALLOWLIST="${SCHEMA_PARITY_ALLOWLIST:-$ROOT/scripts/db/schema-parity-allowlist.txt}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
# a database on the reference server, by name
ref() { local base="${ADMIN%%\?*}" q=""; [ "$base" != "$ADMIN" ] && q="?${ADMIN#*\?}"; printf '%s/%s%s' "${base%/*}" "$1" "$q"; }
BUILD="$(ref _baseline_build)"
STATE="$(ref _baseline_state)"
st() { psql "$STATE" -v ON_ERROR_STOP=1 -qtAX "$@"; }
# tab-separated, every character literal (definitions contain backslashes)
COPY_OPTS="WITH (FORMAT csv, DELIMITER E'\\t', QUOTE E'\\x01')"
fingerprint() { PGOPTIONS='-c default_transaction_read_only=on' psql "$1" -v ON_ERROR_STOP=1 -qAtX -f "$FP"; }

[ "$(psql "$ADMIN" -qtAX -c "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")" = t ] \
  || fail "REFERENCE_ADMIN_URL must be a superuser: the chain creates roles and extensions."

shopt -s nullglob
files=("$ROOT"/database/migrations/*.sql); shopt -u nullglob
printf '%s\n' "${files[@]}" | LC_ALL=C sort > "$WORK/files"
: > "$WORK/manifest"
i=0
while read -r f; do i=$((i + 1)); printf '%s\t%s\t%s\n' "$i" "${f##*/}" "$(md5sum < "$f" | cut -d' ' -f1)" >> "$WORK/manifest"; done < "$WORK/files"
nfiles="$i"

# ── the reference: one fingerprint delta per file (reused while the files
#    are unchanged) ─────────────────────────────────────────────────────────
current="$(psql "$ADMIN" -qtAX -c "SELECT 1 FROM pg_database WHERE datname = '_baseline_state'")"
if [ "$current" = 1 ] && [ "$(st -c "SELECT coalesce(string_agg(step || E'\t' || filename || E'\t' || md5, E'\n' ORDER BY step), '') FROM files" 2>/dev/null)" = "$(cat "$WORK/manifest")" ]; then
  echo "reference: reusing the per-file changes recorded for these $nfiles files"
else
  echo "reference: building the chain one file at a time on $(psql "$ADMIN" -qtAX -c "SELECT current_setting('server_version')") (a few minutes)…"
  psql "$ADMIN" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS _baseline_build" -c "DROP DATABASE IF EXISTS _baseline_state" \
       -c "CREATE DATABASE _baseline_build" -c "CREATE DATABASE _baseline_state"
  st <<'SQL'
CREATE TABLE files (step int PRIMARY KEY, filename text UNIQUE NOT NULL, md5 text NOT NULL);
-- the state of one object after a step: its hash(es), or NULL once removed
CREATE TABLE versions (step int NOT NULL, kind text NOT NULL, grp text NOT NULL, key text NOT NULL, h text);
CREATE TABLE raw (kind text, grp text, key text, h text);
CREATE TABLE prev (kind text, grp text, key text, h text, PRIMARY KEY (kind, key));
CREATE TABLE cur (kind text, grp text, key text, h text, PRIMARY KEY (kind, key));
SQL
  record_step() { # $1 = step
    fingerprint "$BUILD" > "$WORK/fp"
    st -c "TRUNCATE raw, cur" -c "\\copy raw FROM '$WORK/fp' $COPY_OPTS" \
       -c "INSERT INTO cur SELECT kind, min(grp), key, string_agg(DISTINCT h, ',' ORDER BY h) FROM raw GROUP BY kind, key" \
       -c "INSERT INTO versions SELECT $1, c.kind, c.grp, c.key, c.h FROM cur c LEFT JOIN prev p USING (kind, key) WHERE p.h IS DISTINCT FROM c.h" \
       -c "INSERT INTO versions SELECT $1, p.kind, p.grp, p.key, NULL FROM prev p LEFT JOIN cur c USING (kind, key) WHERE c.key IS NULL" \
       -c "TRUNCATE prev" -c "INSERT INTO prev SELECT * FROM cur"
  }
  record_step 0
  while IFS=$'\t' read -r step name sum; do
    psql "$BUILD" -v ON_ERROR_STOP=1 -q -f "$ROOT/database/migrations/$name" > "$WORK/apply.log" 2>&1 \
      || { tail -20 "$WORK/apply.log" >&2; fail "$name failed on the reference database; nothing was read from or written to the target."; }
    record_step "$step"
  done < "$WORK/manifest"
  st -c "\\copy files FROM '$WORK/manifest' $COPY_OPTS"
  echo "reference: done"
fi

# ── the target ─────────────────────────────────────────────────────────
if [ -n "${TARGET_FINGERPRINT_FILE:-}" ] && [ "$MODE" = report ]; then
  cp "$TARGET_FINGERPRINT_FILE" "$WORK/target"
  echo "target: fingerprint from $TARGET_FINGERPRINT_FILE"
else
  if [ "$(PGOPTIONS='-c default_transaction_read_only=on' psql "$TARGET" -qtAX -c "SELECT count(*) FROM pg_extension WHERE extname = 'vector'")" = 1 ] \
     && [ "$(psql "$BUILD" -qtAX -c "SELECT count(*) FROM pg_extension WHERE extname = 'vector'")" = 0 ]; then
    fail "The target has pgvector and the reference server does not: every embedding object would read as drift. Use a reference server with pgvector."
  fi
  fingerprint "$TARGET" > "$WORK/target"
  echo "target: fingerprint read (read-only session)"
fi
grep -v '^#' "$ALLOWLIST" | awk -F'\t' 'NF >= 2 { print $1 "\t" $2 }' > "$WORK/allow" || true

st -c "DROP TABLE IF EXISTS target_raw, target, allow" \
   -c "CREATE TABLE target_raw (kind text, grp text, key text, h text)" \
   -c "\\copy target_raw FROM '$WORK/target' $COPY_OPTS" \
   -c "CREATE TABLE target AS SELECT kind, min(grp) AS grp, key, string_agg(DISTINCT h, ',' ORDER BY h) AS h FROM target_raw GROUP BY kind, key" \
   -c "CREATE TABLE allow (kind text, grp text)" \
   -c "\\copy allow FROM '$WORK/allow' $COPY_OPTS"

st > "$WORK/verdicts" <<'SQL'
WITH keys AS (SELECT kind, key, min(grp) AS grp FROM versions GROUP BY kind, key),
reviewed AS (
  SELECT k.kind, k.key FROM keys k
   WHERE EXISTS (SELECT 1 FROM allow a WHERE a.grp = k.grp AND a.kind IN ('*', k.kind))
),
timeline AS (  -- every state an object had, by the step that produced it
  SELECT kind, key, step, h FROM versions
  UNION ALL  -- absent before the step that created it
  SELECT k.kind, k.key, -1, NULL FROM keys k
   WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.kind = k.kind AND v.key = k.key AND v.step = 0)
),
matched AS (  -- the steps after which the object looked as it does on the target
  SELECT k.kind, k.key, min(tl.step) AS lo, max(tl.step) AS hi
    FROM keys k LEFT JOIN target t USING (kind, key)
    LEFT JOIN timeline tl ON tl.kind = k.kind AND tl.key = k.key AND tl.h IS NOT DISTINCT FROM t.h
   GROUP BY k.kind, k.key
),
items AS (
  SELECT v.step, v.kind, v.key,
         CASE WHEN r.key IS NOT NULL THEN 'reviewed'
              WHEN m.lo IS NULL THEN 'drift'
              WHEN v.step <= m.lo THEN 'consistent'
              WHEN v.step > m.hi THEN 'pending'
              ELSE 'neutral' END AS status
    FROM versions v JOIN matched m USING (kind, key)
    LEFT JOIN reviewed r USING (kind, key)
   WHERE v.step > 0
)
SELECT f.step, f.filename,
       CASE WHEN count(*) FILTER (WHERE i.status = 'drift') > 0 THEN 'drift'
            WHEN count(*) FILTER (WHERE i.status = 'consistent') > 0 AND count(*) FILTER (WHERE i.status = 'pending') > 0 THEN 'partial'
            WHEN count(*) FILTER (WHERE i.status = 'consistent') > 0 THEN 'applied'
            WHEN count(*) FILTER (WHERE i.status = 'pending') > 0 THEN 'pending'
            ELSE 'unverifiable' END,
       count(*) FILTER (WHERE i.status = 'consistent'), count(*) FILTER (WHERE i.status = 'pending'),
       count(*) FILTER (WHERE i.status = 'drift'), count(*) FILTER (WHERE i.status IN ('neutral', 'reviewed')),
       coalesce(string_agg(i.kind || ' ' || i.key, '; ' ORDER BY i.kind, i.key) FILTER (WHERE i.status IN ('drift', 'pending')), '')
  FROM files f LEFT JOIN items i ON i.step = f.step
 GROUP BY f.step, f.filename ORDER BY f.step;
SQL

# ── report ─────────────────────────────────────────────────────────────
if [ "$MODE" = report ] || [ -n "${VERBOSE:-}" ]; then
  echo
  printf '%-58s %-13s %s\n' file verdict 'consistent/pending/drift/neutral'
  awk -F'|' '{ printf "%-58s %-13s %s/%s/%s/%s\n", $2, $3, $4, $5, $6, $7
               if (($3 == "partial" || $3 == "drift") && $8 != "") print "    " substr($8, 1, 400) }' "$WORK/verdicts"
fi
echo
awk -F'|' '{ n[$3]++ } END { for (v in n) printf "%s: %d  ", v, n[v]; print "" }' "$WORK/verdicts"

if [ -n "${TARGET:-}" ] && [ "$(PGOPTIONS='-c default_transaction_read_only=on' psql "$TARGET" -qtAX -c "SELECT to_regclass('public._schema_migrations') IS NOT NULL")" = t ]; then
  PGOPTIONS='-c default_transaction_read_only=on' psql "$TARGET" -qtAX -c "SELECT filename FROM public._schema_migrations" | LC_ALL=C sort > "$WORK/ledger"
  recorded_not_applied="$(awk -F'|' '$3 == "pending" || $3 == "partial" || $3 == "drift" { print $2 }' "$WORK/verdicts" | LC_ALL=C sort | LC_ALL=C comm -12 - "$WORK/ledger" || true)"
  [ -z "$recorded_not_applied" ] || printf 'in the ledger as applied, but the catalog says otherwise (migrate-database.sh will never run them):\n%s\n' "$(sed 's/^/  /' <<< "$recorded_not_applied")"
fi

# An old file left pending under newer applied ones would be run after them.
out_of_order="$(awk -F'|' '$3 == "applied" { last = NR } { v[NR] = $3; n[NR] = $2 } END { for (i = 1; i < last; i++) if (v[i] == "pending" || v[i] == "partial") print n[i] }' "$WORK/verdicts")"
[ -z "$out_of_order" ] || printf 'pending or partial BEFORE an applied file (migrate-database.sh would run them after newer files):\n%s\n' "$(sed 's/^/  /' <<< "$out_of_order")"

[ "$MODE" = report ] && { echo; echo "Report only — nothing was written to the target."; exit 0; }

# ── mark ───────────────────────────────────────────────────────────────
bad="$(awk -F'|' '$3 == "partial" || $3 == "drift" { print $2 }' "$WORK/verdicts")"
[ -z "$bad" ] || fail "Not marking: these files are partial or drift — resolve them first (report shows which objects):
$(sed 's/^/  /' <<< "$bad")"
[ -z "$out_of_order" ] || fail "Not marking: a pending file comes before an applied one (above). Bring the target up to date by hand first."
for name in ${ASSUME_APPLIED:-} ${RUN_AGAIN:-}; do
  grep -q "|$name|unverifiable|" "$WORK/verdicts" || fail "$name is not an unverifiable file of this chain: only those are decided by hand."
done
# An unverifiable file before the last applied one is either already applied
# (ASSUME_APPLIED) or must run again after the newer files (RUN_AGAIN) — the
# operator says which, after reading it; nothing is assumed.
undecided="$(awk -F'|' -v decided=" ${ASSUME_APPLIED:-} ${RUN_AGAIN:-} " '
  $3 == "applied" { last = NR } { v[NR] = $3; n[NR] = $2 }
  END { for (i = 1; i < last; i++) if (v[i] == "unverifiable" && index(decided, " " n[i] " ") == 0) print n[i] }' "$WORK/verdicts")"
[ -z "$undecided" ] || fail "Not marking: these files change nothing the catalog shows (data, customer-role grants, storage settings), so whether they ran cannot be read from the target. scripts/db/baseline-evidence.sql shows their effects read-only, and docs/AUTO_MIGRATIONS.md which of them are unsafe to run twice. List each in ASSUME_APPLIED (its effect is there) or RUN_AGAIN (let migrate-database.sh run it now):
$(sed 's/^/  /' <<< "$undecided")"
awk -F'|' '$3 == "applied" { print $2 }' "$WORK/verdicts" > "$WORK/mark"
for name in ${ASSUME_APPLIED:-}; do echo "$name" >> "$WORK/mark"; done
LC_ALL=C sort -u -o "$WORK/mark" "$WORK/mark"
echo "will record $(wc -l < "$WORK/mark" | tr -d ' ') file(s) as applied, without running them; the other $((nfiles - $(wc -l < "$WORK/mark"))) stay for migrate-database.sh"
if [ "${YES:-}" != 1 ]; then
  read -r -p "Type 'mark' to continue: " answer
  [ "$answer" = mark ] || fail "Aborted. Nothing was written."
fi
{
  echo "BEGIN;"
  echo "CREATE TABLE IF NOT EXISTS public._schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
  sed "s/'/''/g; s/.*/INSERT INTO public._schema_migrations (filename) VALUES ('&') ON CONFLICT (filename) DO NOTHING;/" "$WORK/mark"
  echo "COMMIT;"
} | psql "$TARGET" -v ON_ERROR_STOP=1 -q
echo "recorded. scripts/migrate-database.sh will now apply only the files not recorded."
