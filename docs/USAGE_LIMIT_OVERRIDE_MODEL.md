# Usage Limit Override Model

Status: **canonical (active)** as of 2026-06-21.

## Goal

Provide one and only one canonical effective-limit resolution model for
usage-backed limits, so that:

* Super Admins can override numeric limits per workspace,
* the diagnostics / effective-state API,
* and every enforcement consumer

all see the same final value with the same precedence rules.

## Precedence

For any limit-type capability key (`type: 'limit'` in the registry):

```
workspace_limit_overrides[ws][key]   (override)   ← highest
billing_plans.limits[key]            (plan)
capability_registry[key].defaultValue (default)   ← lowest / fail-safe
```

The `-1` sentinel means **unlimited** at any layer; consumers (notably
`requireLimit`) skip usage comparison when the resolved limit is `-1`.

Boolean entitlements (`feature` / `module` / `channel`) are unchanged
by this phase. Modules and channels continue to use their own override
tables; this document is scoped to numeric limits.

## Single Resolver

The canonical resolver is the SQL RPC `public.check_workspace_entitlement`.
It now consults `public.workspace_limit_overrides` *before* the plan
limits JSONB. Every TypeScript enforcement path goes through
`checkEntitlementFromDB` → this RPC, so override behavior is automatic
for any consumer that already uses `requireLimit(...)` (conversations,
visitors, storage, AI KB jobs, AI credits, contacts).

Diagnostics surfaces (`GET /api/plans/workspace/:id/effective`) read
the same overrides table when assembling the rendered limit map and
stamp `source: 'override' | 'plan' | 'default'` on every limit entry.

## Schema

```sql
CREATE TABLE public.workspace_limit_overrides (
  id            uuid primary key,
  workspace_id  uuid not null,
  limit_key     text not null,    -- e.g. 'max_contacts', 'storage_gb'
  limit_value   integer not null, -- -1 = unlimited
  admin_notes   text,
  UNIQUE(workspace_id, limit_key)
);
```

RLS: Super Admin manages, workspace owner/admin reads own.

## Admin API

Additive endpoints next to the existing module/channel override
endpoints (no rename, same shape):

* `GET    /api/plans/admin/overrides/:workspaceId` — now also returns `limits`
* `POST   /api/plans/admin/overrides/limit`        — body: `{ workspaceId, limitKey, limitValue, adminNotes? }`
* `DELETE /api/plans/admin/overrides/limit/:id`

Validation guardrails:

* `limitKey` must exist in the registry with `type === 'limit'`.
* Capabilities flagged `workspaceOverridable: false` are rejected (e.g.
  `max_workspaces`).
* `limitValue` must be an integer, `-1` or `>= 0`.

Frontend client wrappers live in `src/lib/entitlements-api.ts` as
`setWorkspaceLimitOverride` / `deleteWorkspaceLimitOverride`. The
`fetchWorkspaceOverrides` response shape now includes a `limits` array.

## Cache

`clearEntitlementCache(workspaceId)` is called on every override
upsert/delete, identical to the module/channel override path.

## Backward Compatibility

* The augmented RPC is a strict superset of the previous behavior:
  if no override row exists, the resolution path is byte-identical to
  pre-phase output (plan → default).
* No capability key was renamed, no route renamed, no env touched.
* Module and channel override tables and endpoints are unchanged.

## Intentionally Deferred

* No admin UI panel was added for editing limit overrides — this phase
  only wires the canonical resolver and the API surface. The Plans
  admin page can adopt the new endpoints incrementally.
* No migration of existing per-plan limits into per-workspace overrides
  (overrides are intentionally rare).
* Module/channel/feature override remain on their respective tables;
  unification with limit overrides is out of scope.