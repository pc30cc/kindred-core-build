# Plan Data Reconciliation — Legacy Key Cleanup Audit

_Last updated: 2026-06-22. Status: **AUDIT COMPLETE — zero seed mutations applied this pass (by design)**._

This document captures the strict reconciliation audit between
`CAPABILITY_REGISTRY` (canonical) and the live `billing_plans` seed rows
(`free`, `pro`, `enterprise`). It is the deliverable of the
_Legacy Plan Key Cleanup + Seed Reconciliation_ phase.

The phase is intentionally a **data-consistency / documentation pass**,
not a data migration. No plan row was mutated, no canonical key was
renamed, no middleware contract changed. Diagnostics already surface
drift via `GET /api/plans/admin/diagnostics`; this audit explains what
that drift means and why each item was preserved or deferred.

---

## 1. Authoritative sources

| Layer | File / Surface |
|---|---|
| Canonical key catalog | `server/services/billing/capabilityRegistry.ts` |
| Live plan JSON | `billing_plans.entitlements`, `billing_plans.limits` |
| Soft validator (warn-only on unknown) | `validatePlanPayload(...)` |
| Drift diagnostics | `GET /api/plans/admin/diagnostics` |
| Additive create-time normalizer | `normalizePlanLimitsForCreate(...)` |

The registry is metadata. Middleware reads plan JSON keys directly
(`feature in limits` / `feature in entitlements`) — so a missing
canonical key falls through to the registry `defaultValue`, and a
legacy alias is silently invisible to enforcement unless a resolver
also reads it. That's the invariant this audit must not disturb.

---

## 2. Drift inventory (live seed scan, 2026-06-22)

Source: `SELECT slug, entitlements, limits FROM billing_plans WHERE
is_active = true`.

### 2.1 Entitlement keys

| Key                  | free | pro | enterprise | Registry?           | Classification |
|---|---|---|---|---|---|
| `advanced_analytics` | false | true | true     | ❌ not in registry  | **TOO AMBIGUOUS — KEEP WITH WARNING.** Registry has `analytics` (base) only; `advanced_analytics` is a semantically distinct "advanced tier" flag with no canonical equivalent. No safe 1:1 map. |
| `ai_enabled`         | false | true | true     | ❌ not in registry  | **LEGACY PRESERVED.** Predates the registry. The current canonical surface is split: `ai_assistant` (module), `advanced_ai_agent` (feature), `ai_kb_builder` (feature), `ai_operator_assist` (feature). Mapping a single boolean onto that split would change shipped scope. |
| `ai_assistant`       | true  | —   | —          | ✅ module          | OK (free only). |
| `ai_kb_builder`      | false | true | true     | ✅ feature         | OK. |
| `analytics`          | false | —   | —          | ✅ module          | OK (free only — Pro/Enterprise rely on `advanced_analytics`; see row 1). |
| `api_access`         | false | —   | true      | ✅ module          | OK. Pro plan has it absent (defaults false via registry); intentional. |
| `audit_logs`         | —     | —   | true      | ✅ feature         | OK. |
| `automation`         | false | —   | —          | ✅ module          | OK. |
| `chat`               | false | —   | —          | ✅ module          | OK (free explicitly disables chat). |
| `custom_branding`    | false | true | true     | ✅ module          | OK. |
| `email_campaigns`    | false | —   | —          | ✅ module          | OK. |
| `help_center`        | false | —   | —          | ✅ module          | OK. |
| `knowledge_base`     | true  | true | true     | ✅ module          | OK. |
| `omnichannel`        | false | —   | —          | ✅ module          | OK. |
| `priority_support`   | false | false | true    | ✅ feature         | OK. |
| `sso`                | —     | —   | true      | ✅ feature         | OK. |
| `visitor_tracking`   | false | —   | —          | ✅ module          | OK (free only). |
| `voice_video`        | false | —   | —          | ✅ module          | OK (free only). |

### 2.2 Limit keys

