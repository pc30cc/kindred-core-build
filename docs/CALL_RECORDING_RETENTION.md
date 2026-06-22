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
- Per-recording retention overrides.
- Operator-side visibility.
- Waveform/timeline UI, annotations, comments.
- Optional legacy backfill UI.
