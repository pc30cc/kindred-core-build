# Storage Architecture Audit — Current State

_Status: **Phase A (audit) — complete for the requested scope.** This document is
the factual baseline for the Storage Ownership Standardization project. It
records what exists today, not what should exist. See
`docs/STORAGE_LIMIT_POLICY.md` / `docs/STORAGE_COUNTER_ARCHITECTURE.md` for the
quota system this audit treats as authoritative and unchanged._

Every row below was produced by reading the actual source (file + line), not
inferred from naming. Providers/abstraction (`server/services/storage/index.ts`)
are **not** being replaced — this audit only inventories *ownership* and *key
shape*, per the project's own top-level rule: Storage Provider and Storage
Ownership are separate concerns.

## 1. The shared storage service (`server/services/storage/index.ts`)

Two execution modes, both used across the codebase today:

- **Workspace-resolved** — `uploadFile` / `downloadFile` / `downloadFileRange` /
  `deleteFile` / `getFileUrl`. Resolves the workspace's active provider from
  `provider_configs`, applies a global MIME allowlist + 50MB default size cap
  (`validateFile`, lines 71-76), and **unconditionally logs every
  upload/delete to `storage_usage_logs`** (lines 652-670, 717-725) — this is
  the sole feed for the `storage_gb` quota trigger
  (`trg_storage_usage_logs_apply`).
- **Explicit-config** — `uploadWithConfig` / `downloadWithConfig` /
  `deleteWithConfig` / `getFileUrlWithConfig`. Caller supplies a fully
  resolved `StorageConfig` directly. **Bypasses both the workspace resolver
  and the `storage_usage_logs` insert** (no MIME whitelist either — size
  check only). Used today by: privacy export worker, call-center platform
  ringback audio.

**Critical gap confirmed by direct read:** none of `uploadFile` /
`downloadFile` / `downloadFileRange` / `deleteFile` / `getFileUrl` validate
that `fileKey` is actually scoped to the `workspaceId` argument. The function
signature accepts `{ workspaceId, fileKey }` as two independent, unrelated
strings — any caller (a bug, a future feature, a copy-pasted route) can pass
`workspaceId: 'A'` with `fileKey: 'workspace/B/...'` or `fileKey:
'avatars/...'` and the service will happily upload/read/delete it under
workspace A's resolved provider. **There is currently zero enforcement inside
the service layer** — see §5.

## 2. Producer inventory

