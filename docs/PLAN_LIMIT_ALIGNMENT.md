# Plan Limit Alignment

_Backfill + seed alignment for resolver-ready limit keys._

## Purpose

`docs/ENFORCEMENT_COVERAGE_AUDIT.md` §7 identified that `requireLimit(...)`
could not be safely attached to any route because resolver-ready limit
keys were missing from `billing_plans.limits`, causing
`check_workspace_entitlement` to fail-closed for every workspace.

This phase fixes the **plan-data** side of that gap. No new route
gates were added.

## Resolver-ready limit keys

Defined in `server/services/billing/usageResolvers.ts` and now mirrored
as `USAGE_BACKED_LIMIT_KEYS` in `server/services/billing/capabilityRegistry.ts`:

- `max_conversations`
- `max_visitors`
- `storage_gb`
- `ai_kb_jobs_per_month`
- `ai_credits_per_month`

## Backfill applied

Migration: `supabase/migrations/<timestamp>_plan_limits_backfill.sql`
(jsonb-additive — `new || existing`, so any pre-existing value wins).

| Plan | max_conversations | max_visitors | storage_gb | ai_credits_per_month | ai_kb_jobs_per_month |
|---|---|---|---|---|---|
| free       | 50    | 1 000   | 1   | 0     | 1 (already seeded) |
| pro        | 1 000 | 50 000  | 5   | 5 000 | 5 (already seeded) |
| enterprise | -1    | -1      | 50  | -1    | 50 (already seeded) |

`-1` means **unlimited** and matches the existing convention used by
`conversations_monthly`, `team_members`, etc.

Values were derived from each plan's existing legacy keys
(`conversations_monthly`, `storage_mb`, `ai_requests_monthly`) so product
semantics are preserved. Legacy keys are intentionally left in place —
nothing in the codebase reads them through the registry, but external
billing/reporting may.

## New plan creation hardening

`POST /api/plans/admin` now runs `normalizePlanLimitsForCreate(limits)`
before insert:

- Resolver-ready keys missing from the payload are filled with the
  registry `defaultValue`.
- Keys the admin supplied (including `-1` / `0`) are preserved as-is.
- All other (legacy / unknown) keys pass through untouched.

`PUT /api/plans/admin/:planId` is **not** auto-normalized — edit flows
must remain a faithful write of the admin's intent. The admin UI (which
is registry-driven since the previous phase) already renders these keys.

## Diagnostics

`GET /api/plans/admin/diagnostics` response now includes:

```jsonc
{
  "registrySize": 33,
  "plansChecked": 3,
  "usageBackedLimitKeys": ["max_conversations", "max_visitors", "storage_gb", "ai_kb_jobs_per_month", "ai_credits_per_month"],
  "usageBackedKeysMissingByPlan": [],   // any drift surfaces here per-plan
  "unknownKeysInDb": [...],             // pre-existing
  "registryKeysMissingEverywhere": [],  // pre-existing
  "invalidLimitValues": []              // pre-existing
}
```

Operators can poll this endpoint to detect drift before it blocks
Phase 3 enforcement.

## Admin-bypass policy recommendation

The audit identified a second blocker: `requireLimit` has no admin
bypass, while `POST /api/ai-kb/jobs` enforces its monthly cap
in-handler with `!auth.isAdmin && jobsUsed >= …`.

**Recommendation: keep admin-bypass route-specific. Do NOT add a
generic admin short-circuit to `requireLimit`.**

Reasons:

1. Admin bypass policy is **not uniform**. Some routes (AI KB jobs,
   ops tooling) want admins to ignore caps; others (conversation
   creation, storage upload) should still count admin usage so
   capacity planning stays honest.
2. The middleware is dependency-light and tested. Threading a bypass
   flag through every callsite invites quiet regressions.
3. Routes that need bypass already have a clean pattern: check
   `auth.isAdmin` next to the existing handler logic, before or
   instead of `requireLimit`.

Concrete migration recipe for an admin-bypass route (when the time
comes to move `POST /api/ai-kb/jobs` to middleware):

```ts
router.post(
  '/jobs',
  async (req, res, next) => {
    const auth = await authorize(req);   // existing
    if (auth.isAdmin) return next();     // explicit bypass
    return requireLimit('ai_kb_jobs_per_month',
                        usageFnForLimit('ai_kb_jobs_per_month'))(req, res, next);
  },
  jobCreateHandler,
);
```

This keeps middleware contracts strict and bypasses local and visible.

## What is now unblocked for Phase 3

- Resolver-ready keys are present on every active plan, so
  `check_workspace_entitlement` returns `allowed: true` with a numeric
  `limit` for them on every workspace.
- New plans created through the admin API will not regress the gap.
- Diagnostics surface drift as it appears.

## What is still intentionally deferred

- Attaching `requireLimit(...)` to any route. That is Phase 3.
- Backfilling `max_agents`, `max_workspaces`, `data_retention_days` —
  these are not usage-resolved and are enforced elsewhere.
- Removing the legacy keys (`conversations_monthly`, `storage_mb`,
  `ai_requests_monthly`). They are harmless and external systems may
  read them; revisit when callers are confirmed migrated.
- Auto-normalizing on plan UPDATE — admin intent must remain explicit.
