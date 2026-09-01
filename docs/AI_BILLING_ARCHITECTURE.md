# AI Usage Billing — Architecture

Self-hosted, provider-driven, Express-only. **No Supabase Edge Function is part
of this domain.** All financial logic lives in SQL functions owned by the
database plus the Express services under `server/services/ai-billing/`.

## Domain boundary

| Concern | Owner | Notes |
| --- | --- | --- |
| Analytics / debugging | `ai_usage_logs`, `ai_agent_runs` | unchanged, non-financial |
| Money | `ai_runs`, `ai_run_steps`, `ai_usage_events`, `ai_run_settlements`, wallet tables | append-only where it matters |

Financial state is never derived from the analytics tables and analytics is
never used to charge a workspace.

## Object model

```text
business operation
   └── ai_runs                (1 run per business operation, idempotent)
        ├── ai_run_steps      (each provider call attempt)
        │     └── ai_usage_events   (IMMUTABLE, insert-only, per component)
        └── ai_run_settlements      (exactly one settlement per run)

workspace_ai_wallets
   └── workspace_ai_balance_lots       (PLAN_ALLOWANCE | PURCHASE | ADJUSTMENT | REFUND_COMPENSATION)
        ├── workspace_ai_reservations  → workspace_ai_reservation_allocations (per lot)
        └── workspace_ai_ledger        → workspace_ai_ledger_allocations (per lot)
```

## Invariants

1. **One run per business operation.** `ai_begin_run(operation_key, request_hash)`:
   same key + same hash resumes the same run (real retry); same key + different
   canonical hash raises `idempotency_conflict` — never a silent reuse.
   The hash is built by `canonicalPayload()` from a sorted business payload with
   volatile fields (`requestId`, `attempt`, `timestamp`, `traceId`, …) removed,
   so a retry does not fork a new run and a different prompt cannot hide behind
   an old key.
2. **Usage events are immutable.** `ai_ingest_usage_event` takes an advisory lock
   on `(step, component, event key)`, then:
   - identical payload → `NOOP`;
   - different payload → row inserted into `ai_usage_event_conflicts`, run marked
     `UNRESOLVED / INGESTION_CONFLICT`, historical values untouched;
   - new key → `INSERTED`.
   `UPDATE`/`DELETE` on usage events and on both ledger tables is blocked by the
   `ai_billing_block_mutation()` trigger.
3. **Atomic settlement.** `ai_settle_run` charges, allocates per lot, writes the
   ledger entry and closes the reservation in one transaction, keyed by
   `settle:<runId>` in `ai_billing_commands`; a replay returns the first result.
4. **Reservation → settlement, never a double charge.** In `ENFORCED` mode a run
   reserves an estimate before the first billable step, tops it up between steps
   (`ensureBudgetForNextStep`), and the reservation is consumed by settlement.
5. **Refund routing is deterministic.** Consumption from purchased balance
   refunds to purchased balance; consumption from a still-active plan allowance
   refunds to that allowance; if the original allowance already expired a
   `REFUND_COMPENSATION` lot is created that expires at the end of the *current*
   cycle — an expired allowance never silently becomes non-expiring credit.
6. **Two-stage FX.** Provider currency → USD with the FX snapshot of *that usage
   event*; USD → IRR with the billing FX frozen at run start. A multi-provider,
   multi-currency run is therefore deterministic and a mid-run FX publication
   cannot change an already-recorded charge.
7. **Pricing is versioned.** Publishing a rate card / FX / sell policy creates a
   new version; each usage event stores the rate-card version it was priced with.
8. **Precision.** All arithmetic runs on BigInt fixed point at 12 decimals
   (`decimal.ts`); rounding happens only at the storage boundary
   (`NUMERIC(24,6)`).

## Modes

`app_runtime_config.ai_billing_mode`:

- `METER_ONLY` (default, safe): usage is measured, priced and settled against
  the ledger, but a workspace is never denied.
- `ENFORCED`: reservation is required before billable work. Missing pricing/FX
  fails closed. On exhaustion the sell policy decides:
  `CAP_AND_ABSORB` (platform absorbs the overage, recorded in
  `platform_absorbed_amount`) or `HALT_BILLABLE_EXECUTION`.

## Server wiring

- `server/services/ai/index.ts` — every provider execution goes through a Run:
  the caller's context if supplied, otherwise a standalone run opened here.
  One normalized usage object feeds both the immutable event and the legacy
  `ai_usage_logs` projection.
- `server/services/ai-billing/runContext.ts` — begin / record / budget-guard /
  settle / fail.
- `server/services/ai-billing/recovery.ts` — bounded recovery worker: expires
  stale reservations, settles stuck runs, closes orphans, expires lots, and
  promotes `ESTIMATED/UNRESOLVED` to `RECONCILED` **only** when authoritative
  provider usage exists and no ingestion conflict is open.
- `server/routes/aiBilling.ts` — workspace summary/history (final numbers only)
  and super-admin pricing, runs, health, mode, credit and refund endpoints.

## Security

Every financial SQL function is `SECURITY DEFINER` with a pinned `search_path`
and is granted to `service_role` only — `anon` and `authenticated` cannot
execute them (verified: `permission denied for function ai_available_balance`
from a non-service role). Wallet/ledger tables have RLS enabled with no client
policy; they are reachable exclusively through the Express service role.