| # | Feature | Key construction (exact) | Owner type (should be) | Canonical today? | Provider path | DB reference | Quota-gated (`storage_gb`)? | Storage delete on removal? | Server-side key validation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Operator chat attachments | `conversationAttachments.ts:118` — `` workspace/${workspaceId}/attachments/${yyyy}/${mm}/${uuid}-${safeFileName} `` | workspace | **Yes** | `uploadFile()` | `conversation_attachments.storage_path` — table **has `workspace_id` column AND a DB `CHECK` constraint**: `storage_path LIKE 'workspace/' \|\| workspace_id::text \|\| '/attachments/%'` | Yes | **No** — DELETE route is explicitly soft-only (DB row only; comment: "storage left to GC") | Prefix + `..` check re-verified on every read/write |
| 2 | Widget visitor attachments | `widgetAttachments.ts:103` — same pattern | workspace | **Yes** | `uploadFile()` | Same `conversation_attachments` table (`uploaded_by_type='visitor'`) | Yes (workspace_id server-resolved from widget token, not client input) | **No delete route at all** for this table from the widget surface | Prefix + `..` check |
| 3 | Generic storage API (`/api/storage/*`) | Client supplies `fileKey`; route validates via `workspaceKeyError()` (`storage.ts:66-86`) — requires `workspace/{workspaceId}/` prefix, blocks `..`, `\`, null byte, leading `/`, `://`, percent-encoded traversal | workspace | **Yes (enforced at route only)** | `uploadFile`/`deleteFile`/`getFileUrl` | Caller-owned (no dedicated table) | Yes | Yes — `POST /api/storage/delete` | **Yes, but only at the route.** Nothing stops an internal service from calling `uploadFile()` directly with an unscoped key — this validator is not inside the service |
| 4 | Telegram/Bale inbound media | `mediaIngest.ts:79-85` — `` workspace/${workspaceId}/attachments/${yyyy}/${mm}/${uuid}-${safeFileName} `` | workspace | **Yes** | `uploadFile()` | `conversation_attachments` | Yes — `checkStorageQuota()` in-process | No dedicated delete path found | Server-built only |
| 5 | Telegram contact avatar sync | `mediaIngest.ts:322` — `` workspace/${workspaceId}/avatars/telegram/${fileKeyHint}.jpg `` | workspace | **Yes (path shape)** | `uploadFile()` | **`contacts.avatar_url` only — no storage-key column at all.** Old object cannot be targeted for deletion later. | **No** | **No — orphaned on every re-sync** (overwrites URL/metadata, never calls `deleteFile`) | `fileKeyHint` sanitized by caller |
| 6 | Email compose staged attachment | `email/inbox.ts:279` — `` email-attachments/${workspaceId}/${yyyy}/${mm}/${uuid}-${safeName} `` | workspace | **NO — non-canonical root** (`email-attachments/`, not `workspace/<id>/attachments/email/`) | `uploadFile()` | `email_attachments.storage_key` | **No** | **No — no delete code path exists for `email_attachments` anywhere; DB grants don't even include DELETE for `service_role`** | Filename sanitized; workspaceId is route-authenticated |
| 7 | Gmail inbound attachment ingest | `internalChannels.ts:541` — identical `email-attachments/${workspace_id}/...` | workspace | **NO — same non-canonical root** | `uploadFile()` | `email_attachments.storage_key` | **No** | **No** | Filename sanitized |
| 8 | Yahoo inbound attachment ingest | `internalChannels.ts:847` — byte-identical pattern | workspace | **NO — same non-canonical root** | `uploadFile()` | `email_attachments.storage_key` | **No** | **No** | Filename sanitized |
| 9 | AI Agent KB file ingestion | `fileIngestion.ts:364` — `` workspace/${workspaceId}/ai-agent/files/${source.id}/${uuid}-${safeName} `` | workspace | **Yes** | `uploadFile()` | `ai_data_sources.metadata.storage_path` (**jsonb, not a real column**) | **Partial** — gated by AI KB feature limits (`ai_kb_file_size_mb`/`ai_kb_file_count`), **not** the general `storage_gb` workspace quota | **Yes** — `deleteAiFile()` calls `deleteFile()` best-effort | Server-built |
| 10 | AI Agent assistant avatar | `assistant.ts:232` — `` workspace/${workspaceId}/ai-agent/avatar/${uuid}-${safeName} `` | workspace | **Yes** | `uploadFile()` | `ai_agent_settings.agent_logo_url` (URL) + `metadata.ai_avatar_storage_key` (jsonb) | **No** | **Yes** — best-effort `deleteFile()` on replace and on explicit delete | Filename sanitized; extension derived from magic-byte sniffing, not client MIME |
| 11 | User account avatar | `account.ts:248` — `` avatars/${user.id}/${Date.now()}-${randHex}.${ext} `` | **user** (global, account-level) — see §4 | **NO — non-canonical, and would be *rejected* by `workspaceKeyError()`** | `uploadFile()`, but `workspaceId` used **only for provider/credential routing** (the user's *primary* workspace membership — an arbitrary, mutable binding with no ownership meaning) | `profiles.avatar_url` — **URL only, no storage-key column; old key recovered by string-parsing the stored URL** | **No** | Yes, best-effort, via the parsed-URL key | **Weak** — no traversal/prefix check at all (relies entirely on being 100% server-built) |
| 12 | Workspace branding/icon | `account.ts:735` — `` branding/${workspaceId}/icon-${Date.now()}-${randHex}.${ext} `` | workspace | **NO — non-canonical root** (`branding/`, not `workspace/`) | `uploadFile()` | `workspace_branding.logo_url` — URL only, old key parsed from URL | **No** | Yes, best-effort | Membership check only; no path validation |
| 13 | Call Center workspace avatar | `callCenter.ts:358-359` — `` workspace/${wid}/call-center/avatar/${uuid}-${safeName} `` | workspace | **Yes** | `uploadFile()` | `call_center_settings.avatar_url` **and** `avatar_storage_path` (the only avatar feature that persists the raw key, not a URL-parsed one) | **No** | Yes, best-effort | Inline sanitization; admin-gated route |
| 14 | Call Center platform ringback audio | `callCenter.ts:1602-1606` — `` platform/call-center/ringback/${slot}/${uuid}-${safeName} `` | platform | **Yes (correctly platform-scoped)** | `uploadWithConfig()` against `resolveGlobalStorageConfig()`, called with a **sentinel all-zero UUID** as `workspaceId` (`00000000-0000-0000-0000-000000000000`) purely because the shared type requires one | Global admin route | **N/A structurally** — `uploadWithConfig` never writes `storage_usage_logs` | Yes, best-effort via `deleteWithConfig` | Global-admin gated; inline filename sanitization |
| 15 | Call recordings (LiveKit egress) | `livekitProvider.ts:375` — `` ${providerRoomId}/${Date.now()}.mp4 `` where `providerRoomId = gs_<workspaceId.slice(0,8)>_<callSessionId.slice(0,12)>` | workspace | **NO — not workspace-rooted at all**, and not even written through this codebase's storage service (see §3) | LiveKit Egress writes directly to `cfg.recording_storage`, a **single platform-wide S3-compatible bucket** configured once in `livekit_config` (not per-workspace, not resolved via `resolveStorageConfig`) | `call_recordings.storage_path` (webhook writes `fileResults[].filename` **verbatim, no validation**), `storage_provider` (resolved separately via the **workspace** attachment provider — a mismatch, see §3) | **No** — never goes through `uploadFile`, excluded by policy per `STORAGE_LIMIT_POLICY.md` | Yes — `retentionJanitor.ts` calls `deleteFile(config, workspace_id, storage_path)` using the **workspace attachment resolver**, which may not be the provider that actually holds the bytes | **None** — webhook trusts `fileResults[].filename` from the payload with no prefix/ownership check |
| 16 | Privacy export artifact | `storageResolver.ts:80-86` — `` privacy-exports/${workspaceId ?? '_self'}/${jobId}.zip `` | workspace (or platform/self actor for `_self`) | **NO — non-canonical root**, deliberately a sibling of any workspace root (comment: "keep PII isolated... even if both share a bucket") | Dedicated 4-step provider resolution independent of main attachment storage: workspace `privacy_export_storage` override → platform `privacy_export_storage` → optional fallback to the workspace's general attachment provider → throw. Upload via `uploadWithConfig()` | `privacy_jobs.artifact_path` / `artifact_storage_provider` / `artifact_storage_key` / `artifact_hash` / `artifact_size_bytes` / `expires_at` | **No** — `uploadWithConfig` bypasses `storage_usage_logs` entirely | **Yes** — hourly `expirySweep.ts`, 7-day TTL, refuses to delete if the resolved policy provider has since changed | Key built server-side only, never trusted from caller |

## 3. Architectural mismatches worth flagging before migration

1. **Three independent provider-resolution mechanisms coexist**, not one:
   (a) `resolveStorageConfig(workspaceId)` — the main per-workspace
   attachment provider; (b) `resolvePrivacyStoragePolicy()` — privacy's own
   `provider_configs.provider_type='privacy_export_storage'` +
   `app_runtime_config` policy, with an optional fallback to (a); (c)
   LiveKit's own global `recording_storage` config baked into the singleton
   `livekit_config` row — not workspace-scoped at all. The project's
   instruction to "preserve the privacy provider policy" (§10) and "keep
   provider abstraction, standardize ownership" applies cleanly to (a)/(b);
   (c) needs the interface change described in §11 of the task before it can
   even express a canonical key.
2. **LiveKit `call_recordings.storage_provider` is cosmetically wrong today.**
   The webhook resolves it via the *workspace's* general attachment provider
   (`resolveStorageConfig(config, session.workspace_id)`), but the bytes were
   actually written by LiveKit Egress straight into the separate global
   `cfg.recording_storage` bucket. The existing code comment even flags this
   as legacy/cosmetic. This means the retention janitor's `deleteFile()` call
   assumes a provider that may not be where the object lives — a real
   correctness risk independent of the key-naming problem.
3. **LiveKit webhook trusts `fileResults[].filename` with no ownership
   check.** The only authentication on the webhook payload is an HS256 JWT +
   body-hash check on the *whole* request — nothing validates that the
   `filename` inside it is actually prefixed with the expected
   `providerRoomId` (let alone a workspace/call-session-scoped canonical
   path). A malformed or malicious egress payload would be persisted as-is
   into `call_recordings.storage_path`.
4. **Two incompatible "workspace-scoped" key conventions exist
   side by side.** `workspace/{id}/...` is enforced both by DB (the
   `conversation_attachments` CHECK constraint) and by the generic
   `/api/storage/*` route validator (`workspaceKeyError()`) — but account
   avatar (`avatars/{userId}/...`) and workspace branding
   (`branding/{workspaceId}/...`) use different roots that **would be
   rejected by that very validator** if routed through `/api/storage/*`.
   They are not exploitable today only because both keys are 100%
   server-constructed, never client input — but they prove the enforcement
   that exists is route-local, not systemic.
5. **`email_attachments` has no `workspace_id` column at all** — workspace
   scoping is only reachable by joining through
   `email_messages.workspace_id`. Contrast with `conversation_attachments`,
   which has both a direct `workspace_id` column *and* a DB `CHECK`
   constraint tying `storage_path` to it. This is exactly why the
   `email-attachments/<id>/...` non-canonical root was able to ship — there
   was no DB-level guardrail to catch it, unlike chat attachments.
6. **`uploadWithConfig`/`deleteWithConfig` bypass `storage_usage_logs`
   entirely** — used by privacy exports and platform ringback audio. Any
   future workspace-level storage accounting that reads `storage_usage_logs`
   will silently miss everything written this way. This is consistent with
   documented quota policy (these categories are *deliberately* excluded
   today, per `STORAGE_LIMIT_POLICY.md`), but it means the exclusion is an
   emergent property of which upload function happens to be called, not a
   declared policy anyone enforces or can audit.
7. **Workspace deletion is DB-cascade only — it never touches blob storage.**
   `public.admin_delete_workspace(_workspace_id)` (defined in
   `supabase/migrations/20260415220905_...sql:278-330`) is a single SQL
   function that hard-deletes ~25 tables (`conversation_messages`,
   `conversations`, `contacts`, `workspace_branding`, `email_logs`,
   `provider_configs`, `storage_usage_logs`, etc.) and finally the
   `workspaces` row itself — but **it contains no call to any storage
   provider, no enumeration of `workspace/<id>/...` objects, and no
   verification that blobs were removed.** Every object a deleted workspace
   ever wrote (chat attachments, AI KB files, avatars, call recordings,
   exports) becomes permanently orphaned in the provider the moment this
   function runs. This is the concrete gap the project's requested
   "storage-aware deletion lifecycle" (§16) needs to close.

## 4. Account avatar ownership — investigation needed before migrating (§9 of the task)

`profiles.avatar_url` is a **user-profile column** (on `profiles`, not on any
per-workspace-membership table). The current code path
(`account.ts:240-248`) only consults the user's *primary workspace
membership* to pick a storage **provider** — it never writes the workspace id
into the object key, and nothing in the schema suggests the avatar is
conceptually different per workspace. This audit did not find any UI or API
surface that lets a user have a different avatar per workspace, or that reads
`avatar_url` scoped by workspace — every read site treats it as one value per
user. **Working conclusion for Phase implementation:** this is a genuine
global user asset and belongs under `users/<userId>/avatar/...`, not a
workspace root — consistent with the task's own guidance in §9. This will be
re-confirmed against all `avatar_url` read sites before the migration lands.

## 5. Quota-gating summary (`storage_gb`)

| Path | Gated? |
|---|---|
| Chat attachments (operator + widget) | Yes |
| Generic `/api/storage/upload` | Yes |
| Telegram/Bale media | Yes |
| Telegram avatar sync | No |
| Email (compose/Gmail/Yahoo) | No |
| AI KB files | Partial (separate AI feature limit, not `storage_gb`) |
| AI avatar | No |
| Account avatar | No |
| Workspace branding | No |
| Call-center avatar | No |
| Platform ringback audio | N/A (platform-owned; structurally excluded) |
| Call recordings | No (policy-excluded today) |
| Privacy exports | No (structurally excluded — bypasses `storage_usage_logs`) |

This is a materially inconsistent surface: some byte-creating paths are
capped by the workspace's plan, most are not. §15 of the task (a declared
`StorageCategoryPolicy` registry) is necessary to make this an explicit,
auditable decision instead of an accident of which upload helper a feature
happens to call.

