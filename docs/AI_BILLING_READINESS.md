# AI Usage Billing — operational readiness

**Status: `READY_FOR_LIVE_METER_VALIDATION`** (mode stays `METER_ONLY`;
`ENFORCED` is NOT enabled by any code path — it is an explicit admin action).

All customer-facing money is **stored in IRR (Rial) and displayed in Toman**
(1 Toman = 10 Rial). The conversion lives only in `src/lib/money.ts`, at the
presentation boundary; ledger, settlements and FX snapshots are untouched.

---

## 1. Mandatory database CI gate

`ai-billing-db` (`.github/workflows/ci.yml`) runs the financial suite against a
real `postgres:16` service with `REQUIRE_BILLING_DB=1`.

- `src/test/integration/aiBillingFinancial.pg.test.ts` **throws** when
  `REQUIRE_BILLING_DB=1` and `TEST_DATABASE_URL` is missing — a missing DB
  environment fails the job instead of silently skipping.
- The same job also runs the in-process suites (`src/test/aiBilling`).
- Locally, without `REQUIRE_BILLING_DB`, the suite still skips gracefully.

Current result: **28/28 database invariants** + **23 in-process billing tests**
(propagation 17, scheduler 4 of 21 shared file, failure semantics 2) passing.

## 2. Multi-instance recovery safety

Process-local single-flight is no longer the only guard:

- Migration `075` / `20260901105630_*` adds `ai_billing_recovery_lease`
  (singleton row) plus `ai_billing_try_acquire_recovery_lease(owner, ttl)` and
  `ai_billing_release_recovery_lease(owner)`.
- `runAiBillingRecoveryLeased()` acquires the lease, runs the pass, and releases
  it in `finally`. The ticker calls the leased variant, so with N replicas
  exactly one executes each cycle.
- TTL (240s, range-checked 30–3600s) means a crashed owner never blocks
  recovery: the next pass reclaims an expired lease.
- Recovery operations remain individually idempotent — the lease is a noise and
  contention guard, not the correctness mechanism.
- The admin manual endpoint (`POST /api/ai-billing/admin/recovery`) is unchanged.

Tests: two concurrent acquirers → exactly one winner; loser locked out; only the
owner can release; expired owner reclaimed; invalid owner/TTL rejected; `anon`
and `authenticated` have no EXECUTE.

## 3. Migration authority

| Deployment | Authoritative chain | Billing files |
|---|---|---|
| Self-hosted Postgres | `database/migrations/*.sql` (numeric) | `073_ai_usage_billing.sql`, `074_ai_billing_pricing_append_only.sql`, `075_ai_billing_recovery_lease.sql` |
| Hosted Supabase | `supabase/migrations/*.sql` (timestamp) | `20260901094824_*`, `20260901103902_*`, `20260901105630_*` |

No duplicate logic was invented: the self-host files are mirrors of the hosted
ones, registered in `src/test/integration/migrationMirrorParity.test.ts` (fails
on functional drift) and applied end-to-end by the `selfhost-chain` CI job.
Documented in `docs/DEPLOYMENT.md` §3 and `database/README.md`.

## 4. Regression baseline (before vs. after AI Billing)

| Test file | Failures before | Failures after | Signature | Touches billing code? |
|---|---|---|---|---|
| `src/test/billing/idpayProvider.test.ts` | 59 | 59 | `res.text is not a function` (fetch mock shape) | no |
| `src/test/billing/zarinpalProvider.test.ts` | 24 | 24 | `res.text is not a function` | no |
| `src/test/security/widgetSessionLineageAndCoverage.test.ts` | 7 | 7 | `ERR_ERL_KEY_GEN_IPV6` / widget token header | no |
| `src/test/security/widgetBootstrapCredentialSecurity.test.ts` | 6 | 6 | `Invalid value "undefined" for header "x-widget-token"` | no |
| `src/test/billing/selfHostEntitlementBoundary.test.ts` | 5 | 5 | `maybeSingle is not a function` (supabase mock) | no |
| `src/test/billing/singleWriterInvariants.test.ts` | 1 | 1 | `maybeSingle is not a function` | no |
| `src/test/billing/billingRouteSecurity.test.ts` | 1 | 1 | rate-limit IPv6 keygen warning | no |
| `src/test/inbox/sendMessageIdempotency.test.ts` | 1 | 1 | `fetch failed` | no |
| `src/test/kb/aiKbBuilderTabStates.test.tsx` | 1 | 1 | `expected spy to be called` | no |
| **Total** | **105 (9 files)** | **105 (9 files)** | — | — |

