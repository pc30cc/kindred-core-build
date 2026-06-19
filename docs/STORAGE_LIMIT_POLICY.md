# Storage Limit Policy (`storage_gb`)

_Status: **rolled out** on every byte-creating upload route. Reads,
deletes, and config probes are never gated._

See `docs/STORAGE_COUNTER_ARCHITECTURE.md` for the canonical producer
design, double-counting safeguards, and the explicit decision to skip
historical backfill.

## Locked semantics

`storage_gb` is the per-workspace cumulative size of stored bytes
attributed to the workspace. The plan value is **GB**; the underlying
counter (`workspace_usage_counters.storage_bytes`) is **bytes**. The
resolver `resolveStorageGb` (`server/services/billing/usageResolvers.ts`)
converts bytes → GB and is the single source of truth for the
`requireLimit` middleware via `usageFnForLimit('storage_gb')`.

Counter shape:

- One row per `(workspace_id, period)` in `workspace_usage_counters`.
- For `storage_gb` the cap is **cumulative**, not period-scoped — a
  stored byte continues to consume the cap until the file is deleted.
- The producer increments on upload **and** decrements on delete.
  Period rollover does NOT reset `storage_bytes`; the prior period's
  value is carried forward by the trigger.

## What counts toward `storage_gb`

Any byte the platform persists on behalf of a workspace through the
server-resolved storage provider. Concretely, anything that ultimately
calls `uploadFile()` in `server/services/storage/index.ts`:

- Operator/internal uploads (`POST /api/storage/upload`).
- Conversation attachments (`POST /api/conversation-attachments/:id/upload`).
- Widget visitor attachments (`POST /api/widget/attachments/:id/upload`).

Does **not** count:

- External media URLs referenced but not persisted.
- Provider-managed system buckets (LiveKit recordings, etc.) until/
  unless we explicitly opt them in.
- Database rows / log tables — only blob storage.

## Canonical producer

Single writer of `workspace_usage_counters.storage_bytes`: the trigger
`trg_storage_usage_logs_apply` on `storage_usage_logs`. Increments on
successful uploads with a non-null `file_size`, decrements on
successful deletes (clamped at zero), carries the prior month's value
across period rollover. `deleteFile()` resolves `file_size` from the
most recent successful upload log for the same `(workspace_id,
file_key)` so deletes decrement exactly.

Backfill is intentionally **skipped**: historical delete rows lack
`file_size`, so any backfill would systematically over-count. The
counter is **forward-correct only** — existing workspaces effectively
start at zero and accumulate forward. This is the conservative tradeoff
documented in the counter architecture doc.

## Rolled-out gates

| Route                                              | Surface         | Cleanup on 403                                  |
|----------------------------------------------------|-----------------|-------------------------------------------------|
| `POST /api/storage/upload`                         | Operator/server | none (no reserved row)                          |
| `POST /api/conversation-attachments/:id/upload`    | Operator        | reserved row → `status='failed'`                |
| `POST /api/widget/attachments/:id/upload`          | Visitor/widget  | reserved row → `status='failed'`                |

All three gates use the shared
`requireLimit('storage_gb', usageFnForLimit('storage_gb'))` invoked
inline, after auth/path/size validation, immediately before
`uploadFile()`. Plans with `storage_gb = -1` (unlimited) skip the usage
comparison.

For widget uploads, `workspace_id` is the server-resolved one from the
validated widget token (X-Widget-Token + cookie); it is injected into
`req.body.workspace_id` solely so the shared `extractWorkspaceId()`
helper sees the trusted value.

## Routes intentionally never gated

- `POST /api/storage/delete`, `DELETE /api/conversation-attachments/:id`
  — frees bytes; gating would block quota recovery.
- `POST /api/storage/test` — config probe; logs are best-effort.
- `GET /api/storage/...`, attachment downloads,
  `enrichMessagesWithAttachments` — read-only.
- `POST /api/conversation-attachments/init`,
  `POST /api/widget/attachments/init` — reserve a DB row only; no bytes
  persisted. Gating here would split enforcement across two endpoints.

## Hard rules

- The trigger is the **only** writer of `storage_bytes`. No route may
  inline-increment the counter.
- The resolver may not be widened to read alternative columns.
- `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` is the
  only gate; no ad-hoc storage math in route handlers.
- Cap-reached widget UX is the standard `requireLimit` 403 — no
  bespoke error mapping. A friendlier visitor-facing UX (retry
  disable, telemetry banner) remains future work.
