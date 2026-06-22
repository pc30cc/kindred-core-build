# Plans System — Handoff

_Last updated: 2026-06-22 (Post-Activation Cleanup phase). Status:
**CORE COMPLETE; `max_agents` LIVE.**_

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
  `ai_kb_jobs_per_month`, `ai_credits_per_month`, `max_contacts`
  (TS-first chokepoint at `POST /api/contacts` and
  `POST /api/contacts/bulk`), and `max_agents` (TS-first chokepoint at
  `POST /api/workspace-members/accept-invitation` — service-role
  companion RPC `accept_workspace_invitation_as`; see
  `docs/MAX_AGENTS_POLICY.md`).
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
- Broader call-route gating (queue / availability / cancel / list).
  Composer exists; rollout requires a "deny on create, allow on cleanup"
  drain policy. See `ENFORCEMENT_COVERAGE_AUDIT.md` §3.
  - **Recording start** — resolved (Call Route Enforcement Expansion).
    `POST /api/calls/:id/recording/start` and
    `POST /api/call-center/calls/:id/recording/start` are gated on
    `eff.recording_enabled`; `recording/stop` and `recording/status`
    remain ungated.
  - **Visitor call/callback request creation** — resolved (Call Public/
    Queue/Callback Route Enforcement — Strict Visitor-Safe Pass).
    `POST /api/call-widget/calls/request` is gated on
    `eff.visitor_voice_enabled` / `eff.visitor_video_enabled`;
    `POST /api/call-widget/callbacks/request` and
    `POST /api/widget-callbacks/request` are gated on
    `eff.callbacks_enabled`. All denials use the stable shape
    `{ error: "plan_forbidden", capability, upgrade_required: true }`
    and run before any DB insert / provider resolution. Cleanup, status,
    cancel, accept, reject, hangup, and end paths remain reachable.
  - **Operator call create** — resolved (Phase: Operator Call Route
    Split + Selective Gating — Strict Mixed-Handler Pass).
    `POST /api/calls/create` is gated branch-by-branch via the canonical
    composer: `audio` → `eff.voice_enabled` (`capability:
    voice_video.voice`), `video` → `eff.video_enabled` (`capability:
    voice_video.video`). The check runs before
    `resolveEffectiveCallProvider` and the `call_sessions` insert, so no
    half-created sessions are stranded. Cleanup / lifecycle branches in
    the same router (`/:id/{accept,reject,hangup,end,token}`,
    `GET /:id/state`) remain ungated.
  - **Operator `POST /api/calls/:id/invite`** — still deferred, now
    formally audited (Phase: Participant / Continuity Pass). The route
    is a single undifferentiated handler that inserts a
    `call_participants` row, flips `call_sessions.state` to `ringing`,
    and emits the visitor `call:incoming` envelope. The same path
    serves both **new optional participant adds** and **re-ring /
    recovery / rejoin** of an in-flight participant; no schema, body
    field, or code branch distinguishes the two. Per the
    deny-on-create / allow-on-continuity policy, gating the whole
    route would strand active-call continuity, so no rollout is
    applied. Unblocking requires either an explicit
    `reason: 'new' | 'reissue'` body signal or an idempotency contract
    on `call_participants` so a "brand-new optional participant"
    branch can be isolated. Mapping that would apply when separated:
    audio session → `eff.voice_enabled`, video session →
    `eff.video_enabled`.
  - **`call-queue/enqueue`** — **resolved (Phase: Visitor Queue Denial
    Policy + call-queue/enqueue Selective Gating — Strict Single-Surface
    Pass).** Gated at `POST /api/widget/call-queue/enqueue` via the
    canonical composer (`server/services/calls/queueEntitlementGate.ts`).
    Mapping: `queue_enabled=false` → `capability: 'call_queue'`
    (precedence); else `audio` → `eff.visitor_voice_enabled`
    (`capability: 'voice'`), `video` → `eff.visitor_video_enabled`
    (`capability: 'video'`). `plan_forbidden` (403) is strictly distinct
    from runtime queue/business-state denials inside `enqueueCall`
    (`queue_disabled` / `voice_disabled` / `video_disabled` → 409) and
    from `invalid_body` (400). Cancel/status surfaces remain ungated.
  - **Queue offer/accept** — still deferred: act on already-existing
    entries; gating would strand in-flight queue work.
