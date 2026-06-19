# Storage Counter Architecture

_Status: **canonical producer installed.** `requireLimit('storage_gb', ...)` rollout remains a separate, follow-up phase._

## Locked semantics

- Unit of truth: `workspace_usage_counters.storage_bytes` (bigint, bytes).
- Resolver: `resolveStorageGb` (`server/services/billing/usageResolvers.ts`) reads bytes for the workspace's current-month row and converts to GB.
- Cap kind: **cumulative current occupancy.** A stored byte keeps consuming the cap until the file is deleted. Period rollover does **not** zero the counter — the producer carries the prior period's value forward when it first writes the new monthly row.
- What counts: every byte persisted via `uploadFile()` in `server/services/storage/index.ts`. That includes operator uploads, conversation attachments, and widget visitor attachments — all upload paths funnel through the same service.
- What does **not** count: external URLs, third-party-managed buckets the platform did not write, database rows, log tables.

## Canonical producer

**Single writer:** Postgres trigger `trg_storage_usage_logs_apply` invoking `public.apply_storage_usage_log()` on `AFTER INSERT` of `storage_usage_logs`.

Behavior:

| operation | success | file_size | Effect on storage_bytes |
|---|---|---|---|
| `upload`  | `true`  | `> 0`     | `+= file_size`                |
| `delete`  | `true`  | `> 0`     | `-= file_size` (clamped at 0) |
| anything else, or `success=false`, or null/zero `file_size` | — | — | **no-op** |

New monthly rows are seeded by carrying forward the most recent prior period's `storage_bytes` value, so cumulative occupancy survives rollover while the resolver continues to read the current-month row unchanged.

## Authoritative write/delete points

- Upload: `uploadFile()` in `server/services/storage/index.ts`. All upload routes (`/api/storage/upload`, `/api/conversation-attachments/:id/upload`, `widgetAttachments`) call this single function, which logs the successful upload **with `file_size = req.data.length`**.
- Delete: `deleteFile()` in the same file. It now resolves `file_size` from the most recent successful upload log row for the same `(workspace_id, file_key)` and includes it on the delete log row, so the trigger can decrement exactly.

No route handler writes the counter directly. There is no inline counter math anywhere in `server/`.

## Double-counting and correctness invariants

- The trigger ignores `success=false` rows, so failed handler calls and retries that did not actually persist bytes do not affect the counter.
- The trigger ignores rows with null/zero `file_size`, so legacy delete rows (and any future log row that genuinely lacks a size) are no-ops rather than guessed decrements.
- A re-upload of the same `file_key` is counted as new bytes (the upload service treats each upload as a fresh persisted blob; there is no overwrite-detection in the storage layer today).
- A delete after a delete: the second delete's `file_size` lookup will still find the original upload row and would emit a second decrement, but the trigger clamps `storage_bytes` at zero, so it cannot drift negative. In practice provider `deleteHandlers` return `success=false` for a missing object on most providers, in which case the trigger is a no-op anyway.
- Decrement is clamped at zero in SQL (`GREATEST(..., 0)`), so any edge case still leaves the counter non-negative.

## Backfill

**Intentionally skipped.** The producer is forward-correct only:

- Historical `storage_usage_logs` delete rows do not carry `file_size`, so a backfill from logs would systematically over-count storage by ignoring deletes whose sizes are unknown.
- Re-deriving from current blob inventories would require provider round-trips that the self-host architecture does not have a generic primitive for.
- The chosen tradeoff: start the counter at zero for existing workspaces (which is the current resolver value anyway) and let real traffic from this point forward populate it accurately.

If, later, a workspace needs an exact recompute we can ship a per-workspace inventory pass — but that is out of scope for the counter-truth phase.

## Resolver alignment

`resolveStorageGb` reads `storage_bytes` for `currentMonthPeriod()`. The producer always writes (or upserts) the current-month row keyed by `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`, which is exactly the same string `currentMonthPeriod()` produces. Carry-forward seeding ensures rollover preserves cumulative occupancy. No resolver change was needed.

## Rollout status

`storage_gb` cap enforcement (i.e. attaching `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` to upload routes) is **not** done in this phase. The counter is now trustworthy for new traffic, which is the precondition for rollout — but the rollout itself remains a separate, narrow follow-up phase, starting with `POST /api/storage/upload`.
