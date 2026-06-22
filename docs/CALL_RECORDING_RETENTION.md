# Call Recording Retention — `recording_retention_days`

**Status:** LIVE.

## Subject set

Rows in `public.call_recordings` with `legal_hold = false`. The
underlying storage object is the file at `(storage_provider, storage_path)`
— deleted via `server/services/storage/index.ts#deleteFile` using the
workspace's resolved storage provider (`call_recordings.storage_provider`
is informational only; the workspace storage resolver is canonical).

## Retention clock

Stamped **once on insert** at `egress_started`:

```
retention_expires_at = created_at + effective_recording_retention_days
```

Plan / override changes after the recording is created do **not**
re-stamp existing rows. New recordings always get the current effective
value. This avoids retroactive deletion when an admin shortens
retention and avoids "extension by upgrade" surprises.

## Effective-days resolution

Implemented in
`server/services/recordings/recordingRetention.ts#resolveEffectiveRecordingRetentionDays`.

Precedence (first hit wins):

1. Plan + workspace override via `check_workspace_entitlement('recording_retention_days')`
2. `CallControlPlane.retention_default_days` (global default, 30)
3. Fallback constant 30

`-1` at any layer = unlimited → `retention_expires_at` is left `NULL`;
the partial index and the janitor query both treat NULL as
"never expires".

## Enforcement path (sole)

`server/services/recordings/retentionJanitor.ts#sweepRecordingRetention`

- Boot delay: 2 minutes. Cadence: every 30 minutes. Batch size: 100.
- Single indexed query:
  ```
  legal_hold = false
  AND retention_expires_at IS NOT NULL
  AND retention_expires_at <= now()
  ```
  uses `idx_call_recordings_retention`.
- Per row:
  1. `deleteFile(workspace_id, storage_path)` — derived via the
     inner join to `call_sessions(workspace_id)`.
  2. On success (or "not found"), hard-delete the row.
  3. On other storage failure: leave the row; next sweep retries.
- Legal holds are **never** selected. There is no other delete path.

## Backward compatibility

- Existing `call_recordings` rows have `retention_expires_at = NULL`
  and are never selected by the janitor.
- Registry default is `-1` (unlimited), so any plan without an
  explicit `recording_retention_days` value continues to retain
  recordings indefinitely until an admin opts in.
- The control-plane default (`retention_default_days = 30`) is only
  applied when a plan does not specify the key — preserving existing
  global behaviour.

## Deferred / out of scope

- Per-recording retention overrides (already supported as
  `retention_policy` text + `retention_expires_at`; admin UI not in
  this phase).
- Tombstone / soft-delete intermediate state — not needed; the row
  is the only ledger.
- Attachment retention — separate artifact, handled by
  `attachmentJanitor`.
---

## Operability Surface (Phase Update — Legal Hold + Admin Visibility)

Narrow super-admin-only surface added under the existing
`/api/admin/calls` mount. Architecture, semantics, and the
"janitor is the sole deletion path" rule are **unchanged**.

### `GET /api/admin/calls/recordings`

Paginated list of `call_recordings` joined to `call_sessions` for
workspace ownership. Returns the row fields (id, call_session_id,
workspace_id, provider, recording_type, storage_provider,
storage_path, duration_seconds, size_bytes, retention_policy,
retention_expires_at, legal_hold, created_at) plus a computed
`status` badge:

| status              | meaning                                                          | janitor behavior        |
| ------------------- | ---------------------------------------------------------------- | ----------------------- |
| `on_hold`           | `legal_hold = true`                                              | never selects           |
| `expired`           | `retention_expires_at <= now()` AND `legal_hold = false`         | selects on next sweep   |
| `expires_at`        | `retention_expires_at > now()` AND `legal_hold = false`          | selects when due        |
| `legacy_unmanaged`  | `retention_expires_at IS NULL` AND `legal_hold = false`          | **never selects** (NULL is permanent retention) |

Query params: `workspace_id`, `status`, `limit` (≤200), `offset`.

### `POST /api/admin/calls/recordings/:id/legal-hold`

Body: `{ enabled: boolean, reason?: string }`. Toggles **only**
`call_recordings.legal_hold`. Never writes `retention_expires_at`,
never deletes the row, never touches storage. Writes an
`audit_logs` row keyed by `entity_type = 'call_recording'` with
action `call_recording.legal_hold.enable|disable`.

### Legacy recordings

Pre-existing rows with `retention_expires_at = NULL` are labelled
`legacy_unmanaged` and remain untouched. **There is no backfill
action in this phase**, by design. Operators who want a legacy
row protected long-term can still toggle legal hold on it.

### What is *not* in this phase (intentionally deferred)

