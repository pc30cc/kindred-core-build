# Simple billing (replaces billing v2)

Agreed with the owner on 2026-10-10. This file is the specification; each
phase below lands as its own PR and ticks its line here.

## Why

Billing v2 (about 33 tables, ~50 server files, a 5-minute scheduler with ten
workers, dunning, pre-issued invoices) is far heavier than the product needs,
and it is Rial-only for the wallet and AI credit. Production holds almost no
billing data (2-4 invoices per database), so it can be replaced outright.

## The model: a prepaid account, no pre-issued invoices

- Every workspace has one **account** with a **balance** in one fixed currency.
  The balance is *service credit*: it is spent on the platform, never paid out
  as cash. Refunds go back through the gateway, for the payment they refund.
- Money comes in as a **top-up** (gateway payment, or a Super Admin grant) and
  goes out as **plan renewal**, **upgrade**, or an **AI credit pack**.
- No invoice exists before money moves. Every successful payment has a
  **receipt**, which is a complete invoice document (seller, buyer billing
  profile, lines, VAT, serial number), rendered from the ledger row.
- Tables (all new):
  - `billing_accounts`: one row per workspace: currency, balance, plan,
    billing interval, current period, auto-renew, scheduled change, card
    subscription reference, billing profile (company, economic code, national
    id, VAT id, address).
  - `billing_ledger`: append-only; one row per money movement with
    `balance_after`. About 1-2 rows per workspace per month.
  - `billing_payments`: one row per gateway attempt, created only when the
    customer presses pay. Unfinished attempts older than 30 days are deleted.
- AI usage does not write ledger rows; it keeps its own counter.

## Currency, gateways, tax per edition

| | Iran (`region_mode = iran`) | Multi Region / Global | Turkey only |
|---|---|---|---|
| Currency | Toman (stored as IRR) | USD (cents) | TRY (kuruş) |
| Gateways | Iranian gateways | Paddle (merchant of record), Stripe | iyzico, PayTR |
| VAT | percent from Super Admin (10% today) | empty by default (Paddle computes tax itself) | percent (20% KDV) |
| Auto-renew default | off (no stored cards) | on (saved card via Paddle subscription) | off |

- A VAT field left empty is not shown anywhere.
- An account's currency is fixed by its first money movement.
- Each plan has its own monthly and yearly price per currency.

## Plans (Super Admin)

Per plan: monthly and yearly price per currency, limits, monthly AI credit,
VAT per edition, and **locked-data retention days** (empty = never deleted).

## Renewal

- **Auto-renew on**: at the due moment the price is taken from the balance (in
  Multi Region the saved card is charged by Paddle first; the payment lands in
  the balance and is spent in the same transaction).
- **Auto-renew off**: from 7 days before the due date the panel shows a banner
  and reminder emails go out (7, 3 and 1 days before), with **Renew from
  balance** and **Pay online** buttons. Nothing is charged unless pressed.
- **Not renewed**: at the due moment the workspace moves to the free plan.
  There is no grace period.
- **Early renewal**: the new period starts at the end of the current one.
- **Yearly plans** grant their AI credit monthly, not all at once.

## Upgrade (immediate, no day counting)

- Monthly plan: pay `new price - old price`.
- Yearly plan: pay `(new yearly - old yearly) × remaining whole months / 12`.
- The AI credit difference is added at once; the due date does not move.
- With fewer than 7 days left the page also offers "upgrade from next period".
- Multi Region with a saved card: Paddle subscription update with
  `proration_billing_mode = full_immediately`, amounts computed by us.

## Downgrade and interval change (at period end)

- Takes effect at the end of the current period; it is paid at the due date
  at the cheaper price. It can be cancelled until then.
- If the next period was already paid, the price difference returns to the
  balance.
- Once a period has started, nothing is refunded for it.
- Monthly ↔ yearly also takes effect at period end.

## Over the limit after a downgrade: lock, never delete

- Locks are **computed** (rank by creation time against the plan limit), not
  stored, so a downgrade or upgrade writes nothing and an upgrade unlocks
  everything at once. Oldest items stay active; the newest are locked first.
  The owner does not pick.
- Knowledge base: locked articles are hidden from the help center and the AI
  and cannot be edited.
- Contacts: kept; the excess is blurred and not clickable. A new visitor's
  chat is never blocked.
- Chats: older than the plan's retention are blurred and locked; when the
  monthly quota is full the widget shows the leave-a-message form.
- Agents: the owner stays; the most recently joined are deactivated and their
  open chats return to the queue.
- Modules and channels: stopped, settings kept. The downgrade warning says that
  messages to stopped channels are not received meanwhile.
- AI: the plan's credit follows the new plan; purchased credit stays.
- Storage over the limit: only new uploads are blocked.
- Before a downgrade is confirmed, a report lists exactly what will be locked.
- Locked data can always be exported by the owner.
- Locked data is deleted after the plan's retention days, after notices 30
  and 7 days before.

## AI credit

Fixed packs bought with one click from the balance.

## Screens

- Workspace: balance and top-up, plan and auto-renew, history with receipts,
  billing profile.
- Super Admin: plans and prices, gateways, accounts with balances, manual
  credit/debit, monthly revenue.

## Background work

One job, hourly: due renewals, reminders, scheduled changes, retention
deletion, pruning of stale payment attempts. Replaces the 5-minute ticker.

## Phases

1. Hide billing v2 (workspace page, Super Admin finance tabs) and stop its
   scheduler. Code and data untouched. Everyone keeps their current plan.
2. Accounts, ledger, payments; top-up and receipts; billing profile.
3. Renewal, upgrade, downgrade, reminders, hourly job; Paddle saved card.
4. Computed locks, downgrade report, export, retention deletion.
5. AI credit packs.
6. Super Admin screens.
7. Move current subscriptions, back up and drop billing v2 code and tables.
