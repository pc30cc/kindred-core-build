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

## Intentionally not covered (deferred)

- **Live route HTTP behavior** (admin bypass, 403 shape, attachment
  `status='failed'` rollback): would require booting the Express app and
  Supabase mocks. The wiring invariants above catch the common regression of
  "someone removed `requireLimit`"; full HTTP behavior is currently validated
  manually per `docs/ENFORCEMENT_COVERAGE_AUDIT.md`.
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