- Bulk legal-hold or bulk delete actions.
- Per-recording retention overrides.
- An opt-in admin "backfill expiry for legacy rows" action.
- Operator-side (non-admin) visibility into recordings.

## Admin UI (super-admin only)

Lives in **Admin → Voice & Video Center → Recordings tab**
(`src/pages/admin/VoiceVideoPage.tsx` → `RecordingRetentionPanel`).

Implementation:
- API client: `fetchAdminRecordings`, `setAdminRecordingLegalHold`
  in `src/lib/admin-calls-api.ts` (consumes the existing routes
  unchanged — no new backend surface).
- Panel: `src/components/admin/calls/RecordingRetentionPanel.tsx`
  + the `RetentionStatusBadge` helper.
- Tests: `src/test/admin/recordingRetentionPanel.test.tsx`.

What the UI **can** do:
- Paginated list of recordings with workspace + status filters.
- Visible fields: id, workspace_id, created_at, duration, size,
  `retention_expires_at`, computed status, `legal_hold`.
- Single-row legal-hold toggle (optional reason field).

What the UI **intentionally cannot** do (matches backend policy):
- No delete or purge controls — the retention janitor is the sole
  deletion path.
- No editing of `retention_expires_at` (immutable post-stamp).
- No bulk actions.
- No implicit/explicit backfill of `legacy_unmanaged` rows.
- No operator-side surface — super-admin only, scoped by the
  parent `adminRouter` middleware.

---

## Super-admin artifact access (read-only)

Added: super-admin route `GET /api/admin/calls/recordings/:id/file?disposition=inline|attachment`.

- Streams bytes through the canonical storage abstraction (`downloadFile` → `resolveStorageConfig`), the same helper that powers the widget attachment proxy. No provider URLs or credentials are exposed to the browser.
- Read-only: never mutates `call_recordings`, never touches `retention_expires_at`, never deletes from storage. The retention janitor remains the sole deletion path.
- Disposition: `inline` (default) for in-tab playback, `attachment` to force a download.
- Errors: `404 not_found`, `410 missing_storage_path`, `404 storage_object_missing`, `502 provider_download_failed`.
- UI: the existing Recording Retention panel in Voice & Video Center exposes per-row **Open** and **Save** buttons. Bytes are fetched via authed `fetch` and surfaced through a transient `URL.createObjectURL` (revoked after 60s). No `<a href>` or `<video src>` ever points at the route directly.
- Legacy (`legacy_unmanaged`) rows: accessible if the underlying object still exists; no implicit backfill of `retention_expires_at`.

### Still deferred after this pass
- Range-request / partial-content streaming for very large recordings.
- Bulk operations, per-recording retention overrides, operator-side visibility, optional legacy backfill UI.

---

## Super-admin inline playback (read-only preview)

Layered on top of the existing artifact proxy — no new backend route,
no change to retention semantics, no change to deletion paths.

- UI: a per-row **Preview** toggle in the Recording Retention panel
  expands an inline preview row beneath the recording.
- Bytes are fetched via `fetchAdminRecordingBlob(id, 'inline')` (the
  same authed proxy that powers Open/Save) and rendered through a
  transient `URL.createObjectURL`. The `<audio>` / `<video>` element
  is bound to the object URL, never to the proxy route or any
  provider URL.
- Player selection is driven by the `Content-Type` returned by the
  proxy:
  - `audio/*` → native `<audio controls>`.
  - `video/*` → native `<video controls>`.
  - anything else → explicit "Inline preview is not supported"
    state; Open/Save remain available as fallbacks.
- Resource safety: the object URL is revoked on collapse and on
  unmount; fetches are guarded against late resolution after the
  row is collapsed. No prefetch — bytes are only fetched when the
  operator explicitly opens preview.
- Scope: super-admin only (inherited from the parent `adminRouter`
  middleware). Read-only — no delete, no retention edit, no legal-hold
  side effects.

### Still deferred after the inline playback pass
- Waveform/timeline UI, annotations, comments.
- Bulk operations, per-recording retention overrides, operator-side visibility.

---

## Super-admin ranged artifact access (read-only streaming)

Narrow optimization on the existing artifact proxy. No new route, no
change to retention semantics, no change to deletion paths, no change
to admin auth.

- Backend: `GET /api/admin/calls/recordings/:id/file` now honors an
  HTTP `Range: bytes=START-END` header.
  - Always returns `Accept-Ranges: bytes`.
  - When the provider acknowledges the range, the response is `206
    Partial Content` with `Content-Range: bytes START-END/TOTAL` and a
    `Content-Length` matching the slice.
  - When no `Range` header is sent, the response is a full `200 OK`
    body (identical to prior behavior — fully backward compatible with
    the existing Open/Save and inline-preview blob flow).
  - Unsatisfiable ranges surface `416 Range Not Satisfiable` with a
    `Content-Range: bytes */TOTAL` hint when total size is known.
  - If a provider ignores `Range` and returns the full body anyway, the
    proxy serves a normal `200 OK` (read-only fallback — playback
    still works, large-file efficiency is not gained for that provider).
