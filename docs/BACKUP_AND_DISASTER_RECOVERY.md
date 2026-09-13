# Backup and disaster recovery

## Acceptance status

**NOT READY — RECOVERY SYSTEM INCOMPLETE**

The registry and operational scripts are scaffolding, not a tested recovery system.
All scripts sourcing `ops/backup/lib.sh` deliberately exit before performing work.
Do not remove that interlock until the issues below are resolved and reviewed.
No production restore, backup expiry, destructive retention, or legacy-table removal is authorized by this document.

## Evidence and limits

The earlier database audit reported PostgreSQL 17.6, approximately 50 MB,
archive_mode=on, wal_level=logical, archive_timeout=120s, wal_compression=zstd,
max_wal_senders=5, checkpoint_timeout=300s, checksums and full_page_writes enabled.
The archive command was `/usr/bin/admin-mgr wal-push %p`.
These observations do not prove repository access, continuous recoverability, or
that the connected database is the intended self-hosted production deployment.
The actual Docker service, volume, Coolify jobs, remote repository, encryption,
backup retention and MinIO deployment remain unverified.

## Intended architecture

Use one physical/PITR tool. Retain the existing WAL-G infrastructure if its
ownership and recovery access are confirmed; do not install a competing archiver.
Maintain independent logical exports and versioned object backups off-server.
Targets: RPO <=15 minutes; database RTO <=60 minutes where practical.
Neither target has been measured or guaranteed.

## Blocking corrections before deployment

- Verify the actual host and repository with the operator; an S3 URI alone is not proof of off-server storage.
- Replace the placeholder container image and network with tested, version-pinned infrastructure matching Supabase extensions.
- Remove automatic backup deletion from the draft base-backup flow. Establish one dependency-aware retention policy; generic bucket expiry must not sever WAL chains.
- Correct catalogue parsing and consistent backup IDs. Verify encryption rather than hardcoding it.
- Encrypt all logical artifacts, preserve required grants/roles, validate by isolated restoration, and compare a consistent manifest.
- Remove fallback verification that confuses WAL integrity with base-backup verification.
- Require versioning/immutability before object overwrite; verify bytes and bucket configuration with a real object restore.
- Replace destructive restore-directory deletion with canonical-path, empty-target and ownership checks.
- Isolate recovery networking, disable all database schedulers and external side effects, supply WAL-G and exact extensions, and wait for recovery target completion rather than readiness alone.
- Create any production drill markers only through an approved forward migration. Select a base backup preceding the target; do not blindly fetch LATEST.
- Finish diagnostics translations, navigation, alert integration and evidence-based health calculations.

## Proposed schedules and retention (not deployed)

Continuous WAL; daily physical and logical backups; daily object backup.
Plan for seven daily, four weekly and six monthly recoverable copies, subject to
measured cost and tool-supported dependency retention. Expiration remains disabled.
Archive continuity must span the whole advertised PITR window.

## Secure reconstruction inventory

The operator must escrow encrypted stack configuration separately from production:
JWT secret, anon/service keys, Auth/SMTP/OAuth settings, Kong and Supabase config,
storage/MinIO settings and credentials, environment variables, mounted scripts,
and any existing function deployment artifacts. Record escrow location and restore
access procedures, never plaintext values. No escrow location has yet been verified.

## Required recovery procedure

1. Provision a separate compatible recovery host; block outbound side effects and application workers.
2. Fetch a verified base backup from the remote repository, record its identity and checksum.
3. Restore and replay WAL; for PITR select a base before the target and set an explicit UTC target.
4. Prove A/B present and C absent for a controlled marker experiment; record target and actual results.
5. Compare schemas, extensions, row manifests, constraints, indexes, RLS behavior, workspace isolation, billing, auth, canonical SEO, partition parents/children/bounds and routing.
6. Restore versioned objects consistently with database metadata and verify object bytes.
7. Measure elapsed restoration time and recovered endpoint. Keep the original host untouched.
8. Only after operator approval, fence writes and switch the application to the recovered environment. Rollback requires preventing divergent writes, not blindly reverting a connection string.

The current validation SQL is preliminary; it does not prove row-count equality,
RLS enforcement, ledger integrity or complete partition recovery.

## Monitoring acceptance

Require alerts for stale/missing/failed backups, archive failures and continuity gaps,
unreachable destinations, checksum failure, capacity, retention errors and overdue
restore drills. A metadata report alone must not establish verification or off-site status.

## Test evidence

Previous reported baseline: **4,817 passed / 89 failed**.
Current complete suite and recovery-specific tests have not been run in this continuation.
New unrelated failures: **unknown**, not zero.
Full production-backup restore: not executed. PITR experiment: not executed.
Object restore: not executed. Actual RPO/RTO: not measured.
Destructive data retention remains outside this phase and must stay disabled.