#!/usr/bin/env bash
# Physical base backup via WAL-G, straight to encrypted off-site storage.
#
# WAL-G is the single PITR tool for WEBYAR. Nothing else in this repository
# pushes or expires WAL: two competing PITR systems on one cluster is how
# people end up with an archive that is missing exactly the segment they need.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

require WALG_S3_PREFIX PGDATA
BACKUP_ID="base-$(date -u +%Y%m%dT%H%M%SZ)"
STARTED="$(now_iso)"
log "starting base backup $BACKUP_ID → ${WALG_S3_PREFIX}/basebackups_005"

report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"base","status":"running","started_at":"$STARTED",
 "destination":"${WALG_S3_PREFIX}/basebackups_005","encrypted":true}
JSON
)"

WALG_BASE_OUT="$BACKUP_TMP/walg-base.out"
if ! wal-g backup-push "$PGDATA" > "$WALG_BASE_OUT" 2>&1; then
  log "base backup FAILED: $(tail -c 500 "$WALG_BASE_OUT")"
  report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"base","status":"failed","started_at":"$STARTED",
 "finished_at":"$(now_iso)","destination":"${WALG_S3_PREFIX}/basebackups_005",
 "encrypted":true,"error":$(json_escape "$(tail -c 500 "$WALG_BASE_OUT")")}
JSON
)"
  exit 1
fi

# WAL-G names the backup itself; pull the real name + size + start LSN out of
# its own catalogue so the registry matches the archive, not our guess.
DETAIL=$(wal-g backup-list --detail --json | python3 - <<'PY'
import json,sys
rows = json.load(sys.stdin)
rows.sort(key=lambda r: r.get("time") or r.get("start_time") or "")
b = rows[-1]
print(json.dumps({
  "name": b.get("backup_name") or b.get("name"),
  "lsn": b.get("start_lsn") or b.get("wal_file_name"),
  "bytes": b.get("compressed_size") or b.get("uncompressed_size") or 0,
}))
PY
)
NAME=$(echo "$DETAIL" | python3 -c 'import json,sys;print(json.load(sys.stdin)["name"])')
LSN=$(echo "$DETAIL" | python3 -c 'import json,sys;print(json.load(sys.stdin)["lsn"])')
BYTES=$(echo "$DETAIL" | python3 -c 'import json,sys;print(json.load(sys.stdin)["bytes"])')

log "base backup complete: $NAME (${BYTES} bytes, lsn ${LSN})"
report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"base","status":"succeeded","started_at":"$STARTED",
 "finished_at":"$(now_iso)","bytes":${BYTES:-0},"lsn":$(json_escape "$LSN"),
 "destination":"${WALG_S3_PREFIX}/basebackups_005","encrypted":true,
 "metadata":{"walg_backup_name":$(json_escape "$NAME")}}
JSON
)"

# Retention. WAL-G's own FIND_FULL-aware expiry never removes a base backup
# that retained WAL still depends on, which a hand-written "rm older than N"
# absolutely would.
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
log "applying retention: keep last ${KEEP_DAILY} full backups (+ weekly/monthly via bucket lifecycle)"
wal-g delete retain FULL "$KEEP_DAILY" --confirm > "$BACKUP_TMP/walg-retention.out" 2>&1 \
  || log "WARNING: retention pass failed — backups kept, investigate: $(tail -c 300 "$BACKUP_TMP/walg-retention.out")"