- Storage abstraction: added `downloadFileRange(serverConfig,
  workspaceId, fileKey, rangeHeader?)` alongside the existing
  `downloadFile`. Provider coverage:
  - `local` — true ranged read via `fs.openSync`/`readSync`.
  - `bunny_storage`, `s3`, `cloudflare_r2`, `minio`, `do_spaces`,
    `gcs`, `azure_blob` — `Range` header forwarded to the upstream
    `GET`; the provider's `206`/`Content-Range`/`Accept-Ranges` are
    surfaced back unchanged. The S3 signer signs `Range` like any
    other header.
- Frontend: unchanged in this pass. The Recordings panel still uses
  the authed Blob + `URL.createObjectURL` path for Open/Save/inline
  preview because authenticated `<video src>` / `<audio src>` would
  require a short-lived URL-bound token surface, which is out of
  scope for this read-only optimization pass. Range support is
  therefore exercised by tools (`curl -H "Range: bytes=…"`) and
  by any future short-lived-token surface — it does not regress
  current playback.
- Read-only guarantees preserved: no writes to `call_recordings`, no
  edits to `retention_expires_at`, no deletes from storage. The
  retention janitor remains the sole deletion path.
- Scope: super-admin only (inherited from `adminRouter`).

### Still deferred after the ranged-access pass
- Waveform/timeline UI, annotations, comments.
- Bulk operations, per-recording retention overrides,
  operator-side visibility, optional legacy backfill UI.

---

## Tokenized native playback (short-lived HMAC URL)

Narrow read-only access pass enabling native `<audio>` / `<video>`
streaming for super-admin playback without exposing provider URLs or
credentials.

### Why a new path
The existing artifact proxy is gated by an `Authorization: Bearer`
header, which native media elements cannot attach to their internal
Range requests. Without a URL-bound grant, the admin UI had to fetch
the entire artifact as a Blob first before playback — wasteful for
large recordings.

### Surfaces
- **Mint (super-admin, bearer-protected):**
  `POST /api/admin/calls/recordings/:id/playback-token` →
  `{ recording_id, url, token, disposition, expires_at, ttl_seconds }`.
  Body/query may include `disposition` (`inline` default, `attachment`
  allowed). Returns 404/410 if the recording/storage is missing so the
  operator sees the failure at mint time, not on first Range request.
- **Stream (token-validated, NOT under `/api/admin`):**
  `GET /api/calls/recording-playback/:id?token=…&disposition=…`.
  Mounted at `recordingPlaybackRouter` in `server/index.ts`. Validates
  the HMAC token (id, disposition, exp) and reuses the canonical
  `downloadFileRange` helper — Range support is preserved end-to-end.

### Token model
- Stateless HMAC-SHA256 over `v1.<rid>.<disposition>.<exp>`.
- Signing key derives from the server-only service-role secret via
  domain-separated HMAC. Never exposed to the browser; rotates if the
  service-role secret rotates.
- TTL default 300s, hard cap 900s, minimum 30s.
- Bound to one recording id and one disposition. Reusable inside the
  TTL (so media elements can issue many Range requests), invalid
  after expiry without client cleanup.
- An `inline`-only token cannot be escalated to a forced download —
  the streaming route ignores `?disposition=attachment` for inline
  tokens.

### Frontend
- `RecordingRetentionPanel` → `InlinePreview` now prefers the
  tokenized URL when the row metadata (recording_type / extension)
  unambiguously identifies audio vs video.
- Falls back to the existing authenticated Blob + object-URL path if
  mint fails or the row is too ambiguous to pre-commit to an element.
- Open/Save buttons continue to use the bearer-protected Blob path —
  unchanged.

### Read-only guarantees preserved
- No writes to `call_recordings`, no edits to `retention_expires_at`,
  no deletes from storage.
- Retention janitor remains the sole deletion path.
- Provider URLs and credentials never leave the backend.

### Still deferred after the tokenized playback pass
- Waveform/timeline UI, annotations, comments.
- Per-recording retention overrides.
- Operator-side visibility.
- Optional legacy backfill UI.

## Bulk legal-hold (super-admin)

Narrow bulk operability surface — the ONLY field mutated is
`legal_hold`. Janitor remains the sole deletion path; this surface
cannot delete, edit `retention_expires_at`, or backfill legacy rows.

### Backend
`POST /api/admin/calls/recordings/legal-hold/bulk`