## 6. Delete-path summary

| Path | Deletes storage object on removal? |
|---|---|
| Chat attachments (operator) | **No** — DB soft-delete only, by design ("storage left to GC") |
| Widget attachments | **No delete route exists** |
| Telegram avatar | **No** — orphaned on every re-sync |
| Email attachments (all 3 producers) | **No delete path exists anywhere**; DB doesn't even grant DELETE |
| AI KB files | Yes |
| AI avatar | Yes |
| Account avatar | Yes (best-effort) |
| Workspace branding | Yes (best-effort) |
| Call-center avatar | Yes (best-effort) |
| Platform ringback audio | Yes (best-effort) |
| Call recordings | Yes — 30-min retention janitor (see §3 mismatch caveat) |
| Privacy exports | Yes — hourly expiry sweep, 7-day TTL |

## 7. DB schema notes relevant to migration/constraint design

- `conversation_attachments` — **has** `workspace_id` column + `CHECK
  (storage_path LIKE 'workspace/' || workspace_id::text || '/attachments/%')`.
  This is the proof the canonical convention is already the intended one;
  it should be the template for the `email_attachments` constraint requested
  in §8 of the task.
- `email_attachments` — **no** `workspace_id` column; scoping only via
  `message_id → email_messages.workspace_id`. `storage_key text NOT NULL`,
  no CHECK constraint. GRANT to `service_role` is `SELECT, INSERT` only (no
  UPDATE/DELETE), consistent with there being no delete path in code today.
