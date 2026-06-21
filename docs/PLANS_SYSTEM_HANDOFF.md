# Plans System — Handoff

_Last updated: 2026-06-21. Status: **CORE COMPLETE**._

This is the "start here" document for the next maintainer of the plans
subsystem. The plans system is a finished subsystem: capability modeling,
admin controls, workspace overrides, usage-backed limits, customer-facing
visibility, and live enforcement on the major plan-bounded surfaces are
all in place and tested.

Anything not listed under **Core complete** is either intentionally
deferred or optional polish — not unfinished work.

---

## 1. Canonical sources of truth

| Concern | File / Surface |
|---|---|
| Capability catalog (every key, type, default, visibility) | `server/services/billing/capabilityRegistry.ts` |
| Plan JSON values (per-plan entitlements + limits) | `billing_plans.entitlements`, `billing_plans.limits` |
| Module / channel boolean overrides | `workspace_module_overrides`, `workspace_channel_overrides` |
| Numeric limit overrides | `workspace_limit_overrides` |
| Effective entitlement resolver (RPC) | `public.check_workspace_entitlement` |
| TypeScript enforcement entry points | `server/middleware/featureGating.ts` (`requireFeature` / `requireModule` / `requireChannel` / `requireLimit` / `requireAICredits`) |
| Usage resolvers per limit key | `server/services/billing/usageResolvers.ts` |
| Admin + diagnostics API | `server/routes/plans.ts` (`/api/plans/...`) |
| Super Admin UI | `src/pages/admin/PlansPage.tsx` |
| Customer-facing visibility | `src/components/billing/PlanUsagePanel.tsx` (mounted by `src/pages/app/BillingPage.tsx`) |

The registry never decides runtime access. The middleware in
`featureGating.ts` is the only runtime authority and always reaches the
canonical resolver — same payload that the admin and customer UIs read.

---

## 2. Where things happen

- **Effective entitlements** are resolved in `check_workspace_entitlement`
  (SQL, security definer). All TS enforcement consumers reach it via
  `checkEntitlementFromDB`. Aggregated read for UIs:
  `GET /api/plans/workspace/:id/effective` — every limit carries
  `source: 'override' | 'plan' | 'default'`.
- **Module / channel / feature overrides** are managed by the Workspace
  Console in `PlansPage.tsx` via the existing
  `/api/plans/admin/overrides/*` endpoints.
- **Numeric limit overrides** use the same console and the additive
  `POST /api/plans/admin/overrides/limit` /
  `DELETE /api/plans/admin/overrides/limit/:id` endpoints. Precedence is
  `workspace_limit_overrides → billing_plans.limits → registry.default`,
  and `-1` means unlimited.
- **Usage-backed limit enforcement** runs through `requireLimit('<key>',
  usageFnForLimit('<key>'))` against the canonical counters. The current
  rolled-out keys are `max_conversations`, `max_visitors`, `storage_gb`,
  `ai_kb_jobs_per_month`, `ai_credits_per_month`, and `max_contacts`
  (TS-first chokepoint at `POST /api/contacts` and
  `POST /api/contacts/bulk`).
- **Counter writes** are single-writer per metric (DB trigger or atomic
  RPC). Application code must not write `workspace_usage_counters.*`
  outside the Super Admin "usage adjust" route. Enforced by the CI
  invariant test `src/test/billing/singleWriterInvariants.test.ts`.
- **Customer-facing visibility** is read-only. The Plan & Usage tab in
  `/app/billing` consumes the same effective-state payload as enforcement
  and renders only `userVisible` capabilities. No mutation controls.
- **Call surfaces** are plan-modeled (`voice_video`, `voice`, `video`,
  `call_center`, `call_recording`, `call_queue`, `call_callbacks`). The
  composer `server/services/calls/entitlementComposer.ts` is canonical
  for plan ∧ control-plane ∧ override composition. The first call route
  enforced is `POST /api/callInvitations` (channel-scoped). All other
  call routes are intentionally deferred — see
  `docs/ENFORCEMENT_COVERAGE_AUDIT.md`.

---

## 3. Final scope (what is done)

### Core complete

- Central capability registry with `feature` / `module` / `channel` /
  `limit` types, visibility flags, and stable keys.
- Registry-driven Super Admin Plans UI (`PlansPage.tsx`), including the
  Workspace Console and limit-override controls.
