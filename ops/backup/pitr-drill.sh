#!/usr/bin/env bash
# Test B — point-in-time recovery proof with marker transactions.
#
#   T0  insert marker A
#   T1  insert marker B          <- recovery target lands here
#   T2  insert marker C
#
# Restore to a timestamp between T1 and T2 and assert A and B exist while C
# does not. A WAL archive full of files is not proof of PITR; this is.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

RESTORE_DIR="${RESTORE_DIR:-/var/tmp/webyar-pitr-drill}"
RESTORE_PORT="${RESTORE_PORT:-55433}"
CONTAINER="webyar-pitr-drill"
MARKER_TABLE="public.backup_pitr_markers"
refuse_production "$RESTORE_DIR"

log "creating marker table on production (append-only, drill use)"
psql -q -c "create table if not exists $MARKER_TABLE (
  marker text primary key, drill_id text not null, written_at timestamptz not null default now())"

DRILL_ID="pitr-$(date -u +%Y%m%dT%H%M%SZ)"

psql -q -c "insert into $MARKER_TABLE(marker, drill_id) values ('A-$DRILL_ID', '$DRILL_ID')"
psql -q -c "select pg_switch_wal()" >/dev/null
sleep 2
psql -q -c "insert into $MARKER_TABLE(marker, drill_id) values ('B-$DRILL_ID', '$DRILL_ID')"
T_AFTER_B=$(psql -Atc "select now()")
psql -q -c "select pg_switch_wal()" >/dev/null

# Gap so the recovery target is unambiguously between B and C.
sleep 5
psql -q -c "insert into $MARKER_TABLE(marker, drill_id) values ('C-$DRILL_ID', '$DRILL_ID')"
psql -q -c "select pg_switch_wal()" >/dev/null
# Recovery cannot pass a target it has no archived WAL for.
sleep "${PITR_ARCHIVE_WAIT:-130}"

TARGET_TIME=$(psql -Atc "select (timestamptz '$T_AFTER_B' + interval '1 second')::text")
log "recovery target: $TARGET_TIME (between B and C)"

rm -rf "$RESTORE_DIR"; mkdir -p "$RESTORE_DIR"
wal-g backup-fetch "$RESTORE_DIR" LATEST || die "backup-fetch failed"

cat >> "$RESTORE_DIR/postgresql.conf" <<CONF
restore_command = 'wal-g wal-fetch "%f" "%p"'
recovery_target_time = '$TARGET_TIME'
recovery_target_action = 'promote'
recovery_target_inclusive = on
archive_mode = off
CONF
touch "$RESTORE_DIR/recovery.signal"
chmod 700 "$RESTORE_DIR"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -v "$RESTORE_DIR:/var/lib/postgresql/data" \
  -p "127.0.0.1:${RESTORE_PORT}:5432" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17 >/dev/null || die "failed to start PITR container"

for _ in $(seq 1 180); do
  pg_isready -h 127.0.0.1 -p "$RESTORE_PORT" >/dev/null 2>&1 && break
  sleep 2
done

export PGHOST=127.0.0.1 PGPORT="$RESTORE_PORT" PGUSER=postgres PGDATABASE=postgres
unset PGPASSWORD

HAS_A=$(psql -Atc "select count(*) from $MARKER_TABLE where marker='A-$DRILL_ID'")
HAS_B=$(psql -Atc "select count(*) from $MARKER_TABLE where marker='B-$DRILL_ID'")
HAS_C=$(psql -Atc "select count(*) from $MARKER_TABLE where marker='C-$DRILL_ID'")
log "marker A=$HAS_A  B=$HAS_B  C=$HAS_C  (expected 1 / 1 / 0)"

STATUS=failed
if [ "$HAS_A" = "1" ] && [ "$HAS_B" = "1" ] && [ "$HAS_C" = "0" ]; then STATUS=passed; fi

report_drill "$(cat <<JSON
{"drill_kind":"pitr","environment":"isolated-container:${CONTAINER}",
 "source_backup_id":"LATEST","target_time":$(json_escape "$TARGET_TIME"),
 "status":"$STATUS","finished_at":"$(now_iso)",
 "findings":{"marker_a":$HAS_A,"marker_b":$HAS_B,"marker_c":$HAS_C,
             "expected":{"marker_a":1,"marker_b":1,"marker_c":0},"drill_id":$(json_escape "$DRILL_ID")},
 "notes":"Test B — recovery_target_time between marker B and marker C"}
JSON
)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
[ "$STATUS" = passed ] || die "PITR drill FAILED (A=$HAS_A B=$HAS_B C=$HAS_C)"
log "PITR drill PASSED"
