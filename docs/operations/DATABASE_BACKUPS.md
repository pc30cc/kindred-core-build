# Database backups (Super Admin → Database → Backup)

The Backup tab of `/admin/database` makes real backups of the database the
backend runs on. Until 2026-10-07 that tab was a mock (a two-second wait, settings
that were never saved, sample history); this page describes the real one.

Code: `server/services/backup/databaseBackup.ts` (runs, destinations, scheduler),
`databaseBackupSettings.ts` (settings, schedule rule), `backupCrypto.ts`,
`ftpClient.ts`; routes under `/api/admin/database/backups` in
`server/routes/adminDatabase.ts` (platform admin only); page
`src/components/admin/database/DatabaseBackupsSection.tsx`.

## What a backup is

1. `pg_dump --format=custom --compress=6` of the whole database, written to a
   private temp directory. The password reaches pg_dump only through `PGPASSWORD`
   in its environment, never its command line.
2. `pg_restore --list` and then `pg_restore --file=/dev/null` read the archive back
   completely (table of contents and every data block). Only an archive that reads
   back is recorded as a backup, with its sha256 and `verification_status=verified`.
3. The archive is kept on one destination:
   - **This server** (`local`): `BACKUP_LOCAL_DIR`, default `/app/data/backups/database`,
     file mode 0600. Not encrypted: it sits next to the database it copies.
   - **A storage provider** (`storage`): any vendor of the storage pool except `local`,
     under `backups/database/<id>.dump.enc`.
   - **FTP / FTPS** (`ftp`): the operator's server; explicit FTPS (AUTH TLS, protected
     data channel, TLS session reuse) is the default, plain FTP is allowed.
   Off-server copies are encrypted with AES-256-GCM under a per-file key derived
   (HKDF-SHA256, random salt) from `PLUGIN_SECRETS_MASTER_KEY`. File layout:
   `"WYDBK001" | salt(16) | nonce(12) | ciphertext | tag(16)`.
4. The run is a `backup_runs` row, kind `logical`, `metadata.source = database_backup`,
   with a credential-free destination (`file://…`, `s3://bucket/key`,
   `bunny://zone/key`, `ftps://host:port/dir/file`). The backup-health panel already
   reads these rows; `bunny`, `ftp` and `ftps` count as off-site there.

Download (history row → ⤓) always returns the plain `.dump`: the server fetches an
off-server copy, checks its sha256, decrypts it and checks the archive's sha256
again before sending it.

## Settings

Stored in `app_runtime_config` under `database_backup_settings`:
schedule on/off, daily / weekly / monthly, hour (UTC), destination, storage vendor,
FTP host / port / user / folder / FTPS / certificate check, retention days.
The FTP password is stored only as an encrypted envelope (`PLUGIN_SECRETS_MASTER_KEY`)
and is never sent back to the browser; leaving the field blank keeps it.

**Schedule.** The backend checks every 5 minutes. The first run is the first slot at the
chosen hour after the schedule was switched on; after that, one interval after the
previous scheduled attempt (successful or not), at the chosen hour. A run is never
repeated within one slot. If a backup cannot even start (no pg_dump, FTP not set),
one failed run is recorded for the slot, so the history shows why.
`DATABASE_BACKUP_SCHEDULER=off` disables the scheduler on an instance.

**One at a time.** A lease in `app_runtime_config` (`database_backup_lock`), renewed
every minute while a backup runs, so a crashed backup frees it within 5 minutes; a row
left `running` by a stopped server is closed as `interrupted`.

**Retention.** After each successful backup, files of successful backups older than the
retention window are deleted from their destination. The newest backup is always kept,
and the history row stays (marked removed). A backup on a destination that can no longer
be reached (another FTP login, a vendor taken out of the pool) is left alone.

## Environment (backend only)

| Variable | Meaning |
| --- | --- |
| `BACKUP_DATABASE_URL` | Login pg_dump uses. Without it, `DATABASE_URL` with `--role=$DATABASE_ROLE` (default `service_role`). |
| `BACKUP_DATABASE_ROLE` | Optional `--role` for `BACKUP_DATABASE_URL`. |
| `BACKUP_LOCAL_DIR` | Local backup folder (default `<cwd>/data/backups/database`). |
| `PLUGIN_SECRETS_MASTER_KEY` | Encrypts off-server copies and the FTP password. Never change it: older backups become unreadable. |
| `BACKUP_PG_DUMP_TIMEOUT_MS` | pg_dump / read-back limit (default 60 min). |
| `BACKUP_MAX_REMOTE_MB` | Largest off-server copy (default 2048; it passes through memory). |
| `PG_DUMP_PATH`, `PG_RESTORE_PATH` | Tool paths (default from `PATH`; `Dockerfile.server` installs `postgresql17-client`). |
| `DATABASE_BACKUP_SCHEDULER=off` | No scheduled backups on this instance. |

## Production (set up 2026-10-07)

- Login role `webyar_backup` on `webyar-postgres`: `LOGIN BYPASSRLS`, member of
  `pg_read_all_data`, `default_transaction_read_only = on`, connection limit 3.
  Verified: reads every table (including one `service_role` cannot), refuses writes.
  Its password is in the root-only kit `/root/webyar-rollout/20261007-dbbackup/`.