| Key                   | free  | pro    | enterprise | Registry?         | Classification |
|---|---|---|---|---|---|
| `max_conversations`   | 50    | 1000   | -1         | ✅ canonical      | OK. |
| `conversations_monthly` | 50  | 1000   | -1         | ❌ legacy alias   | **LEGACY PRESERVED.** Duplicate of `max_conversations` with identical values across all seeds. Removing it could break unknown external consumers; values already mirror canonical. |
| `conversations`       | 100   | —      | —          | ❌ legacy         | **LEGACY PRESERVED (free only).** Diverges from `max_conversations:50` — free has *both* `conversations:100` and `max_conversations:50`. Middleware reads `max_conversations`; this row is invisible to enforcement. Removing it might break a UI surface still keyed on `conversations`. Keep until consumer search is exhaustive. |
| `max_visitors`        | 1000  | 50000  | -1         | ✅ canonical      | OK. |
| `storage_gb`          | 1     | 5      | 50         | ✅ canonical      | OK. |
| `storage_mb`          | 100   | 5000   | 50000      | ❌ legacy         | **LEGACY PRESERVED.** Mirrors `storage_gb` exactly (×1000). No middleware consumer; safe to leave. |
| `file_storage_mb`     | 100   | —      | —          | ❌ legacy         | **LEGACY PRESERVED (free only).** Same value as `storage_mb`. Unused by middleware. |
| `max_contacts`        | —     | —      | —          | ✅ canonical      | **MISSING from every seed.** Registry default = 100. Effective limit today: 100 for all plans. See §3. |
| `contacts`            | 100   | 5000   | -1         | ❌ legacy         | **DEFERRED — risky migration.** `contacts → max_contacts` is a high-confidence semantic map, but applying it would silently raise Pro from the registry default (100) to 5000 and Enterprise to unlimited — i.e., an upgrade in shipped customer access. Per the phase rules ("no cleanup may silently downgrade or upgrade customer access"), no migration is applied. Resolution requires explicit admin sign-off on the intended Pro/Enterprise contact ceiling. |

> **Cross-namespace collision note.** The string `contacts` is *also* a
> canonical **module** key in `CAPABILITY_REGISTRY`. When it appears in
> `billing_plans.limits` it is a legacy limit alias (different
> namespace). `validatePlanPayload` flags this correctly as
> `Key 'contacts' is not a 'limit' in registry (type=module)` — a
> warning, not an error. The two are intentionally not unified: the
> canonical limit name is `max_contacts`.
| `max_agents`          | —     | —      | —          | ✅ canonical      | **MISSING from every seed.** No `requireLimit('max_agents', ...)` consumer exists yet, so this is currently inert; registry default 1 applies. Filling will be safe once a usage resolver lands. Deferred. |
| `team_members`        | 2     | 10     | -1         | ❌ legacy alias   | **LEGACY PRESERVED.** Intended canonical is `max_agents`. No middleware consumer today; migrating now would be cosmetic. Migrate together with `max_agents` resolver introduction. |
| `agents`              | 1     | —      | —          | ❌ legacy alias   | **LEGACY PRESERVED (free only).** Same family as `team_members`. |
| `ai_credits_per_month`| 0     | 5000   | -1         | ✅ canonical      | OK. |
| `ai_credits`          | 0     | —      | —          | ❌ legacy alias   | **LEGACY PRESERVED (free only).** Mirrors canonical value. |
| `ai_kb_monthly_credits` | 10  | 200    | 5000       | ❌ legacy         | **TOO AMBIGUOUS — KEEP WITH WARNING.** Distinct unit/scope from `ai_credits_per_month` (KB-specific budget). No canonical equivalent yet. Belongs to a future "AI KB credits" capability if the scope is real; otherwise dead weight — leave alone for now. |
| `ai_requests_monthly` | 0     | 5000   | -1         | ❌ legacy         | **TOO AMBIGUOUS — KEEP WITH WARNING.** Pre-credits-era throttle. No canonical equivalent. Removing risks breaking external usage telemetry consumers. |
| `ai_kb_jobs_per_month`| 1     | 5      | 50         | ✅ canonical      | OK. |
| `ai_kb_max_pages`     | 3     | 25     | 200        | ✅ canonical      | OK. |
| `ai_kb_max_depth`     | 1     | 2      | 3          | ✅ canonical      | OK. |
| `ai_kb_max_articles`  | 3     | 30     | 300        | ❌ legacy         | **TOO AMBIGUOUS — KEEP WITH WARNING.** Different unit than `ai_kb_max_pages`; semantically real, but no registry slot defined. |
| `ai_kb_max_chars`     | 10000 | 100000 | 1000000    | ❌ legacy         | **TOO AMBIGUOUS — KEEP WITH WARNING.** Same as above. |
| `ai_kb_file_size_mb`  | —     | —      | —          | ✅ canonical      | Missing from seeds → registry default 10 MB applied. Inert (no resolver/consumer); intentional defer. |
| `ai_kb_file_count`    | —     | —      | —          | ✅ canonical      | Same as above (default 20). |
| `kb_articles`         | 10    | 100    | -1         | ❌ legacy         | **TOO AMBIGUOUS — KEEP WITH WARNING.** No canonical equivalent. |
| `data_retention_days` | —     | —      | —          | ✅ canonical      | Missing → registry default 30 days. No resolver/consumer; defer. |

### 2.3 Modules / channels missing from seeds

