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

- **Auto-renew on**: at the due moment the price is taken from the balance.
  In Multi Region with a saved card the card pays instead: Paddle charges it
  a day before the due moment, the payment lands in the balance and is spent
  on the next period in the same transaction, and the balance itself is never
  spent unasked (see "The saved card" below).
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
- Multi Region with a saved card: the difference (VAT on top) is charged to
  the card once (a Paddle one-time charge), then the card's recurring price
  follows the new plan without billing (`do_not_bill`). Not
  `full_immediately`: that bills the whole new price, not our difference.

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

## Emails

Every email the billing sends (renewal reminders 7/3/1 days, renewed,
expired to free, receipt, downgrade scheduled, data-deletion notices 30/7
days, top-up received) comes from the Super Admin's branding and email
settings, exactly like the rest of the platform: sender, logo, layout and
the text of each template. Nothing is hard-coded in the billing code.
Multi Region has its own templates, separate from Iran's, with its own brand
and languages; an Iran template is never used for a Multi Region workspace or
the other way round.

## AI credit

Fixed packs bought with one click from the balance.

## Screens

- Workspace: balance and top-up, plan and auto-renew, history with receipts,
  billing profile.
- Super Admin: plans and prices, gateways, accounts with balances, manual
  credit/debit, monthly revenue.

## Background work

One job: due periods every 5 minutes; reminders, AI credit, trials,
retention deletion and pruning of stale payment attempts hourly. Replaces
billing v2's 5-minute ticker (see "The hourly job" below).

## Phases

1. Hide billing v2 (workspace page, Super Admin finance tabs) and stop its
   scheduler. Code and data untouched. Everyone keeps their current plan.
2. Accounts, ledger, payments; top-up and receipts; billing profile. (Done:
   migration 259.)
3. Renewal, upgrade, downgrade, reminders, hourly job; Paddle saved card.
   3a (migration 261): everything but the saved card. 3b (migration 262):
   the Paddle saved card.
4. Computed locks, downgrade report, export, retention deletion.
5. AI credit packs.
6. Super Admin screens.
7. Move current subscriptions, back up and drop billing v2 code and tables.

## Technical design

Names avoid billing v2's tables (`billing_payments` and `billing_wallet_*`
exist there until phase 7).

### Which plan a workspace is on

Unchanged: `workspace_subscriptions` (`plan_id`, `status`, `billing_interval`,
`current_period_start`/`end`) stays the only source the entitlement code
reads (`planSelection.ts`, `check_workspace_entitlement`). The simple billing
writes it through one SQL function, and billing v2's guard trigger
(`trg_billing_v2_block_direct_subscription`) and lifecycle mail trigger are
dropped, because v2 no longer runs and its mails are not Super Admin
templates.

### Tables

- `billing_settings` (one row per edition, `iran` | `international`): the
  seller shown on receipts (legal name, economic code / national id or VAT
  id, address, phone, email), VAT percent per currency (null = not shown),
  receipt number prefix, AI credit packs per currency.
- `billing_accounts` (one row per workspace): `currency` (fixed at creation
  from the region: IRR / USD / TRY), `balance_minor` (never negative),
  `auto_renew`, the scheduled change (`scheduled_plan_id`,
  `scheduled_interval`, `next_period_prepaid_minor`), the saved card
  (`card_provider`, `card_customer_id`, `card_subscription_id`), the billing
  profile (company, economic code, national id, VAT id, address, postal code,
  country, invoice email), and which reminders were sent for which period.
- `billing_account_ledger` (append-only): `kind` (topup, renewal, upgrade,
  ai_pack, admin_credit, admin_debit, refund, prepaid_return),
  `amount_minor` (+ in, − out), `balance_after`, `currency`, the plan and
  period it paid for, and for money that came through a gateway the receipt:
  `receipt_number`, `net_minor`, `tax_minor`, `tax_percent`, the buyer and
  seller snapshot. An `idempotency_key` is unique.
- `billing_account_payments`: one row per gateway attempt: provider,
  currency, `amount_minor` (what the gateway charges = net + VAT),
  `purpose` (topup, renewal, upgrade, ai_pack, plan) with its details,
  `status`, `provider_ref`, `provider_payment_id`, `ledger_id`. Attempts that
  never finished are deleted after 30 days.
- `billing_plans` gains `locked_data_retention_days` (null = never) and
  `ai_allowance` (per currency, minor units).