- App 29 (backend; app 25 since the move to `vps-50cc1602` on 2026-10-07): `BACKUP_DATABASE_URL` (runtime only) points at that role and
  database `webyar`; a bind volume `/data/webyar/db-backups` → `/app/data/backups`
  keeps local backups across deploys. Both apply from the first deploy after they
  were added.
- Local backups live on the same disk as the database. For a copy that survives the
  server, choose a storage provider or FTP.
- Coolify's own daily dump (02:13 UTC, 14 kept on the server) continues independently.

## The schema `billing_v2_archive` (migrations 267 and 268)

Billing v2's records are kept in their own schema, `billing_v2_archive`: 267
created it with the log of the move into simple billing (`migration_log`),
and 268 moved the 28 v2 tables there intact (invoices, payments, wallets,
periods, …) with the retired email templates
(`docs/billing/SIMPLE_BILLING.md`, "Phase 7B"). No application role can read
it: `PUBLIC`, `anon`, `authenticated` and `service_role` have no access, and
row level security is on with no policy.

A full `pg_dump` must read it, so the backup login matters:

- **`webyar_backup`** (production's `BACKUP_DATABASE_URL`) reads it. On
  WebYar it is a member of `pg_read_all_data` with `BYPASSRLS`, which covers
  every schema already, so 268 grants it nothing. On a database where the
  role exists without `pg_read_all_data`, 268 grants it `USAGE` on the schema
  and `SELECT` on its tables; it also needs `BYPASSRLS` (pg_dump refuses a
  table whose rows RLS would filter). A table added to the archive later
  needs the same grant again.
- **`service_role`** (the fallback when `BACKUP_DATABASE_URL` is unset)
  cannot read it, so the backup fails with a `permission denied` error that
  names the archive or one of its tables. That has been true since 267 created
  `migration_log`. Set `BACKUP_DATABASE_URL` to a login like `webyar_backup`.
- **RESPOK** (`respok-postgres`): 268 grants only `webyar_backup`, and only
  when that role exists. Check which login RESPOK's backend uses for backups
  (its `BACKUP_DATABASE_URL`) and that it can read the archive
  (`SELECT has_schema_privilege('<role>', 'billing_v2_archive', 'USAGE')`, or
  membership of `pg_read_all_data`), then run Super Admin → Database → Backup
  once after 268.

Coolify's daily dump runs as `postgres` and includes the schema. A restore
(below) brings the archive back with the rest; the roles it names must exist,
as for every other schema.

## Restore

A backup is restored by an operator, never from the web page.

1. Get the `.dump`: download it from the history (already decrypted), or take the file
   from the destination. An `.enc` file is decrypted offline with the deployment's key:

   ```sh
   PLUGIN_SECRETS_MASTER_KEY=… node scripts/db/decrypt-backup.mjs <id>.dump.enc <id>.dump
   ```

   A wrong key or a damaged file leaves no output behind.
2. Look at it: `pg_restore --list <id>.dump | head`.
3. Restore into an empty database on a server that has the roles the dump refers to
   (`anon`, `authenticated`, `service_role`, `webyar_app`, … — owners, grants and
   policies name them) and the extensions (pgvector):

   ```sh
   createdb restored
   pg_restore --exit-on-error -d restored <id>.dump
   ```

4. To put it into production, follow the switch and rollback steps in
   `PRODUCTION_DATABASE_MODE.md` (stop the writers, point `DATABASE_URL` at the
   restored database, deploy through Coolify's queue).

**Drill (2026-10-07).** A backup made by this feature from `webyar_staging` was restored
into an empty `pgvector/pgvector:pg17` with `--exit-on-error`: no error, 317 tables with
identical exact row counts, and the same 808 functions, 385 policies, 139 triggers and
1000 indexes as the source. The same run sent backups over FTPS (vsftpd,
`require_ssl_reuse=YES`) and plain FTP, downloaded and checked them, deleted one remotely,
and checked retention, the scheduler, a refused login (no password in the recorded error)
and a refused certificate.

## Troubleshooting

The page translates every error code; the history row shows the code and pg_dump's or the
FTP server's own message, with credentials removed.

- `pg_dump_unavailable`: the running image predates `postgresql17-client`; redeploy.
- `pg_dump_failed: … password authentication failed`: `BACKUP_DATABASE_URL` is wrong.
- `pg_dump_failed: … permission denied for table …` (or `for schema billing_v2_archive`): the login cannot read everything;
  use the `webyar_backup` role above, not `service_role`.
- `ftp_tls_refused` / `ftp_tls_failed`: the FTP server has no FTPS, or its certificate
  is not trusted (turn off "verify certificate" only for a server you control).
- `ftp_credentials_changed`: the backup was sent with other FTP settings; put them back
  to download or delete it, or remove the row from the history only.
- `backup_decrypt_failed`: `PLUGIN_SECRETS_MASTER_KEY` differs from the one the backup
  was made with.