- The `chat_widget`, `email`, `whatsapp`, `sms`, `instagram`, `telegram`,
  `voice`, `video` channel keys are absent from every seed. Channels
  are resolved via `workspace_channel_overrides` and the registry
  `defaultValue`; absence from plan JSON is the intended layered model,
  not drift. **No action.**
- `call_center` and `contacts` modules are absent from every seed.
  Default registry values apply (`call_center` false, `contacts` true).
  Intentional — no action.
- `white_label`, `remove_powered_by`, `call_recording`, `call_queue`,
  `call_callbacks`, and the `contact_*` features are likewise absent;
  registry defaults apply. **No action** — adding them now would change
  shipped behavior on customers already running against these defaults.

---

## 3. Reconciliation policy locked

1. **Canonical registry keys are the source of truth for naming.** Live
   plan rows may carry legacy keys indefinitely.
2. **Soft validation stays soft.** `validatePlanPayload` continues to
   warn (never error) on unknown keys, and plan create/update accepts
   them. No legacy key listed above is being promoted to a hard reject.
3. **No legacy → canonical key migration that would silently change
   effective customer access is performed in this phase.** This explicitly
   includes `contacts → max_contacts`, `team_members → max_agents`, and
   `agents → max_agents`.
4. **No filling of missing canonical keys with non-default values.** The
   `normalizePlanLimitsForCreate` path already fills resolver-ready keys
   with registry defaults at *create* time only; existing rows are
   untouched, on purpose.
5. **Unmappable legacy keys (advanced_analytics, ai_enabled, kb_articles,
   ai_requests_monthly, ai_kb_max_articles, ai_kb_max_chars,
   ai_kb_monthly_credits, storage_mb, file_storage_mb, conversations,
   conversations_monthly, ai_credits, team_members, agents)** stay in
   the seed rows and continue to surface as warnings in
   `validatePlanPayload` and `diagnoseAgainstPlans`. They are
   middleware-invisible today.
6. **Diagnostics endpoint (`/api/plans/admin/diagnostics`) is the
   long-running drift surface.** Operators inspect it; this doc explains
   each line item. Diagnostics must not be silenced for cosmetic reasons.

---

## 4. Cleanup actually applied this phase

- **Documentation only.**
  - This doc (`docs/PLAN_DATA_RECONCILIATION.md`) added.
  - Cross-references added in `docs/PLANS_SYSTEM_HANDOFF.md` and
    `docs/ENTITLEMENT_ARCHITECTURE.md`.
- **No SQL migration.** No `UPDATE billing_plans` was issued.
- **No registry change.** No keys added, removed, or renamed.
- **No middleware change.** No gating, normalizer, or composer logic
  was touched.
- **One backward-compatibility test added** (`legacyPlanKeys.test.ts`)
  asserting the soft-warning contract for every legacy key catalogued
  above.

---

## 5. Backward-compatibility safeguards still in force

- `validatePlanPayload` returns `level: 'warning'` on every legacy key
  in §2 — never `'error'`. Plan CRUD is unaffected.
- `normalizePlanLimitsForCreate` only touches keys in
  `USAGE_BACKED_LIMIT_KEYS` and only fills missing entries; legacy keys
  pass through untouched.
- `checkEntitlement` (`server/services/billing/index.ts`) reads
  `feature in limits` / `feature in entitlements` directly — adding,
  removing, or renaming any legacy key without explicit admin sign-off
  could change customer-effective access. The audit's deferral list is
  exactly the set where that risk applies.
- Diagnostics output is unchanged; the same drift remains visible.

---

## 6. Intentionally deferred — explicit unblock criteria

| Deferred item | Unblock criterion |
|---|---|
| `contacts → max_contacts` migration on Pro/Enterprise (would lift effective limit from registry default 100 → 5000/-1) | Admin sign-off that 5000 / unlimited was the intended shipped contact ceiling for Pro / Enterprise, captured in `CONTACTS_LIMIT_POLICY.md`. Then run a one-shot SQL `UPDATE billing_plans SET limits = jsonb_set(limits, '{max_contacts}', limits->'contacts')` per slug, mirror values, leave legacy `contacts` in place for one release. |
| `team_members / agents → max_agents` migration | Land a `max_agents` usage resolver + `requireLimit('max_agents', ...)` chokepoint first. Migration becomes mechanical at that point. |
| Filling `max_workspaces`, `data_retention_days`, `ai_kb_file_size_mb`, `ai_kb_file_count` into seeds | Land their respective resolvers / consumers; values currently fall through to registry defaults harmlessly. |
| Promoting `advanced_analytics`, `ai_kb_max_articles`, `ai_kb_max_chars`, `ai_kb_monthly_credits`, `ai_requests_monthly`, `kb_articles` into the registry as canonical keys | Product decision on whether each tracks a real capability. If yes, add as `feature` / `limit` with a resolver; if no, deprecate via a separate cleanup pass. |
| Hard-rejecting unknown plan keys on create/update | Out of scope. The shipped contract is soft-warn forever unless explicitly versioned. |

