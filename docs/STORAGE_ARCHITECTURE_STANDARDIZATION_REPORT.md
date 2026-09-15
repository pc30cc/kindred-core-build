# Storage Architecture Standardization — Final Report

Branch: `claude/storage-architecture-standardization-gtzt6p`
Status: **Original 8 phases + two corrective passes complete.** The first version of this report claimed the Definition of Done was met; an independent review found real multi-provider correctness gaps, fixed in the first corrective pass (§2). A second independent review then found the deletion machinery itself was still unsafe under multi-instance/production conditions (lease expiry with no fencing, an incomplete write barrier, single-provider user deletion, unchecked business-level RPC failures, and no protection against a storage config changing mid-cleanup) — fixed in the second corrective pass, §7. **This document reflects the current, honest status** — see §3 for the first pass's Definition-of-Done table and §8 for the second pass's, §4/§9 for what still isn't covered.

## 0. Why this report was rewritten

The original report's central mistake: it treated "every workspace object lives under `workspace/<id>/...`" (true, an object-key invariant) as if it meant "every workspace object lives in the same physical storage provider" (false). A workspace can have up to **three separate physical storage accounts**: its ordinary attachment provider, LiveKit's own `recording_storage` account, and privacy export's own policy-resolved account. The workspace deletion worker, the consistency audit, and several recording read/delete paths all assumed a single provider and were quietly wrong for any workspace where LiveKit or privacy storage pointed somewhere else — LiveKit recordings in particular were never actually deletable by the deletion worker or the retention janitor in that configuration, and would have been misreported as "dangling" by the audit. Self-host also could not complete a workspace deletion at all (`admin_delete_workspace` didn't exist there). None of this was caught by the original test suite because every test used a single mocked provider for everything.

## Commits (in order)

Original 8 phases: see the commit hashes already on this branch (`657d264` through `68955cd`) — unchanged, not re-listed here. Corrective pass commits are listed at the end of this document once pushed.

## 1. What was built — original 8 phases (unchanged, still accurate)

### Ownership model & key builder (`server/services/storage/keys.ts`)
Three namespaces, one discriminated `StorageOwner` type (`workspace | user | platform`), and a single key-builder module every producer is expected to use. All legacy pre-canonicalization shapes are named, exported regexes — one source of truth consumed by both enforcement (`index.ts`) and the migration tool (`legacyMigration/categories.ts`).

### Service-layer enforcement (`server/services/storage/index.ts`)
`enforceOwnerScope()` runs inside `uploadForOwner`/`downloadForOwner`/`deleteForOwner`/`getFileUrlForOwner`/`listForOwner` themselves. Fails closed on any mismatch.

### Producers migrated to the canonical model
Email attachments, account avatar, privacy exports, LiveKit call recordings — see the original phase commits for detail, all still accurate.

### DB integrity, quota/category policy, legacy migration tooling, workspace deletion lifecycle (v1), observability
Still accurate as originally built; the corrective pass below replaces the workspace deletion worker's internals and the consistency audit's internals with provider-aware versions, and adds new pieces — it does not undo anything from the original 8 phases.

## 2. Corrective pass — what was actually wrong, and what changed

### P0 — Multi-provider workspace deletion (FIXED)
**Was**: the deletion worker called `listForOwner(workspace)` — one provider, the ordinary attachment one. LiveKit recordings and privacy exports living in a different physical account were never scanned or deleted.
**Now**: `server/services/storage/workspaceScopes.ts` defines `workspaceStorageScopes()` — one `WorkspaceStorageScope` per physical scope (`attachment`, `privacy_export`, `livekit_recording`), each independently resolved. `server/services/workspaceDeletion/worker.ts` was rewritten to walk every scope, persisting per-scope progress (`storage_scopes` JSONB: status/cursor/counts) so the job is resumable and never redoes a completed scope. Two scopes that resolve to the **same** physical `StorageConfig` (fingerprint match via `storageConfigFingerprint()`) are deduplicated — listed/deleted once, not twice. `db_cleanup` is only reached once every scope is `done` or `skipped_not_configured`. Tests: `src/test/storage/workspaceDeletionWorker.test.ts` (rewritten again in the second corrective pass for lease fencing — see §10 for its final 18-test count) — multi-scope walk across ticks, dedup, resumability, unconfigured-scope handling, mid-cleanup deconfiguration, retry/backoff, terminal failure, workspace/-prefix-only guarantee.

