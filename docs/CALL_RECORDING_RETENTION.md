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