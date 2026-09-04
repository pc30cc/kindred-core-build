#!/usr/bin/env bash
# ============================================================================
# BILLING V2 — PRODUCTION CUTOVER RUNBOOK (single command, fail-closed)
#
#   ADMIN_DSN=postgres://... \
#   scripts/ops/billing-v2-production-deploy.sh --workspace <uuid> [--region IR]
#
# Order of operations (each step aborts the deploy on failure):
#
#   1. Reversible backup      pg_dump -Fc of the whole production database.
#   2. Migrations 113 → 124   applied IN ORDER and ONLY when not yet applied,
#                             tracked in public.ops_schema_migrations. No older
#                             migration is ever rewritten or re-run.
#   3. Schema / ACL / RPC     scripts/ops/billing-v2-sanity.sql
#   4. Policy validation      public.billing_v2_validate_policy() — a false `ok`
#                             (e.g. an invalid fallback_plan_id) stops here.
#   5. New-workspace default  billing_v2_policy.new_workspace_default_state.
#                             Existing legacy workspaces are NOT touched.
#   6. Canary cutover         billing_v2_activate() — the canonical RPC only.
#                             No manual DB hack, no fabricated payment.
#   7. Read-only smoke        scripts/ops/billing-v2-smoke.sql
#
# NOT done here, on purpose: no retention/purge, no data deletion, no test
# payment, no financial fixture.
# ============================================================================
set -euo pipefail

DSN="${ADMIN_DSN:-${DATABASE_URL:-}}"
WORKSPACE=""
REGION="IR"
NEW_WS_DEFAULT="v2_active"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --new-workspace-default) NEW_WS_DEFAULT="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$DSN" ] || { echo "ADMIN_DSN (or DATABASE_URL) is required" >&2; exit 2; }
[ -n "$WORKSPACE" ] || { echo "--workspace <uuid> is required (the canary workspace)" >&2; exit 2; }

PSQL=(psql "$DSN" -v ON_ERROR_STOP=1 -qtA)
say() { printf '\n=== %s\n' "$*"; }

# ─── 1. Backup ──────────────────────────────────────────────────────────────
say "1/7 backup"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$BACKUP_DIR/prod-pre-billing-v2-$STAMP.dump"
pg_dump "$DSN" -Fc -f "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" >/dev/null
BACKUP_BYTES="$(wc -c < "$BACKUP_FILE" | tr -d ' ')"
[ "$BACKUP_BYTES" -gt 10240 ] || { echo "backup implausibly small ($BACKUP_BYTES bytes) — aborting" >&2; exit 1; }
echo "backup OK: $BACKUP_FILE ($BACKUP_BYTES bytes, restore with pg_restore -d <db> -c)"

# ─── 2. Migrations 113 → 124, gated by a ledger ─────────────────────────────
say "2/7 migrations"
"${PSQL[@]}" <<'SQL'
CREATE TABLE IF NOT EXISTS public.ops_schema_migrations (
  filename    TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER
);
GRANT ALL ON public.ops_schema_migrations TO service_role;
SQL

APPLIED=()
SKIPPED=()
for f in database/migrations/1{1,2}*.sql; do
  n="$(basename "$f")"
  num="${n%%_*}"
  [ "$num" -ge 113 ] 2>/dev/null || continue
  present="$("${PSQL[@]}" -c "SELECT 1 FROM public.ops_schema_migrations WHERE filename = '$n'")"
  if [ "$present" = "1" ]; then SKIPPED+=("$n"); continue; fi
  sum="$(sha256sum "$f" | awk '{print $1}')"
  if [ "$DRY_RUN" = "1" ]; then echo "WOULD APPLY $n"; APPLIED+=("$n"); continue; fi
  start=$(date +%s%3N)
  psql "$DSN" -v ON_ERROR_STOP=1 -q -1 -f "$f"
  end=$(date +%s%3N)
  "${PSQL[@]}" -c "INSERT INTO public.ops_schema_migrations (filename, checksum, duration_ms)
                   VALUES ('$n', '$sum', $((end - start)))
                   ON CONFLICT (filename) DO NOTHING" >/dev/null
  echo "applied $n ($((end - start)) ms)"
  APPLIED+=("$n")
done
echo "applied: ${APPLIED[*]:-none}"
echo "already applied (skipped): ${SKIPPED[*]:-none}"

[ "$DRY_RUN" = "1" ] && { echo "dry run — stopping before sanity/cutover"; exit 0; }

# ─── 3. Schema / ACL / RPC sanity ───────────────────────────────────────────
say "3/7 schema + ACL + RPC sanity"
psql "$DSN" -v ON_ERROR_STOP=1 -f scripts/ops/billing-v2-sanity.sql

# ─── 4. Mandatory policy validation (fail-closed) ───────────────────────────
say "4/7 policy validation"
POLICY="$("${PSQL[@]}" -c "SELECT public.billing_v2_validate_policy()::text")"
echo "$POLICY"
OK="$("${PSQL[@]}" -c "SELECT (public.billing_v2_validate_policy() ->> 'ok')")"
[ "$OK" = "true" ] || { echo "billing policy invalid — deploy stopped, nothing was cut over" >&2; exit 1; }

# ─── 5. Default path for NEW workspaces (existing legacy untouched) ─────────
say "5/7 new-workspace default = $NEW_WS_DEFAULT (region $REGION)"
"${PSQL[@]}" -c "UPDATE public.billing_v2_policy
                    SET new_workspace_default_state = '$NEW_WS_DEFAULT',
                        new_workspace_default_region = '$REGION',
                        updated_at = now()
                  WHERE id"
"${PSQL[@]}" -c "SELECT new_workspace_default_state || ' / ' || COALESCE(new_workspace_default_region,'-')
                   FROM public.billing_v2_policy WHERE id"

# ─── 6. Canary cutover through the canonical RPCs only ──────────────────────
say "6/7 canary cutover for $WORKSPACE"
"${PSQL[@]}" -c "UPDATE public.billing_v2_rollout SET region = '$REGION'
                  WHERE workspace_id = '$WORKSPACE'::uuid AND region IS DISTINCT FROM '$REGION'" >/dev/null
READINESS="$("${PSQL[@]}" -c "SELECT public.billing_v2_evaluate_cutover('$WORKSPACE'::uuid)::text")"
echo "readiness: $READINESS"
"${PSQL[@]}" -c "SELECT public.billing_v2_set_state('$WORKSPACE'::uuid, 'shadow', NULL, 'production canary')::text"
"${PSQL[@]}" -c "SELECT public.billing_v2_set_state('$WORKSPACE'::uuid, 'v2_cutover_pending', NULL, 'production canary')::text"
ACTIVATION="$("${PSQL[@]}" -c "SELECT public.billing_v2_activate('$WORKSPACE'::uuid, NULL, 'production canary')::text")"
echo "activation: $ACTIVATION"
STATE="$("${PSQL[@]}" -c "SELECT public.billing_v2_state('$WORKSPACE'::uuid)")"
[ "$STATE" = "v2_active" ] || { echo "workspace did not reach v2_active (state=$STATE)" >&2; exit 1; }

# ─── 7. Read-only smoke ─────────────────────────────────────────────────────
say "7/7 smoke"
psql "$DSN" -v ON_ERROR_STOP=1 -v ws="$WORKSPACE" -f scripts/ops/billing-v2-smoke.sql

say "BILLING V2 CUTOVER COMPLETE — backup: $BACKUP_FILE — workspace $WORKSPACE = v2_active"
echo "retention/purge was NOT enabled and no data was deleted."
