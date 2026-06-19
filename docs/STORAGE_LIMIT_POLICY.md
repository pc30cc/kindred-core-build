# Storage Limit Policy (`storage_gb`)

_Status: **DEFERRED — counter producer missing.** No route gating in this phase._

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

`workspace_usage_counters.storage_bytes` has **no producer today.** The
column defaults to `0` and is never written.

Evidence:

- The migration that created the column
  (`supabase/migrations/20260415220905_*.sql`) declares
  `storage_bytes bigint NOT NULL DEFAULT 0` and adds **no trigger**.
- `server/services/storage/index.ts` writes `storage_usage_logs` rows
  on upload/delete but never updates `workspace_usage_counters`.
- No application-side increment of `storage_bytes` exists anywhere in
  `server/`.
- Resolver `resolveStorageGb` reads the counter directly:
  `bytes / 1024^3` → for every workspace today this is **always 0**.

Consequence: attaching `requireLimit('storage_gb', usageFnForLimit('storage_gb'))`
to any upload route right now would be a **silent no-op** — the cap is
structurally unreachable. Worse, the moment a producer is later added,
gating would activate retroactively across every wired route at once,
producing a hard breakage rather than a controllable rollout.

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

1. Add a canonical single-writer producer for `storage_bytes`. The
   chosen approach is a Postgres trigger on `storage_usage_logs` that:
   - On `INSERT` with `operation='upload'` AND `success=true`:
     `storage_bytes += file_size`.
   - On `INSERT` with `operation='delete'` AND `success=true`:
     `storage_bytes -= file_size` (clamped to ≥ 0). Requires the delete
     log row to record the freed `file_size`, which the current code
     does **not** do — this must be fixed in the same migration.
   - Period key is the cumulative bucket (e.g. `'all-time'`) so that
     rollover does not zero the counter. Resolver must be aligned to
     read the same period.
2. Backfill `storage_bytes` from existing `storage_usage_logs` (sum of
   successful uploads minus successful deletes) so the counter starts
   accurate, not zero.
3. Only then attach `requireLimit('storage_gb', usageFnForLimit('storage_gb'))`
   to **`POST /api/storage/upload`** as the first rollout site
   (operator-authenticated, lowest-UX-risk).
4. Conversation attachments next, in a separate phase.
5. Widget attachments last, paired with widget-runtime UX for the 403.

Until step 1 lands, no upload route should be gated.

## Hard rules

- The producer, once shipped, is the **only** writer of
  `storage_bytes`. No route may inline-increment the counter.
- The resolver may not be widened to read alternative columns.
- `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` is the
  only gate; no ad-hoc storage math in route handlers.
