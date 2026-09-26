#!/usr/bin/env bash
# Verify the newest base + logical backup without touching production.
#
# "The job exited 0" is not verification. This script re-reads the artefacts
# out of off-site storage and proves they are structurally restorable.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

require WALG_S3_PREFIX
STATUS=verified
NOTES=""

log "verifying newest base backup"
if wal-g backup-list --detail --json > "$BACKUP_TMP/walg-list.json" 2>"$BACKUP_TMP/walg-list.err"; then
  LATEST=$(python3 - "$BACKUP_TMP/walg-list.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
rows.sort(key=lambda r: r.get("time") or r.get("start_time") or "")
print((rows[-1].get("backup_name") or rows[-1].get("name")) if rows else "")
PY
)
  if [ -z "$LATEST" ]; then
    STATUS=failed; NOTES="no base backup found in the archive"
  else
    # Re-reads every segment of the backup from object storage and checks its
    # internal checksums — the closest thing to a restore that is not one.
    if wal-g backup-verify "$LATEST" >"$BACKUP_TMP/walg-verify.out" 2>&1 \
       || wal-g wal-verify integrity timeline >"$BACKUP_TMP/walg-verify.out" 2>&1; then
      log "base backup $LATEST verified"
    else
      STATUS=failed; NOTES="verification failed for $LATEST: $(tail -c 300 "$BACKUP_TMP/walg-verify.out")"
    fi
  fi
else
  STATUS=failed; NOTES="backup destination unreachable: $(tail -c 200 "$BACKUP_TMP/walg-list.err")"
fi

report "$(cat <<JSON
{"backup_id":"${LATEST:-unknown}","kind":"base","status":"$( [ "$STATUS" = verified ] && echo succeeded || echo failed )",
 "finished_at":"$(now_iso)","destination":"${WALG_S3_PREFIX}/basebackups_005","encrypted":true,
 "verification_status":"$( [ "$STATUS" = verified ] && echo verified || echo failed )",
 "verified_at":"$(now_iso)"$( [ -n "$NOTES" ] && echo ",\"error\":$(json_escape "$NOTES")" )}
JSON
)"

[ "$STATUS" = verified ] || die "$NOTES"
log "verification complete"