### Money flow

- A gateway payment is settled by one SQL function, in one transaction:
  check amount and currency, credit the net to the balance with a receipt,
  then perform the purpose (renewal, upgrade, AI pack, plan purchase) from
  the balance. If the purpose can no longer be done (the plan changed in the
  meantime), the money stays in the balance.
- VAT is charged on money coming in (top-up or direct payment) and shown on
  its receipt; spending the balance later creates no second receipt.
- Gateways listed are those allowed in the edition, active, accepting the
  account currency, and able to confirm a payment (a `verifyPayment` or a
  signed webhook that carries our payment id).

### Plans: buy, renew, upgrade, change (phase 3a, migration 261)

Each rule is one SQL function (service_role only), one transaction, keyed so
that a retry does nothing twice; a replayed key must be the same charge
(same workspace, kind and amount) or it is refused. Simple billing writes
`workspace_subscriptions` only through `billing_account_write_subscription`,
which also writes `plan_change_log`. Super Admin plan assignments still
write it directly; right after one (assign, revoke, grant) a prepayment for
the old period's next one returns to the balance and a scheduled change is
dropped (`billing_account_admin_replaced`), whatever the new end date. A
prepayment made for a period replaced in any other way returns as soon as
the page, a quote, a checkout or a billing action sees it
(`billing_account_release_stale_prepaid`). Billing v2's customer endpoints that would write it (plan
change, invoice and wallet payments, v2 checkout, cancel/resume) answer
410 `BILLING_V2_RETIRED` while `LEGACY_BILLING_ENABLED` is off.

Every amount the page shows comes from the quote (`GET .../quote`), which
mirrors the SQL exactly: what the action takes from the balance now
(`amount_minor`), what it returns first (`returned_minor`: a prepaid next
period that now costs less), the upgrade's own cost, the prepaid next
period and its new price, and for "from the next period" its own amounts.
The page sends back the net amount it showed (`expectedNetMinor`); if the
price, balance or period moved meanwhile the server answers 409
`QUOTE_CHANGED` with the new quote and charges nothing.

- **Buy** (`billing_account_purchase_plan`): on Free, a trial, or after a plan
  ran out. The full price from the balance; the period starts now; the
  month's AI credit is granted. Refused while a paid period runs (that is an
  upgrade or a change). Idempotent per the browser's key.
- **Renew** (`billing_account_renew`): pays the next period at the price of
  the plan and interval it will have (the change scheduled for the period
  end, if any). Before the due date it is kept as
  `next_period_prepaid_minor` (with `next_period_start`, the period it was
  paid for); the next period starts when the current one ends. Every
  renewal is its own charge. The page (and the job) name the period they
  renew (`p_expected_period_end`): once it was renewed or replaced, a retry
  or a second tab renews nothing (`PERIOD_CHANGED`); a second renewal of a
  prepaid period is refused (`ALREADY_RENEWED`), as is one whose next period
  was already paid through billing v2 (a `scheduled` service period, which
  the due moment starts; no reminder either). The page also sends the price
  it showed (`p_expected_price_minor`): a price or scheduled change that
  moved since answers `QUOTE_CHANGED` and charges nothing.
- **The due moment** (`billing_account_process_due`; the job every 5
  minutes, and the billing page, a quote or a checkout of that workspace at
  once): a next period paid through billing v2 (`scheduled`) starts; else a
  prepaid next period starts; else, with auto-renew on and enough balance,
  it is paid from the balance and starts; else (or when Free is scheduled)
  the subscription becomes `expired` and the workspace is on Free at once.
  The plan stays on the row, so the page offers "Renew <plan>" (a purchase
  of that plan and interval) while it is still sold. Buying a plan in the
  minutes between the due moment and the job processes the due period
  first.
- **Upgrade** (`billing_account_upgrade`): at once, same interval, same due
  date. Monthly: the price difference. Yearly: the difference x whole months
  left / 12 (`billing_account_upgrade_cost`). The month's AI credit
  difference is granted under its own source (after the month of the old
  plan, so it is never added on top of the new plan's full allowance). A
  window longer than one interval (a Super Admin grant) pays the monthly
  difference for each whole month left. A scheduled plan change is dropped;
  a prepaid next period stays paid at the new plan's price (the difference
  is taken with the upgrade, or returned first when it costs less).
