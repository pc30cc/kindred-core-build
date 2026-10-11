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
5. AI credit packs. (Done: migration 264; see "AI credit packs" below.)
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
  ai_pack, admin_credit, admin_debit, refund, prepaid_return, and since
  264 ai_pack_return),
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
days) and the end of a trial, pruning of unfinished payments (30 days), and
the `locks` step of phase 4 (below: a paused member's open chats back to the
queue, the deletion clock, the 30/7-day notices and the deletion; it acts
only while the edition's billing locks are on, at most 200 workspaces an
hour). A
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
4242", besides `{plan_name}`, `{amount}` (what the card was charged, VAT
included), `{balance}`, `{period_start}`, `{period_end}`),
`billing_card_payment_failed` (its `{failure_reason}` read from Paddle's
error code, as the billing page reads it), `billing_card_removed`, and for
phase 4 `billing_locked_data_deletion` (locked data is deleted on
`{deletion_date}`, sent 30 and 7 days before with `{days_left}`; also
`{plan_name}`, `{locked_summary}` such as "12 articles, 340 contacts", and
`{export_url}`; migration 265, both editions). A card
Paddle names no type for is "Card •••• 4242" in English and only "•••• 4242"
in Persian and Turkish, whose templates already say "card".
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
  Its net, tax and VAT percent are the ones on Paddle's item (its
  `custom_data` carries `net_minor`, `tax_minor` and `vat_percent`; a VAT
  change re-syncs the item), so a VAT change Paddle's item could not follow
  before the charge never prints a percent the tax was not priced with.
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
  payment id on its item (the webhook, the verify route, which the dialog
  calls while it waits for up to a minute, the job) and fails
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
  Paddle is never asked to charge that period again. Nor is its date moved
  earlier while the checkout that saved the card is not settled here (a card
  saved mid-period paid the next period with it): that checkout is asked
  about first, and until it settles the date stays (`setup_unsettled`).
  Inside the freeze the reconciler changes only what never bills and never
  charges sooner, and only while Paddle's own 30-minute lock is still away:
  a date of Paddle's earlier than the one our period anchors (its end − 24
  hours, never the one clamped to now + 45 minutes, which would push a
  correct date on at every pass) is moved later; a stop is scheduled at
  Paddle's period end; and the item is set to the next period's (a plan or
  interval change made just before), with Paddle's date kept, after a
  preview that bills nothing and does not move that date (one that would
  waits). Never a date earlier.
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
  the job cancels it at Paddle. Its ledger rows and payments go with it:
  since 263 the purge (`admin_purge_workspaces`, used by workspace and user
  deletion) names the workspaces it purges, and the append-only ledger lets
  their rows go. Deleting a user keeps the ledger rows and payments of
  workspaces that survive (one the user topped up, say), with `actor_id` and
  `created_by` left pointing at the deleted user. Outside a purge the ledger
  stays append-only.
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

### Over the limit: computed locks (phase 4, migration 265)

Nothing is stored about what is locked. Per workspace and kind, SQL computes
the effective limit and a cutoff row; a row ranked after it is locked. A
downgrade, an upgrade, an override or a deleted row changes what is locked
at the next read, without writing anything to the locked rows.

- **The switch.** `billing_settings.locks_enabled` per edition, off by
  default (a fresh database has no row: off). While it is off nothing is
  locked, stopped or deleted anywhere: no row lock, no paused seat, no
  stopped channel, no new storage gate, no `quota_full` in the widget, no
  `over_quota` capture, no acknowledgement for a downgrade. The downgrade
  report is then a preview. Super
  Admin → Plans → Billing settings → Billing locks: a **Preview** of every
  active workspace on its current plan (what would lock now, and the
  workspaces whose X plugin stops), then the switch, which asks first
  (`/api/admin/billing/locks`, `/preview`). WebYar and RESPOK turn it on
  separately, after the owner has reviewed the preview.
