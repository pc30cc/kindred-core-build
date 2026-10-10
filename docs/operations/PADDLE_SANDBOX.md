# Paddle sandbox gateway (`paddle_sandbox`)

A test gateway for the International edition (RESPOK) that runs against
Paddle's **sandbox**: no real money moves, and the checkout shows Paddle's
"Test Mode" watermark. It is a gateway of its own, next to live `paddle`, so it
can be configured and switched on without touching the live account's
credentials.

| | Live `paddle` | `paddle_sandbox` |
|---|---|---|
| Paddle account | vendors.paddle.com | **sandbox-vendors.paddle.com** (a separate login) |
| API base | `https://api.paddle.com` | `https://sandbox-api.paddle.com` (forced) |
| Paddle.js | production | `Paddle.Environment.set('sandbox')` (forced) |
| API key | `pdl_live_apikey_…` (or an older key with no prefix) | must contain `_sdbx` |
| Client-side token | `live_…` | must start with `test_` |
| Webhook URL | `…/api/billing/webhook/paddle` | `…/api/billing/webhook/paddle_sandbox` |
| Credentials | `billing_provider_credentials` row `paddle` | its own row `paddle_sandbox` |
| Editions | both | International only (never listed, resolved or charged in the Iranian edition) |
| Who can pay with it | every customer | Super Admins only, until "Open to customers" is switched on |

Code: `server/services/billing/providers/paddle-sandbox.ts` (wraps
`paddle.ts` with the sandbox forced on), `shared/testGateways.ts`,
`shared/edition.ts` (`INTERNATIONAL_ONLY_PAYMENT_PROVIDERS`).

No database migration is needed: the gateway's Finance → Gateways row is
created the first time it is saved there, and its credentials go into the
existing `billing_provider_credentials` table.

## What the integration needs from Paddle

- **No catalog product or price.** Each checkout creates a transaction with a
  non-catalog, one-time price for exactly the invoice amount (tax-inclusive,
  `tax_mode: internal`), with an inline product named after the plan. The
  optional *Product ID* attaches that price to an existing product instead; it
  must be a product of the **sandbox** catalog (`pro_…`).
- **Events** the provider handles (`paddle.ts → verifyWebhook`):
  - `transaction.paid`, `transaction.completed` of a checkout (origin `api` /
    `web`) — settle the invoice or account payment (the second one is an
    idempotent no-op);
  - `adjustment.created`, `adjustment.updated` — an approved refund, or an
    approved chargeback (marked as one), is recorded once per adjustment;
  - with *Automatic card renewal* on (below): every `transaction.*` that
    Paddle made from a subscription (origin `subscription_recurring`,
    `subscription_charge`, `subscription_update`,
    `subscription_payment_method_change`) and `subscription.created`,
    `.activated`, `.updated`, `.past_due`, `.paused`, `.resumed`, `.canceled`
    are *card events*, routed by the subscription id (never by the checkout's
    `intent_id`, which Paddle copies onto the subscription and its renewals).
  Every other event (`transaction.payment_failed` of a checkout included: the
  checkout stays open for another try) is acknowledged and ignored.
- **Currencies:** USD, EUR, GBP, TRY (the same as live Paddle). RESPOK
  invoices in USD.

## Setup (RESPOK)

1. **Sandbox account.** Sign up at <https://sandbox-vendors.paddle.com/signup>
   (a separate account from the live one; no verification needed).
2. **Default payment link.** Paddle → *Checkout* → *Checkout settings* →
   *Default payment link*: `https://app.respok.app/`. Paddle refuses to create
   transactions until one is set (`transaction_default_checkout_url_not_set`).
   In the sandbox any domain is accepted — no domain approval is needed (live
   Paddle needs `app.respok.app` approved under *Website approval*).
3. **API key.** *Developer tools* → *Authentication* → *API keys* → *New API
   key*. The key starts with `pdl_sdbx_apikey_`. Permissions: at least
   *Transactions* read + write (create the checkout, verify it, cancel a
   superseded one) and *Notification settings* read (the Super Admin "Test"
   button lists event types); for automatic card renewal also
   *Subscriptions* read + write. It is a sandbox key, so giving it every
   permission is fine.
4. **Client-side token.** Same page → *Client-side tokens* → *New client-side
   token*. It starts with `test_`.
