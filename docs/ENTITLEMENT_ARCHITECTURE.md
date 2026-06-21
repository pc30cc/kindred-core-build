# Entitlement Architecture

_Last updated: 2026-06-19_

This document describes how plan capabilities, feature gating, module/channel access, and numeric limits flow through the platform. It is the companion to the **Capability Registry** at `server/services/billing/capabilityRegistry.ts`.

The previous billing/plan implementation continues to work exactly as before. The registry is **additive** — it does not rename keys, alter middleware contracts, or change schema.

---

## 1. Layers (in authority order)

| # | Layer | File / Table | Authority |
|---|---|---|---|
| 1 | Registry metadata | `server/services/billing/capabilityRegistry.ts` | Describes _what_ is configurable. Not authoritative for runtime decisions. |
| 2 | Plan JSON values | `billing_plans.entitlements`, `billing_plans.limits` | Plan-level truth. |
| 3 | Workspace overrides | `workspace_module_overrides`, `workspace_channel_overrides` | Wins over plan for module/channel access. |
| 4 | Usage counters | `workspace_usage_counters` | Compared against caps by `requireLimit`. |
| 5 | Backend middleware | `server/middleware/featureGating.ts` | **Final runtime authority.** Frontend never decides. |

---

## 2. Capability types

- `feature` — boolean entitlement (e.g. `sso`, `audit_logs`).
- `module` — boolean module access; supports per-workspace overrides.
- `channel` — boolean channel access; supports per-workspace overrides.
- `limit` — numeric limit (e.g. `max_agents`). Use `-1` for unlimited.

Each registry entry carries: `key`, `type`, `label`, `description`, `group`, `defaultValue`, `planConfigurable`, `workspaceOverridable`, `userVisible`, optional `internalOnly`, optional `unit`, optional `sortOrder`.

---

## 3. Backend endpoints (additive)

