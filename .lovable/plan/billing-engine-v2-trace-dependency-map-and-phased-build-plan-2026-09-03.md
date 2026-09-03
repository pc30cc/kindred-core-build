# Billing Engine V2 — Trace, Dependency Map, and Phased Build Plan

Per §140, this is the pre-implementation trace and plan. No code is written yet.

## 1. Where money currently creates entitlement directly

Three paths bypass any invoice concept today:

```text
Gateway callback (server/routes/billing.ts ~line 640)
  ├─ purchase_type = 'subscription'
  │    └─ applySubscriptionPayment()  → RPC billing_apply_subscription_payment
  │         → mutates workspace_subscriptions period in place
  │         → handleWorkspaceEntitlementChanged()
  └─ purchase_type = 'ai_credit_topup'
       └─ aiLedger.purchaseCredit() → purchased AI lot

AI summary endpoint (server/routes/aiBilling.ts:64 ensureCycleAllowance)
  └─ on READ of the summary, grants the plan AI allowance for the
     CALENDAR month (billingCycleId() = "YYYY-MM"), command key
     grant:<ws>:<YYYY-MM>:plan, expiry = first day of next month
```

Consequences to fix:
- Payment success is the authority, not an invoice.
- Plan AI allowance is calendar-month-bound and granted as a side effect of a GET.
- Subscription has a single mutable period row; no period history, no scheduled period.
- No wallet, no invoice, no dunning, no retention.

## 2. Dependency map (what must keep working)

| Component | Files | V2 role |
| --- | --- | --- |
| Payment intents (105/107/108) | `services/billing/paymentIntent.ts`, `providerBinding.ts`, `invoiceNumber.ts` | kept; gains `invoice_id` / `wallet_deposit_id`; amount becomes non-authoritative |
| `billing_payments` (105) | `applyPayment.ts:recordCustomerPayment` | kept; becomes settlement money only, allocated to invoices |
| Durable application marker (106) | `billing_subscription_applications` | superseded by `billing_invoice_applications`; kept for legacy replay safety |
| Period math | `services/billing/periods.ts` (+tests) | reused verbatim for invoice periods |
| Entitlements | `entitlementChange.ts`, `entitlementFanout.ts`, `capabilityRegistry.ts` | reused; registry extended with `limit_type` + `retention_behavior` |
| AI ledger (073/109) | `services/ai-billing/*`, `ai_grant_allowance` | kept; grant key moves to `plan_allowance:<period_id>` |
| Transaction history (108) | `transactionHistory.ts` | extended with invoice relation |
| ACL convergence | migration 109 | pattern reused for all new RPCs |

Migration numbers 110–112 are already taken (admin data reset / chunked export / schema dump), so **Billing V2 starts at 113**.

## 3. Schema plan (additive, rerunnable)

- `113_billing_v2_core.sql` — `billing_invoices` (types: `new_subscription`, `subscription_renewal`, `plan_upgrade`, `addon`, `manual`, **`ai_credit_purchase`**), `billing_invoice_lines`, `billing_subscription_periods`, `billing_invoice_applications`; `workspace_subscriptions` gains anchor/current_period_id/next_invoice_at/next_plan_id/pending_change_type/grace/free_fallback columns; `billing_payment_intents` gains `invoice_id`, `wallet_deposit_id`, and an immutable `expected_amount_irr` copied from the invoice at checkout creation.
- `114_billing_v2_wallet.sql` — `billing_wallet_accounts`, `billing_wallet_ledger` (append-only trigger), `billing_wallet_deposits`, `billing_payment_allocations`.
- `115_billing_v2_rpcs.sql` — `billing_issue_invoice`, `billing_settle_invoice`, `billing_apply_invoice_effects`, `billing_activate_period`, `wallet_deposit`, `wallet_apply_to_invoice`, `wallet_refund`, `wallet_admin_adjust`. All `SECURITY DEFINER`, pinned `search_path`, revoke PUBLIC/anon/authenticated, grant service_role.
- `116_billing_v2_workers.sql` — one shared durable job table backing every billing worker: `status` (pending / leased / succeeded / failed), `attempt_count`, `lease_until`, `next_attempt_at`, `last_error`, `idempotency_key UNIQUE`, plus `claim`/`complete`/`fail` RPCs. Notification, dunning, retention and scheduler jobs all use this one pattern; no critical lifecycle depends on an in-process timer.
- `117_billing_v2_dunning_retention.sql` — `billing_retention_cases` and platform billing policy settings (lead days, reminders, grace, fallback plan, retention days, wallet auto-pay default).
- `118_billing_v2_backfill.sql` — one `billing_subscription_periods` row per active subscription with `source = legacy_migration` (no fake paid invoices), a monthly zero-invoice period for Free subscriptions, plus `billing_v2_effective_at` marker per workspace to block double AI grants.

