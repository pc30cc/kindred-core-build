# Workspace Usage Metrics — Shared Resolver

_Backend foundation for `requireLimit(...)` enforcement._

## Why

Phase 1 enforcement (see `ENFORCEMENT_COVERAGE_AUDIT.md`) deferred most
`requireLimit(...)` candidate routes because there was no single backend
helper that could answer "how much of this limit has the workspace
already consumed in the current period?".

`server/services/billing/usageResolvers.ts` is now that helper. Future
route gating MUST consume it — no ad-hoc usage queries inside route
handlers.

## Public API

```ts
import {
  resolveUsage,
  isUsageSupported,
  listUsageSupport,
  usageFnForLimit,
  currentMonthPeriod,
} from 'server/services/billing/usageResolvers';
```

- `resolveUsage(config, workspaceId, limitKey) → UsageResolution`
  Returns `{ value, period, periodKind, source, isExact, supported, reasonIfUnsupported, note }`. Never throws.
- `usageFnForLimit(limitKey) → (req, workspaceId) => Promise<number>`
  Adapter that plugs straight into the existing `requireLimit(feature, currentUsageFn)` middleware contract.
- `listUsageSupport()` — snapshot for diagnostics.
- `isUsageSupported(limitKey)` — boolean guard.
- `currentMonthPeriod()` — `YYYY-MM` UTC, matches `workspace_usage_counters.period`.

## Supported limit keys

| Limit key | Resolver source | Period | Exact? | Notes |
|---|---|---|---|---|
| `max_conversations` | `workspace_usage_counters.conversations_count` | calendar month | yes | Pre-aggregated counter; missing row → 0. |
| `max_visitors` | `workspace_usage_counters.visitors_count` | calendar month | yes | Pre-aggregated counter; missing row → 0. |
| `storage_gb` | `workspace_usage_counters.storage_bytes` ÷ 1 GiB | lifetime | yes | Counter is bytes; resolver converts to GB so it can be compared directly to `limits.storage_gb`. |
| `ai_kb_jobs_per_month` | `count(*)` on `ai_kb_jobs` since UTC start of month (delegates to `services/ai-kb/limits.ts`) | calendar month | yes | Reuses the existing `countJobsThisMonth` helper that already gates `POST /api/ai-kb/jobs`. |
| `ai_credits_per_month` | `workspace_usage_counters.ai_credits_used` | calendar month | yes | Pre-aggregated. AI credit deduction goes through `deduct_ai_credits` RPC. |

`isExact: true` means the value is read from a pre-aggregated counter or
from a cheap, deterministic source-table count. Future resolvers that
approximate (e.g. cached aggregates) MUST set `isExact: false` and the
caller must decide whether to fail-closed.

## Intentionally unsupported (so far)

These registry keys have no resolver yet. Calling `resolveUsage` for
them returns `supported: false` with a reason — and `usageFnForLimit`
throws so `requireLimit` fails-closed.

| Limit key | Why deferred |
|---|---|
| `max_agents` | Seat/role semantics need product confirmation before counting `workspace_members`. |
| `max_workspaces` | Enforced at workspace creation, not per-workspace. |
| `ai_kb_max_pages` | Per-job cap, not a workspace-period usage. |
| `ai_kb_max_depth` | Per-job cap, not a workspace-period usage. |
| `ai_kb_file_size_mb` | Per-file cap, not a workspace-period usage. |
| `ai_kb_file_count` | Lifetime file count not yet aggregated. |
| `data_retention_days` | Enforced by janitor jobs; not a usage-vs-limit gate. |

## How to wire `requireLimit(...)` later

```ts
import { requireLimit } from 'server/middleware/featureGating';
import { usageFnForLimit } from 'server/services/billing/usageResolvers';

router.post(
  '/api/.../create',
  requireLimit('max_conversations', usageFnForLimit('max_conversations')),
  handler,
);
```

The middleware's existing fail-closed behaviour (deny when the usage
function throws) is preserved on purpose — unsupported keys must not
silently let traffic through.

## Current consumers

| Route | Limit key | Bypass |
|---|---|---|
| `POST /api/ai-kb/jobs` (`server/routes/aiKb.ts`) | `ai_kb_jobs_per_month` | Route-local Super Admin (`auth.isAdmin`) skips the middleware entirely. |

Phase 3 migrated the AI KB monthly job cap from in-handler counting to
`requireLimit('ai_kb_jobs_per_month', usageFnForLimit('ai_kb_jobs_per_month'))`.
The previous duplicate `countJobsThisMonth` + threshold check in the
handler was removed; the resolver now owns counting.

All other resolver-ready keys (`max_conversations`, `max_visitors`,
`storage_gb`, `ai_credits_per_month`) remain unattached. They need
route-level policy decisions (especially around widget/anonymous
traffic) before middleware is wired up.

`max_conversations` specifically: see
[`CONVERSATION_LIMIT_POLICY.md`](./CONVERSATION_LIMIT_POLICY.md) for
the route-truth audit and the policy decisions required before
`requireLimit('max_conversations', …)` can be attached. The dominant
creator is the public widget (`POST /api/widget/message` /
`/offline-messages`), not the operator route, so isolated gating of
`POST /api/conversations/start-from-visitor` was rejected.

## Adding a new resolver

1. Confirm the metric is either (a) a column on `workspace_usage_counters`,
   or (b) cheaply derivable from a small source table.
2. Implement a `(config, workspaceId) → Promise<UsageResolution>` function
   in `usageResolvers.ts`.
3. Register it in the `RESOLVERS` map.
4. Remove the key from `KNOWN_UNSUPPORTED` if present.
5. Update this document.
6. _Then_ — and only then — attach `requireLimit(key, usageFnForLimit(key))`
   to the relevant route in a separate small PR.

## Non-goals

- This module does **not** mutate counters; increment continues to flow
  through `increment_usage_counter` (RPC) and the per-domain helpers
  (`incrementUsage`, `deduct_ai_credits`, `logAiKbUsage`, storage
  service writes). Read path and write path stay separate on purpose.
- This module does **not** decide policy (what to do at the limit) —
  that remains the middleware's job.
- This module is **backend only**; do not import it from `src/`.