All under `/api/plans` (existing router, nothing renamed):

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/capabilities` | Registry catalog (filter `type`, `group`). |
| `GET`  | `/workspace/:id/effective` | Aggregated plan + overrides + usage for one workspace. |
| `POST` | `/admin/validate` | Soft-validate a plan payload against the registry. |
| `GET`  | `/admin/diagnostics` | Drift report: unknown DB keys, missing registry keys, invalid limit values. |

`POST /admin` and `PUT /admin/:planId` now soft-validate the payload — errors block the write, warnings are returned in the response body (backward-compatible with legacy keys).

---

## 4. Frontend consumption

Use `src/lib/entitlements-api.ts` and `src/hooks/useEntitlements.ts`. Both admin and app surfaces should consume backend-derived effective state instead of re-implementing plan interpretation.

- `useCapabilityCatalog()` — render plan editors and billing UI from the registry instead of hardcoded arrays.
- `useWorkspaceEffectiveEntitlements(workspaceId)` — single source for "what is currently allowed for this workspace and where does each value come from".

Migration is gentle. Existing pages keep working; new or rewritten screens should prefer these hooks.

---

## 5. How to add a new capability

1. Add a row to `CAPABILITY_REGISTRY` with a stable `key`. Once shipped, never rename it.
2. Pick a conservative `defaultValue` (deny-by-default for sensitive capabilities).
3. Update plan rows (admin UI) to set the new key on the plans that include it. `/admin/diagnostics` surfaces drift.
4. Add backend enforcement where the capability gates an action:
   - `requireFeature('<key>')` for booleans.
   - `requireModule('<key>')` / `requireChannel('<key>')` (also honours overrides).
   - `requireLimit('<key>', usageFn)` for numeric caps.
   - `requireAICredits(n)` for AI-credited operations.
5. UI surfaces read the new key via the catalog and effective state endpoints without code changes per capability.

### How to add a new limit

Same as above with `type: 'limit'` and the right `unit`. Use `-1` in plan JSON for unlimited. Wire `requireLimit` with a `currentUsageFn` returning current usage for the workspace.

---

## 6. Effective state — interaction rules

Boolean `module` / `channel`:

    effective = override ?? plan ?? registry.default

Boolean `feature`:

    effective = plan ?? registry.default

`limit`:

    effective_limit = workspace_limit_override ?? plan ?? registry.default
    blocked = effective_limit !== -1 && usage >= effective_limit

Aggregation lives in `GET /api/plans/workspace/:id/effective` so frontends do not re-implement it.
The canonical resolver is the SQL RPC `public.check_workspace_entitlement`, which now consults
`public.workspace_limit_overrides` before the plan limits JSONB. See
[USAGE_LIMIT_OVERRIDE_MODEL.md](./USAGE_LIMIT_OVERRIDE_MODEL.md) for full precedence and admin-API details.

---

## 7. Backward compatibility safeguards

- No table renames, no JSON shape break, no key renames.
- No existing route removed.
- Plan create/update accepts unknown keys (warning only).
- Registry is consulted for metadata, never to deny runtime access.
- `featureGating.ts` middleware contract is unchanged.

---

## 8. Out of scope (intentionally deferred)

- Migrating legacy unknown keys discovered by `/admin/diagnostics`.
- Registry-aware admin plan editor UI rewrite.
- Reconciling the free/paid plan seed JSON with the registry.

---

## 9. Call surfaces (plan ↔ runtime composition)

Plan keys for call surfaces are an upper bound, not a replacement,
for the runtime control plane in `server/services/calls/controlPlane.ts`.

- Plan-level: `voice_video` (module), `voice` / `video` (channels),
  `call_center` (module), `call_recording` / `call_queue` /
  `call_callbacks` (features).
- Runtime-level (kept as-is): global gates
  (`*_enabled_global`), workspace overrides on
  `workspace_provider_settings(provider_type='call')`, and per-call
  defaults (max participants, bitrates, retention).

Effective state = `plan AND control_plane.enabled AND <feature>_enabled_global AND workspace_override`.
The canonical composer is `server/services/calls/entitlementComposer.ts`
(`composeCallEntitlements` pure / `loadEffectiveCallEntitlements` async).
No call route is gated on it yet. See
`docs/CALL_ENTITLEMENT_COMPOSITION.md` for the per-surface table and
`docs/CALL_SURFACES_PLAN_MODEL.md` for the registry mapping.

## 10. Contacts surface (plan modeling, no enforcement yet)

The Contacts directory is now plan-shaped through the central registry
so Super Admin can toggle Contacts capabilities per plan exactly like
Call Center / Voice & Video / AI.

- Plan-level module: `contacts` (default `true` — directory is on by default).
- Plan-level features (group: `contacts`): `contact_import`,
  `contact_export`, `contact_tags`, `contact_notes`,
  `bulk_contact_actions`.
- No numeric Contacts limits are added in this phase. The legacy
  `contacts` numeric key in `billing_plans.limits` seed JSON is
  intentionally NOT promoted to the registry — there is no usage
  resolver for it and no enforcement consumer exists yet.
- No Contacts route is gated on these keys yet. See
  `docs/CONTACTS_PLAN_MODEL.md` for the per-surface mapping and the
  candidate enforcement boundaries deferred to a later phase.
- `max_contacts` is **not** in the registry. The contacts creation
  boundary is PostgREST (not Express), so the only safe enforcement
  options are a BEFORE-INSERT trigger or SECURITY DEFINER RPC on
  `public.contacts`. Both require explicit approval and are deferred.
  Locked semantics and the readiness audit live in
  `docs/CONTACTS_LIMIT_POLICY.md`. The invariant that every registry
  limit key has a real enforcement consumer is preserved.
- Update (Max Contacts Promotion + Enforcement — RPC-Only pass):
  the create/import RPCs (`public.create_contact`,
  `public.bulk_create_contacts`) now exist as the UI's chokepoint, but
  `max_contacts` is **still not promoted**. Reconfirmed blockers:
  (1) `authenticated` retains direct DML on `public.contacts`, making
  any in-RPC check bypassable; (2) there is no SQL-side entitlement
  composer — adding one inside the RPC would create a second source of
  truth for `billing_plans.limits` / `workspace_subscriptions`
  resolution, which this document forbids. The invariant "one canonical
  composition layer" is preserved by deferring rather than splitting.
- Update (Max Contacts Promotion + Enforcement — TS-First Canonical
  Path pass): `max_contacts` is now **promoted and enforced** through
  the canonical TypeScript stack, without introducing any SQL-side
  composer. The chokepoint is a thin Express boundary
  (`POST /api/contacts`, `POST /api/contacts/bulk`) that runs
  `requireLimit('max_contacts', usageFnForLimit('max_contacts'))`
  before inserting via the service-role client. The bypass is closed
  (revoked `INSERT ON public.contacts` and `EXECUTE` on the legacy
  RPCs from `authenticated`). The invariant "one canonical composition
  layer in TypeScript" is preserved — the Express boundary uses the
  same `checkEntitlementFromDB` + resolver path as
  `max_conversations`, `max_visitors`, `storage_gb`, etc.

- Update (Super Admin Limit Override UI Completion — operability
  pass): The Workspace Console in `PlansPage.tsx` is now the canonical
  admin surface for workspace-level numeric limit overrides. It reuses
  the existing additive endpoints
  (`POST/DELETE /api/plans/admin/overrides/limit`) and the
  registry-driven rendering model — no second admin surface, no
  client-side resolver, no key/route/schema rename. Override mutations
  are followed by a reload of `GET
  /api/plans/workspace/:id/effective`, so the UI's effective value and
  `source` badge always match the same payload enforcement consumes.

- Update (Customer-Facing Usage / Billing Visibility — product
  completion pass): `src/pages/app/BillingPage.tsx` now defaults to a
  new **Plan & Usage** tab rendered by
  `src/components/billing/PlanUsagePanel.tsx`. The panel is read-only
  and consumes the canonical `GET
  /api/plans/workspace/:id/effective` payload plus the registry
  catalog (`userVisible` only). Source badges (`plan` / `override` /
  `default`) are informational; Super Admin override controls remain
  exclusively in `PlansPage.tsx`. No backend route, capability key,
  schema, or env was changed; no second entitlement model was created
  in the browser. Limits without a canonical counter on the customer
  payload (e.g. `max_contacts`) render an explicit
  "usage not tracked in this view" notice instead of fabricated math.
  See `docs/CUSTOMER_USAGE_VISIBILITY.md`.