- Workspace effective entitlements resolved by a single SQL RPC consumed
  by all enforcement paths and both UIs.
- Module, channel, feature, and numeric-limit overrides — all canonical,
  all consulted before plan defaults.
- Usage-backed limit enforcement for `max_conversations`, `max_visitors`,
  `storage_gb`, `ai_kb_jobs_per_month`, `ai_credits_per_month`, and
  `max_contacts`.
- Plan modeling for Contacts and Call surfaces.
- Customer-facing Plan & Usage panel.
- Diagnostics endpoint surfacing drift between registry, plan JSON, and
  the usage-backed limit set.
- Tests: 72 passing across `src/test/billing/`, including the
  single-writer invariant, registry contract, override invariants, and
  per-limit middleware behavior.

### Deferred by design (recorded; not core blockers)

- Migrating legacy unknown plan keys discovered by `/admin/diagnostics`.
- Reconciling free/paid plan seed JSON with the registry.
- Broader call-route gating (queue / availability / callbacks / recording
  / cancel / list). Composer exists; rollout requires a "deny on create,
  allow on cleanup" drain policy. See `ENFORCEMENT_COVERAGE_AUDIT.md` §3.
- ~~Splitting `email.ts` into platform/auth vs channel-email before gating.~~
  **Resolved (Phase: Email Surface Split + Channel Gating).** Platform
  email stays on `POST /api/email/send` (un-gated). Channel email lands
  on `POST /api/email/send-channel` and `sendChannelEmail()`, both
  gated with `requireChannel('email')`. See `EMAIL_SURFACE_SPLIT.md`.
- `aiAgent.ts` settings/sources/runs/qna gating — needs per-route audit
  to avoid regressing admin tooling.

### Out of scope

- A second entitlement composer (SQL-side or client-side). The single
  canonical composition path is non-negotiable.
- Renaming any capability key, route, env var, schema, or middleware
  contract. All changes since the registry shipped are additive.

---

## 4. Optional future polish (not required)

These items are explicitly **not** unfinished plans work. Treat them as
independent enhancement tickets, scoped on demand:

- Customer usage history charts / time-series in the Plan & Usage panel.
- Context-aware upgrade CTAs and recommendation UX.
- Surfacing `max_contacts` live occupancy on the customer payload.
- Bulk-edit / CSV affordances for limit overrides in the admin console.
- Unifying the three override tables (`workspace_module_overrides`,
  `workspace_channel_overrides`, `workspace_limit_overrides`) into one
  schema.
- Audit-log surfacing improvements for plan / override mutations.
- Additional call-route enforcement once a drain policy is defined.

Each can be picked up without reopening the core plans system.

---

## 5. Backward-compatibility safeguards (still in force)

- No existing route, capability key, schema column, or env var was
  renamed across the entire plans rollout.
- Plan create/update accepts unknown keys with a soft warning — never a
  hard reject — to keep legacy plan rows valid.
- The registry is metadata only; it cannot deny runtime access.
- The `featureGating.ts` middleware contract is unchanged since shipping.
- Customer UI is read-only; admin mutation surfaces are exclusive to
  `PlansPage.tsx`.

---

## 6. Companion docs

- `docs/ENTITLEMENT_ARCHITECTURE.md` — layered authority model, how to
  add a capability or limit.
- `docs/ENFORCEMENT_COVERAGE_AUDIT.md` — per-route classification of
  what is gated, deferred, or must not be gated.
- `docs/USAGE_LIMIT_OVERRIDE_MODEL.md` — limit override precedence,
  admin API, `-1` semantics.
- `docs/CUSTOMER_USAGE_VISIBILITY.md` — what the customer sees and why.
- `docs/CONTACTS_PLAN_MODEL.md`, `docs/CONTACTS_LIMIT_POLICY.md` —
  Contacts modeling and `max_contacts` enforcement.
- `docs/CALL_SURFACES_PLAN_MODEL.md`, `docs/CALL_ENTITLEMENT_COMPOSITION.md`
  — call surfaces.
- `docs/PLAN_LIMIT_ALIGNMENT.md`, `docs/USAGE_METRICS.md` — counter
  semantics and per-limit policy index.
- `docs/ENTITLEMENT_TESTING.md` — what the test suite already protects
  (registry shape, override invariants, per-limit middleware, single-
  writer rule, customer panel rendering).

If this doc disagrees with code, the code wins and this doc must be
updated — but the system itself is finished.