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

## Phase 12 — Forward-correct rollout decision (ACCEPTED)

**Decision:** Position **A — Accept forward-correct rollout now**, but
only on the single safest operator-side route.

### Why accepted

- The canonical `storage_bytes` producer (DB trigger on
  `storage_usage_logs`, see `docs/STORAGE_COUNTER_ARCHITECTURE.md`) is
  live and the resolver `resolveStorageGb` reads it as the single source
  of truth. New uploads/deletes are counted exactly.
- Backfill is intentionally skipped because historical delete logs lack
  `file_size`; reconstructing occupancy would over-count and silently
  inflate enforcement against existing workspaces. A wrong backfill is
  worse than a forward-correct start.
- The first rollout site (`POST /api/storage/upload`) is
  operator-authenticated (bearer must equal anon or service-role key).
  It is not reachable from widget/public flows, so a 403 here is
  recoverable through normal operator UX, not visitor-facing breakage.

### Consequence (must be communicated)

- Existing workspaces effectively **start at zero** for `storage_bytes`
  and accumulate forward. They will not hit `storage_gb` caps until
  forward traffic alone fills the plan limit.
- This is a deliberate **conservative** tradeoff: operators are never
  blocked for storage they uploaded before the producer existed.
- Backfill remains a future option once historical `file_size` data is
  reconstructable; it is **not** required to ship Phase 12.

### Route gated in Phase 12

- `POST /api/storage/upload` — single gate using
  `requireLimit('storage_gb', usageFnForLimit('storage_gb'))`, applied
  after the existing bearer-token auth and size validation, before the
  call into `uploadFile()`. No route-local storage math.

### Routes intentionally **not** gated in Phase 12

- `POST /api/conversation-attachments/:id/upload` — operator path, but
  deferred to keep Phase 12 to a single route. Will be gated next phase.
- `widgetAttachments.ts` upload paths — widget/public-facing; deferred
  pending widget-runtime UX for a 403 surface (visitor-side error
  rendering, retry/disable behavior).
- `POST /api/storage/test`, `POST /api/storage/delete`, `GET
  /api/storage/url`, `GET /api/storage/config/:workspaceId` — not
  storage-creation routes; deletes only decrement, the rest read.

### Invariants reaffirmed

- Trigger on `storage_usage_logs` remains the **sole** writer of
  `workspace_usage_counters.storage_bytes`.
- `resolveStorageGb` / `usageFnForLimit('storage_gb')` is the **only**
  usage source for the gate.
- No second producer, no route-local counting, no schema/route/env
  rename, no widget UX change.

## Hard rules

- The producer, once shipped, is the **only** writer of
  `storage_bytes`. No route may inline-increment the counter.
- The resolver may not be widened to read alternative columns.
- `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` is the
  only gate; no ad-hoc storage math in route handlers.

## Phase 13 — conversation-attachment rollout

- Gated route: `POST /api/conversation-attachments/:id/upload`.
- Reuses the exact narrow pattern from Phase 12 (inline `requireLimit`
  invocation, no route-local storage math). Gate runs after operator
  auth, attachment-row ownership checks, and the declared-size guard,
  immediately before `uploadFile()`.
- On a 403 from the gate, the reserved `conversation_attachments` row
  is flipped to `status = 'failed'` so it does not strand in
  `'uploading'`. No counter side-effects (the producer only fires on
  successful `storage_usage_logs` rows, which are not written when the
  upload is blocked).
- Forward-correct policy from Phase 12 is unchanged. No backfill, no
  second producer, no schema/route/env rename.
- Widget/public attachment uploads (`server/routes/widgetAttachments.ts`)
  remain **explicitly deferred**. They require visitor-facing UX for a
  403 (clear error surface, retry/disable behavior) before gating; that
  is a later, UX-aware phase.

## Phase 14 — widget-attachment rollout

### Outcome

**Gated.** Visitor-facing widget attachment uploads now enforce
`storage_gb` on the actual byte-creating branch.

### Route audit

- `POST /api/widget/attachments/init` — reserves a row; **does NOT**
  create stored bytes. Not gated.
- `POST /api/widget/attachments/:id/upload` — **the only** widget
  branch that writes through canonical `uploadFile()`. **Gated.**
- `GET /api/widget/attachments/:id` — read-only proxy. Not gated.
- `enrichMessagesWithAttachments` / `attachUploadedFileToMessage` —
  metadata helpers. Not gated.

Trust at gate time:
- `workspace_id` comes from `resolveWorkspaceId(req, res)` (validated
  X-Widget-Token + dvsid cookie). It is never trusted from the visitor
  body. We inject the resolved id into `req.body.workspace_id` solely
  so the shared `extractWorkspaceId()` helper sees the same trusted
  value the operator routes use.
- Gate runs after token enforcement, row lookup
  (`workspace_id`/status/path checks), and the declared-size guard,
  immediately before `uploadFile()`.

### Visitor-facing cap-reached policy

- Existing attachments and downloads are **unaffected** (no read paths
  gated, no provider behavior change).
- Only **new** widget attachment uploads are denied, with the standard
  `requireLimit` 403 (`{ error, feature: 'storage_gb', limit, ... }`).
  Widget runtime treats this as a generic upload failure — acceptable
  for v1; no bespoke error mapping introduced.
- On rejection the reserved `conversation_attachments` row is flipped
  to `status = 'failed'` (mirrors operator `/conversation-attachments`
  behavior), so the visitor's widget does not see a stranded
  `'uploading'` row and a fresh `/init` is required for retry.
- No counter side-effects: the producer only fires on successful
  `storage_usage_logs` inserts, and those are not written when the
  upload is blocked.

### Invariants reaffirmed

- Canonical `storage_bytes` producer remains the **sole** writer.
- `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` is the
  **only** gate; no route-local storage math.
- Operator-side rollout (Phases 12 & 13) is unchanged. Widget-side was
  the remaining public-sensitive surface and is now closed.
- No schema/route/env/key/middleware rename.