### P0 — LiveKit read/delete provider routing (FIXED)
**Was**: recording playback, the retention janitor, and the admin recording download/delete/archive routes all called `downloadFile`/`downloadFileRange`/`deleteFile` scoped to the workspace's ordinary attachment provider — the wrong bucket for a LiveKit-only recording account.
**Now**: `server/services/calls/recordingStorageResolver.ts` is the one canonical resolver (`resolveRecordingStorageConfig()`, mapping `livekit_config.recording_storage`) — every consumer rewired to it: `recordingPlayback.ts` (playback + ranged reads), `retentionJanitor.ts` (retention deletion), `adminCalls.ts` (admin download/delete), `callCenter.ts` (both recording-archive routes), `legacyMigration/categories.ts` (migration), `workspaceDeletion/worker.ts` (via `workspaceScopes.ts`), `consistencyAudit.ts` (see below). **Recording creation was already correct** — `livekitProvider.ts`'s `startRecording()` always instructed LiveKit Egress via `cfg.recording_storage` directly; it never went through the workspace attachment resolver, so there was nothing to fix there. Explicit Provider-A/Provider-B regression tests: `src/test/storage/livekitProviderRouting.test.ts` (retention deletion, resolver isolation) plus dedicated multi-provider tests in `workspaceDeletionWorker.test.ts` and `consistencyAudit.test.ts`.

### P0 — Privacy multi-provider audit/deletion (FIXED)
Same fix as above, for the `privacy_export` scope: `workspaceScopes.ts`'s `privacy_export` entry resolves through `resolvePrivacyStoragePolicy()` (unchanged resolver, just now actually wired into deletion and audit), never the ordinary workspace resolver.

### P0 — Atomic deletion enqueue (FIXED)
**Was**: `DELETE /workspaces/:id` did an UPDATE then an INSERT as two separate, non-atomic operations.
**Now**: `enqueue_workspace_deletion(_workspace_id, _actor_user_id)` (migration 181) — one `SECURITY DEFINER` function, `FOR UPDATE` row lock, active→deleting transition and job creation in the same transaction. `uq_workspace_deletion_jobs_active` (partial unique index on `workspace_id` where status is pending/storage_cleanup/db_cleanup) makes "one active job per workspace" a hard DB constraint, not just app-level idempotency — holds even under concurrent DELETE requests.

### P0 — Failed deletion recovery (FIXED)
Automatic bounded retry with exponential backoff (`attempt_count`/`next_retry_at`, `MAX_JOB_ATTEMPTS=5`, backoff 5s→30min) for transient failures — the job stays in its current status and resumes from stored `storage_scopes` progress, never restarting a completed scope. After exhausting retries the job becomes terminally `status='failed'`, visible via `GET .../deletion-status`. Manual recovery: `retry_workspace_deletion_job()` RPC + `POST /workspaces/:id/deletion-retry` route. The literal bug called out — `202 { started:false, job:null }` for a stuck workspace — is fixed: that state now returns `409` with a `retry_endpoint` hint.

### P0 — Upload deletion lock (FIXED)
`isWorkspaceDeleting()` (`server/services/storage/index.ts`) now fails **closed**: any DB error or thrown exception during the lookup blocks the upload (previously failed open). Regression tests in `src/test/storage/storageKeyEnforcement.test.ts`: a DB-lookup error rejects the upload; a 20-attempt race test where the workspace flips to `deleting` mid-loop shows every attempt before the flip succeeding and every attempt after it failing, with none landing after the flip.

### P0 — Self-host `admin_delete_workspace`/purge (FIXED)
`database/migrations/182_admin_purge_workspaces_selfhost.sql` ports the hosted `admin_purge_workspaces`/`admin_delete_workspace`/`admin_delete_user` function bodies to self-host verbatim (they are fully schema-introspecting via `information_schema`/`pg_constraint`, so no self-host-specific table list was needed). One deliberate deviation: the hosted originals get `PERFORM set_config('app.billing_purge','on',true)` injected by migration 155's dynamic DO-block; since 155 already ran (against functions that didn't exist yet) before this migration, that injection cannot retroactively patch a function defined later — so the ported functions call `set_config` explicitly themselves, reproducing exactly what 155's injection would have added. **Validated by actually running it**: applied against a local PostgreSQL 16 instance with a minimal schema (workspaces/profiles/user_roles/has_role + FK-linked child tables), confirmed `admin_delete_workspace` cascades through conversations→messages and email_attachments and hard-deletes the workspace row, and `admin_delete_user` cascades through owned workspaces and deletes the profile — both via the real SQL, not a mock.