## 4. Backend engine

- `services/billing/invoice/` — issue, immutable line snapshot, settle, applyEffects.
- **Frozen effect snapshot:** when an invoice moves to `open`, its `effect_snapshot` JSONB is frozen with `source_plan_id`, `target_plan_id`, `action_type`, `effective_at`, `period_start/end`, proration inputs and result, target limits/entitlement snapshot, AI allowance delta and billing interval. `applyInvoiceEffects()` reads ONLY this snapshot — a later Super Admin price or plan-definition change can never re-price an already-issued invoice.
- **Exact-amount, fail-closed settlement:** `gateway_verified_amount == payment_intent.expected_amount_irr == invoice.amount_due_irr` is asserted before settlement. Any mismatch aborts entitlement application; the money is still recorded as a `billing_payments` row flagged for reconciliation (and, where policy allows, credited to the wallet) so no received payment is ever lost.
- **AI credit purchase is invoice-based:** `ai_credit_purchase` invoice → payment/wallet → invoice paid → `ai_purchase_credit` exactly once, keyed `invoice:apply:<invoice_id>`. The direct `Payment → aiLedger.purchaseCredit()` path is removed. Wallet deposits remain the one exception: they are a deposit receipt document, not an invoice.
- `services/billing/wallet/` — typed wrappers over the wallet RPCs, no JS arithmetic.
- `services/billing/proration.ts` — integer IRR, time-ratio on UTC, single documented rounding rule. Downgrade is next-cycle only in V1: no refund, no proration credit.
- Workers on the shared durable lease/retry pattern (no edge functions, no pg_cron): invoice scheduler, period activation, dunning, notifications, retention purge.
- `ensureCycleAllowance()` demoted: it stops granting plan allowance once `billing_v2_effective_at` is set for the workspace; grants come only from period activation. Free subscriptions get a monthly period so allowance, quotas and usage cycles stay period-bound with no zero invoice issued.

## 5. UI

Billing IA becomes: نمای کلی / فاکتورها / پلن‌ها / کیف پول / اعتبار هوش مصنوعی / تراکنش‌ها, plus invoice detail, past-due banner, retention summary, and a Super Admin billing policy page. All Persian labels per §129–132; Jalali presentation only. No UI work happens before Phase D.

## 6. Phasing (each phase ends with its own migration run on a scratch DB, integration tests, typecheck and build — nothing is applied to production and nothing is merged until the phase is reported)

| Phase | Content |
| --- | --- |
| A | Migrations 113–115, invoice/wallet/settlement engine, frozen effect snapshot, exact-amount settlement, AI-credit invoice path, invariant + concurrency tests |
| B | Backfill 118, rollout flag `billing_engine_version=v2`, no-double-grant tests |
| C | Shared worker table 116 + invoice scheduler, wallet auto-pay, period activation worker |
| D | Iran UI switch (invoices, wallet, overview, transactions) |
| E | Dunning + grace + free fallback + notifications (117) |
| F | Retention engine, resource-specific behaviors, purge safety |

## 7. Confirmed decisions

1. Phase-by-phase delivery; no giant change set.
2. Downgrade (monthly and yearly) is next-cycle only in V1 — no automatic refund or proration.
3. Gateway payments are exact-amount only; mismatch fails closed but the payment is preserved for reconciliation.
4. Free plans get monthly subscription periods with no zero invoice.
5. AI credit purchases go through an `ai_credit_purchase` invoice; wallet deposits stay a separate deposit document.
6. Payment intents keep an immutable expected amount sourced from the invoice; the client is never an amount authority.
7. Invoice effects run from the frozen snapshot only.
8. All billing workers share one durable lease/retry job contract.

## 8. Phase A exit criteria

Migration chain green on a fresh DB and on a 109-state DB; invoice/settlement/wallet RPC ACL tests (anon and authenticated denied, service_role allowed); concurrency tests (double settlement, double invoice application, wallet + gateway race, no overpayment); invariant tests for the three invariants in §139; frontend typecheck, server typecheck, production build, `git diff --check`. No production migration, no merge.

