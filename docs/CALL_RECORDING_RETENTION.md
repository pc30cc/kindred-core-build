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
