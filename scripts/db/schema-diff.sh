#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Compare the schema two databases present to the application — functions
# (bodies, security, volatility, settings), service_role privileges, tables,
# columns, constraints, indexes, triggers, views, RLS policies, rules, types,
# sequences and extensions — not just table and column names.
#
#   SOURCE_DATABASE_URL=postgresql://...  TARGET_DATABASE_URL=postgresql://... \
#     bash scripts/db/schema-diff.sh
#
# Read-only on both sides. Both run scripts/db/schema-fingerprint.sql, which
# normalizes what legitimately differs between a Supabase project and plain
# PostgreSQL (the extensions schema, whitespace, comments in function bodies,
# constraint and index names, customer-role privileges). Differences listed
# in scripts/db/schema-parity-allowlist.txt (or the file SCHEMA_PARITY_ALLOWLIST
# names) are reported as reviewed; any other difference makes the exit
# status 1.
#
# Output: one line per differing object —
#   missing   on the target only in the source
#   extra     on the target, not in the source
#   changed   in both, with a different definition
# Set VERBOSE=1 to also print the allowlisted ones.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

SOURCE="${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
TARGET="${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fingerprint() {
  PGOPTIONS='-c default_transaction_read_only=on' \
    psql "$1" -v ON_ERROR_STOP=1 -qAtX -f "$HERE/schema-fingerprint.sql" | LC_ALL=C sort
}
fingerprint "$SOURCE" > "$WORK/source"
fingerprint "$TARGET" > "$WORK/target"

ALLOWLIST="${SCHEMA_PARITY_ALLOWLIST:-$HERE/schema-parity-allowlist.txt}"
grep -v '^#' "$ALLOWLIST" | awk -F'\t' 'NF >= 2' > "$WORK/allow" || true

awk -F'\t' -v verbose="${VERBOSE:-}" -v allowlist="${SCHEMA_PARITY_ALLOWLIST:-scripts/db/schema-parity-allowlist.txt}" '
  FILENAME == ARGV[1] { allow[$1 "\t" $2] = 1; next }
  FILENAME == ARGV[2] { k = $1 "\t" $3; src[k] = $4; grp[k] = $2; next }
  FILENAME == ARGV[3] { k = $1 "\t" $3; dst[k] = $4; grp[k] = $2; next }
  END {
    for (k in grp) {
      split(k, p, "\t")
      if (!(k in dst)) what = "missing"
      else if (!(k in src)) what = "extra"
      else if (src[k] != dst[k]) what = "changed"
      else continue
      reviewed = (("*" "\t" grp[k]) in allow) || ((p[1] "\t" grp[k]) in allow)
      if (reviewed) { nreviewed++; if (verbose != "") print "reviewed  " what "  " p[1] "  " p[2]; continue }
      nbad++
      print what "  " p[1] "  " p[2]
    }
    printf "schema-diff: %d unexpected difference(s), %d reviewed (%s)\n", nbad, nreviewed, allowlist > "/dev/stderr"
    exit nbad > 0 ? 1 : 0
  }
' "$WORK/allow" "$WORK/source" "$WORK/target" | LC_ALL=C sort