- **Change at the period end** (`billing_account_schedule_change`):
  downgrade, Free, monthly <-> yearly, or a higher plan "from the next
  period" (offered when fewer than 7 days are left). Choosing the current
  plan and interval cancels, always (even when the plan is no longer sold).
  A prepaid next period is re-priced: the difference returns to the
  balance, or the missing part is taken from it (the page offers a top-up
  of what is missing; a change cannot be paid online). Without auto-renew
  and without a paid next period, a scheduled change applies only if the
  next period is paid; the page and the mail say so.
- **Pay online** for a plan, a renewal or an upgrade: the gateway charges
  what the balance is missing (at least the top-up minimum), plus VAT; the
  settlement credits it and spends it on the purpose in the same
  transaction, or leaves it in the balance if the purpose can no longer be
  done; what happened is stored on the payment (`purpose_result`) and the
  return page says it. A renewal paid after the plan ran out buys that plan
  again. A refund of such a payment takes a prepaid next period back first.
  At most 10 payment attempts an hour per workspace (429
  `TOO_MANY_CHECKOUTS`).
- **AI credit**: each month of a period (and of a trial) gets the plan's
  monthly allowance once (`billing_account_grant_month`, cycle id
  `cycle:account:<month start>`, expiring at that month's end). The amount
  is the workspace's override, else `billing_plans.ai_allowance.IRR`, else
  the limit `included_ai_allowance_irr`, else `ai_credits_per_month`. A
  month another path already funded is not funded again: billing v2's own
  cycle, or the old calendar grant (`YYYY-MM`) made in that month of the
  same period. Granting a month retires what is left of older calendar lots
  (another plan's, such as a trial's, or an earlier month's), as billing v2
  did, so the two never add up. The AI wallet counts in its own unit
  (Rial).
- Billing v2's guard and lifecycle-mail triggers on `workspace_subscriptions`
  are dropped; its other tables and functions stay until phase 7.

### The hourly job (server/services/billing/account/job.ts)

Due periods every 5 minutes (`simple_billing_due` lease), so a workspace
moves to Free within minutes of its due moment. Beside it, every 5 minutes,
the saved cards' step (`simple_billing_card` lease, 3b below). The rest once an hour
(first two minutes after start), under the `simple_billing` ticker lease:
due periods again, the
month's AI credit, renewal reminders (7, 3, 1 days before; not sent when
auto-renew will pay or the next period is paid), trial reminders (3 and 1
days) and the end of a trial, pruning of unfinished payments (30 days). A
reminder is recorded in `billing_accounts.notices_sent` before it is sent
and taken back if the mail fails, so it goes out once. `SIMPLE_BILLING_JOB=off`
stops both on that process (renewals, the move to Free, AI credit and
reminders then wait for another process; only a workspace whose billing
page is opened has its own ended period processed): for a second replica
of a test install, never production.

The panel warns too: from 7 days before an unpaid due date (no prepaid
next period, and auto-renew cannot pay it) the sidebar banner and the
alerts bell say when the plan ends and link to the billing page
(`server/services/billing/account/renewalNotice.ts`).

### Billing emails

Templates (Super Admin -> Branding -> Email templates, per edition, fa/en/tr):
`billing_renewal_reminder`, `billing_renewed`, `billing_expired`,
`billing_plan_changed`, `billing_change_scheduled`, `billing_payment_receipt`,
`billing_plan_activated`, `billing_trial_ending`, `billing_trial_ended`, and
for the saved card (3b, sent in Multi Region only) `billing_card_renewed` (a
renewal the card paid, instead of `billing_renewed`; its `{card}` is "Visa ••••
4242", besides `{plan_name}`, `{amount}`, `{balance}`, `{period_start}`,
`{period_end}`), `billing_card_payment_failed` and `billing_card_removed`.
The server fills the variables in the edition's way (Toman, Persian digits
and the Persian calendar in Iran; the Gregorian calendar in Persian mail of
the international edition) and adds `billing_url`, `receipt_url`,
`{brand}`, `{year}`, `{support_email}`. Recipient: the billing profile's
invoice email, else the owner. `billing_change_scheduled` goes once per
target plan and interval per period (choosing back and forth mails each
once); an interval change names the interval ("Pro (monthly)").

Auto-renew starts off for every new account in 3a, Multi Region included:
its "default on" comes with the saved card (3b: saving a card turns it on),
so a card customer is never charged from a balance they did not expect to
be used.