### P1 — User deletion routes through workspace deletion machinery (FIXED)
**Was**: `DELETE /users/:userId` manually gathered storage pointers from three tables with a 5000-row cap, deleted them best-effort, then hard-deleted DB rows — no LiveKit/privacy provider awareness, no ordering guarantee between storage and DB cleanup, could orphan storage silently past the cap.
**Now**: `database/migrations/183_user_deletion_lifecycle.sql` + `server/services/userDeletion/worker.ts` — a new async job (`user_deletion_jobs`, same leased-claim/retry/backoff pattern as workspace deletion) that: (1) enqueues one `workspace_deletion_jobs` row per owned workspace via the **same** `enqueue_workspace_deletion` RPC — full multi-provider machinery reused, not reimplemented; (2) waits until every owned workspace is actually gone from `public.workspaces` (i.e. fully purged, storage and DB); (3) deletes the user's own **global** `users/<id>/...` storage (the account avatar) via `listForOwner`/`deleteForOwner`; (4) only then calls `admin_delete_user`. DB ownership rows are structurally never purged before storage cleanup completes — enforced by the state-machine order, not a best-effort guess. `DELETE /users/:userId` is now async (202 + job, matching the workspace pattern), with `GET/POST .../deletion-status` and `.../deletion-retry`. Tests: `src/test/storage/userDeletionWorker.test.ts` (rewritten again in the second corrective pass — see §10 for its final 22-test count, now also multi-provider).

### P1 — Workspace branding legacy migration (FIXED)
`account.ts` documented `branding/<workspaceId>/...` as pending; there was no canonical builder, no migration provider, and no DB column to migrate to (the field is a full URL, `workspace_branding.logo_url`, not a bare key). Added: `workspaceBrandingKey()` builder (`workspace/<id>/branding/<uuid>-<name>`); `account.ts`'s workspace-icon upload/delete routes now use `uploadForOwner`/`deleteForOwner` with the canonical key (which also means these uploads now correctly respect the workspace deletion write-lock, previously not applicable since they bypassed the owner-scoped path entirely); `database/migrations/184_workspace_branding_storage_key.sql` adds `workspace_branding.logo_storage_key` (bare-key sibling column, same pattern migration 177 used for `profiles.avatar_storage_key`); `workspaceBrandingMigrationProvider()` added to the legacy migration registry, parsing the legacy URL marker to recover the old key and committing to the new bare-key column. `LEGACY_BRANDING_PATTERN` is **not** removed — a legacy row only gets a bare key once actually migrated, so the pattern is still load-bearing for both reads and the migration tool's discovery query. Tests: 4 new cases in `src/test/storage/legacyMigrationCategories.test.ts`, 3 new cases in `consistencyAudit.test.ts`.

### P1 — Provider-aware consistency audit (FIXED)
**Was**: `auditWorkspaceStorage()` listed one provider and compared every DB pointer (including `call_recordings` and `privacy_jobs`, which never live there) against that single listing — a valid LiveKit recording or privacy export was **always** reported dangling, and every ordinary object was at risk of misreporting once a LiveKit/privacy key was checked against it too.
**Now**: rewritten to resolve and list each of the three scopes independently (same dedup-by-fingerprint as the deletion worker), and cross-reference each DB pointer source (`conversation_attachment`, `email_attachment` → attachment; `call_recording` → livekit_recording; `privacy_export` → privacy_export; `call_center_avatar`, `workspace_branding` → attachment) against **its own** scope's listing only. The report now carries a `scopes` breakdown (`{configured, objectCount, error?, dedupOf?}` per scope name) and `unreliableCategories` — a scope that fails to list or isn't configured excludes its categories from dangling/orphaned reporting instead of misreporting them as drift. `workspace_branding` is no longer `UNAUDITABLE_CATEGORIES` (removed that export entirely) now that 184 gives it a real DB column, with a fallback to parsing `logo_url` for legacy rows purely for `legacyShapeCounts`. Tests: `src/test/storage/consistencyAudit.test.ts`, rewritten, 16 tests — including the specific regression the corrective pass asked for: a LiveKit recording is verified against the LiveKit scope even when the attachment scope's listing is empty and unrelated, and is never reported orphaned or dangling because of that.

### P1 — Multi-worker-safe deletion job claiming (FIXED)
Both `claim_workspace_deletion_job()` (migration 181) and `claim_user_deletion_job()` (migration 183) use `FOR UPDATE SKIP LOCKED` plus a lease (`locked_by`/`lease_expires_at`) — any number of concurrent worker processes can poll the same table without double-processing a job, and a worker that crashes mid-tick self-heals once its lease expires (no separate stuck-job sweep needed). Concurrency proven directly in the migration-182 Postgres validation run (see above) and by the claim-related tests in both worker test suites (second claim attempt while a lease is held returns `null`).

## 3. Definition of Done — current, honest status