- **Which limit.** The plan in force (the twin of `planSelection.ts`, else
  Free), the workspace's limit override first. Only a limit the plan names
  locks: an absent key, `-1`, or a value that is not a whole number locks
  nothing (registry defaults are never used, so the Trial plan without
  `max_agents` and every plan without `data_retention_days` lock nothing).
  The plan editor therefore does not write the default it shows for a lock
  limit (`max_agents`, `max_contacts`, `max_kb_articles`,
  `data_retention_days`) that an existing plan does not name, unless the
  Super Admin changes it. A workspace that is not `active`, or a self-host
  install without billing, never locks. Locks fail open: an unreadable plan
  locks nothing more; the create-time quotas stay fail-closed (503).
- **Ranking.** Oldest first by `(created_at, id)`; a missing `created_at`
  ranks first; limit 0 locks every row.
  - Knowledge base: every article, any status, against `max_kb_articles`
    (aliases `ai_kb_max_articles`, `kb_articles`).
  - Contacts: not spam, and not an anonymous widget visitor (no name, email
    or phone), against `max_contacts`; the contact quota counts the same
    rows (`billing_countable_count`).
  - Members: everyone but the owner and suspended members, against
    `max_agents − 1` (the owner holds a seat), keyed by user id. The seat
    count of invitations (`wi_resolve_seat_capacity`) reads the same limit
    (Free's 2 seats after a plan ends, no longer 0) and does not count
    suspended members.
  - Chats: by last activity (`updated_at`, else `created_at`) older than the
    plan's `data_retention_days`. A message from the visitor moves
    `updated_at`, so a customer who comes back reopens the thread.
- **What a lock does.** Every refusal is a 403 `{error, upgrade_required:
  true}`.
  - Knowledge base: hidden from the help center, the widget, Telegram's help
    menu and the AI (retrieval re-check, index sync), read-only (403
    `kb_article_locked`, also from the AI KB builder's accept and publish);
    deleting stays allowed and unlocks the next article at once.
  - Contacts: listed blurred and redacted (only id and creation date leave
    the server), 403 `contact_locked` (with the plan's `limit`) on open,
    its chats list and edit; delete stays allowed. A new visitor is never
    blocked. In an unlocked chat a locked contact is redacted too (D4).
  - Chats: listed without subject or preview (`locked_by_retention`), 403
    `conversation_locked` (with `retention_days`) on messages, reply,
    change, claim and take-over.
  - Members: 403 `seat_locked` everywhere in that workspace except
    `GET /api/workspace-members/me`, which the app reads to show "your seat
    is paused" instead of the page; out of routing, push and email
    notifications. Their open chats return to the queue when the plan
    change applies, when a member is suspended or removed, from the hourly
    job, and when routing meets one. Suspended members are not routed
    either (this one applies with the switch off too).
  - Modules: stopped by their existing gates. Channels: stopped, settings
    and secrets kept; ingest answers 200 `{accepted: false, reason:
    'plan_locked'}` so providers do not retry, a reply in such a chat is
    refused (`plan_locked`) and a queued one cancelled, and the plugin
    catalog shows it as stopped. An unreadable plan stops nothing.
  - Storage: only new operator uploads are blocked (AI files, workspace
    icon, call-center avatar; 403 at the limit, 503 when unreadable); an
    inbound Yahoo Mail attachment is skipped and its message kept.
  - The monthly chat quota: the widget gets `availability.quota_full` and
    shows the leave-a-message form, and those messages are kept (tag
    `over_quota`).
  - Converting a learned answer to an article now counts against
    `max_kb_articles` like any new article (with the switch off too).
- **The report.** `billing_lock_report(ws, plan)` plus the server's modules,
  channels and AI credit (`locks/report.ts`). The quote of a change to
  another plan at the period end carries it (`lock_report`), and the plan
  picker shows it. While the switch is on and it lists anything, the change
  needs the customer's "I understand" (`acknowledgeLocks`, else 409
  `LOCKS_NOT_ACKNOWLEDGED` with the report). Its counts are those of now;
  the dialog says they are final at the effective date. With the switch
  off the change goes through as before. `GET .../lock-report` (managers)
  serves the panel's banner, which owners and admins see while something is
  locked, with the next deletion date and links to upgrade and export.
- **Export.** The owner (`workspaces.owner_id` only) can always export what
  is locked when the export runs, on every plan, whatever `contact_export`
  says: a ZIP (articles as JSON and Markdown, contacts as JSON and CSV,
  chats with their messages and up to 500 MB of attachments; at most 50,000
  rows per kind, the manifest says when more were left out), one at a time
  per workspace (`billing_lock_exports`). It is stored in the privacy-export
  storage when one is set up, else the workspace's own (not counted against
  its quota), and kept 7 days; each download link works once and for 15
  minutes, and a new one can be asked for until then. Routes:
  `POST|GET /api/billing/account/:ws/locked-export`,
  `POST .../locked-export/:id/download-token`,
  `GET /api/billing/account/locked-export/download?token=`; a worker on
  every replica builds the file (`locks/exportWorker.ts`).
- **Deletion.** Only when the plan sets `locked_data_retention_days` (L; none
  does by default) and the switch is on. The hourly job records when it
  first saw a kind locked (`billing_lock_clocks`, a clock, not a lock: no
  row ids), sends `billing_locked_data_deletion` 30 and then 7 days before
  the deadline, and deletes only after both went out: at the latest of
  since + L, 30 days after the 30-day notice and 7 days after the 7-day
  notice. It deletes only rows locked now and named by the 30-day notice
  (created before it), storage objects first. Chats go in monthly batches
  (the 1st, 00:00 UTC) with the cutoff fixed when the 30-day notice goes
  out. Upgrading, deleting rows or raising a limit removes the clock. Members
  are never deleted, nor are modules, channels or files.
- **Deploying.** On WebYar build the four indexes of 265's header with
  `CREATE INDEX CONCURRENTLY` first, then apply 265 by hand (after 264) as every
  migration. Nothing changes until the switch is turned on.

Decisions the rules above leave open (agreed in the phase 4 design):

| # | Question | Decision |
|---|---|---|
| D1 | Every widget visitor creates a contact. | Spam and anonymous widget contacts (no name, email or phone) count neither for the quota nor for the lock. |
| D2 | "Chats older than retention": created or last active? | Last activity (`updated_at`, else `created_at`); a visitor's new message moves it. |
| D3 | Do suspended members hold seats? | No: not counted, not ranked; suspending frees a seat. |
| D4 | A locked contact in an open chat. | The chat works; the contact's link and stored fields are hidden. |
| D5 | Notices for chats that expire every day. | Monthly deletion batches: at most two notices a month. |
| D6 | What is deleted? | Articles, contacts and chats only. |
| D7 | Where the deletion clock lives. | `billing_lock_clocks`, written by the job; a downgrade writes nothing. |
| D8 | Channel messages while stopped. | Answered 200 and dropped, so providers do not retry. |
| D9 | Unreadable plan. | Locks fail open; create quotas stay fail-closed. |
| D10 | Leave-a-message over the monthly quota. | Kept and shown to operators, tagged `over_quota`; not locked. |
| D11 | Rollout. | A switch per edition, off by default, turned on after the Super Admin's preview; Iran stays off until the owner reviews it. |

### AI credit packs (phase 5, migration 264)

Fixed packs of AI credit, bought with one click from the balance or paid
online. Credit bought this way never expires; the plan's monthly credit is
spent first.

- **The packs.** Super Admin → Plans → AI credit packs, per edition and
  currency: Iran `IRR`; Multi Region / Global `USD` and `TRY`. Stored in
  `billing_settings.ai_packs` as `{"USD": [{"id": "m", "price_minor": 2000,
  "credit_minor": 2200, "active": true, "label": {"fa", "en", "tr"}}]}`. The
  price and the credit are both in the pack's own currency, in minor units
  ("$20 buys $22 of AI credit"; in Iran both in Rial, entered as Toman). At
  most 8 per currency; `id` is `^[a-z0-9][a-z0-9_-]{0,23}$`, unique per
  currency, and stays once saved; an Iranian price is whole Toman (a multiple
  of 10 Rial). None are seeded: until Super Admin saves packs, none are
  offered.
- **When they are sold.** Only while AI billing is `ENFORCED` (in
  `METER_ONLY` credit blocks nothing, so selling it would mislead; the
  billing page hides the AI card), and only with an exchange rate for the
  account's currency (below). A payment made online that settles after the
  mode changed still delivers its pack: the money was paid.
- **The AI wallet's unit.** The AI wallet counts in Rial. A pack's credit is
  converted at purchase with the rate the AI meter charges with
  (`ai_exchange_rates`, the open row): `currency→IRR`, else `currency→USD ×
  USD→IRR`; IRR is 1. The rate and the wallet amount are kept on the ledger
  row. No rate: the pack is not offered and nothing is debited
  (`billing_ai_fx_unavailable`). The page shows the AI balance in the
  account's currency (`floor(wallet / rate)`), Toman in Iran: credit that
  ends (the plan's, and a refund's compensation lot) with its end date, and
  credit with no end (packs, Super Admin's credit) as never expiring. In Multi Region
  the `USD→IRR` rate is only an internal scale: changing it after packs were
  sold rescales every workspace's AI credit in dollars, so the pack editor
  warns about it.
- **From the balance** (`billing_account_buy_ai_pack`, one transaction, lock
  order account then AI wallet): an `ai_pack` ledger row of −price (no
  receipt: the money already had one when it came in), then a `PURCHASED` AI
  lot with no expiry (`ai_purchase_credit`, unchanged). The page sends the
  price it showed (another one: `QUOTE_CHANGED`, nothing charged) and a key:
  the ledger row is `ai_pack:<workspace>:<browser key>`, its lot
  `ai_pack_lot:<ledger id>`. A replay returns the same row and lot, before
  the pack is looked up, so it still answers after the pack was edited or
  removed; the same key on another workspace is refused.
- **Pay online** (purpose `ai_pack`, like a plan, renewal or upgrade): the
  gateway charges what the balance is missing (at least the top-up minimum),
  plus VAT; the settlement credits it with its receipt ("AI credit") and buys
  the pack in the same transaction (key `ai_pack:payment:<payment id>`). A
  pack changed or removed meanwhile, or a rate gone, leaves the money in the
  balance and says why (`purpose_result.error`). A saved card never pays for
  a pack.
- **What never touches purchased credit.** The month's grant, an upgrade, a
  change at the period end, the due moment (also the move to Free), the end
  of a trial, the expiry of lots, and phase 4's locks: they act on
  `PLAN_ALLOWANCE` lots or lots with an expiry only.
- **Refunds.** A refund of a payment that bought a pack reverses the pack
  first (`billing_ai_pack_reverse`): at most the refund's net share, never
  more than the pack's price in all, and never more than the share of the
  price its unused credit is worth (what a reply in flight reserved is not
  unused). That credit leaves the lot (AI ledger `ADJUSTMENT`, reason
  `ai_pack_refund`; the lot is `DEPLETED` when empty) and its price share
  returns to the balance as `ai_pack_return`; the refund is then taken from
  the balance as before. What the pack already used stays `shortfall_minor`
  and is logged REVIEW. A refund of a plain top-up whose money later bought a
  pack from the balance does not touch the pack.
- **Email.** `billing_ai_pack_purchased` (fa/en/tr, both editions), after
  every pack, with `{pack_name}` (the pack's name in the mail's language,
  else a generic "AI credit pack"), `{credit}`, `{amount}`, `{balance}`,
  `{ai_balance}` (empty without a rate) besides the common variables. A pack
  paid online also gets `billing_payment_receipt`.
- **The old Rial top-up** (`/api/ai-billing/.../topup/config|preview|checkout`)
  answers 410 `BILLING_V2_RETIRED` while `LEGACY_BILLING_ENABLED` is off; an
  old intent already paid is still credited by its verify callback. Super
  Admin's manual AI credit stays.
- **Not in this phase.** The plan's monthly AI credit per currency
  (`billing_plans.ai_allowance.USD`) is still read as IRR; phase 6's plan
  screens take it up.
- **Deploying.** Apply 264 to WebYar's database by hand before merging (it
  redefines settlement and refund, which the server calls); RESPOK's migrator
  applies it on push. It is inert until packs are saved and AI billing is
  `ENFORCED`. Then: set the packs, make sure RESPOK has a `USD→IRR` rate (and
  `TRY→USD` or `TRY→IRR`), and switch AI billing to `ENFORCED` when ready.