Body: `{ ids: string[] (1..200, uuid), enabled: boolean, reason?: string }`

- `enabled` is a deterministic SET, not a toggle. All supplied ids end
  in that state regardless of prior value (safe for mixed selections).
- Missing ids are reported per-id under `failures` with `not_found`;
  the call still returns 200 with the `succeeded` ids.
- One `audit_logs` row per successfully-updated id, reusing the same
  action keys as the per-row endpoint (`bulk: true` in `new_value`).

### Frontend
- Per-row selection checkbox + "select all visible" in the Recordings
  tab. Selections are scoped to the current page — changing
  filters/pages drops out-of-view selections.
- Bulk action bar appears only when at least one row is selected.
  Buttons: **Set legal hold ON**, **Set legal hold OFF**, **Clear**.
  Optional reason input is forwarded verbatim.
- Result summary shows succeeded count and any failures.

### Still deferred after the bulk legal-hold pass
- Bulk delete / bulk retention edits (intentionally absent).
- Per-recording retention overrides → implemented (see next section).
- Operator-side visibility.
- Waveform/timeline UI, annotations, comments.
- Optional legacy backfill UI.

## Per-recording retention override (super-admin)

Single-row override for `retention_expires_at` / `retention_policy` on
an already-existing recording. Strict, narrow, super-admin only. No
bulk surface and no implicit backfill — legacy/unmanaged rows are
only modified through an explicit per-row override.

### Backend
`POST /api/admin/calls/recordings/:id/retention-override`

Body (discriminated union on `mode`):
- `{ mode: 'exact',         expires_at: <ISO>,  reason?: string }`
- `{ mode: 'days_from_now', days: <0..3650>,    reason?: string }`
- `{ mode: 'unlimited',                          reason?: string }`

Effects:
- `unlimited` → `retention_expires_at = NULL`, `retention_policy =
  'override:unlimited'`. The janitor's existing partial index already
  treats NULL as "never expires".
- `exact` → writes the supplied ISO and stamps `retention_policy =
  'override:exact'`.
- `days_from_now` → `now() + days`, stamped as `override:Nd`.
- `legal_hold` is **never** touched. Legal hold still wins — an
  expired override on a held row will not be deleted until the hold
  is released, exactly as before.
- One `audit_logs` row per call with action
  `call_recording.retention.override`.

Clearing an override is now supported as an explicit, operator-
triggered action — see "Restore to inherited retention" below.

### Frontend
- Per-row "Override" button in the Expires cell of the Recordings tab.
- Dialog with three modes (Days from now / Exact date-time /
  Unlimited) and an optional reason.
- Rows whose `retention_policy` starts with `override:` get an
  inline "Overridden (…)" tag below the expiry date.
- No bulk surface, no clear-override, no delete shortcut.

### Still deferred after the per-recording override pass
- Bulk retention edits / bulk delete.
- Clear-override / restore-to-inherited → implemented (see next section).
- Optional legacy backfill UI.
- Operator-side visibility.
- Waveform/timeline UI, annotations, comments.

## Restore to inherited retention (super-admin)

Single-row, explicit, operator-triggered restore that clears a prior
`override:*` stamp and returns the row to the canonical inherited
retention model. Strict, narrow, super-admin only. No bulk surface,
no implicit recomputation, no legacy backfill.

### Restore policy (locked)
- Eligible **only** for rows whose current `retention_policy` starts
  with `override:`. Already-inherited rows (`Nd`, `unlimited`) and
  legacy/unmanaged rows (NULL policy) return **409** — restoring those
  would either be a no-op pretending to act or an implicit legacy
  backfill.
- "Inherited" is defined as the same computation `stampRetention`
  performs at recording insert today, applied to **this** row's
  workspace and anchored at the row's own `created_at`. That is the
  only inherited value the model can express — the original
  creation-time stamp is not preserved separately. The recomputation
  is explicit and operator-triggered, never silent.
- Effects:
  - `retention_policy` ← `<N>d` or `unlimited` (same format the
    LiveKit webhook writes at insert time).
  - `retention_expires_at` ← `created_at + N days` (or `NULL` for
    unlimited), matching the live janitor contract exactly.
  - `legal_hold` is **never** touched and still wins over expiry.
  - One `audit_logs` row per call with action
    `call_recording.retention.restore`, including the resolved
    `inherited_source` and `inherited_days`.
- The retention janitor remains the sole deletion path. Restoring a
  row whose recomputed expiry is already in the past does NOT delete
  it immediately — the janitor will pick it up on its next sweep, and
  only if `legal_hold = false`.
- No retention engine fork: the recomputation reuses
  `resolveEffectiveRecordingRetentionDays()` and
  `computeRetentionExpiresAt()`, the exact functions used at insert.

