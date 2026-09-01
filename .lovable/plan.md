# AI Usage Billing — Production Billing Domain

## A. Audit findings (verified in code today)

- **Provider boundary is intact and must stay:** Core never touches a provider socket. `server/services/ai/index.ts` resolves config (workspace `provider_configs` → `app_runtime_config.default_ai_provider`) and delegates to the AI Runtime via `runtimeClient.runtimeComplete` / `runtimeEmbed`. Provider code lives in `runtime/ai/**` and a security test fails the build if Core imports it.
- **Single completion funnel:** every chat completion goes through `executeAICompletion` / `executeAICompletionWithConfig`. Call sites: `server/routes/ai.ts` (`/api/ai/complete`), `server/routes/ai-agent/assistant.ts`, `server/routes/ai-agent/operatorAssist.ts`, and the agent engine `engine/generationStage.ts` (including a retry call at line 282). This is the single interception point for billing — no channel-specific AI path exists, so Widget/Telegram/Bale/WhatsApp/Instagram all converge here.
- **Usage recording today:** `ai_usage_logs` rows (workspace, provider_name, model, prompt/completion/total tokens, latency, success, error_message, endpoint, metadata). No cost, no currency, no run grouping, no rate version. Embeddings and tool/retrieval calls are **not** logged at all.
- **Idempotency today:** `server/services/ai/idempotency.ts` — in-process, 5-minute memo keyed by `requestId`. Not durable, not financial.
- **Credits today:** `deduct_ai_credits(_workspace_id, _credits)` RPC called only from `server/routes/ai.ts` before execution (fixed 1 credit); `workspace_usage_counters.ai_credits_used / ai_credits_balance / ai_requests_count` per `YYYY-MM` period. The agent engine and operator assist never deduct, so the counter is effectively 0.
- **Counters are trigger-written (single-writer rule):** `src/test/billing/singleWriterInvariants.test.ts` mandates DB triggers as canonical writer; conversations/messages/ai_requests triggers were added recently.
- **Plan/limit layer:** `check_workspace_entitlement`, `server/middleware/featureGating.ts` (`requireFeature`, `requireLimit`, 60s cache, `selfHostBillingUnlimited` escape hatch), `billing_plans.limits/entitlements` jsonb, `workspace_limit_overrides`, `src/pages/admin/PlansPage.tsx`, `PlanLockedOverlay`, `PlanUsagePanel`.
- **Run rows already exist:** `ai_agent_runs` has `credits_used`, `prompt_tokens`, `completion_tokens` — an operational run log, not a financial ledger.

**Decision:** keep `ai_usage_logs` as the raw/analytics projection (unchanged writes, unchanged tests) and keep `ai_agent_runs` as the operational run log. Build the financial domain as **new, separate, append-only tables**. No duplicate source of truth: money lives only in the new ledger; tokens live only in the new usage-event table plus the existing log.

## B. Money model

- Canonical stored unit: **IRR minor-free integer-free** — all amounts `NUMERIC(20,6)` in **IRR**. Presentation layer divides by 10 to show تومان. Never mixed; documented once and enforced by a formatter helper.
- Provider cost stored in `NUMERIC(20,10) USD` (per-token prices are tiny). Rounding happens only at the settlement boundary, to 2 decimals IRR.
- No float anywhere in the pipeline; all arithmetic in Postgres `NUMERIC` or a decimal helper in TS that never converts to `number` mid-calculation.

## C. Database (new migrations, additive only)

Catalog & pricing (super-admin owned, versioned, never overwritten):
- `ai_models` — provider, model key, display name, family, status.
- `ai_rate_cards` — provider, model, currency (USD), `effective_from`, `effective_to`, status, created_by. New price = new row; old row gets `effective_to`.
- `ai_rate_card_components` — rate_card_id, `component_type`, `unit`, `price_per_unit NUMERIC(20,12)`.
- `ai_exchange_rates` — USD→IRR, rate, effective_from/to, created_by.
- `ai_sell_policies` — multiplier `NUMERIC(10,4)` (default 3.0000), `scope` (`global` now; columns for `plan_id`/`workspace_id`/`model` reserved and nullable so overrides need no migration later), effective_from/to.

