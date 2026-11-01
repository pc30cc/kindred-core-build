# Apirone gateway (`apirone`): USDT on TRON for WebYar's USD accounts

Temporary (owner, 2026-11-01): for Apple's App Review, a WebYar workspace
whose dashboard is not in Persian pays in US dollars with crypto; it is to
be removed later. The rule itself is in `docs/operations/EDITIONS.md`, "The
billing currency in WebYar follows the dashboard's language".

| | |
|---|---|
| Edition | Iranian only (`IRAN_ONLY_PAYMENT_PROVIDERS`, `shared/edition.ts`); RESPOK never lists, resolves or charges it |
| Coin and network | USDT on TRON only (`usdt@trx`, 6 decimals) |
| Accounts it charges | USD accounts only (`canChargeAccount`, `account/gateways.ts`) |
| Prices | the plans' own USD prices (`billing_plans.prices.USD`); no exchange rate, no VAT |
| Fee | paid by the customer: invoice = USD amount × (1 + fee % ÷ 100), rounded up to a whole micro-USDT |
| Invoice life | 1 hour; Apirone ends it (our clock never expires the payment), and the account's currency is held for 2 hours from its creation |
| Callback | `https://api.webyar.ai/api/billing/webhook/apirone` (sent on every invoice; unsigned, answered `*ok*`) |
| What is credited | what arrived (looked up at Apirone), mapped back to cents; under- and overpayments stay in the balance |
| Code | `server/services/billing/providers/apirone.ts`, `account/currencyChoice.ts`, migration 292 |

Apirone's API needs no key to create or look up an invoice. The account's
**transfer key** can move its funds out: it is never stored here (the
private invoice lookup that needs it is not used).

## Setup

0. **Migration 292** (`database/migrations/292_billing_crypto_usd_accounts.sql`)
   is applied by hand on WebYar's database BEFORE the code is merged
   (CLAUDE.md, Migrations: a dry run inside `BEGIN … ROLLBACK` first). RESPOK
   gets it from its migrator on push and never uses it.
1. **Apirone dashboard** (apirone.com): create the account (`apr-` and 32 hex
   characters), and under Settings set the **forwarding of `usdt@trx`** to the
   owner's own TRON wallet address, so every payment leaves Apirone's account
   at once. Nothing in this platform moves funds.
2. **Super Admin → Providers → Apirone**: the Account ID (`account`) and
   the Fee percent (`fee_percent`, 0 to 10, blank = 1, what the customer pays
   on top). Save, then press Test: it reads the account's public info for
   `usdt@trx`.
3. **Super Admin → Finance → Gateways**: turn Apirone on. Its readiness card
   lists it for USD (and, as expected, not for IRR).
4. Check with an English dashboard on a workspace that has not moved money:
   the billing page shows USD and Apirone; the hosted invoice page opens; a
   small payment comes back credited. Also send a little MORE than one
   invoice asks: it must read `overpaid` and then `completed` (the history
   at `GET /v2/invoices/{invoice}`), and be credited only at `completed`.
   Should Apirone leave it at `overpaid`, it is never credited on its own:
   credit it by hand and tell the developers.

The platform's public API address (Super Admin's domains, `api_base_url`)
must be https: it is the invoice's `callback-url`.

## How a payment goes

1. Checkout (`POST /api/billing/account/:ws/checkout` or `/topup`) creates the
   payment row, then the invoice (`POST /v2/accounts/{account}/invoices`,
   `linkback` = the billing page with `?payment=…&provider=apirone`); the
   customer is sent to Apirone's `invoice-url`.
2. Apirone calls back on every status change. The callback is a nudge: its
   account must be ours; the invoice is looked up
   (`GET /v2/invoices/{invoice}`); the payment is the one its own linkback
   names, and only when that invoice is the payment's stored reference is it
   looked up again and settled. Final: `completed` (the status, or a
   `completed` entry in the history), and `expired` with money; `created`,
   `paid`, `partpaid` and `overpaid` (all set at 0 confirmations) wait, so
   overpaying never skips the confirmation. Only the transactions up to the
   history's last `completed` entry count. A final callback that could not
   be settled (a database error, a lookup not final yet) is answered 500,
   so Apirone sends it again; it is never acknowledged unsettled. Outside
   the Iranian edition the route answers 404 before reading anything.
3. The customer's return (`POST …/payments/:id/verify`) does the same
   lookup. It never ends an Apirone payment for its age: Apirone does
   (`expired` with nothing arrived fails it), so a payment made at the end
   of the hour is not reported failed and then credited.
4. What arrived is mapped to cents (received × amount ÷ invoice amount,
   rounded down: a full payment is exactly the amount) and credited; a
   different amount first becomes the payment's amount
   (`billing_account_set_received_amount`; the quote is kept in
   `purpose_detail.quoted_amount_minor`). The plan is bought only when the
   balance covers it.

Money sent to an invoice after it expired reaches the forwarding wallet but
gets no callback from Apirone: it is not credited automatically; credit it by
hand (Super Admin → accounts → adjust) after checking the wallet.

## Turning it off

Super Admin → Finance → Gateways: turn Apirone off. USD accounts that have
not moved money then have no gateway listed, and no new USD account is
created (`PUT …/currency` answers `CURRENCY_NOT_AVAILABLE`); USD accounts
that moved money keep their USD balance. Removing the code later: the
provider, its registry and edition entries, `currencyChoice.ts` and the
route, and `ACCOUNT_CURRENCIES.iran` back to IRR.