### Backend
`POST /api/admin/calls/recordings/:id/retention-restore`
Body: `{ reason?: string }`

### Frontend
- Per-row "Restore inherited" button rendered in the Expires cell of
  the Recordings tab, **only** for rows whose `retention_policy`
  starts with `override:`.
- Small confirmation dialog with an optional reason.
- No bulk surface, no delete shortcut.

### Still deferred after the restore-to-inherited pass
- Bulk retention edits / bulk delete.
- Operator-side visibility.
- Waveform/timeline UI, annotations, comments.

## Legacy adoption (single-row backfill) — implemented

Narrow, one-row-at-a-time path for adopting legacy/unmanaged recordings
(those with `retention_expires_at IS NULL` AND `retention_policy IS NULL`)
into the managed retention model. There is **no bulk adoption, no
implicit backfill, and no scheduled adoption** — every adopted row is
the result of one explicit super-admin click.

### Adoption policy
- Eligible **only** for rows that are legacy/unmanaged. Already-managed
  rows (any non-null `retention_policy`, including `unlimited` and
  `override:*`) return `409 not_legacy`.
- "Adopted" means the SAME computation `stampRetention` performs at
  insert time: `resolveEffectiveRecordingRetentionDays(workspaceId)` +
  `computeRetentionExpiresAt(row.created_at, days)`. Reuses the single
  canonical helper — no second retention engine.
- Writes `retention_policy = '<N>d' | 'unlimited'` and
  `retention_expires_at = created_at + Nd` (NULL for unlimited).
- `legal_hold` is never touched and still wins over expiry.
- If the recomputed expiry is already in the past, the row simply
  becomes janitor-eligible on the next sweep. The janitor remains the
  sole deletion path; adoption itself never deletes.
- Audit-logged as `call_recording.retention.adopt` with
  `{ inherited_source, inherited_days, reason }`.

### Backend
`POST /api/admin/calls/recordings/:id/retention-adopt`
Body: `{ reason?: string }`

### Frontend
- Per-row "Adopt retention" button rendered in the Expires cell of the
  Recordings tab, **only** for legacy/unmanaged rows.
- Compact confirmation dialog explaining the inherited-retention model
  and the past-expiry → janitor-eligible consequence.
- No bulk surface, no delete shortcut, no legal-hold mutation.

### Still deferred after the legacy adoption pass
- Bulk retention edits / bulk legacy adoption / bulk delete.
- Operator-side visibility. *(implemented — see below)*
- Waveform/timeline UI, annotations, comments.

## Operator-side recording visibility — implemented (read-only)

Workspace-scoped, read-only access to call recordings for non-super-admin
operators. This is the smallest correct surface: list + inline playback
only. Retention, legal-hold, override, restore, adopt, and delete remain
exclusive to the super-admin Recordings tab.

### Permission model
- Gated by the same workspace-membership check (`is_workspace_member` RPC)
  that already protects `/api/call-center/calls/:id`. No new role was
  introduced — recording metadata was already visible on the call detail
  view; this pass upgrades that metadata to a playable artifact for the
  same audience.
- Cross-workspace access (recording id from another workspace, or a
  recording id paired with a call id from another session) returns a
  uniform `404 not_found` — never a `403`, to avoid leaking the
  existence of out-of-scope recordings.

### Operator backend surface
- `GET  /api/call-center/calls/:id/recordings?workspaceId=...` — lists
  artifact metadata (`id`, `recording_type`, `duration_seconds`,
  `size_bytes`, `created_at`, `has_storage`). `storage_path`, provider
  identifiers, retention fields, and legal-hold flags are never returned.
- `POST /api/call-center/calls/:id/recordings/:recordingId/playback-token`
  — mints a short-lived HMAC token (default 5 min, 15 min cap) bound to
  the recording id and hard-coded to `disposition='inline'`. Operators
  cannot mint attachment-disposition tokens; that remains super-admin
  only on `/api/admin/calls/recordings/:id/playback-token`.
- Streaming reuses the existing public route
  `GET /api/calls/recording-playback/:id?token=...`, which validates the
  HMAC and proxies bytes through the same canonical
  `downloadFileRange` storage helper as the super-admin path. Range
  requests are honored. No second playback engine, no provider URL
  exposure.