- ~~Splitting `email.ts` into platform/auth vs channel-email before gating.~~
  **Resolved (Phase: Email Surface Split + Channel Gating).** Platform
  email stays on `POST /api/email/send` (un-gated). Channel email lands
  on `POST /api/email/send-channel` and `sendChannelEmail()`, both
  gated with `requireChannel('email')`. See `EMAIL_SURFACE_SPLIT.md`.
- `aiAgent.ts` per-route audit — **partially resolved** (Phase: AI Agent
  route audit + selective gating). `POST /generate-business-description`
  and `POST /learning-candidates/generate` are now gated with
  `requireModule('ai_assistant')` because both are pure new-action
  generators with no in-progress state. All settings/platform-settings/
  sources/data-sources/runs/qna CRUD/knowledge-index/files/workflows/
  topics/tools/test-cases/test-runs/regression/guidance/routing/learning-
  candidate finalization/operator-assist analytics/overview/debug routes
  remain intentionally admin-safe — they are read/status/config/finalize
  surfaces or operate on already-created rows, and `operator/suggest-
  reply` keeps its existing in-handler `checkEntitlementFromDB` +
  dev-bypass logic. See `ENFORCEMENT_COVERAGE_AUDIT.md` §1 and §3.

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
- `docs/PLAN_DATA_RECONCILIATION.md` — legacy plan-JSON key audit,
  per-key classification (LEGACY PRESERVED / DEFERRED / TOO AMBIGUOUS),
  and the explicit deferral list with unblock criteria.
- `docs/MAX_AGENTS_POLICY.md` — `max_agents` seat-limit semantics,
  counting model (live `count(*)` on `workspace_members`), and the
  exact Express-route unblock criterion that gates rollout and the
  `team_members / agents → max_agents` seed migration.

_Status update 2026-06-22 (Workspace Member Write Boundary phase):_
the canonical Express seat-creation boundary
(`POST /api/workspace-members/accept-invitation`,
`server/routes/workspaceMembers.ts`) has shipped. `InvitePage.tsx`
now calls it instead of the SQL RPC directly. `max_agents` is still
intentionally **not** enforced; the only remaining blocker is
revoking `EXECUTE` on `public.accept_workspace_invitation(text)`
from the `authenticated` role so the Express route is the sole
reachable path. See `docs/MAX_AGENTS_POLICY.md` §4.1.

_Status update 2026-06-22 (Max Agents Final Activation phase) —
CORRECTION:_ the "revoke EXECUTE from authenticated" unblock above
is retracted. The canonical Express route also runs as the
`authenticated` role (anon-key + user JWT, required so the SECURITY
DEFINER RPC sees the correct `auth.uid()`), so a plain REVOKE would
break the canonical path together with the bypass. Closing the
bypass now requires either adding a new SECURITY DEFINER companion
RPC `accept_workspace_invitation_as(_token, _user_id)` (granted
only to `service_role`) or moving the RPC logic into JS in the
Express route — both deferred to an explicit follow-up. `max_agents`
remains **not enforced**; no resolver, no middleware, no seed
migration was applied this phase. See `docs/MAX_AGENTS_POLICY.md`
§4.2 for the corrected unblock matrix.

_Status update 2026-06-22 (Service-Role Companion RPC + Max Agents
Activation phase):_ **`max_agents` is now LIVE.** The companion-RPC
option was applied:
`public.accept_workspace_invitation_as(_token, _user_id)` is now
the SECURITY DEFINER service-role-only path the Express route
calls. `EXECUTE` on the original `accept_workspace_invitation(text)`
is revoked from `anon`/`authenticated`/`public` (browser bypass
closed; `service_role` retains EXECUTE for legacy/internal use).
`resolveMaxAgents` is registered in `usageResolvers.ts` (added to
`USAGE_BACKED_LIMIT_KEYS`), and
`requireLimit('max_agents', usageFnForLimit('max_agents'))` is
mounted on `POST /api/workspace-members/accept-invitation` with an
already-member skip so re-accepts do not consume a new seat. The
`team_members → max_agents` seed mirror has been applied
(free=2 / pro=10 / enterprise=-1); legacy `team_members` and
`agents` keys are preserved for one release. See
`docs/MAX_AGENTS_POLICY.md` §4.3.

If this doc disagrees with code, the code wins and this doc must be
updated — but the system itself is finished.