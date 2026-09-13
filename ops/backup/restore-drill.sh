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

log "starting isolated PostgreSQL on port $RESTORE_PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --network none-or-isolated \
  -v "$RESTORE_DIR:/var/lib/postgresql/data" \
  -p "127.0.0.1:${RESTORE_PORT}:5432" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17 >/dev/null || die "failed to start recovery container"

for _ in $(seq 1 120); do
  pg_isready -h 127.0.0.1 -p "$RESTORE_PORT" >/dev/null 2>&1 && break
  sleep 2
done
pg_isready -h 127.0.0.1 -p "$RESTORE_PORT" >/dev/null 2>&1 || die "recovery instance never became ready"

export PGHOST=127.0.0.1 PGPORT="$RESTORE_PORT" PGUSER=postgres PGDATABASE=postgres
unset PGPASSWORD

log "running post-restore validation"
FINDINGS=$(psql -Atq -f ./validate-restore.sql)
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
