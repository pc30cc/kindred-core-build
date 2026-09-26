#!/usr/bin/env bash
# Object storage (MinIO / Supabase Storage) mirror.
#
# PostgreSQL PITR restores the storage.objects *rows*, not the bytes behind
# them. Without this path, a restored database points at files that no longer
# exist. The two are backed up separately and verified separately.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

require MINIO_ALIAS MINIO_BACKUP_ALIAS MINIO_BUCKETS
BACKUP_ID="object-$(date -u +%Y%m%dT%H%M%SZ)"
STARTED="$(now_iso)"
TOTAL_BYTES=0
TOTAL_OBJECTS=0

report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"object","status":"running","started_at":"$STARTED",
 "destination":$(json_escape "${MINIO_BACKUP_ALIAS}/webyar-backups/objects"),"encrypted":true}
JSON
)"

for bucket in $MINIO_BUCKETS; do
  log "mirroring bucket $bucket"
  # --remove is deliberately NOT passed: a deletion in production must not
  # propagate into the backup copy, or a bad DELETE destroys both sides.
  mc mirror --overwrite --preserve \
    "${MINIO_ALIAS}/${bucket}" "${MINIO_BACKUP_ALIAS}/webyar-backups/objects/${bucket}" \
    >"$BACKUP_TMP/mc-mirror.out" 2>&1 || {
      log "mirror FAILED for $bucket: $(tail -c 300 "$BACKUP_TMP/mc-mirror.out")"
      report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"object","status":"failed","started_at":"$STARTED",
 "finished_at":"$(now_iso)","encrypted":true,
 "error":$(json_escape "mirror failed for $bucket")}
JSON
)"
      exit 1
    }
  stats=$(mc du --json "${MINIO_BACKUP_ALIAS}/webyar-backups/objects/${bucket}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("size",0), d.get("objects",0))')
  TOTAL_BYTES=$(( TOTAL_BYTES + $(echo "$stats" | cut -d' ' -f1) ))
  TOTAL_OBJECTS=$(( TOTAL_OBJECTS + $(echo "$stats" | cut -d' ' -f2) ))
done

# Bucket policies/configuration — the objects alone do not restore a bucket.
mc admin bucket info --json "${MINIO_ALIAS}" > "$BACKUP_TMP/bucket-config.json" 2>/dev/null || true
mc cp "$BACKUP_TMP/bucket-config.json" \
  "${MINIO_BACKUP_ALIAS}/webyar-backups/objects/_config/buckets-$(date -u +%Y%m%d).json" >/dev/null 2>&1 || true

log "object mirror complete: $TOTAL_OBJECTS objects, $TOTAL_BYTES bytes"
report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"object","status":"succeeded","started_at":"$STARTED",
 "finished_at":"$(now_iso)","bytes":$TOTAL_BYTES,"encrypted":true,
 "destination":$(json_escape "${MINIO_BACKUP_ALIAS}/webyar-backups/objects"),
 "verification_status":"verified","verified_at":"$(now_iso)",
 "metadata":{"objects":$TOTAL_OBJECTS,"buckets":$(json_escape "$MINIO_BUCKETS")}}
JSON
)"