Runs & usage:
- `ai_runs` — id, workspace_id, conversation_id, message_id, channel, entry_point, requested_model, actual_model, provider, status (`RUNNING|USAGE_RECORDED|SETTLEMENT_PENDING|SETTLED|FAILED|CANCELLED`), billing_quality (`ACTUAL|ESTIMATED|RECONCILED|UNRESOLVED`), cost_source, fallback_kind (`USER_SELECTED|PLATFORM_FALLBACK`), started_at, completed_at, and settlement snapshot columns: `provider_cost_usd`, `exchange_rate_snapshot`, `internal_cost_irr`, `multiplier_snapshot`, `workspace_charge_irr`, `platform_absorbed_irr`, `rate_card_version_id`, `sell_policy_version_id`, `exchange_rate_version_id`, `idempotency_key UNIQUE`.
- `ai_usage_events` — one row per normalized component of a run: run_id, workspace_id, provider, requested_model, actual_model, `component_type` (input_token, cached_input_token, output_token, reasoning_token, embedding_token, cache_write, cache_storage, web_search, tool_call, image_*, audio_*, video_*, provider_specific), quantity, unit, provider_request_id, rate_card_version_id, provider_cost_usd, billing_quality, `raw_usage_json`.

Wallet:
- `workspace_ai_wallets` — cached `available_irr`, `reserved_irr`, updated only inside ledger transactions.
- `workspace_ai_balance_lots` — source_type (`PLAN_ALLOWANCE|PURCHASE|ADJUSTMENT`), original_amount, remaining_amount, billing_cycle, expires_at. Consumption order: plan allowance (soonest expiry) then purchased.
- `workspace_ai_reservations` — run_id, amount, state (`ACTIVE|SETTLED|RELEASED|EXPIRED`), expires_at.
- `workspace_ai_ledger` — append-only; type in `PLAN_ALLOWANCE|AI_USAGE|PURCHASE|REFUND|ADJUSTMENT|EXPIRATION`; amount, lot_id, run_id, reference, created_by, created_at. Triggers block UPDATE/DELETE.
- `ai_billing_adjustments` — admin id, reason, reference, amount.
- `ai_billing_audit_log` — who/what/old/new/effective_from for rate, FX, multiplier, allowance, adjustment, refund.

Postgres functions (the only financial authority, `SECURITY DEFINER`, service-role only, `SELECT ... FOR UPDATE` on the wallet row):
`ai_reserve(...)`, `ai_settle_run(...)`, `ai_release_reservation(...)`, `ai_refund_run(...)`, `ai_grant_allowance(...)`, `ai_expire_lots()`, `ai_reconcile_wallet(workspace)`.
Idempotency enforced by `UNIQUE(run_id, charge_type)` on ledger and `ai_runs.idempotency_key`.

Indexes: `(workspace_id, created_at)`, `(run_id)`, `(status)` partial for unsettled runs, `(provider, model, created_at)`, reservations `(state, expires_at)`.

Plans: add `included_ai_allowance_irr` to plan limits jsonb (managed in the existing Plans admin UI), snapshotted into a lot at cycle start — never a balance reset.

## D. Server implementation