- `workspace_usage_counters` / `storage_usage_logs` — as documented in
  `docs/STORAGE_COUNTER_ARCHITECTURE.md`; single-writer trigger
  `trg_storage_usage_logs_apply`. Not touched by this audit's proposed
  changes.
- `admin_delete_workspace()` (self-host mirror: check
  `database/migrations` for the equivalent function — same audit applies)
  hard-deletes ~25 tables and the workspace row with **no storage
  interaction**. Any future storage-aware deletion lifecycle must sit
  *alongside/before* this function, not assume it already handles blobs.
- Migration parity is enforced by
  `src/test/integration/migrationMirrorParity.test.ts`, which pins specific
  self-host/hosted migration file pairs and fails CI on any functional SQL
  drift between them. Any new migration for this project (e.g. the
  `email_attachments.workspace_id` addition, or a new `storage_objects`
  table) must ship as a matched pair in both `database/migrations/` and
  `supabase/migrations/` and, if it's meant to be pinned for parity
  checking, be added to the `MIRRORS` array in that test file.

## 8. Additional findings from the repo-wide sweep

- **Client-side key construction exists and must be closed (relevant to task
  §13).** Two frontend call sites build a full `fileKey` themselves and POST
  it straight to `/api/storage/upload`:
  - `src/components/plugins/TelegramConfigPanel.tsx:230-232` — builds
    `workspace/${workspaceId}/${provider}/bot-avatar-${Date.now()}.${ext}`.
  - `src/pages/app/WidgetPage.tsx:122-124` — builds
    `workspace/${id}/widget/launcher-...`.
  Both currently pass `workspaceKeyError()`'s check because they happen to
  use the right prefix, but the *server* only validates shape, not that the
  suffix is one of a known set of purposes — the client still picks the
  category/subpath. This is exactly the gap §13 asks to close with a
  `purpose`-based upload API.
