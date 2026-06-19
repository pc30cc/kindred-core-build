# Storage Limit Policy (`storage_gb`)

_Status: **counter producer installed.** Rollout (attaching `requireLimit`)
remains a separate follow-up phase. No route gating in this phase._

See `docs/STORAGE_COUNTER_ARCHITECTURE.md` for the canonical producer
design, double-counting safeguards, and the explicit decision to skip
historical backfill.

## Locked semantics

`storage_gb` is the per-workspace cumulative size of stored bytes
attributed to the workspace. The plan value is **GB**; the underlying
counter (`workspace_usage_counters.storage_bytes`) is **bytes**. The
resolver `resolveStorageGb` (`server/services/billing/usageResolvers.ts`)
already converts bytes → GB and is the single source of truth for the
`requireLimit` middleware via `usageFnForLimit('storage_gb')`.

Counter shape:

- One row per `(workspace_id, period)` in `workspace_usage_counters`.
- For `storage_gb` the cap is **cumulative**, not period-scoped — a
  stored byte continues to consume the cap until the file is deleted.
- Therefore the producer must increment on upload **and** decrement on
  delete. Period rollover does NOT reset `storage_bytes`.

## What counts toward `storage_gb`

Any byte the platform persists on behalf of a workspace through the
server-resolved storage provider. Concretely:

- Operator/internal uploads (`POST /api/storage/upload`).
- Conversation attachments (`POST /api/conversation-attachments/:id/upload`).
- Widget visitor attachments (`server/routes/widgetAttachments.ts`).
- Anything that ultimately calls `uploadFile()` in
  `server/services/storage/index.ts`.

Does **not** count:

- External media URLs referenced but not persisted (e.g. third-party
  image links pasted into messages).
- Provider-managed system buckets (LiveKit recordings written by an
  external provider, etc.) until/unless we explicitly opt them in.
- Database rows / log tables — only blob storage.

## Counter producer status — **the blocker**

`workspace_usage_counters.storage_bytes` now has exactly one canonical
writer: the trigger `trg_storage_usage_logs_apply` on
`storage_usage_logs`, defined in the migration that accompanies this
phase. It increments on successful uploads with a non-null `file_size`,
decrements on successful deletes (clamped at zero), and carries the
prior month's value forward across period rollover. `deleteFile()` was
updated to resolve `file_size` from the most recent successful upload
log for the same `(workspace_id, file_key)` so deletes decrement
exactly. Backfill is intentionally skipped — see the architecture doc.

Until `requireLimit` is wired to an actual upload route in a follow-up
phase, no upload is yet gated. The counter is, however, now live and
will populate from new traffic.

## Cap-reached product policy (locked, applies once producer ships)

- Operator-side `POST /api/storage/upload`: hard 403 via `requireLimit`.
- `POST /api/conversation-attachments/:id/upload`: hard 403 via
  `requireLimit`. Existing attachments and downloads remain unaffected.
- Widget visitor attachments: hard 403 is acceptable but must surface
  through the widget runtime as a friendly "uploads disabled" UX, not
  a raw error. Until that UX exists this branch stays deferred even
  after the producer ships.
- Reads (`GET /api/storage/...`, attachment downloads) are never gated.
- `DELETE` paths are never gated — deletes free space.

## Resolution path (next phase)

The next storage phase must, in this order:

1. ✅ **Done in this phase.** Canonical single-writer producer
   (`apply_storage_usage_log` trigger) installed; `deleteFile` updated
   to record freed `file_size`. Period semantics aligned with the
   resolver via current-month rows + carry-forward seeding.
2. Backfill is intentionally **skipped** — historical delete rows
   lack `file_size`, so any backfill would over-count. The counter is
   forward-correct only.
3. Attach `requireLimit('storage_gb', usageFnForLimit('storage_gb'))`
   to **`POST /api/storage/upload`** as the first rollout site
   (operator-authenticated, lowest-UX-risk).
4. Conversation attachments next, in a separate phase.
5. Widget attachments last, paired with widget-runtime UX for the 403.

Until step 3 lands, no upload route is gated.

## Hard rules

- The producer, once shipped, is the **only** writer of
  `storage_bytes`. No route may inline-increment the counter.
- The resolver may not be widened to read alternative columns.
- `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` is the
  only gate; no ad-hoc storage math in route handlers.
