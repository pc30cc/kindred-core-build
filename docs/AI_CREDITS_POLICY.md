# AI Credits Enforcement Policy

## Canonical mechanism

AI work is paid from the workspace's AI billing wallet (reserve/settle in
`server/services/ai-billing/`). The direct `POST /api/ai/complete` route,
the `requireAICredits` middleware, `deductAICredits()` and the AI-KB
`consumeAiCredits()` wrapper have been removed: nothing in the server
calls the `deduct_ai_credits` Postgres RPC any more. The SQL function is
left in place (it is part of the migration chain); dropping it is a
separate decision.

`usageFnForLimit('ai_credits_per_month')` exists only for the
capability registry / read-only usage display (e.g. AI Builder UI via
`readAiCreditState`). It must not be paired with `requireLimit` on AI
routes that already deduct via the RPC.

## What counts as AI credit consumption

- Any server- or worker-side path that performs billable LLM work
  against a workspace's resolved AI provider config.
- Each billable step is charged to the AI wallet by its measured usage.

## Current enforcement surfaces

| Surface                                              | Mechanism                  | Status               |
|------------------------------------------------------|----------------------------|----------------------|
| AI-KB worker per-page processing                     | AI billing wallet          | Enforced             |
| `POST /api/ai-agent/playground/test`                 | own rate limit only        | Deferred (see below) |
| `POST /api/ai-agent/operator/suggest-reply`          | AI billing wallet (reserve/settle) | Enforced      |
| `POST /api/ai-agent/generate-business-description`   | none                       | Deferred (see below) |
| `POST /api/ai/test`                                  | n/a (caller-supplied keys) | Not gated — correct  |
| `GET  /api/ai/config/:workspaceId`                   | n/a (read-only)            | Not gated — correct  |

## Why other AI surfaces aren't gated

The AI wallet is charged on the surfaces marked enforced above. Every
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

- `workspace_usage_counters.ai_credits_used` was produced only by the
  `deduct_ai_credits` RPC, which nothing calls any more.
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

- Deciding whether `/playground/test` should consume workspace AI
  credits at all.
- Per-call variable-cost credits (token-weighted) — out of scope of
  the current fixed `1`-credit-per-unit model.
