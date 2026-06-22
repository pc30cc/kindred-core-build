# Entitlement Architecture

_Last updated: 2026-06-21. Status: **CORE COMPLETE** — see
[PLANS_SYSTEM_HANDOFF.md](./PLANS_SYSTEM_HANDOFF.md) for the maintainer
entry point._

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

## 8. Intentionally deferred (recorded, not core blockers)

- Migrating legacy unknown keys discovered by `/admin/diagnostics`.
- Reconciling the free/paid plan seed JSON with the registry.
- Broader call-route enforcement (see `ENFORCEMENT_COVERAGE_AUDIT.md` §3).
- Splitting `email.ts` into platform/auth vs channel-email before gating.

Optional polish that is **not** unfinished plans work — usage history
charts, upgrade-recommendation UX, override audit log surfacing,
`max_contacts` live occupancy on the customer payload, bulk-edit limit
overrides, unifying the three override tables — is listed in
[PLANS_SYSTEM_HANDOFF.md](./PLANS_SYSTEM_HANDOFF.md) §4.

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
`POST /api/callInvitations` is gated on it (channel-scoped). All other
call routes remain intentionally deferred. See
`docs/CALL_ENTITLEMENT_COMPOSITION.md` for the per-surface table and
`docs/CALL_SURFACES_PLAN_MODEL.md` for the registry mapping.

## 10. Contacts surface — final state

The Contacts directory is plan-shaped through the central registry:

- Module: `contacts` (default `true`).
- Features (group: `contacts`): `contact_import`, `contact_export`,
  `contact_tags`, `contact_notes`, `bulk_contact_actions`.
- Limit: `max_contacts` — promoted, registry-declared, usage-resolved
  via a live `count(*)`, and enforced through the canonical TypeScript
  stack at `POST /api/contacts` and `POST /api/contacts/bulk`.
  `INSERT ON public.contacts` and `EXECUTE` on the legacy RPCs are
  revoked from `authenticated`, closing the bypass. No SQL-side
  composer was introduced.

Update / delete / tag / note flows remain direct PostgREST and are
intentionally out of scope. See `docs/CONTACTS_PLAN_MODEL.md` and
`docs/CONTACTS_LIMIT_POLICY.md` for full details.

## 11. Workspace-level limit overrides — final state

Numeric limits resolve through:

    workspace_limit_overrides[ws][key] → billing_plans.limits[key] → registry.default

`public.check_workspace_entitlement` consults
`public.workspace_limit_overrides` before plan JSONB, so every consumer
routed through `requireLimit` automatically honours overrides. The
aggregated `GET /api/plans/workspace/:id/effective` payload stamps
`source: 'override' | 'plan' | 'default'` on every limit; the Super
Admin Workspace Console and the customer-facing Plan & Usage panel both
render that exact payload. Mutation lives only in `PlansPage.tsx`.

## 12. Customer-facing visibility — final state

`/app/billing` defaults to a read-only **Plan & Usage** tab
(`src/components/billing/PlanUsagePanel.tsx`) that consumes the same
effective-state payload as enforcement, filtered to `userVisible`
capabilities. `-1` renders as `Unlimited`. Limits without a canonical
counter on the customer payload render a "not tracked in this view"
notice instead of fabricated math. No mutation surface exists in the
customer UI. See `docs/CUSTOMER_USAGE_VISIBILITY.md`.

## 13. Legacy plan-JSON keys

Active `billing_plans` rows still carry legacy keys (e.g. `contacts`,
`team_members`, `conversations_monthly`, `ai_enabled`,
`advanced_analytics`, `storage_mb`, `kb_articles`,
`ai_kb_max_articles`, `ai_kb_max_chars`, `ai_requests_monthly`,
`ai_kb_monthly_credits`, `ai_credits`, `file_storage_mb`,
`conversations`, `agents`). They predate the registry, are
middleware-invisible (no `requireLimit` / `requireFeature` consumer
reads them), and continue to surface as warnings in
`validatePlanPayload` and the `/api/plans/admin/diagnostics` drift
report. They are **not** removed automatically: doing so risks breaking
downstream consumers, and silently mapping them onto canonical keys
(e.g. `contacts → max_contacts`) would change effective customer
access. The full per-key classification, deferral list, and unblock
criteria live in `docs/PLAN_DATA_RECONCILIATION.md` — that doc is the
authoritative audit trail; this section is the pointer.

## 14. Max Agents — seat limit (rollout deferred)

`max_agents` is canonical in the registry but intentionally **not
yet enforced**. Audit details, locked semantics, the chosen counting
model, and the precise unblock criterion (one new Express route
owning `workspace_members` INSERT) live in
`docs/MAX_AGENTS_POLICY.md`. The `KNOWN_UNSUPPORTED.max_agents`
rationale in `server/services/billing/usageResolvers.ts` points at
the same doc. Until rollout, `usageFnForLimit('max_agents')` callers
receive the documented "unsupported" response — never silently 0 —
and the customer-facing payload falls through to the registry
default of 1.
