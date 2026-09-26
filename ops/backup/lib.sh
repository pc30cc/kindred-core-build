#!/usr/bin/env bash
# Shared helpers for the WEBYAR backup agent.
# shellcheck disable=SC2155
set -Eeuo pipefail

# Fail closed: these drafts have not passed an isolated production restore.
# Nothing runs unless the operator explicitly opts in with
# WEBYAR_BACKUP_ENABLED=1 (see README.md / backup.env.example). Any other
# value — including unset — keeps the interlock closed (exit 78, EX_CONFIG).
if [ "${WEBYAR_BACKUP_ENABLED:-0}" != "1" ]; then
  printf "%s\n" "NOT READY: backup tooling is disabled pending infrastructure validation and restore testing." >&2
  exit 78
fi

BACKUP_LOG_PREFIX="${BACKUP_LOG_PREFIX:-webyar-backup}"

# Per-run scratch directory. Fixed /tmp/*.out names were shared by every
# script and by both backup containers, so a concurrent run could overwrite
# (and report) another run's output. Removed when the script exits.
BACKUP_TMP="$(mktemp -d "${TMPDIR:-/tmp}/webyar-backup.XXXXXX")"
trap 'rm -rf "$BACKUP_TMP"' EXIT

# Logging that can never print a credential: every value that looks like a
# secret is replaced before the line reaches stdout or the log file.
log() {
  local msg="$*"
  msg="${msg//${PGPASSWORD:-__nope__}/***}"
  msg="${msg//${AWS_SECRET_ACCESS_KEY:-__nope__}/***}"
  msg="${msg//${AWS_ACCESS_KEY_ID:-__nope__}/***}"
  msg="${msg//${BACKUP_AGENT_TOKEN:-__nope__}/***}"
  msg="${msg//${BACKUP_ENCRYPTION_PASSPHRASE:-__nope__}/***}"
  msg="${msg//${WALG_LIBSODIUM_KEY:-__nope__}/***}"
  printf '[%s] %s %s\n' "$BACKUP_LOG_PREFIX" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg"
}

die() { log "FATAL: $*"; exit 1; }

require() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "missing required configuration: $name"
  done
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# Report one backup run to the app. Best-effort by design: a reporting outage
# must never abort an otherwise healthy backup, but it is logged loudly because
# an unreported backup shows up as "too old" in Super Admin.
report() {
  local payload="$1"
  if [ -z "${WEBYAR_API_BASE:-}" ] || [ -z "${BACKUP_AGENT_TOKEN:-}" ]; then
    log "reporting skipped (WEBYAR_API_BASE / BACKUP_AGENT_TOKEN not set)"
    return 0
  fi
  local code
  code=$(curl -sS -o "$BACKUP_TMP/report.out" -w '%{http_code}' \
    -X POST "${WEBYAR_API_BASE%/}/api/backup-agent/report" \
    -H 'Content-Type: application/json' \
    -H "x-backup-agent-token: ${BACKUP_AGENT_TOKEN}" \
    --data "$payload" || echo 000)
  if [ "$code" != "200" ]; then
    log "WARNING: report failed with HTTP $code: $(head -c 300 "$BACKUP_TMP/report.out" || true)"
    return 0
  fi
  log "reported to app (HTTP 200)"
}

report_drill() {
  local payload="$1"
  [ -n "${WEBYAR_API_BASE:-}" ] && [ -n "${BACKUP_AGENT_TOKEN:-}" ] || return 0
  curl -sS -o /dev/null \
    -X POST "${WEBYAR_API_BASE%/}/api/backup-agent/drill" \
    -H 'Content-Type: application/json' \
    -H "x-backup-agent-token: ${BACKUP_AGENT_TOKEN}" \
    --data "$payload" || log "WARNING: drill report failed"
}

# Guard used by every restore script: refuse to touch production.
refuse_production() {
  local target="$1"
  [ -n "$target" ] || die "restore target not set"
  if [ "$target" = "${PGDATA:-/var/lib/postgresql/data}" ]; then
    die "refusing to restore over the production data directory ($target)"
  fi
  case "$target" in
    /var/lib/postgresql/data|/var/lib/postgresql/data/*)
      die "refusing to restore into the production data directory tree" ;;
  esac
}

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