### The saved card (phase 3b, migration 262)

Multi Region and Global only: edition `international`, region mode `multi`
or `global`, account currency USD, gateway `paddle` or `paddle_sandbox` with
its **Automatic card renewal (Multi Region)** switch on (off by default;
Super Admin → Providers → Billing). Iran never has a card: every card path
starts from a card row, and none is ever created there. Paddle setup,
permissions, events and the sandbox checks to run before switching it on:
`docs/operations/PADDLE_SANDBOX.md`.

- **What a card is.** One Paddle subscription per workspace with one
  recurring price we set (`billing_account_cards`; at most one live card,
  `active` or `past_due`). Paddle's clock charges it; our server only moves
  that clock to the end of the last paid period − 24 hours, and that price
  to the next period's plan, interval and price with VAT. Paddle can never
  be asked by our sync to bill: every change is `do_not_bill`, after a
  preview that shows nothing billed now.
- **Saving it.** "Renew automatically with this card" in the pay-online
  dialog (ticked by default, Paddle gateways only) for a plan or a renewal:
  the checkout charges the full price of the period (a renewal: the next
  period paid now) and its price recurs, so paying it makes Paddle create the
  subscription. `subscription.created` registers the card for the checkout's
  workspace (`billing_card_register`), points the account at it and turns
  auto-renew on. A second card of the same workspace (two tabs) is cancelled.
  The job registers a paid card checkout whose event never came. A card
  registered before its checkout settled waits up to 2 hours for it, counted
  from the later of the checkout being opened and the card being registered
  (a checkout paid hours after it was opened keeps its card).
- **Renewal.** Paddle charges the card 24 hours before the due moment. The
  transaction becomes a `card_renewal` payment (`billing_card_record_charge`,
  once per transaction) and is settled in one transaction
  (`billing_card_settle`): credited, then spent as the prepaid next period
  (`billing_card_apply_renewal`), which the due moment starts. No receipt of
  ours (Paddle mails its invoice); our mail is `billing_card_renewed`, which
  names the card. A renewal Paddle charged for the next period's very plan
  and interval renews at what it charged, even when the price rose since
  Paddle's item was last set (the new price applies from the period after);
  a price that fell is the one spent, and the rest stays in the balance.
  A payment that cannot be spent on the renewal (card no longer live,
  auto-renew off, already renewed, Free or unsold next, another plan or
  interval below the price) stays in the balance, with a receipt and a
  REVIEW log (`payments.review`).
- **Declined.** The card is `past_due`, `billing_card_payment_failed` goes out
  once per transaction, and the banner, the alerts bell and the billing page
  say so. A failed attempt Paddle reports after the transaction was collected
  (its notifications come in any order) changes nothing and is not mailed. The customer can update the card and pay (Paddle's
  update-payment-method transaction, in Paddle.js) or renew from the
  balance (the card is cancelled first, but only for a renewal that will go
  through: otherwise the renewal's own refusal is answered and the card
  stays). Turning auto-renew off then cancels the card at once (Paddle's
  retries stop; the plan runs to its end).