- **Four incompatible naming conventions for "the object key" coexist across
  tables/code**: `storage_path` (`call_recordings`, `conversation_attachments`),
  `storage_key` (`email_attachments`, `privacy_jobs.artifact_storage_key`),
  `fileKey` (in-flight API/route variable name only) and `ringback_*_path`
  (three separate JSON/text fields on `platform_call_center_settings`), plus
  one key hidden inside jsonb (`ai_agent_settings.metadata.ai_avatar_storage_key`).
  A central key-builder module does not need to rename existing DB columns,
  but new code should stop inventing new naming variants.
- **`avatar_url` is reused verbatim across three unrelated tables** —
  `profiles` (user account), `contacts` (CRM/visitor), `call_center_settings`
  (workspace call-center branding). `profiles.avatar_url` has **three
  independent write paths**: `account.ts` (user-initiated upload/delete),
  `admin.ts:362,368,387` (admin nulls it out), and
  `privacy/anonymizer.ts:78,285` (GDPR anonymization nulls it). All three
  must be considered when migrating avatar storage, not just the upload
  route.
- **`server/routes/adminManagement.ts:172-176`** maintains a hand-written
  `collect(table, column)` registry of every table+column that holds a
  storage key, used by an admin data-export/inventory job. It currently
  covers `conversation_attachments.storage_path`, `call_recordings.storage_path`,
  and `privacy_jobs.artifact_storage_key` — **it does not include
  `email_attachments.storage_key`, any avatar column, or ringback audio**.
  This registry should be extended, not duplicated, as the canonical
  producer list grows — it's a natural seed for the `storage_objects`
  inventory question in task §14.
