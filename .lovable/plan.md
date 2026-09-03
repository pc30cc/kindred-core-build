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

- `113_billing_v2_core.sql` — `billing_invoices`, `billing_invoice_lines`, `billing_subscription_periods`, `billing_invoice_applications`; `workspace_subscriptions` gains anchor/current_period_id/next_invoice_at/next_plan_id/pending_change_type/grace/free_fallback columns; `billing_payment_intents` gains `invoice_id`, `wallet_deposit_id`.
- `114_billing_v2_wallet.sql` — `billing_wallet_accounts`, `billing_wallet_ledger` (append-only trigger), `billing_wallet_deposits`, `billing_payment_allocations`.
- `115_billing_v2_rpcs.sql` — `billing_issue_invoice`, `billing_settle_invoice`, `billing_apply_invoice_effects`, `billing_activate_period`, `wallet_deposit`, `wallet_apply_to_invoice`, `wallet_refund`, `wallet_admin_adjust`. All `SECURITY DEFINER`, pinned `search_path`, revoke PUBLIC/anon/authenticated, grant service_role.
- `116_billing_v2_dunning_retention.sql` — `billing_notification_jobs` (unique idempotency_key), `billing_retention_cases`, platform billing policy settings (lead days, reminders, grace, fallback plan, retention days, wallet auto-pay default).
- `117_billing_v2_backfill.sql` — one `billing_subscription_periods` row per active subscription with `source = legacy_migration` (no fake paid invoices), plus `billing_v2_effective_at` marker per workspace to block double AI grants.

## 4. Backend engine

- `services/billing/invoice/` — issue, snapshot-immutable lines, settle, applyEffects (renewal → schedule period, upgrade → activate now, new → activate now).
- `services/billing/wallet/` — typed wrappers over the wallet RPCs, no JS arithmetic.
- `services/billing/proration.ts` — integer IRR, time-ratio on UTC, single documented rounding rule.
- Workers (durable, leased, reusing the existing worker/ticker infrastructure — no edge functions, no pg_cron): invoice scheduler, period activation, dunning, notifications, retention purge.
- `ensureCycleAllowance()` demoted: it stops granting plan allowance once `billing_v2_effective_at` is set for the workspace; grants come only from period activation.

## 5. UI

Billing IA becomes: نمای کلی / فاکتورها / پلن‌ها / کیف پول / اعتبار هوش مصنوعی / تراکنش‌ها, plus invoice detail, past-due banner, retention summary, and a Super Admin billing policy page. All Persian labels per §129–132; Jalali presentation only.

## 6. Phasing (each phase ends with tests + typecheck + build, no merge)

| Phase | Content |
| --- | --- |
| A | Migrations 113–115, invoice/wallet/settlement engine, invariant tests |
| B | Backfill 117, rollout flag `billing_engine_version=v2`, no-double-grant tests |
| C | Invoice scheduler, wallet auto-pay, period activation worker |
| D | Iran UI switch (invoices, wallet, overview, transactions) |
| E | Dunning + grace + free fallback + notifications (116) |
| F | Retention engine, resource-specific behaviors, purge safety |

## 7. Decisions I need from you before Phase A

1. Phase-by-phase delivery (recommended) vs. one giant change set.
2. Downgrade of a yearly plan mid-term: next-cycle only (per §32) — confirm no proration refund in V1.
3. Gateway overpayment: hard-reject non-exact amounts in V1 (§86) — confirm.
4. Free plan periods: give Free subscriptions a monthly period with no invoice (§79) — confirm.