5. **Notification destination.** *Developer tools* → *Notifications* → *New
   destination*:
   - Type: webhook; URL: `https://api.respok.app/api/billing/webhook/paddle_sandbox`
   - Events: `transaction.paid`, `transaction.completed`,
     `adjustment.created`, `adjustment.updated`; for automatic card renewal
     also the events listed under [Automatic card renewal](#automatic-card-renewal-multi-region)
   - Save, then copy the destination's *secret key* (`pdl_ntfset_…`).
6. **Credentials in RESPOK.** Super Admin → *Providers* → *Billing* →
   **Paddle — Sandbox (test)**: API key, client-side token, webhook secret,
   (optional) sandbox product id. Leave **Open to customers** off unless
   ordinary accounts must test too (a test card buys a real plan for nothing).
   A live key or token is refused here with a message saying why; the live
   `paddle` gateway likewise refuses `_sdbx` / `test_` credentials unless its
   own *Sandbox Mode* is on.
   Saving on that screen also makes the saved vendor the platform's *default*
   billing provider (as for every vendor). The invoice engine does not use
   that default for the sandbox (customers pick a gateway from Finance →
   Gateways, and the sandbox is never a non-admin's fallback), but if the
   legacy default matters, save the live gateway again afterwards.
7. **Switch it on.** Super Admin → *Finance* → *Gateways* → *Paddle — Sandbox
   (test)*: active, currency USD. It is always marked as a test gateway.
8. **Check.** Super Admin → *Billing* → *Providers* → *Paddle — Sandbox (test)*
   → *Test* should answer OK (it calls `GET /event-types` on the sandbox, and
   with *Automatic card renewal* on also `GET /subscriptions?per_page=1`, which
   fails with a message naming the missing *Subscriptions* permission).

## Testing a payment

Signed in as a Super Admin (or any account once *Open to customers* is on),
open an unpaid invoice → *Pay*. The gateway shows as **Paddle — Sandbox
(test)** with the "Test gateway" mark, and a note with the test card while it
is selected. Paddle's test cards (any future expiry, any CVC, any name):

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | paid, no 3-D Secure |
| `4000 0038 0000 0446` | paid after a 3-D Secure challenge |
| `4000 0000 0000 0002` | declined (the checkout stays open) |

After a payment, the customer returns to the payment page (`…&_ptxn=txn_…`),
which verifies the transaction with sandbox-api.paddle.com; the
`transaction.paid` webhook settles the same invoice (idempotently).

Sandbox behaviour to expect:

- Webhooks are retried only **3 times within 15 minutes** (live: 60 times over
  3 days), so keep the backend up while testing.
- Refunds (Paddle → *Transactions* → *Refund*) are approved automatically
  about every 10 minutes; the approved `adjustment.updated` records the
  refund on the payment.

## Automatic card renewal (Multi Region)

Simple billing phase 3b (`docs/billing/SIMPLE_BILLING.md`): a Multi Region /
Global account (USD) can tick "Renew automatically with this card" when it
pays for a plan. The checkout's price then recurs (`billing_cycle`), so
Paddle saves the card on a **subscription** with one price we set, and
charges it 24 hours before each of our due dates. Our server moves that
subscription's date and price (always with `proration_billing_mode:
do_not_bill`, after a preview that shows nothing billed), cancels it when
auto-renew is turned off or the card is removed, and charges an upgrade's
difference with a one-time `/charge`. The Paddle layer is
`server/services/billing/providers/paddleSubscriptions.ts`; the card logic is
`server/services/billing/account/card.ts`.

It is **off** until the Super Admin switches **Automatic card renewal (Multi
Region)** on for a Paddle gateway (Providers → Billing → the gateway).
Switch it on for `paddle_sandbox` first, run the checks below, then for live
`paddle`. With it off nothing new is offered; cards already saved keep
renewing and their notifications are still handled.

Before switching it on, for that gateway's Paddle account:

- **API key permissions:** add *Subscriptions* read + write (get, preview,
  update, cancel, one-time charge), next to *Transactions* read + write and
  *Notification settings* read. *Test* checks the read part.
- **Notification events:** add to the destination
  - `transaction.created`, `transaction.billed`, `transaction.paid`,
    `transaction.completed`, `transaction.payment_failed`,
    `transaction.past_due`, `transaction.canceled`;
  - `subscription.created`, `subscription.activated`, `subscription.updated`,
    `subscription.past_due`, `subscription.paused`, `subscription.resumed`,
    `subscription.canceled`;
  - `adjustment.created`, `adjustment.updated` (refunds and chargebacks).

### Sandbox checks before going live

Each check tests an assumption the design makes about Paddle. Run them on
the sandbox; Paddle's *Transactions* / *Subscriptions* pages and the
notification log show what happened. A renewal can be brought forward by
setting `next_billed_at` at least 30 minutes ahead, and the sandbox does not
retry failed payments.

1. `PATCH next_billed_at`, earlier and later, with `do_not_bill`: no
   transaction and no credit is created.
2. Swapping the item (monthly → yearly included) with `do_not_bill`: note
   what happens to `next_billed_at` (the next sync corrects it if it moved).
3. `/charge` with `on_payment_failure: prevent_change`: a decline comes back
   in the call (400 `subscription_payment_declined`; save the card with
   Paddle's test card that succeeds once and then declines), and a charged
   transaction can be found with `GET /transactions?subscription_id=…`
   carrying the price's `custom_data.payment_id`.
4. A renewal transaction has `origin: subscription_recurring`, the copied
   top-level `custom_data`, and the item's price `custom_data`
   (`plan_id`, `interval`, `net_minor`, `tax_minor`).
5. Cancelling a `past_due` subscription immediately also cancels its open
   transaction (no later charge).
6. Whether updates are refused while a cancel is scheduled (auto-renew off,
   then on again before the date).
7. `payments[].method_details.card` (`type`, `last4`, `expiry_month`,
   `expiry_year`) is present on the checkout and on a renewal.
8. Under `tax_mode: internal`, a reverse-charged business buyer's
   transaction `total` still equals our price. If it does not, the money is
   still credited (as a top-up, logged REVIEW) but the renewal is not
   applied, and the tax mode needs a decision.

Taken from Paddle's API reference, not yet seen in practice: a chargeback
arrives as an `adjustment` with `action: chargeback` and `status: approved`;
it is recorded like a refund, marked as a chargeback. A `chargeback_reverse`
(the money coming back) is acknowledged and left to a person.

## How test money is marked

Payments and intents carry their gateway in `provider_name`; there is no
separate test column (the same convention as `zarinpal_test`,
`internal_test`, …). `shared/testGateways.ts` lists the test gateways. The
finance report (`/api/billing/admin/finance-report`) keeps their money in the
totals, as before, and marks it: `byProvider[].test`, `recentPayments[].is_test`
and `totals.testRevenue` (the part of `grossRevenue` that came through test
gateways). Super Admin → Billing → Report shows a "Test gateway" badge on
those providers.

## Removing it

Switch it off in Finance → Gateways. Its credentials can stay; the live
`paddle` gateway is unaffected either way. Cards already saved through it
keep renewing (keep its notification destination); switching *Automatic card
renewal* off only stops new ones.
