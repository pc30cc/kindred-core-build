#!/usr/bin/env bash
# Test A — full restore of the newest valid backup into an isolated container.
#
# Never runs against production: refuse_production() blocks the production data
# directory, and the recovery container is started with every external side
# effect disabled (no SMTP, no payment callbacks, no channel workers, no cron).
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

RESTORE_DIR="${RESTORE_DIR:-/var/tmp/webyar-restore-drill}"
RESTORE_PORT="${RESTORE_PORT:-55432}"
CONTAINER="webyar-restore-drill"
refuse_production "$RESTORE_DIR"

STARTED="$(now_iso)"
rm -rf "$RESTORE_DIR"; mkdir -p "$RESTORE_DIR"

log "fetching newest base backup into $RESTORE_DIR"
wal-g backup-fetch "$RESTORE_DIR" LATEST || die "backup-fetch failed"

# Recovery configuration. restore_command replays archived WAL; the isolated
# instance is promoted once it has caught up.
cat >> "$RESTORE_DIR/postgresql.conf" <<'CONF'
restore_command = 'wal-g wal-fetch "%f" "%p"'
recovery_target_timeline = 'latest'
# Side-effect isolation for the recovery environment:
archive_mode = off
cron.database_name = ''
CONF
touch "$RESTORE_DIR/recovery.signal"
chmod 700 "$RESTORE_DIR"

log "starting isolated PostgreSQL (no network)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# `--network none`: the restored copy has no network at all, so nothing in it
# can reach SMTP, payment callbacks, channel providers or production. With no
# network a published port would be unreachable too, so every check below
# runs inside the container through `docker exec` instead of over TCP.
# (RESTORE_PORT is kept for configuration compatibility but no longer used.)
docker run -d --name "$CONTAINER" --network none \
  -v "$RESTORE_DIR:/var/lib/postgresql/data" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17 >/dev/null || die "failed to start recovery container"

for _ in $(seq 1 120); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || die "recovery instance never became ready"

log "running post-restore validation"
FINDINGS=$(docker exec -i "$CONTAINER" psql -U postgres -d postgres -Atq < ./validate-restore.sql)
log "$FINDINGS"

FAILS=$(echo "$FINDINGS" | grep -c '^FAIL' || true)
STATUS=$([ "$FAILS" -eq 0 ] && echo passed || echo failed)

report_drill "$(cat <<JSON
{"drill_kind":"full_restore","environment":"isolated-container:${CONTAINER}",
 "source_backup_id":"LATEST","status":"$STATUS","finished_at":"$(now_iso)",
 "findings":{"checks":$(json_escape "$FINDINGS"),"failed_checks":$FAILS},
 "notes":"Test A — newest base backup restored into an isolated instance, started $STARTED"}
JSON
)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
[ "$STATUS" = passed ] || die "restore drill FAILED with $FAILS failing checks"
log "restore drill PASSED"