New `server/services/ai-billing/` domain — the single writer:
- `rates.ts` — resolve active rate card / FX / sell policy at a timestamp; **fail closed** with `billing_rate_not_configured`, `billing_fx_not_configured`, `billing_policy_not_configured`.
- `estimate.ts` — conservative pre-charge estimate from input tokens + `max_tokens` + price + FX + multiplier.
- `ledger.ts` — thin typed wrappers over the SQL functions: `reserveAiUsage`, `recordAiUsage`, `settleAiRun`, `releaseAiReservation`, `refundAiRun`.
- `normalize.ts` — provider usage → component list (OpenAI-compatible today; `raw_usage_json` retained for anything unmapped).
- `policy.ts` — the six failure cases from the spec, plus fallback cap (charge capped at the user-selected model's expected cost; remainder → `platform_absorbed_irr`).
- `mode.ts` — `METER_ONLY` vs `ENFORCED`, read from `app_runtime_config` (super-admin toggle). METER_ONLY records everything but never blocks.

Wiring: `executeAICompletionWithConfig` becomes the enforcement point — begin run → resolve pricing → estimate → reserve (ENFORCED) → runtime call → normalize usage → settle → release remainder. Existing `ai_usage_logs` insert stays untouched. `requestId` becomes the durable idempotency key. Retrieval/embedding calls (`runtimeEmbed`) join the same run when a run context is present, otherwise open their own run. Engine's retry path reuses the same run so a platform retry does not double-charge (extra provider cost → absorbed).

Zero balance surfaces a domain error `ai_allowance_exhausted` (403) from the shared boundary, so every channel behaves identically. Recovery worker (existing `worker/index.ts` cadence) expires stale reservations and reconciles `ESTIMATED`/`UNRESOLVED` runs via `ADJUSTMENT` entries.

New API:
- `GET /api/workspaces/:id/ai-billing/summary` → `{ available, reserved, plan_allowance_remaining, purchased_balance_remaining, cycle_used, cycle_total, renews_at }` — final numbers only, no cost/multiplier.
- `GET /api/workspaces/:id/ai-billing/history` → run list (time, channel, model, charge, status).
- `/api/admin/ai-billing/*` — rate cards, FX, sell policy, plan allowances, runs drilldown, KPI aggregates, adjustments/refunds, health. Platform-admin only, all mutations audited.

## E. UI

- Workspace: `PlanUsagePanel` + Overview card show «اعتبار مصرف هوش مصنوعی — X تومان باقی‌مانده از Y» with progress bar, cycle usage, AI reply count, renewal date, and separate plan vs purchased lines. New Usage History section. Warnings at 20%/10%/0% via existing notifications. Zero balance → `PlanLockedOverlay` with «اعتبار مصرف هوش مصنوعی این Workspace به پایان رسیده است». No provider cost / FX / multiplier ever exposed.
- Super Admin: new `AiBillingPage` with tabs — Dashboard (provider cost, workspace charges, provider gross margin + %, platform absorbed, runs, unresolved), Pricing (rate cards, FX, multiplier, plan allowances; "Create new version" only, history read-only), Runs drilldown, Health (unsettled runs, stale reservations, reconciliation mismatches). Fully localized fa/en/tr, RTL-safe.

## F. Tests

New suites under `src/test/billing/ai-billing/`: cost math per component, cached tokens, FX + multiplier, historical version immutability (run A unchanged after new FX/multiplier/rate), rounding precision, reservation/settlement/release, idempotent settlement under duplicate retry, concurrency (N parallel reservations against balance 1000 can never over-reserve), tenant isolation (workspace A cannot read/mutate B's wallet/ledger/runs), the six failure policies, fallback cap + absorbed cost, missing usage → ESTIMATED → RECONCILED, missing rate card → fail closed (never free), ledger append-only, plan allowance expiration and purchased rollover, refund/adjustment. Existing billing/security/AI suites must stay green.

## G. Rollout & migration

1. Ship schema + seed (rate cards for the models currently in use, FX and multiplier entered by super admin, plan allowances).
2. Turn on **METER_ONLY** — everything metered, nothing blocked; verify numbers in the admin dashboard.
3. Backfill historical `ai_usage_logs` into runs/usage events with `billing_quality = ESTIMATED`, `cost_source = BACKFILL`, **no ledger effect** (analytics only).
4. Flip to **ENFORCED**; `deduct_ai_credits` and `ai_credits_used` remain but stop gating AI. `ai_requests_count` kept for analytics.
5. Write `docs/AI_BILLING_ARCHITECTURE.md` (lifecycle, units, resolution order, failure policy, invariants) and refresh `docs/AI_CREDITS_POLICY.md`.

## Defaults I will use unless you say otherwise

- Storage currency IRR, display تومان (÷10).
- Default multiplier 3.0000, seeded as the first `ai_sell_policies` version; FX left unset until you enter it (billing fails closed and stays in METER_ONLY until configured).
- Rate cards seeded from public provider list prices for the models actually configured in this install, marked as super-admin editable.
- Phase order = the five phases above, delivered end-to-end (not left half-done).