- **No `storage_objects` table exists anywhere in this codebase's own
  migrations.** If Supabase's built-in `storage.objects` is used at all, it
  is outside this repo's migration control — worth confirming operationally
  before assuming it's unused, but nothing in the app code references it.
- **Pre-existing, unrelated self-host/hosted schema drift** (found
  incidentally, not introduced by this project, but touches tables this
  project will modify): `call_center_settings`, `workspace_usage_counters`,
  and `storage_usage_logs` are all `ALTER`ed or written to by later
  `database/migrations/*.sql` files, but **no file in that chain ever
  `CREATE TABLE`s them** — they only exist via `CREATE TABLE` in
  `supabase/migrations/*`. This mirrors the class of bug
  `database/migrations/016a_selfhost_product_parity_base_tables.sql` already
  fixed for six other tables; these three appear to have been missed. Since
  Phase for DB constraints (task §8) and quota policy (task §9/§15) will
  touch `workspace_usage_counters`/`storage_usage_logs`, and avatar-ownership
  work (task §9) touches `call_center_settings`, this drift should be
  patched alongside those changes (or explicitly flagged to the team as a
  pre-existing self-host gap) rather than silently worked around.
- **Migration parity coverage** (`src/test/integration/migrationMirrorParity.test.ts`)
  does **not** currently include any storage-related migration pair except
  `email_inbox` (163 ↔ 20260912110000, already parity-clean). Any new
  migration this project adds that should be parity-pinned needs a new entry
  in that test's `MIRRORS` array.
- No `createWriteStream` usage exists anywhere for blob storage — all writes
  are buffer-based today (relevant only if a future phase adds large-file
  streaming to the provider interface, task §17).

## 9. What is *not* in scope / not touched

- Storage provider abstraction (Bunny/S3/local) — kept as-is, per the task's
  explicit instruction.
- `storage_gb` counter/trigger mechanics — kept as-is; only the *set of
  categories opted into it* is a later, explicit policy decision (§15/§9 of
  the task), not a rewrite of the counter.
- Any UI/admin visibility work (task §26) — deferred until ownership
  correctness (this audit + Phase 1+) lands, per the task's own priority
  order.

## 10. Next step

Phase 1 (canonical ownership model, central key builder, service-layer
enforcement, tests) begins now, per the task's execution plan (§28):
Email → generic storage clients → AI/channel audit (already covered above) →
account avatar ownership → privacy → LiveKit recordings → DB constraints →
quota/category policy → legacy migration tooling → workspace cleanup
lifecycle.

## 11. Persisted URLs (superseded)

Several rows in the inventory above were recorded as storing an absolute public
URL next to (or instead of) their key — `profiles.avatar_url`,
`workspace_branding.logo_url`, `call_center_settings.avatar_url`,
`ai_agent_settings.agent_logo_url`, `contacts.avatar_url`. That is no longer
true of any of them.

A URL names one vendor's hostname, so a row holding one is pinned to whichever
storage provider was primary when it was written. The platform now persists the
canonical key ONLY and derives every link at read time, which makes promoting a
new provider a zero-row-rewrite operation.

See **`docs/STORAGE_URL_DERIVATION.md`** for the invariant, the single
derivation layer (`server/services/storage/urlResolver.ts`), the per-column
migration map, and the promotion rule that follows from it.