| Requirement | Status |
|---|---|
| Workspace deletion verified across multiple physical providers | ✅ — `workspaceDeletionWorker.test.ts`'s multi-scope tests use genuinely different `StorageConfig`s (different buckets) per scope and assert each is listed/deleted independently; migration 182 was validated against a real Postgres instance |
| LiveKit playback/retention use the actual recording provider | ✅ — both rewired to `resolveRecordingStorageConfig()`, regression-tested with a Provider-A/Provider-B setup in `livekitProviderRouting.test.ts` |
| Self-host workspace/user deletion fully functional | ✅ — `admin_delete_workspace`/`admin_delete_user`/`admin_purge_workspaces` now exist on both chains with functionally identical bodies (migration-parity-tested), validated by direct execution against Postgres |
| Atomic enqueue, DB-level one-active-job guarantee | ✅ both workspace and user deletion |
| Automatic + manual retry, no permanent wedge | ✅ both workspace and user deletion |
| Fail-closed upload lock during deletion | ✅ with a dedicated race test |
| Provider-aware consistency audit | ✅ no longer conflates providers; unreliable categories explicitly flagged rather than misreported |
| Workspace branding fully migrated | ✅ canonical builder, producer, migration provider, DB column, audit coverage all present; `LEGACY_BRANDING_PATTERN` correctly still registered (migration coverage existing, not proof every historical row has been migrated in any real deployment — this session cannot run the migration tool against production data) |
| Multi-worker-safe claiming | ✅ both job types |
| All original-8-phase items | unchanged from the original report — see that report's §3 for the full table (not reproduced here); nothing in the corrective pass regressed them |

**What is explicitly NOT claimed, because the code does not prove it:**
- That every legacy-shaped row in any real production/self-host database has actually been migrated. The migration tool (original Phase 6, extended this pass with the branding provider) can do this, but running it is an operational step outside this session — `legacyShapeCounts`/`UNAUDITABLE_CATEGORIES` removal only prove the *tooling and audit* now cover branding, not that a specific deployment's data is clean.
- That the consistency audit's three-scope model is exhaustive for every possible storage configuration ever added to this codebase — it covers the three scopes that exist today (`attachment`, `privacy_export`, `livekit_recording`); a future fourth physical storage integration would need its own scope entry the same way these three were added.
- That `gcs`/`azure_blob` providers work with any of the multi-provider deletion/audit machinery — `listHandlers` still excludes them (pre-existing gap, §4).

## 4. Known gaps — tracked, not fixed (deliberate scope decisions, corrective pass and earlier)

Gaps unrelated to the corrective pass are unchanged from the original report — see items on `internalChannels.ts`'s remaining pre-existing lint debt, `admin.ts`'s avatar-reset endpoint, `callCenter.ts`'s avatar/ringback ad-hoc key shapes, the three hosted-only `NOT VALID` CHECK constraints, no admin UI for async deletion status, BunnyCDN pagination, `gcs`/`azure_blob` listing exclusion, the `storage_objects` catalog table decision, and `stat()`/batch-delete primitives.

Corrective-pass-specific gaps:
1. **Legacy migration coverage is tooling-complete, not deployment-verified.** As stated in §3, this session cannot run `npm run storage:migrate-legacy` against a real production/self-host database. Every legacy shape this project knows about (email attachments, account avatars, privacy exports, LiveKit recordings, workspace branding) has a provider in `legacyMigration/categories.ts`, but "has a provider" is not the same claim as "zero legacy rows remain anywhere."
2. **The three physical scopes are hardcoded to today's feature set.** `workspaceStorageScopes()` returns exactly `attachment`/`privacy_export`/`livekit_recording`. A future feature that introduces a fourth physically-separate storage account (another third-party integration with its own bucket) will silently NOT be covered by workspace deletion or the consistency audit unless a developer remembers to add a scope entry — there is no structural guard that catches "a new storage-writing feature forgot to register its scope."
3. **User deletion's workspace-wait step polls, it does not push.** `checkWorkspaceDeletionsComplete()` re-checks `public.workspaces` every tick until every owned workspace is gone; for a user who owns many large workspaces, this could take several worker poll cycles (5s each) times however long each workspace's own deletion takes — correct, but not instant.
4. **`admin_purge_workspaces`'s dynamic table walk was validated structurally (a real, if minimal, Postgres schema), not against this repo's full production schema** — the self-host port (182) is a verbatim structural copy of the hosted version, which has run in that form in the hosted chain, so the risk surface is "did the port introduce a divergence" (checked: it did not, parity-tested) rather than "does the dynamic-SQL approach work at all" (already proven by the hosted original).

## 5. Migrations added (this project, all phases)

| # | Self-host | Hosted | Mirrored? |
|---|---|---|---|
| 177 | `177_profiles_avatar_storage_key.sql` | `20260915073000_...` | yes |
| 178 | `178_email_attachments_workspace_scope.sql` | `20260915090000_...` | yes |
| 179 | `179_profiles_avatar_storage_key_scope_check.sql` | `20260915090500_...` | yes |
| — | — | `20260915091000_call_recordings_workspace_scope.sql` | **hosted-only** (pre-existing gap) |
| — | — | `20260915091500_call_center_settings_avatar_scope.sql` | **hosted-only** (pre-existing gap) |
| — | — | `20260915092000_privacy_jobs_artifact_scope.sql` | **hosted-only** (pre-existing gap) |
| 180 | `180_workspace_deletion_lifecycle.sql` | `20260915093000_...` | yes |
| 181 | `181_workspace_deletion_multi_provider.sql` | `20260915094000_...` | yes |
| 182 | `182_admin_purge_workspaces_selfhost.sql` | *(none — hosted already had these functions since before this pass)* | **self-host-only, intentionally** |
| 183 | `183_user_deletion_lifecycle.sql` | `20260915095000_...` | yes |
| 184 | `184_workspace_branding_storage_key.sql` | `20260915100000_...` | yes |