- **The due moment.** The server first asks Paddle for a paid renewal it
  never heard of and settles it. `billing_account_process_due` never renews a
  card account from the balance: with nothing prepaid the workspace moves to
  Free (no grace) and the card is marked `canceling`, then cancelled at
  Paddle at once (Paddle's own retries stop). A renewal that still arrives
  after that buys the plan again, but only for a card cancelled because it
  had not paid (`not_renewed`), and only when it covers that plan's price
  now (the balance is never spent on it unasked).
- **Upgrade.** Charged to the card: exactly the quoted difference, one
  `/charge` per payment row (`card_charge`, at most one pending per
  workspace), with `prevent_change` so a decline changes nothing. A charge
  whose answer never came is never posted again: it is looked up by the
  payment id on its item (the webhook, the verify route, the job) and fails
  as `charge_not_found` after an hour. Paddle's minimum is 70 cents. Only
  the total the button showed is charged (`expectedTotalMinor`, VAT
  included; another one answers `QUOTE_CHANGED` and the page reloads its
  VAT). Each attempt counts toward the 10 payment attempts an hour
  (`TOO_MANY_CHECKOUTS`). The page offers it only for a card whose gateway
  still has card renewal on for the viewer (`card.chargeable`); otherwise
  the upgrade is paid online or from the balance.
- **Plan changes.** Downgrade, interval change, Free and their cancel are
  3a's; triggers on the billing tables move the card's `sync_version`, and
  the reconciler (`card.ts` `syncCard`, after every action and from the job)
  moves Paddle's date and price, or cancels at Paddle's period end (Free,
  not sold, auto-renew off). Plan actions are refused while the card is
  `past_due` (`CARD_PAST_DUE`) and from 2 hours before Paddle's charge until
  Paddle moved its date on, at most 6 hours after (`CARD_RENEWAL_IN_PROGRESS`).
  The same window is also kept around the charge our own period expects (its
  end − 24 hours) while that renewal is not recorded, because Paddle moves
  its date on before the renewal reaches us; once that time has passed, a
  renewal Paddle charged is pulled and settled first, which ends it.
  The reconciler never moves Paddle's date earlier over a renewal Paddle
  charged that we have not recorded: it settles that renewal instead, and it
  decides again on what is paid right before it moves a date earlier (a
  renewal another notification settled meanwhile moves our date on). One
  that did not renew our period (charged at another amount, so credited as a
  top-up for review; or refused by a renewal guard) keeps Paddle's date too:
  Paddle is never asked to charge that period again. Inside the freeze the
  reconciler changes nothing, except that a date of Paddle's earlier than
  ours is moved later (never earlier, never the item) while Paddle's own
  30-minute lock is still away.
- **Customer actions.** Auto-renew off: Paddle cancels at its period end
  first, then the flag goes off (on again before then undoes it); refused
  (`CARD_RENEWAL_IN_PROGRESS`) once Paddle's charge time has passed and its
  renewal is not recorded yet (its money would stay unspent). Remove
  card: cancelled at Paddle first, then here; the plan runs to its end. A
  cancel made in Paddle's own portal is followed (auto-renew off, mail),
  never undone. "Renew from balance" with a card moves Paddle's charge one
  period on first, so the card does not pay the period the balance paid.
  Paying a renewal online is refused while a card is live
  (`CARD_PAYS_RENEWAL`).
- **Routing Paddle's events.** A transaction Paddle made from a subscription
  (any origin but a checkout's) and the subscription's own events are card
  events: they act only through our own card row or our own card checkout,
  never on the workspace their copied `custom_data` names (RESPOK's database
  is a clone of WebYar's), and never by the checkout's copied `intent_id`.
  A subscription not registered yet is our checkout's only while that
  checkout has no card and Paddle's checkout transaction names that very
  subscription. One that is not ours is acknowledged and nothing is done.
  Our `custom_data` (`workspace_id`, `card_id`) is written once; other keys
  Paddle keeps are left as they are. A refund or a
  chargeback of a card payment uses the refund path; a chargeback also
  cancels the card at once (REVIEW). A refunded card renewal that renewed
  the period turns auto-renew off (the card stops at Paddle's next date);
  one that renewed nothing (kept in the balance for review, such as a charge
  for a period already paid) changes nothing else. A chargeback reversal
  books nothing and is logged REVIEW for a person.
- **A deleted workspace.** Its card row is kept: a card not cancelled yet
  is marked `canceling` (`workspace_deleted`) instead of being deleted, and
  the job cancels it at Paddle. (Deleting a workspace whose balance has
  ledger rows fails today: the ledger is append-only since 259.)
- **The job's card step** (every 5 minutes): cards to sync, paid card
  checkouts with no card, upgrade charges still pending, cards still to
  cancel at Paddle, and renewals Paddle charged whose event never came.
- **Routes.** `GET /account/:ws` adds `card` (with `chargeable`),
  `card_available`, `card_providers` (managers only); `POST checkout` takes
  `autoRenew`; `POST card/charge` (`{purpose: 'upgrade', planId,
  expectedNetMinor, expectedTotalMinor}`), `POST card/update`,
  `DELETE card`; `PUT auto-renew` answers the card too (International
  only).
- **Deploying.** The server reads the card table on every due step, plan
  action and renewal notice, Iran included (it finds nothing there): apply
  262 to WebYar's database by hand before merging, as every migration
  (RESPOK's migrator applies it on push). It is inert without card rows.
  On RESPOK the new backend may start before its migrator has applied 262:
  until then those reads treat the missing table as no card.

