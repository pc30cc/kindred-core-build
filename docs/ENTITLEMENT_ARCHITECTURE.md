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

    effective_limit = plan ?? registry.default
    blocked = effective_limit !== -1 && usage >= effective_limit

Aggregation lives in `GET /api/plans/workspace/:id/effective` so frontends do not re-implement it.

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
