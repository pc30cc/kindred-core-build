# Entitlement Testing & Invariants

Hardening guardrails for the entitlement / enforcement system already
rolled out across capability registry, usage resolvers, route gates,
and counter producers. This phase adds **no new product surface** —
only deterministic, repo-grounded tests.

## Test files

- `src/test/billing/capabilityRegistry.test.ts`
  - Registry has unique keys.
  - All keys consumed by completed `requireLimit` rollouts exist in the registry
    (`max_conversations`, `max_visitors`, `storage_gb`, `ai_kb_jobs_per_month`,
    `ai_credits_per_month`, plus the `advanced_ai_agent` / `ai_kb_builder`
    feature flags).
  - `USAGE_BACKED_LIMIT_KEYS` only references real `type: 'limit'` capabilities.
  - **Resolver alignment**: parses `usageResolvers.ts` and asserts the
    `RESOLVERS` map keys exactly match `USAGE_BACKED_LIMIT_KEYS`. This is the
    central drift detector between registry, resolver, and diagnostics.
  - `normalizePlanLimitsForCreate` fills missing usage-backed keys, never
    overwrites caller values, preserves legacy keys, never mutates input.
  - `validatePlanPayload` correctly errors on type mismatches, warns on
    unknown keys (backward compat), and accepts `-1` as unlimited.
  - `diagnoseAgainstPlans` surfaces unknown DB keys, missing registry keys,
    and invalid limit values.

- `src/test/billing/singleWriterInvariants.test.ts`
  - **Single writer for `workspace_usage_counters`**: scans all `server/` and
    `worker/` `.ts` files and fails if any code other than the explicitly
    allowlisted Super Admin "usage adjust" route (`server/routes/plans.ts`)
    issues `.insert/.update/.upsert/.delete` against `workspace_usage_counters`.
    DB triggers and migrations remain the canonical writers for
    `conversations_count`, `visitors_count`, `storage_bytes`.
  - Conversation limit helper wires the shared `requireLimit('max_conversations',
    usageFnForLimit('max_conversations'))` pair.
  - Visitor limit helper wires the shared `requireLimit('max_visitors',
    usageFnForLimit('max_visitors'))` pair AND never writes counters itself.
  - Each storage upload route (`storage.ts`, `conversationAttachments.ts`,
    `widgetAttachments.ts`) attaches the `storage_gb` limit gate.

- `src/test/billing/requireLimitMiddleware.test.ts` (Phase 17 — runtime)
  - Drives the real `requireLimit` middleware with a mocked
    `@supabase/supabase-js` client. Verifies actual branching:
    allow-below-limit calls `next()`, at/over-limit returns 403 without
    `next()`, `limit === -1` skips usage comparison entirely, plan-disallowed
    returns 403, missing `workspace_id` returns 400, and a throwing usage
    resolver fails closed (403). This is the highest-leverage runtime check
    behind every rolled-out limit gate.

- `src/test/billing/conversationLimitHelper.test.ts` (Phase 17 — runtime)
  - Exercises `enforceMaxConversationsLimit` end-to-end through the shared
    middleware. Confirms the create branch proceeds when below the cap,
    returns false with a 403 when the cap is reached, and surfaces 400 when
    no `workspace_id` is present. The "reply branches must NOT call this
    helper" rule remains protected by the import-seam invariants in
    `singleWriterInvariants.test.ts`.

- `src/test/billing/visitorLimitHelper.test.ts` (Phase 17 — runtime)
  - Exercises `enforceMaxVisitorsLimitIfNewThisMonth` against a mocked
    `visitor_sessions` membership read and a mocked entitlement RPC.
    Confirms in-month revisits short-circuit (no RPC call), true new-this-
    month visitors invoke `requireLimit` and proceed when allowed,
    cap-reached writes 403, and the documented fail-OPEN behavior on
    membership-read errors is preserved.

## Invariants protected by CI

These are deterministic, do not depend on external services, and run as part of
`npm test`:

| Invariant | Where enforced |
|---|---|
| Registry keys consumed by middleware exist | `capabilityRegistry.test.ts` |
| Registry ↔ resolver key alignment | `capabilityRegistry.test.ts` (text parse) |
| Plan create normalization fills usage-backed keys | `capabilityRegistry.test.ts` |
| Unknown keys preserved (backward compat) | `capabilityRegistry.test.ts` |
| Diagnostics surface drift | `capabilityRegistry.test.ts` |
| Single canonical writer for counters | `singleWriterInvariants.test.ts` |
| Limit helpers reuse shared middleware contract | `singleWriterInvariants.test.ts` |
| Storage upload surfaces still gated | `singleWriterInvariants.test.ts` |
| `requireLimit` allow / deny / unlimited / fail-closed branches | `requireLimitMiddleware.test.ts` |
| Conversation create gate proceeds / 403 on cap | `conversationLimitHelper.test.ts` |
| Visitor revisit skip / new-this-month gate / fail-open | `visitorLimitHelper.test.ts` |

## Intentionally not covered (deferred)

- **Full Express HTTP route tests** for `aiKb.ts` admin-bypass branch and the
  attachment `status='failed'` cleanup writes on denial. The middleware
  branching itself is now covered at runtime by Phase 17 tests above; the
  per-route cleanup write and admin-bypass short-circuit remain protected by
  the source-level wiring invariants and are validated manually per
  `docs/ENFORCEMENT_COVERAGE_AUDIT.md`. Booting Express + Supabase mocks for
  full HTTP coverage is intentionally deferred — the cost/benefit ratio is
  unfavorable while the middleware seam itself is now runtime-tested.
- **Live counter increment behavior** under the DB trigger: covered by the
  migration and validated manually; this phase only protects the application
  side of the single-writer contract.
- **AI credits route gating**: existing atomic `deduct_ai_credits` RPC is the
  test boundary — see `docs/AI_CREDITS_POLICY.md`.

## Where future rollouts add coverage

When a new `requireLimit('<key>', usageFnForLimit('<key>'))` rollout lands:

1. Add `<key>` to the "required" list in `capabilityRegistry.test.ts`.
2. If the rollout adds a counter column, add the route file to the
   storage-style assertion in `singleWriterInvariants.test.ts` (or extend
   the allowlist if a NEW canonical writer is introduced — review carefully).
3. Update `USAGE_BACKED_LIMIT_KEYS` and `RESOLVERS`; the alignment test will
   fail until both move together.

## Running

```
npm test                         # full suite
npx vitest run src/test/billing  # entitlement guardrails only
```