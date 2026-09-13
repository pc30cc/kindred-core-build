#!/usr/bin/env bash
# Polls WEBYAR for operator-requested backup commands and runs them.
#
# The command set is allow-listed on both sides (database CHECK constraint +
# this case statement). There is no restore command and there never should be:
# a production restore is a controlled operational procedure, not a button.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

require WEBYAR_API_BASE BACKUP_AGENT_TOKEN
INTERVAL="${BACKUP_AGENT_POLL_SECONDS:-30}"
log "backup agent started, polling every ${INTERVAL}s"

api() {
  curl -sS -X POST "${WEBYAR_API_BASE%/}/api/backup-agent/$1" \
    -H 'Content-Type: application/json' \
    -H "x-backup-agent-token: ${BACKUP_AGENT_TOKEN}" \
    --data "${2:-{\}}"
}

while true; do
  RESP=$(api claim || echo '{"command":null}')
  CMD_ID=$(echo "$RESP" | python3 -c 'import json,sys;d=json.load(sys.stdin).get("command") or {};print(d.get("id",""))' 2>/dev/null || echo '')
  CMD=$(echo "$RESP" | python3 -c 'import json,sys;d=json.load(sys.stdin).get("command") or {};print(d.get("command",""))' 2>/dev/null || echo '')

  if [ -z "$CMD_ID" ]; then sleep "$INTERVAL"; continue; fi
  log "claimed command $CMD ($CMD_ID)"

  set +e
  case "$CMD" in
    run_base_backup)    ./base-backup.sh    > /tmp/cmd.out 2>&1 ;;
    run_logical_backup) ./logical-backup.sh > /tmp/cmd.out 2>&1 ;;
    verify_latest_backup) ./verify-backup.sh > /tmp/cmd.out 2>&1 ;;
    *) echo "unknown command: $CMD" > /tmp/cmd.out; false ;;
  esac
  RC=$?
  set -e

  if [ $RC -eq 0 ]; then
    api complete "{\"id\":\"$CMD_ID\",\"status\":\"succeeded\",\"result\":{\"exit_code\":0}}" >/dev/null
    log "command $CMD succeeded"
  else
    api complete "{\"id\":\"$CMD_ID\",\"status\":\"failed\",\"error\":$(json_escape "$(tail -c 900 /tmp/cmd.out)")}" >/dev/null
    log "command $CMD failed (rc=$RC)"
  fi
done