Totals: before `3769 passed / 105 failed / 9 files`; after
`3775 passed / 105 failed / 9 files` — the delta is exactly the new billing
tests. `grep -c 'ai-billing\|aiBilling'` returns **0** in every failing file, so
none of them import, mock or exercise billing code. No new failure was
introduced by AI Billing.

## 5. Active pricing configuration

`GET /api/ai-billing/admin/pricing/coverage` renders the live report:

- every rate card in force (provider, model, currency, version,
  `effective_from`, source, and each component rate: input, cached input,
  output, and any other component/unit/per-units);
- active provider-currency FX rows and the active USD→IRR billing FX;
- the active customer multiplier and overage policy (global and per workspace);
- included AI allowance per plan;
- `runtimePaths` — every provider/model runtime can actually bill, derived from
  the model catalog, recorded usage events and legacy usage logs;
- `missingRates` — billable paths with **no** valid rate card.

**Gate:** `readyForEnforced` is `false` while `missingRates` is non-empty or FX
/ sell policy is unconfigured. Do not switch to `ENFORCED` while it is `false`;
those calls could only be billed at zero.

## 6. Billing-DB failure semantics (tested)

`beginAiRunGuarded()` in `server/services/ai-billing/runContext.ts` is the
single decision point:

| Mode | Billing DB unavailable | Result |
|---|---|---|
| `METER_ONLY` | yes | AI keeps serving; no Run; failure counted in `degrade.ts` and written to `ai_billing_audit_log` as `billing_unavailable` with workspace / entry point / operation key for reconciliation |
| `ENFORCED` | yes | Fails closed — the error propagates **before** any billable provider call |

`idempotency_conflict` and `ai_allowance_exhausted` always propagate in both
modes. If the mode itself cannot be read, `METER_ONLY` semantics apply (serve),
and the loss is still recorded. Covered by
`src/test/aiBilling/billingFailureSemantics.test.ts`.

Degradation counters are exposed on `GET /api/ai-billing/admin/health` under
`degradation` (total, per stage, last 50 entries).

## 7. SECURITY DEFINER privilege audit (actual result)

Live check against the project database:

- 23 billing `SECURITY DEFINER` functions in `public`; **all** carry
  `search_path = public, pg_temp`.
- `has_function_privilege` for `anon` and `authenticated` is `false` for
  **every** one of them (including the two new lease functions). Only
  `service_role` may execute.
- Schema `CREATE` privilege: `public`, `extensions` and `pg_catalog` all report
  `false` for `anon`, `authenticated`, `service_role` and `PUBLIC` — owners are
  `pg_database_owner` / `postgres` / `supabase_admin`.
- Therefore no untrusted role can create an object in any schema on the
  functions' resolution path, and `pg_temp` is last, so function/operator
  resolution cannot be hijacked.

Linter note: the lease table reports the informational
`RLS Enabled No Policy` finding **by design** — it is service-role-only data
with RLS on and deliberately zero policies, so no client role can reach it. The
other findings in the project scan predate this work.

## 8. Live-meter validation checklist (numeric)

`GET /api/ai-billing/admin/health` → `validationChecklist` returns, for the
current cycle:

| Field | Expected during healthy METER_ONLY |
|---|---|
| `orphanUsageEvents` | 0 |
| `ingestionConflictsOpen` | 0 |
| `unresolvedRuns` | 0 |
| `staleReservations` | 0 (recovery releases them) |
| `settlementPendingRuns` | → 0 within one recovery cycle |
| `reconciliationMismatchWallets` | 0 (wallet vs. active lot truth) |
| `providerCostUsdTotal` | > 0 once AI is used |
| `internalCostIrrTotal` | ≈ providerCostUsd × billing FX |
| `theoreticalCustomerChargeIrrTotal` | ≈ internal cost × multiplier — the amount that WOULD be charged under `ENFORCED` |
| `platformAbsorbedIrrTotal` | absorbed under `CAP_AND_ABSORB` |
| `meterOnlyMetrics.settlementCoverage` | 1.0 |

Amounts are IRR in the payload (`currency: "IRR"`, `displayCurrency: "TOMAN"`)
and are shown divided by 10 in the UI.

## 9. Remaining limitations

- `ENFORCED` has been exercised only by tests, not by live traffic — that is the
  point of the live-meter validation window.
- Rate coverage depends on operator-published rate cards; today only the
  published cards exist, so `missingRates` must be reviewed before enforcing.