### Operator frontend surface
- Rendered inline in the Call detail sheet of `Call Center → Calls`,
  inside the existing Recording panel (the previous "Playback/download
  will be added later" placeholder is replaced).
- Per artifact: load-on-demand "Load playback" button → native
  `<audio>` or `<video>` element using the tokenized URL. No download
  button, no admin controls, no retention badges.
- Empty/loading/error states are explicit and bounded.

### Safeguards
- Janitor remains the sole deletion path; this surface never writes to
  `call_recordings` or storage.
- Retention semantics, capability keys, env vars, routes, and schema
  are unchanged.
- Tokens minted on the operator path always carry `disposition='inline'`
  in their signed claim; the streaming route refuses to escalate to
  `attachment` even if the query string is tampered with.

### Still deferred after the operator-visibility pass
- Bulk retention edits / bulk legacy adoption / bulk delete.
- Waveform/timeline UI, annotations, comments.
- Operator-side download. *(implemented — see below)*

## Operator-side recording download — implemented (read-only)

Workspace-scoped, explicit, read-only export of a single recording the
operator can already view. The smallest correct surface: one additional
token mint route that reuses the canonical streaming/storage path.

### Permission model
- Gated by `requireCallOperator` — the same gate that protects every
  other operator write/action on the Call Center router (start/stop
  recording, agent status, callback handling). Strictly stronger than
  the read-only `requireMember` gate used for the inline mint, by
  intent: download is an explicit export action, not passive viewing.
- Cross-workspace / cross-call mismatches return a uniform `404
  not_found`, matching the inline-mint behavior — no existence leak.
- The janitor remains the sole deletion path; this surface never
  writes to `call_recordings` or storage.

### Operator backend surface
- `POST /api/call-center/calls/:id/recordings/:recordingId/download-token`
  — mints a short-lived HMAC token bound to the recording id with
  `disposition='attachment'`. Same TTL, same signer, same canonical
  token model as the inline mint; only the disposition claim differs.
- Streaming reuses the existing public route
  `GET /api/calls/recording-playback/:id?token=...`. The disposition
  claim is enforced server-side — an inline-only token cannot be
  escalated to attachment by tampering with the query string, and an
  attachment token never exposes provider URLs or storage paths.

### Operator frontend surface
- One additional "Download" button next to the existing "Load playback"
  button in the per-recording row of the Call detail sheet. Visible
  only when `has_storage === true`.
- Clicking mints a fresh attachment-scoped token and triggers a save
  via a transient anchor element — no new player, no bulk selection,
  no admin controls.

### Safeguards
- No retention, legal-hold, override, restore, adopt, or delete
  surface is added on the operator side.
- Inline playback behavior is unchanged.
- No route/env/schema/capability-key rename.
- Token TTL, signer, and disposition enforcement are reused verbatim
  from the existing super-admin tokenized playback model.

### Still deferred after the operator-download pass
- Bulk retention edits / bulk legacy adoption / bulk delete.
- Bulk download / multi-select export. *(implemented — see below)*
- Waveform/timeline UI, annotations, comments.

## Operator-side bulk download / multi-select export — implemented (read-only)

Smallest safe orchestration around the existing per-row operator
download mint: selecting multiple recordings on the Call detail sheet
and exporting them in one action. No archive is generated server-side
and no second access path is introduced.

### Permission model
- Same gate as single-row download (`requireCallOperator`).
- Bulk endpoint validates every recording id against the URL's call id
  and the caller's workspace via the existing
  `call_sessions!inner(workspace_id)` join. Any mismatch is reported
  per id as `error: 'not_found'` — the uniform existence-leak-free
  response the inline/single-row mint already uses.

### Operator backend surface
- `POST /api/call-center/calls/:id/recordings/bulk-download-tokens`
  - Body: `{ workspaceId, recording_ids: string[] }`
  - Hard cap: 25 ids per request (`too_many_recordings` on overflow).
  - Empty input → `400 recording_ids_required`. Non-UUID id →
    `400 invalid_recording_id` (rejected before any lookup).
  - Duplicate ids are deduped server-side.
  - Per-id result: either a tokenized URL (same shape as the single
    download-token mint, `disposition='attachment'`) or
    `{ recording_id, error: 'not_found' | 'missing_storage_path' | 'lookup_failed' }`.
  - Tokens are minted via the same canonical `mintPlaybackToken` helper
    — same TTL, same signer, same id-bound, same disposition-claim
    enforcement on the streaming route.
- No new streaming route, no archive job, no provider URL exposure,
  no storage_path leakage.

### Operator frontend surface
- Per-recording checkbox in the Call detail sheet's Recordings panel,
  plus a single "Download selected (N)" button.
- Selection is bounded to rows the operator can already preview
  (`has_storage === true`). The bulk button is disabled at 0 selected.
- On click: one bulk-mint request → the client triggers a transient
  anchor click per successful result, with a small stagger so browsers
  don't drop concurrent navigations. Partial failures are surfaced in
  a single destructive toast (`N started, M failed`).
- No new playback engine, no admin controls, no bulk delete or
  retention mutation.

### Safeguards
- Janitor remains the sole deletion path; bulk export never writes to
  `call_recordings` or storage.
- No route/env/schema/capability-key rename; the existing single-row
  download-token route and per-row UI are unchanged.
- Inline playback behavior is unchanged.
- A single bad id never poisons the batch: per-id results isolate
  failure modes.

### Still deferred after the bulk-download pass
- Bulk retention edits / bulk legacy adoption / bulk delete.
- Cross-call / cross-workspace bulk export (intentionally scoped to one
  call's recordings per request).
- Waveform/timeline UI, annotations, comments.

## Operator-side archive (ZIP) export — implemented (read-only)

Operators can package the same selection they could already bulk-download
into a single ZIP file with one click. This is a packaging convenience,
not a new access surface — the same operator gate, same per-id
workspace/call validation, and the same canonical storage abstraction
are reused.

### Archive policy (locked)
- Available to any workspace member who already passes
  `requireCallOperator` for the target call.
- Scope: one call per request (page/call-scoped). No cross-call,
  no cross-workspace export.
- Hard caps per request: `ARCHIVE_LIMIT = 25` ids,
  `ARCHIVE_MAX_TOTAL_BYTES = 500 MB` of payload.
- Method: STORE-only (no DEFLATE) — recordings are already-compressed
  media, so STORE keeps memory bounded and avoids a third-party
  archive dependency.
- Delivery: built in memory and sent as a single
  `application/zip; attachment` response. No persistent artifact is
  created on disk or in storage. No temporary lifetime to manage.
- Partial-failure model: any id that fails (not found, cross-workspace,
  cross-call, missing storage, download failure, size cap exceeded) is
  omitted from the ZIP and logged in an inline `manifest.txt`. The
  request only 404s if zero recordings could be safely packaged.

### Operator backend surface
- `POST /api/call-center/calls/:id/recordings/archive`
  - Body: `{ workspaceId, recording_ids: string[] }`.
  - Auth: workspace operator gate (same as bulk-download-tokens).
  - Reads bytes via the canonical `downloadFile(...)` storage helper —
    never a raw provider URL/credential.
  - Returns `application/zip` with `Content-Disposition: attachment`,
    plus `X-Archive-Included` / `X-Archive-Excluded` headers.
  - Cross-workspace or cross-call ids return the same uniform
    `not_found` exclusion in `manifest.txt`, with no existence leak.

### Operator frontend surface
- "Download ZIP" button appears next to the existing "Download selected"
  button in the call detail sheet's recordings panel.
- Uses the same selection state as bulk download; existing per-row
  playback and per-row download flows are unchanged.
- Shows pending state, success toast, and a partial-success toast
  pointing at `manifest.txt` when any rows were excluded.

### Safeguards
- Retention semantics did not change; janitor remains the sole deletion
  path; this surface never writes to storage or `call_recordings`.
- No route/env/schema/capability-key rename. Existing single-file and
  bulk-token-mint flows are intact.
- No raw provider URL or storage path leaks into the response,
  archive entries, or `manifest.txt` (only the in-archive basename).
- Hard caps prevent runaway memory use; entries above the size cap
  are excluded with a clear `manifest.txt` reason.

### Still deferred after the archive export pass
- Bulk retention edits / bulk legacy adoption / bulk delete.
- Cross-call / cross-workspace archive export.
- Streaming/chunked archive responses (current implementation builds
  the ZIP in memory under the 500 MB cap).
- Waveform/timeline UI, annotations, comments.

## Storage-provider correctness pass

### Policy (locked)
- New `call_recordings` rows MUST stamp `storage_provider` with the
  workspace's effective storage provider, resolved through the canonical
  `resolveStorageConfig(serverConfig, workspaceId)` helper in
  `server/services/storage/index.ts`. No second provider-resolution path
  is introduced; no vendor is hardcoded at the write site.
- Read paths (admin proxy, operator playback/download, archive, janitor)
  continue to resolve the workspace's *current* effective provider via
  `downloadFile` / `deleteFile`. The `storage_provider` column is
  metadata for auditing — it does NOT route reads.
- Legacy rows that pre-date this fix retain whatever historical tag they
  were stamped with. They are never silently re-stamped or migrated.
- LiveKit egress still physically writes to its configured S3-compatible
  bucket (`livekit_config.recording_storage`). That backend remains the
  storage substrate; this pass only fixes the metadata stamp so audits
  no longer falsely report every recording as `s3` regardless of the
  workspace's effective provider (e.g. `bunny_storage`, `cloudflare_r2`,
  `minio`, `do_spaces`, `local`).

### Change applied
- `server/routes/livekitWebhook.ts` (egress_started handler): replaced the
  hardcoded `storage_provider: 's3'` with the resolved provider name from
  `resolveStorageConfig(config, session.workspace_id)`. Resolution
  failure falls back to `'local'` and never blocks recording ingest.
  Insert metadata gains `storage_provider_source: 'workspace_effective'`
  so newly-stamped rows are distinguishable in audits.

### Still deferred
- Backfill / re-stamp of legacy rows.
- Routing reads by the stamped `storage_provider` column instead of the
  workspace-current resolver (would require per-row credential snapshots
  and is out of scope for this correctness pass).

## Call Center i18n label fix

- Added `nav.callCenter` (operator nav) and `admin.nav.callCenter`
  (super-admin nav) to all three shipped locales (`en`, `fa`, `tr`) in
  `src/i18n/locales/`. The raw `nav.callCenter` token no longer leaks
  into either navigation surface.
- `src/components/layout/CallCenterLayout.tsx` page title now reads from
  `t('nav.callCenter')` with the previous literal as a safety fallback.

## Recording Timeline / Waveform UX (read-only)

A shared read-only playback enhancement was introduced at
`src/components/recordings/RecordingTimeline.tsx` and adopted on the two
existing recording playback surfaces:

- Super-admin Voice & Video Center recordings preview
  (`src/components/admin/calls/RecordingRetentionPanel.tsx`,
  tokenized streaming branch only).
- Operator call-detail recordings panel
  (`src/pages/app/call-center/CallsPage.tsx`).

### Scope (strict)
- Wraps — does not replace — the existing native `<audio>`/`<video>`
  element. Tokenized streaming and Range requests are unchanged.
- Adds a click-to-seek progress bar, hover-time preview, ±10s skip
  controls, and a current/duration readout.
- Renders a deterministic decorative bar field derived from the
  recording id; it is explicitly NOT a decoded waveform (no full-file
  download, no `AudioContext.decodeAudioData`, no provider URLs).
- Falls back silently when duration metadata is unavailable.
- Removes its event listeners on unmount; creates no object URLs.

### Out of scope (still deferred)
- Real decoded waveform / amplitude rendering.
- Annotations, comments, markers, chapters.
- Bulk retention edits, bulk legacy adoption, bulk delete.
- Cross-workspace export (workspace-scoped multi-call export now exists; see below).
- Streaming/chunked ZIP responses above the in-memory archive cap.
- Legacy `call_recordings.storage_provider` backfill.

## Workspace-scoped multi-call archive export (read-only)

Extends the single-call archive surface to a bounded multi-call export
inside one authorized workspace.

- Route: `POST /api/call-center/workspaces/recordings/archive`
  Body: `{ workspaceId, items: Array<{ call_id, recording_id }> }`
- Authorization: `requireCallOperator(req, res, workspaceId)` — same gate
  the per-row playback/download and single-call archive routes use.
- Per-item validation: every `{ call_id, recording_id }` pair is re-checked
  against `call_recordings.id`, `call_session_id`, and
  `call_sessions.workspace_id`. Cross-workspace and cross-call items
  return a uniform `not_found` exclusion in the manifest — no existence
  leak, no token leak, no provider URL leak.
- Caps (identical to single-call archive): `ARCHIVE_LIMIT=25` items per
  request, `ARCHIVE_MAX_TOTAL_BYTES=500 MB` total uncompressed payload.
- Partial-failure model: included items are packaged; excluded items are
  listed in `manifest.txt` with their reason
  (`not_found` / `missing_storage_path` / `download_failed` /
  `archive_size_cap_exceeded`). Zero successes returns a structured
  `404 no_recordings_available` instead of an empty archive.
- Archive layout: files are grouped under `call-<call_id[:8]>/...` to
  avoid filename collisions across calls. Only sanitized basenames
  (`safeArchiveName`) appear inside the ZIP; no storage paths.
- Bytes flow through the canonical `downloadFile` storage abstraction —
  raw provider URLs and credentials are never exposed.
- Retention, legal-hold, override, and deletion semantics are unchanged.
  The janitor remains the sole deletion path.

### UI surface
- Operator Calls page (`src/pages/app/call-center/CallsPage.tsx`): adds a
  per-row checkbox to the calls table and one explicit
  "Export selected (ZIP)" header action. The client resolves recordings
  per selected call via the existing `listCallRecordings` endpoint,
  flattens to `items[]`, caps at 25, and posts to the workspace route.
- The single-call "Download ZIP" action inside the call-detail panel and
  all per-row playback/download flows remain unchanged.

### Still deferred after this pass
- Cross-workspace export.
- Streaming/chunked ZIP responses above the in-memory archive cap.
- Bulk retention edits, bulk legacy adoption, bulk delete.
- Annotations / comments / decoded waveforms.
- Legacy `call_recordings.storage_provider` backfill / re-stamp.
