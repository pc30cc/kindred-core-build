# Customer-Facing Usage / Plan Visibility

Status: shipped (visibility pass — no backend semantic changes).

## Canonical surface

- Page: `/app/billing` (`src/pages/app/BillingPage.tsx`).
- New default tab: **Plan & Usage**.
- Component: `src/components/billing/PlanUsagePanel.tsx`.

There is exactly one customer-facing plan/usage surface. The
pre-existing **Plans** (upgrade) and **Payments** (history) tabs
remain unchanged.

## Source of truth

The panel reads, read-only:

- `GET /api/plans/workspace/:workspaceId/effective`
  (via `fetchWorkspaceEffective` in `src/lib/entitlements-api.ts`)
- `GET /api/plans/capabilities`
  (via `fetchCapabilityCatalog`) for registry-driven labels and
  `userVisible` curation.

No entitlement logic is recomputed in the browser. The panel renders
`{ value, source }` exactly as returned by the canonical resolver —
the same payload `requireLimit` consumes server-side.

## What workspace owners now see

- Plan name and subscription status.
- For every `userVisible` registry limit:
  - effective value (with `Unlimited` for `-1`),
  - current usage (where a canonical counter exists), `usage / limit`,
  - progress bar when limit > 0 and usage is available,
  - source badge: "From your plan" / "Custom for your workspace" /
    "Default".
- Modules, channels, and features (only `userVisible`, not
  `internalOnly`) with on/off state.

## Usage column mapping (read-only)

The panel mirrors the columns `usageResolvers.ts` reads from
`workspace_usage_counters` so the customer view never fabricates math:

| limit key              | counter column        |
|------------------------|-----------------------|
| `max_conversations`    | `conversations_count` |
| `max_visitors`         | `visitors_count`      |
| `ai_credits_per_month` | `ai_credits_used`     |
| `storage_gb`           | `storage_bytes` (÷ 1024³) |

Limits without a canonical counter on the customer payload (notably
`max_contacts`, which is a live `count(*)` on the server) render the
effective limit and an explicit "Current usage not tracked in this
view" notice. They are never shown as `0 / N`.

## Boundaries

- Super Admin override edit/clear controls are NOT rendered here.
  Those live exclusively in `src/pages/admin/PlansPage.tsx`
  (Workspace Console). The customer view is read-only.
- Source badges expose plan/override/default as informational context
  only — no mutation affordance.
- No new override system, no client-side resolver, no
  capability/route/env/schema rename.

## Intentionally deferred

- Per-period usage history charts.
- Surfacing `max_contacts` live occupancy in the customer payload
  (would require an additive backend field on `effective` — not in
  scope for a visibility pass).
- Upgrade CTAs that pre-select the cheapest plan that lifts a hit
  limit.