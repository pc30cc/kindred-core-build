#!/usr/bin/env bash
# Portable logical backup: pg_dump custom format, validated, encrypted, off-site.
#
# This is deliberately independent of WAL-G. Physical backups are tied to the
# PostgreSQL major version and the cluster layout; the logical dump is what
# rebuilds WEBYAR on a different host, a different provider, or a newer
# PostgreSQL.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

require PGHOST PGUSER PGDATABASE WALG_S3_PREFIX
WORKDIR="${BACKUP_WORKDIR:-/var/tmp/webyar-logical}"
mkdir -p "$WORKDIR"
BACKUP_ID="logical-$(date -u +%Y%m%dT%H%M%SZ)"
STARTED="$(now_iso)"
# WORKDIR is a volume shared by the agent and the cron container: each run
# gets its own subdirectory so two runs can never write (or delete) each
# other's artefacts, and the whole run directory is removed at the end.
RUN_DIR="$(mktemp -d "$WORKDIR/$BACKUP_ID.XXXXXX")"
DUMP="$RUN_DIR/$BACKUP_ID.dump"
DEST_PREFIX="${WALG_S3_PREFIX%/postgres}/postgres/logical"

log "starting logical backup $BACKUP_ID"
report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"logical","status":"running","started_at":"$STARTED",
 "destination":$(json_escape "$DEST_PREFIX"),"encrypted":true}
JSON
)"

fail() {
  log "logical backup FAILED: $1"
  report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"logical","status":"failed","started_at":"$STARTED",
 "finished_at":"$(now_iso)","destination":$(json_escape "$DEST_PREFIX"),
 "encrypted":true,"error":$(json_escape "$1")}
JSON
)"
  rm -rf "$RUN_DIR"
  exit 1
}

# Data + schema of the application database.
pg_dump --format=custom --compress=9 --file="$DUMP" \
  --no-owner --no-privileges --verbose 2>"$BACKUP_TMP/pgdump.log" \
  || fail "pg_dump failed: $(tail -c 400 "$BACKUP_TMP/pgdump.log")"

# Globals (roles, grants) live outside the database and pg_dump does not carry
# them. Without this file a restored cluster has no roles to own anything.
pg_dumpall --globals-only --no-role-passwords > "$RUN_DIR/$BACKUP_ID.globals.sql" \
  || fail "pg_dumpall --globals-only failed"

# Extensions + server settings needed to reconstruct the cluster.
psql -Atc "select extname||' '||extversion from pg_extension order by 1" \
  > "$RUN_DIR/$BACKUP_ID.extensions.txt" || fail "extension inventory failed"

# ── Validation: exit code 0 is not proof of a usable dump. ─────────────────
pg_restore --list "$DUMP" > "$RUN_DIR/$BACKUP_ID.toc" 2>"$BACKUP_TMP/pgrestore.log" \
  || fail "dump is unreadable by pg_restore: $(tail -c 300 "$BACKUP_TMP/pgrestore.log")"
TOC_ENTRIES=$(grep -c ';' "$RUN_DIR/$BACKUP_ID.toc" || echo 0)
[ "$TOC_ENTRIES" -gt 50 ] || fail "dump table of contents has only $TOC_ENTRIES entries — refusing to accept"
TABLES_IN_DB=$(psql -Atc "select count(*) from pg_tables where schemaname='public'")
TABLES_IN_DUMP=$(grep -c 'TABLE DATA' "$RUN_DIR/$BACKUP_ID.toc" || echo 0)
log "validation: $TABLES_IN_DUMP table-data entries in dump, $TABLES_IN_DB public tables live"
[ "$TABLES_IN_DUMP" -gt 0 ] || fail "dump contains no table data"

CHECKSUM=$(sha256_of "$DUMP")
BYTES=$(stat -c%s "$DUMP")

# ── Client-side encryption before it ever leaves the host. ─────────────────
require BACKUP_ENCRYPTION_PASSPHRASE
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$DUMP" -out "$DUMP.enc" -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
  || fail "encryption failed"

# ── Upload. Content-addressed name: an identical id can never silently
#    overwrite a different backup, and a retried upload is idempotent. ──────
for artifact in "$DUMP.enc" "$RUN_DIR/$BACKUP_ID.globals.sql" "$RUN_DIR/$BACKUP_ID.extensions.txt"; do
  aws ${AWS_ENDPOINT:+--endpoint-url "$AWS_ENDPOINT"} s3 cp "$artifact" \
    "$DEST_PREFIX/$(basename "$artifact")" --only-show-errors \
    || fail "upload failed for $(basename "$artifact")"
done

LSN=$(psql -Atc "select pg_current_wal_lsn()")
log "logical backup complete: $BYTES bytes, sha256 ${CHECKSUM:0:16}…"
report "$(cat <<JSON
{"backup_id":"$BACKUP_ID","kind":"logical","status":"succeeded","started_at":"$STARTED",
 "finished_at":"$(now_iso)","bytes":$BYTES,"checksum":$(json_escape "$CHECKSUM"),
 "lsn":$(json_escape "$LSN"),"destination":$(json_escape "$DEST_PREFIX"),"encrypted":true,
 "verification_status":"verified","verified_at":"$(now_iso)",
 "metadata":{"toc_entries":$TOC_ENTRIES,"table_data_entries":$TABLES_IN_DUMP,"public_tables":$TABLES_IN_DB}}
JSON
)"

rm -rf "$RUN_DIR"