> **Update 2026-06-22 (Max Agents phase).** The `max_agents`
> semantics, counting model (live `count(*)` on `workspace_members`),
> and unblock criterion are now formally locked in
> `docs/MAX_AGENTS_POLICY.md`. The `team_members / agents →
> max_agents` migration is mechanical now, but still deferred until
> one new Express route owns the `workspace_members` INSERT path —
> currently every seat mutation happens directly from the frontend
> via Supabase RLS, so `requireLimit` has nowhere to attach. Running
> the seed migration before that route ships would lift the visible
> Pro/Enterprise seat limit (1 → 10 / unlimited) without enforcement.

> **Update 2026-06-22 (Workspace Member Write Boundary phase).** The
> canonical Express seat-creation boundary now exists:
> `POST /api/workspace-members/accept-invitation` (see
> `docs/MAX_AGENTS_POLICY.md` §4 and `server/routes/workspaceMembers.ts`).
> The `team_members / agents → max_agents` seed migration is still
> deferred — but the remaining blocker is now narrower: revoking
> `EXECUTE` on `public.accept_workspace_invitation(text)` from the
> `authenticated` role so the Express route is the only reachable
> path. After that revoke ships, the seed migration and
> `requireLimit('max_agents', …)` rollout are a mechanical three-step
> sequence (resolver register → middleware mount → SQL UPDATE on
> `billing_plans`).

> **Update 2026-06-22 (Max Agents Final Activation phase) —
> CORRECTION.** The "narrow REVOKE" framing above is **wrong** and is
> retracted. Live `pg_proc` audit confirms `EXECUTE` is held by
> `anon`, `authenticated`, `service_role`, and `public`, but the
> canonical Express route also runs as the `authenticated` role
> (anon-key + user JWT), so a `REVOKE … FROM authenticated` would
> break the canonical path along with the bypass. The real unblock
> requires either a new SECURITY DEFINER companion RPC
> `accept_workspace_invitation_as(_token, _user_id)` granted only to
> `service_role`, or replacing the RPC call with JS logic in the
> Express route. Both are larger than this phase's scope and are
> deferred to an explicit follow-up. No seed migration was applied.
> See `docs/MAX_AGENTS_POLICY.md` §4.2 for the corrected unblock
> matrix.

> **Update 2026-06-22 (Service-Role Companion RPC + Max Agents
> Activation phase) — APPLIED.** The companion-RPC option from
> §4.2 was implemented. `accept_workspace_invitation_as(_token,
> _user_id)` now exists (service_role-only), the original RPC's
> `EXECUTE` is revoked from `anon`/`authenticated`/`public`,
> `resolveMaxAgents` is registered, `requireLimit('max_agents',
> …)` is mounted on
> `POST /api/workspace-members/accept-invitation`, and the
> `team_members → max_agents` seed migration has been applied
> (`free=2`, `pro=10`, `enterprise=-1`; the only conflicting
> legacy row, `free.agents=1`, was resolved in favour of the more
> permissive `team_members=2` to avoid silently shrinking
> existing customer capacity). Legacy `team_members` and `agents`
> keys remain in place for one release per the deferral matrix.
> See `docs/MAX_AGENTS_POLICY.md` §4.3.

---

## 7. How to extend this audit safely

1. Re-run `GET /api/plans/admin/diagnostics` and compare its
   `unknownKeysByPlan` / `usageBackedKeysMissingByPlan` output with
   §2.1 / §2.2 above.
2. For any new legacy key that appears: classify it into one of the
   five buckets (LEGACY PRESERVED / SAFE TO MIGRATE / SAFE TO REMOVE /
   TOO AMBIGUOUS / REGISTRY SHOULD ABSORB) before any DB change.
3. Never delete or rename a key in `billing_plans` without:
   - confirming no middleware path reads it (grep `<key>` under
     `server/`),
   - confirming no UI reads it (grep under `src/`),
   - confirming no analytics/billing pipeline downstream depends on it.
4. Update this doc in the same change. The doc is the audit trail.

---

## 8. Hard acceptance checks (re-verified 2026-06-22)

- [x] No canonical capability key renamed.
- [x] No customer-facing entitlement behavior changed.
- [x] Seed plans are not less coherent than before (no row was mutated).
- [x] Diagnostics are more trustworthy: every drift line item is now
      explained in §2 with a classification.
- [x] Backward compatibility for legacy plan keys preserved (still
      warn-only).
- [x] No route, env var, schema, or middleware contract renamed.
- [x] Repo is cleaner without being riskier (documentation-only delta).