All registered (or explicitly documented as intentionally unregistered, with the reason) in `src/test/integration/migrationMirrorParity.test.ts`. Migration 182 was additionally validated by direct execution against a live PostgreSQL 16 instance (not just parity-diffed against its hosted source).

## 6. Test coverage added this corrective pass

- `src/test/storage/workspaceDeletionWorker.test.ts` — rewritten (17 tests): multi-scope walk, dedup, resumability, retry/backoff, terminal failure, workspace/-only guarantee.
- `src/test/storage/userDeletionWorker.test.ts` — new (16 tests): collecting/awaiting/purging states, avatar cleanup pagination, idempotent-recovery, retry/backoff.
- `src/test/storage/consistencyAudit.test.ts` — rewritten (16 tests): per-scope drift classification, the LiveKit/privacy multi-provider regression tests, branding legacy-URL fallback, dedup.
- `src/test/storage/livekitProviderRouting.test.ts` — new (3 tests): explicit Provider-A/Provider-B isolation for the recording resolver and retention deletion.
- `src/test/storage/legacyMigrationCategories.test.ts` — extended (+4 tests): workspace branding provider.
- `src/test/storage/storageKeyEnforcement.test.ts` — extended (+2 tests): fail-closed lookup-error case, 20-attempt deletion race.
- `src/test/integration/migrationMirrorParity.test.ts` — extended (+3 pairs / 1 documented-intentional-non-pair): migrations 181/183/184 mirrored, 182 documented as self-host-only.
- `src/test/billing/operatorRecordingVisibility.test.ts` — updated mocks for the new `resolveRecordingStorageConfig`-based archive routes (this test's existing 18 cases now correctly reflect the fixed routing instead of masking it with a stale mock).

Full targeted suite (`src/test/storage/`, `src/test/billing/{operatorRecordingVisibility,recordingStartRoutes,recordingStorageProvider}.test.ts`, `src/test/integration/migrationMirrorParity.test.ts`) — 246 tests, all passing. `npm run typecheck` and `npm run typecheck:server` both clean except one pre-existing, unrelated error in `server/routes/backupAgent.ts` (confirmed present before this session's work began). `node scripts/lint-changed.mjs` (the repo's full-file-clean-on-touch gate, comparing against the base branch): **`OK — 0 errors, 0 warnings across 51 changed files`** — includes `server/routes/internalChannels.ts` and `src/test/billing/operatorRecordingVisibility.test.ts`, both pre-existing `any`-typed debt in files this pass touched, cleaned up mechanically (types only, zero behavior change, independently verified) as part of closing this pass out.

A broader `src/test/security` sweep surfaced several failing suites (`widgetSessionLineageAndCoverage.test.ts`, `emailVerificationPolicy.test.ts`, `billingRouteSecurity.test.ts`) — confirmed pre-existing and unrelated: they fail identically with this branch's changes fully stashed out, touch none of the files this project modified (widget session rate-limiting, workspace provisioning, billing v2 rollout), and reference Supabase query-builder methods (`.order()`, `.upsert()`) unrelated to storage.

## 7. Second corrective pass — lease fencing, complete write barrier, multi-provider user deletion, config drift

An independent review of the first corrective pass found the deletion machinery itself was not safe to run with more than one worker process under real production timing: leases could expire mid-work with no real fencing, the write barrier didn't cover every workspace-owned producer, user deletion assumed a single storage provider, a business-level RPC failure could be silently ignored, and nothing detected a storage provider changing configuration mid-cleanup. This section documents exactly how each is fixed, per the review's explicit request.

### How fencing works

`database/migrations/185_deletion_lease_fencing.sql` adds a `lease_token uuid` column to both `workspace_deletion_jobs` and `user_deletion_jobs`. `claim_workspace_deletion_job()`/`claim_user_deletion_job()` mint a **fresh random token on every successful claim** — including a reclaim of an expired lease. Every progress/status write either worker makes (`persistFenced()` in both `server/services/workspaceDeletion/worker.ts` and `server/services/userDeletion/worker.ts`) is an `UPDATE ... WHERE id = <job> AND lease_token = <token this claim was given>`. If another worker has since reclaimed the job, its token no longer matches: the `WHERE` clause matches zero rows, `persistFenced()` detects the empty result and throws `LeaseFencedError` — the write is rejected outright, not silently applied and not silently dropped either (it's a hard, observable stop). This was proven directly against a live PostgreSQL 16 instance (not just unit-mocked): worker A claims (token T1), the lease is force-expired, worker B reclaims (token T2), worker A's `renew` call with T1 returns `{ok:false, error:'fenced_out'}`, and worker A's conditioned `UPDATE ... WHERE lease_token = T1` affects zero rows while worker B's own write with T2 succeeds — see the commit's `test_185_186.sql` validation run.

### How leases are renewed (heartbeat)

`renew_workspace_deletion_lease()`/`renew_user_deletion_lease()` extend `lease_expires_at` **without changing the token**, as long as the caller still presents the current one. Both workers call this from inside `server/services/storage/scopeCleanupEngine.ts`'s per-key delete loop — not only between poll ticks — every `HEARTBEAT_INTERVAL_MS` (15s) while actively deleting a page of objects, which can be up to ~1000 S3 keys with per-key retries. If a single un-paginated provider call (BunnyCDN's recursive listing, which has no native pagination and returns its complete result in one call — see `bunnyList()`'s doc comment) runs long enough to lose the lease with no opportunity to heartbeat mid-call, fencing is still the safety net: the eventual persist attempt after that call returns is simply rejected, per the mechanism above.

### How stale workers are prevented from writing

Exactly as described above — `persistFenced()`'s conditioned `UPDATE` is the enforcement point, not a convention a worker has to remember to check. `tick()` in both workers catches `LeaseFencedError` specifically, logs it, and returns — no further work is attempted for that job on that worker. A `tickRunning` module-level boolean additionally prevents a SINGLE process's own `setInterval` from launching a second overlapping tick if one is still in flight (defense in depth; it does nothing for a second worker *process*, which is what `lease_token` exists for).

### How late privacy/LiveKit writes are prevented

Two producers previously bypassed the deletion write lock entirely:
- **Privacy exports** called `uploadWithConfig()` directly (the dedicated-provider-policy path, needed because privacy storage can be a different physical account than the workspace's ordinary one) — which enforces neither owner-scope nor the deletion write lock. `server/services/storage/index.ts` now exports `uploadWithConfigForOwner()`, which does both (via the same `isWorkspaceDeleting()` guard `uploadForOwner()` already used, now exported so nothing duplicates its logic) and then delegates to `uploadWithConfig()`. `server/services/privacy/worker.ts`'s `processJob()` now calls this instead.
- **LiveKit recordings** — Egress writes directly to `recording_storage`, never through this module's upload handlers at all, so the guard has to run before the recording is even started. `server/services/calls/providers/livekitProvider.ts`'s `startRecording()` now checks `isWorkspaceDeleting()` first and throws `CallProviderNotReadyError` if the workspace is mid-deletion — this is the single choke point both call sites (`server/services/callCenter/recordingControl.ts` and `server/routes/calls.ts`) funnel through, since Agora/Janus/Jitsi don't implement real recording (stubs only).

Job/recording *creation* is also blocked, not just the eventual write: `POST /api/privacy/jobs` now rejects a workspace-owned job with 409 if the workspace is deleting (fails fast instead of queueing work that could only ever end in a failed job — the worker-side guard above is what actually prevents an orphan either way). `call_recordings` rows are only ever created by the LiveKit webhook after Egress reports a result, so blocking `startRecording()` is sufficient — no new egress process is ever initiated during deletion, so no new row is ever created for a deleting workspace either.

Regression tests: `src/test/storage/writeBarrierLateWrites.test.ts` (6 tests) — proves `uploadWithConfigForOwner` allows an active-workspace upload, rejects a deleting-workspace upload, never blocks a user-owned (non-workspace) export, and that `processJob()` throws end-to-end when the workspace enters deleting mid-flight; and that `livekitProvider.startRecording()` rejects for a deleting workspace and is not a false positive for an active one. These use the REAL production `uploadWithConfigForOwner`/`isWorkspaceDeleting` code, not a mock of the guard itself.

### How final empty verification works

A scope reaching `status: 'done'` only ever meant "the last listing pass exhausted its cursor" — not "nothing has been written there since." An in-flight producer that started before the write barrier engaged could still land an object after the scope was swept. `server/services/storage/scopeCleanupEngine.ts` adds a `verified: boolean` field to each scope's progress and never lets the caller advance past storage cleanup until **every** scope is `skipped_not_configured` or `done AND verified`. A `done`-but-unverified scope gets a fresh, from-scratch listing pass (cursor reset to null): if it's genuinely empty, `verified` flips to `true`; if it finds anything, that's a late write — it's deleted and the scope is **reopened** (`status` back to `in_progress`, `verified` stays `false`) so a later tick re-verifies, rather than the job proceeding to `db_cleanup`. This loops until a verification pass genuinely finds nothing (guaranteed to terminate given the write barrier above actually stops new producers; a late write is a finite, one-time catch-up, not a stream). Both `runStorageCleanup` (workspace) and `purgeUser` (user, via the same shared engine) get this for free — `db_cleanup`/the final `admin_delete_user` call literally cannot be reached with an outstanding unverified scope, since `runScopeCleanupTick` only returns `{kind:'advance'}` once that's true.

Regression tests: `src/test/storage/scopeCleanupEngine.test.ts`'s "final verification" describe block (3 tests) — a clean re-listing verifies; a late write is deleted and reopens the scope instead of advancing; a reopened scope correctly needs ANOTHER clean verification pass before it's trusted.

### Which physical scopes user deletion cleans

`server/services/storage/userScopes.ts` is the user-deletion analogue of `workspaceScopes.ts`: `userStorageScopes(config, userId)` returns two scopes — `'default'` (the global/default user storage provider, via the same `resolveStorageConfigForOwner({kind:'user'})` the account avatar uses) and `'privacy_export'` (the dedicated privacy-export policy resolver, called with `workspaceId: null` — the exact same call `privacy/worker.ts` makes when writing a user-subject export). `database/migrations/186_user_deletion_multi_provider.sql` adds `user_deletion_jobs.storage_scopes` (superseding the old single `avatar_cleanup_done` boolean, kept unused per forward-only convention). `purgeUser()` in `server/services/userDeletion/worker.ts` walks both via the SAME shared `runScopeCleanupTick` engine workspace deletion uses — same dedup-by-fingerprint, same final-verification, same config-drift protection. `admin_delete_user` is never called until both scopes are settled.

Regression test: covered in the user-deletion worker test suite (§10) — a Provider-A `default` scope and a Provider-B `privacy_export` scope, proving both are actually cleaned.

### What happens when a child workspace deletion fails

`collectWorkspaces()` (the `collecting_workspaces` state) now inspects `enqueue_workspace_deletion`'s **business result**, not just the RPC transport error — a SQL-successful call can still return `{ok:false, error:'workspace_stuck_no_active_job'}` (every prior attempt on that workspace exhausted its retries), which is now treated as a real failure/retry condition for the user-deletion job. `{ok:false, error:'workspace_not_found'}` (a race where the workspace was already gone) is treated as fine — nothing to wait for.

`checkWorkspaceDeletionsComplete()` (the `awaiting_workspace_deletions` state) no longer only checks whether the owned workspace rows still exist. For any that do, it now looks up their latest `workspace_deletion_jobs` row: if that job is terminally `'failed'`, the user-deletion job is put through its own retry/backoff (and eventually terminal failure after `MAX_JOB_ATTEMPTS`) instead of polling `workspaces` forever. This is fully resumable — once an admin retries the failed workspace deletion (`POST .../workspaces/:id/deletion-retry`), the next check here proceeds normally without redoing any already-completed work.

### What happens when storage config changes mid-deletion

Every scope already stored a fingerprint of the `StorageConfig` it started against (`storageConfigFingerprint()` — provider/bucket/storageZone/endpoint/region/localPath). `scopeCleanupEngine.ts` now uses it as an actual invariant, not just a dedup key: before EVER reusing a stored cursor (a resumed `in_progress` scope) or trusting a `done` scope enough to verify it, the scope's config is re-resolved and its fresh fingerprint is compared against the one recorded when progress began. A mismatch — Option B from the review, no secrets persisted — fails the scope explicitly with a `storage_config_changed` error rather than either (a) silently continuing the old cursor against the new location (which could skip real objects) or (b) silently marking the scope complete (which would abandon whatever's still in the original bucket). This routes through the same retry/backoff path as any other scope error; after `MAX_JOB_ATTEMPTS` it's a terminal job failure, visible to an admin, who must reconcile the original location (e.g. temporarily restoring the old config) before retrying — an explicit operator-safe stop, never a silent one.

Regression tests: `src/test/storage/scopeCleanupEngine.test.ts`'s "storage config drift detection" describe block (3 tests), including the EXACT scenario from the review — delete starts against bucket A, first page completes and the cursor is saved, config changes to bucket B, the next tick runs, the old cursor is proven never applied to bucket B (`listWithConfig` call count unchanged), and the outcome is an explicit `storage_config_changed` error, never `'done'`.

## 8. Definition of Done — second corrective pass

| Requirement | Status |
|---|---|
| Real lease fencing (not just `locked_by`) | ✅ `lease_token`, minted fresh on every claim, conditions every write; proven against live Postgres |
| Lease renewal/heartbeat during long-running work, not only between ticks | ✅ inside the per-key delete loop, every 15s |
| `tickRunning` same-process guard | ✅ both workers |
| Workspace deletion write barrier covers privacy exports | ✅ `uploadWithConfigForOwner()` |
| Workspace deletion write barrier covers LiveKit recording start | ✅ checked inside `livekitProvider.startRecording()` |
| Final re-verification pass before `db_cleanup` | ✅ `verified` flag; a late write reopens the scope instead of letting the job proceed |
| User deletion is multi-provider | ✅ `userScopes.ts` — `default` + `privacy_export`, same dedup/verify/drift guarantees as workspace deletion |
| User deletion observes `enqueue_workspace_deletion`'s business result | ✅ `{ok:false}` is a real failure, not just a transport error |
| User deletion observes a child workspace deletion's terminal failure | ✅ propagates as a retry/failure, never polls forever |
| Storage config drift detection | ✅ fingerprint compared on every resume/verify; mismatch fails the scope explicitly, never silently restarts against the new location |

## 9. Known gaps — second corrective pass (deliberate scope decisions, narrow fixes only)

1. **The legacy migration tool's copy step (`legacyMigration/engine.ts`) still calls the bare `uploadWithConfig()`**, not the owner-aware variant — an operator running `npm run storage:migrate-legacy` against a workspace that is simultaneously mid-deletion could theoretically write a canonical-shaped object that lands after the deletion worker's scope walk passed it. This is a batch/operational tool, not an automatic producer like privacy jobs or call recordings, and running it against a workspace actively being deleted is an unusual operational sequence outside what this pass was asked to fix — flagged rather than fixed, to keep this pass narrow per the explicit instruction not to do unrelated cleanup.
2. **No write barrier exists for USER deletion** (only workspace deletion has one). The review's explicit write-barrier ask was scoped to workspace deletion; user deletion's `purgeUser()` still gets the same final-verification safety net (a late global-user-storage write is caught and cleaned before `admin_delete_user` runs), just not a pre-emptive block on new writes during the cleanup window.
3. **`userStorageScopes()` is two scopes today**, exactly mirroring `workspaceStorageScopes()`'s "a fourth scope needs a developer to remember to add it" gap already noted in §9 (first pass) — same caveat applies here.
4. **Drift reconciliation is manual.** When a scope's config changes mid-cleanup, an admin must actually restore/reconcile the original physical location before retrying — there is no automated "diff the two buckets" tooling. This was the explicitly preferred trade-off (Option B: never persist a secret-bearing config snapshot) over Option A.

## 10. Test coverage added this second corrective pass

- `src/test/storage/scopeCleanupEngine.test.ts` — new (15 tests): dedup, final verification/late-write reopening, storage-config-drift detection (including the exact bucket-A→bucket-B regression scenario), heartbeat-during-delete-loop, error paths.
- `src/test/storage/writeBarrierLateWrites.test.ts` — new (6 tests): `uploadWithConfigForOwner` active/deleting/user-owned cases, `processJob()` end-to-end rejection, `livekitProvider.startRecording()` active/deleting cases.
- `src/test/storage/workspaceDeletionWorker.test.ts` — rewritten again (18 tests) for the fencing/heartbeat/engine-delegation rewrite, including the explicit 5-step lease-race scenario (claim A → simulate expiry/reclaim by B → A finishes late → A's write is proven rejected via a conditioned `id AND lease_token` update, B's state is proven intact).
- `src/test/storage/userDeletionWorker.test.ts` — rewritten (22 tests) for the same fencing model plus multi-provider scopes, the `enqueue_workspace_deletion` business-result check, the child-workspace-terminal-failure propagation, and its own lease-fencing race scenario.
- `src/test/security/privacyExportOwnership.test.ts` — updated mocks (its Supabase stub and `uploadWithConfig` mock now target `uploadWithConfigForOwner`, the actual call site `processJob()` uses post-fix) — this test's existing 7 cases now correctly reflect the fixed write-barrier routing instead of failing against a stale mock.
- `src/test/integration/migrationMirrorParity.test.ts` — extended (+2 pairs): migrations 185 and 186 mirrored.

**Totals, this second corrective pass**: 297 tests passing across the full targeted storage/billing/security regression suite (`src/test/storage/`, `src/test/billing/{operatorRecordingVisibility,recordingStartRoutes,recordingStorageProvider}.test.ts`, `src/test/security/{accountAvatarOwnership,privacyExportOwnership,livekitRecordingKeyValidation}.test.ts`) plus 49 migration-parity tests, all passing. `npm run typecheck`, `npm run typecheck:server` (clean except the same pre-existing, unrelated `backupAgent.ts` error), and `node scripts/lint-changed.mjs` (`OK — 0 errors, 0 warnings across 55 changed files`, once the new files are staged) all clean. One pre-existing, unrelated failure was found and confirmed NOT caused by this pass: `src/test/security/adminManagementRoutes.test.ts`'s `GET deletion-status` test fails identically with every change from both corrective passes fully stashed out.

Exact commit SHAs, and whether the branch is safe to merge under multi-instance production conditions, are given directly to the user at the end of this pass.
