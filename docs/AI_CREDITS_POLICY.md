# AI Credits Enforcement Policy

## Canonical mechanism

AI credit consumption is governed by **one** path:

- Producer + gate: `deduct_ai_credits(_workspace_id, _credits)` Postgres
  RPC, wrapped server-side by `deductAICredits()` in
  `server/middleware/featureGating.ts`.
- Express middleware: `requireAICredits(credits)` in the same file.
- Worker entry point: `consumeAiCredits()` in
  `server/services/ai-kb/credits.ts` (thin wrapper over the same RPC).

The RPC is **atomic**: it both increments
`workspace_usage_counters.ai_credits_used` and fail-closes when the
plan-resolved limit is reached. There is no separate credit ledger.
`requireLimit('ai_credits_per_month', usageFnForLimit(...))` is **not**
the canonical AI-credit gate — it would read+compare without atomic
deduction and would race with `deduct_ai_credits`. Do not introduce a
second AI-credit accounting path.

`usageFnForLimit('ai_credits_per_month')` exists only for the
capability registry / read-only usage display (e.g. AI Builder UI via
`readAiCreditState`). It must not be paired with `requireLimit` on AI
routes that already deduct via the RPC.

## What counts as AI credit consumption

- Any server- or worker-side path that performs billable LLM work
  against a workspace's resolved AI provider config.
- Per-call cost is currently fixed at `1` credit per unit-of-work
  (one `/complete` call, one AI-KB page processed).

## Current enforcement surfaces

| Surface                                              | Mechanism                  | Status               |
|------------------------------------------------------|----------------------------|----------------------|
| `POST /api/ai/complete`                              | `requireAICredits(1)`      | Enforced             |
| AI-KB worker per-page processing                     | `consumeAiCredits()` (RPC) | Enforced             |
| `POST /api/ai-agent/playground/test`                 | own rate limit only        | Deferred (see below) |
| `POST /api/ai-agent/operator/suggest-reply`          | `deductAICredits(1)` inline | Enforced             |
| `POST /api/ai-agent/generate-business-description`   | none                       | Deferred (see below) |
| `POST /api/ai/test`                                  | n/a (caller-supplied keys) | Not gated — correct  |
| `GET  /api/ai/config/:workspaceId`                   | n/a (read-only)            | Not gated — correct  |

## Why other AI surfaces aren't gated

The canonical AI-credit gate is attached to the single generic billable
LLM surface (`/api/ai/complete`) and the worker per-page consumer. Every
other candidate is variable, bespoke, or behavior-changing in a way
that needs an explicit policy decision before enforcement:

- **`/playground/test`** — owner/admin testing surface. Has its own
  per-user rate limit. Today it does not consume workspace AI credits.
  Gating it would silently make workspace owners spend credits during
  configuration testing. Product decision, not coverage decision.
- **`/operator/suggest-reply`** — now enforced, wired inline rather than
  as middleware: the deduction happens after operator-permission,
  entitlement and provider-resolution checks and only on the
  `callLLM=true` branch, so `callLLM=false` previews stay free. Every
  assist run is additionally mirrored into `ai_agent_runs`
  (`run_type='suggestion'`, `mode='operator_assist'`) so it appears in
  the unified Recent-runs activity feed.
- **`/generate-business-description`** — single AI call used during
  setup. Likely safe to gate later, but introducing it here mid-phase
  would change setup-flow behavior without notice.

## Counter / producer alignment

- Producer of `workspace_usage_counters.ai_credits_used`:
  `deduct_ai_credits` RPC, exclusively.
- Reader for display: `readAiCreditState` in
  `server/services/ai-kb/credits.ts` and `resolveAiCreditsPerMonth` in
  `server/services/billing/usageResolvers.ts`.
- Both producer and readers agree on the column name and per-period
  semantics (`period = YYYY-MM`).
- No mismatch between "AI work that should count" and "AI work
  currently deducted" on the two enforced surfaces.

## Backward compatibility

- No middleware contract changed.
- No route, env var, schema, or key renamed.
- No second AI-credit architecture introduced.
- Capability registry and resolver behavior unchanged.

## Intentionally deferred

- Wiring `requireAICredits(1)` (or an inline conditional deduction)
  into `/operator/suggest-reply` once a policy decision is made about
  the `callLLM=false` branch and operator-assist credit semantics.
- Deciding whether `/playground/test` should consume workspace AI
  credits at all.
- Per-call variable-cost credits (token-weighted) — out of scope of
  the current fixed `1`-credit-per-unit model.
