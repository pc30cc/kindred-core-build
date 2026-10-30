# Taking payment gateways live

Three gateways are going live:

- **ZarinPal**, for WebYar (Iran edition, IRR).
- **Zibal**, for WebYar (Iran edition, IRR), next to ZarinPal (owner, 2026-10-30). See section 1b.
- **Paddle**, for RESPOK (International edition, USD/EUR), with automatic card renewal.

All other gateways stay in the Providers portal but **inactive** in Finance → Gateways. That covers PayPing, NextPay, SEP, IDPay, Stripe, PayPal, Lemon Squeezy, iyzico, PayTR, Sipay, Paratika, Craftgate and manual. Do not switch them on yet. They were audited against their providers' current APIs in October 2026; section 4 says, for each one, what to enter, where, and what to know before it is switched on.

Live and test are separate gateways that run the same code:

| Live | Its sandbox (already tested end to end) |
|---|---|
| `zarinpal` | `zarinpal_test` (and `internal_test`) |
| `zibal` | `zibal_test` |
| `paddle` | `paddle_sandbox` |

The live gateways have **no sandbox switch**. Live `zarinpal` always talks to `api.zarinpal.com` and `www.zarinpal.com`. Live `zibal` always sends the merchant code saved in Providers and refuses Zibal's test merchant `zibal`; `zibal_test` always sends `zibal`. Live `paddle` always talks to `api.paddle.com` and runs Paddle.js in `production`. A sandbox switch stored earlier is ignored. The only differences from the sandbox are the hosts and the credentials. Requests, verification, callbacks, webhooks, amounts and refunds are the same code.

**The name customers see** is the Super Admin's: Finance → Gateways → the pencil next to a gateway's name. There is one field per panel language (Persian, English, Turkish), each up to 60 characters. A language left empty shows the English name, then the Persian one, and at least one name is required, so a customer never sees a gateway's internal id. The name appears in the customer's list of payment methods, and it is copied onto the receipt of each payment settled after it is saved; earlier receipts keep the name they were issued with. The gateway's own page (Zibal's, ZarinPal's, Paddle's) shows the gateway's brand, which this setting cannot change.

Super Admin paths used below:

- **Providers**: `/admin/providers?type=billing&provider=<name>`. This is where credentials go. The **Test** button checks the saved settings against the gateway itself.
- **Finance → Gateways**: `/admin/finance?tab=gateways`. Here you switch gateways on or off and set their currencies and order. The **Billing gateways** card at the top shows, per currency, whether customers see each gateway and why not. "Settings incomplete" names the missing field.

---

## 1. ZarinPal (WebYar)

### What you need from ZarinPal

| Field in Providers | Where to get it |
|---|---|
| **Merchant ID** (required) | ZarinPal panel → Gateways (terminal) → your terminal. It is 36 characters in UUID form (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Anything else is refused on save. |
| **Currency** (optional) | Leave it on **IRR (Rial)**. Simple billing sends the exact Rial amount. IRT (Toman) divides by 10 and rounds, so a VAT total that is not a multiple of 10 Rial would be charged a few Rial off. |

On the terminal in ZarinPal's panel:

- **Website / domain:** `app.webyar.ai`. The gateway sends the customer back to `https://app.webyar.ai/<workspace>/billing?payment=<id>&provider=zarinpal&Authority=…&Status=OK|NOK`. Because the app is https, no API hop is used. If ZarinPal also asks for the API domain, add `api.webyar.ai`; the fallback hop `https://api.webyar.ai/api/billing/account-return` is used only for a non-https app address.
- **IP restriction:** if the terminal has an IP whitelist, add the production server's address **5.39.70.213** (since 2026-10-28; it was 192.99.68.134, the address ZarinPal answered from in the 2026-10-12 probe, so an IP registered before the move must be replaced). It is outside Iran. Without it, ZarinPal answers -10.
- **Webhook:** none. ZarinPal is confirmed by the server calling `verify.json` when the customer returns. Nothing needs registering.

RESPOK (International edition) never offers ZarinPal, so there is no RESPOK URL for it.

### Order of steps

1. **Providers → ZarinPal (`zarinpal`)**: enter the Merchant ID, set Currency to IRR, and save.
2. Press **Test**. The server sends a real payment request (20,000 Rial, never paid) with `https://app.webyar.ai/billing` as the callback. It shows success **only** when ZarinPal answers code 100. If it fails, it shows ZarinPal's code and meaning:
   - **-10**: invalid terminal. Check the merchant id, the IP whitelist and the domain.
   - **-11**: terminal not active yet.
   - **-12**: too many attempts. Wait a few minutes.
   - **-9**: validation, for example the callback domain.
3. **Finance → Gateways**: switch `zarinpal` **on**, with currency IRR. The readiness card must show it **Listed** for IRR. If it says "Settings incomplete", it names the missing field.
4. Do the small real payment (smoke test below).
5. Only after it passes, switch **`zarinpal_test` and `internal_test` off** in Finance → Gateways. Until then they are also offered to customers.

### Smoke test (ZarinPal)

1. In a WebYar workspace, open **Billing → Top up** and pay a small amount in IRR. It must be at or above ZarinPal's minimum; 10,000 Toman is safe.
2. On the bank page the address must be `www.zarinpal.com/pg/StartPay/A…`. An authority that starts with **S** means the sandbox: stop.
3. Pay. Back on the billing page the top-up shows **succeeded** with a receipt, and the balance grows by the net amount.
4. Reload that page. It shows the same receipt, and the balance does not grow again.
5. Start another top-up and **cancel** on the bank page. That payment ends as failed (`gateway_failed`), and nothing is credited.
6. In the ZarinPal panel, the paid transaction appears with the same amount. Its reference number (ref_id) is the payment's `provider_payment_id`.

What else to know:

- **The customer must come back to the billing page.** ZarinPal reverses an unverified payment to the payer by itself.
- **A verify that took the money but whose answer was lost settles on the next try.** This can happen on a restart or a network cut. ZarinPal answers 101 ("already verified") for that payment's own authority, and the server accepts it once. Each ZarinPal call times out after 20 s.
- **Refunds are manual.** ZarinPal has no refund API here. Refund in the ZarinPal panel, then book a debit in Super Admin → Finance → Accounts → the account → Adjust.

---

## 1b. Zibal (WebYar)

The adapter was already in the code (audited in October 2026, section 4.1). On 2026-10-30 the owner decided to take it live next to ZarinPal.

### Probed from the production server (2026-10-30)

From `host.respok.app` (5.39.70.213), with Zibal's test merchant `zibal`, so no money moved:

- `POST /v1/request` answered `result: 100` with a `trackId` in **0.4 s**. Zibal answers this server, unlike SEP and IDPay.
- The start page `gateway.zibal.ir/start/{trackId}` offers pay and cancel. "Pay" redirected (302) to our callback with Zibal's fields **appended to our own query**: `https://app.webyar.ai/<workspace>/billing?payment=<id>&provider=zibal&success=1&status=2&trackId=…&orderId=…`.
- `POST /v1/verify` answered 100 with `amount` and `status: 1`. The sandbox gives `refNumber: null`, so the trackId is used as the reference there. A second verify answered **201** ("previously verified") with no amount, and `/v1/inquiry` then gave `status: 1` and the amount. That is exactly the "already verified" path in section 4.
- Before payment, verify answered 202 and inquiry `status: -1`.

`src/test/billing/zibalTestProvider.test.ts` replays these answers.

### What you need from Zibal

| Field in Providers | Where to get it |
|---|---|
| **Merchant code** (`merchant`, required) | Zibal panel → the gateway → merchant code. The test merchant `zibal` is refused on the live gateway. |

On the gateway in Zibal's panel:

- **Website:** `app.webyar.ai`. The callback must be on that domain (else the request answers 106), and the `Referer` of the redirect to `/start/…` must match it (else Zibal does not open its payment page). The app sends the customer there with a normal browser redirect under `Referrer-Policy: strict-origin-when-cross-origin`, so the Referer is `https://app.webyar.ai/`.
- **IP list:** if the gateway has one, add **5.39.70.213**. Otherwise Zibal answers 115.
- **Webhook:** none. Zibal is confirmed by the server calling `/v1/verify` when the customer returns.

### Order of steps

1. Optional, before the merchant code exists: **Finance → Gateways**, switch **`zibal_test`** on (currency IRR). It needs no settings. Only platform admins are offered it, with the "Test gateway" badge. Top up from a WebYar workspace with it, press pay on Zibal's test page, and the billing page shows **succeeded** with a receipt. Then switch it off again.
2. **Providers → Zibal (`zibal`)**: enter the merchant code and save.
3. Press **Test**. The server sends a real payment request (20,000 Rial, never paid) with `https://app.webyar.ai/billing` as the callback. It shows success only on result 100. Otherwise it shows Zibal's code and meaning: 102 merchant not found, 103 inactive (or the contract is not signed), 104 invalid, 106 callback domain refused, 115 server IP not registered.
4. **Finance → Gateways**: switch `zibal` **on** with currency IRR. It is listed after ZarinPal (its seeded order, 3). The first listed gateway is preselected for the customer, who can pick the other. Optionally set the name customers see with the pencil. The readiness card must show it **Listed** for IRR.
5. Run the smoke test below.

### Smoke test (Zibal)

1. In a WebYar workspace, open **Billing → Top up**, choose Zibal (under the name set in step 4) and pay a small amount. Zibal's minimum is 1,000 Rial.
2. The bank page is `gateway.zibal.ir/start/…`.
3. Pay. Back on the billing page, the top-up shows **succeeded** with a receipt, the receipt names the gateway as customers see it, and the balance grows by the net amount.
4. Reload. The same receipt shows, and the balance does not grow again.
5. Start another top-up and **cancel** on Zibal's page. That payment ends as failed (`gateway_failed`; verify answers 202), and nothing is credited.
6. In Zibal's panel, the paid transaction shows the same amount. Its `refNumber` is the payment's `provider_payment_id`.

What else to know:

- **The customer must come back to the billing page**, as with ZarinPal: the server verifies on that return.
- **Refunds are manual.** Refund in Zibal's panel, then book a debit in Super Admin → Finance → Accounts → the account → Adjust.

---

## 2. Paddle (RESPOK), with automatic card renewal

### What you need from Paddle (vendors.paddle.com, the LIVE account)

1. **A live Paddle account with onboarding and domain review finished.** Without it Paddle answers `transaction_checkout_not_enabled`.
2. **Checkout → Checkout settings → Default payment link**: an address on an approved domain, for example `https://app.respok.app/`. Without it, every transaction fails with `transaction_default_checkout_url_not_set`. The app sends no `checkout.url`; it opens Paddle.js on its own billing page.
3. **Approve the domain** `app.respok.app` (Checkout → Website approval). Paddle.js runs only on approved domains.
4. **Developer tools → Authentication → API keys**: create a key. It starts `pdl_live_apikey_…`; keys made before 2025-05-06 have no prefix and are also accepted. Give it these permissions:
   - Transactions: read and write
   - Notification settings: read (used by the Test button)
   - Subscriptions: read and write (needed for automatic card renewal)
5. **Developer tools → Authentication → Client-side tokens**: create a token. It starts `live_…`.
6. **Developer tools → Notifications → New destination**:
   - URL: **`https://api.respok.app/api/billing/webhook/paddle`**. Not `/paddle_sandbox`: that one belongs to the sandbox account and checks the sandbox secret.
   - Events:
     - `transaction.paid`, `transaction.completed`, `adjustment.created`, `adjustment.updated`
     - for card renewal also: `transaction.created`, `transaction.billed`, `transaction.payment_failed`, `transaction.past_due`, `transaction.canceled`, `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`
   - Copy the destination's **secret key**.

The customer returns to `https://app.respok.app/<workspace>/billing?payment=<id>&provider=paddle&_ptxn=txn_…` (`&card=setup` when a card is saved). That page asks Paddle about the transaction from the server.

Paddle sends webhooks from its own published IPs. The server checks the `Paddle-Signature` (HMAC-SHA256, 5-minute window) and needs no IP allowlist.

WebYar (Iran edition) never offers Paddle, so there is no WebYar URL for it. If Paddle were ever used there, the same paths apply on `api.webyar.ai` and `app.webyar.ai`.

### Where to enter it: Providers → Paddle (`paddle`)

| Field | Value |
|---|---|
| API Key | the `pdl_live_apikey_…` key (secret) |
| Client-side Token | the `live_…` token (public: it is sent to the payment page) |
| Webhook Secret Key | the destination's secret from step 6 |
| Product ID (optional) | a `pro_…` from the **live** catalog, or empty (a one-off product per checkout). A sandbox `pro_` fails. |
| Automatic card renewal | **on**, once the Subscriptions permission and the extra events are in place |

These are refused on save, with a message saying why:

- a sandbox key (`_sdbx`) or sandbox token (`test_`);
- a client-side token that does not start with `live_`;
- **an API key pasted into the Client-side Token field**, which would otherwise be sent to every customer's browser. If that ever happened, revoke the key in Paddle.

### Order of steps

1. Enter the four fields above and save.
2. Press **Test**. It calls `GET /event-types`, and with card renewal on also `GET /subscriptions?per_page=1`. A 403 there means the key lacks the Subscriptions permission.
3. **Finance → Gateways**: switch `paddle` **on**, with currencies USD and EUR. Give it a higher place in the order than `paddle_sandbox`. On the readiness card, `paddle` must be **Listed** for USD and EUR. "Settings incomplete" names what is missing: API key, client-side token or webhook secret, or a key of the wrong kind. The card also shows "Automatic card renewal: On".
4. Do the small real payment (smoke test below).
5. Once it passes, switch **`paddle_sandbox` off**, or at least keep its "Open to customers" off so only Super Admins see it. A Super Admin can also try the sandbox and then live in the same page: the page loads Paddle.js again for the other environment.

### Smoke test (Paddle)

1. In a RESPOK workspace, top up a small USD amount. Paddle's minimum is 0.70 USD.
2. The Paddle overlay opens with no "Test Mode" mark. Pay with a real card.
3. The page returns to `…/billing?…&_ptxn=txn_…` and shows **succeeded** with a receipt.
4. Server log (backend app 32 for RESPOK): `transaction.paid` arrives with no `[billing-webhook] rejected provider=paddle`.
5. **Card renewal:** buy a plan with "Save my card" ticked. The account shows the saved card, and Paddle shows an active subscription.
6. **Refund:** in Paddle, refund the top-up transaction. Once Paddle approves it, the `adjustment.updated` event records the refund once, and the balance goes down.
7. Optional: in Paddle, cancel the test subscription, or turn auto-renew off on the account. The card is cancelled at Paddle.

---

## 3. Switch order, summarised

1. Enter credentials, then **Test**.
2. Switch the live gateway on, and check that the readiness card shows **Listed**.
3. Make a small **real** payment, check it with the smoke test, and refund it if wanted.
4. Switch the test gateways off: `zarinpal_test`, `zibal_test` and `internal_test` on WebYar, `paddle_sandbox` on RESPOK (or keep it admins-only).
5. Leave every other gateway inactive.

---

## 4. The other gateways (inactive; for when they are switched on)

What every one of them now has, the same as ZarinPal and Paddle:

- **Settings check.** Each gateway's required credentials are checked (`gatewaySettingsProblem`, `server/services/billing/account/gateways.ts`). An active gateway with an empty or wrong field is not offered to customers. The readiness card shows **Settings incomplete** and names the field.
- **Test mode is admins-only.** A Stripe test key (`sk_test_…`) or a sandbox switch (PayPal, iyzico, PayTR, Craftgate, Lemon Squeezy Test Mode) puts the gateway in its provider's test mode. Customers are not offered it; Super Admins are, so they can try it.
- **Switches are read strictly.** The Providers screen stores toggles as strings, and the string `'false'` used to read as on. That is the defect that sent live ZarinPal to its sandbox. Now only `true`, `'true'`, `'1'`, `'on'` and `'yes'` are on, for every gateway.
- **Timeouts.** Every call to a gateway gives up after **20 s**, except SEP's verify, which waits up to **120 s**: SEP does not undo a verify, and a retry only gets "already verified" (ResultCode 2), which settles nothing on its own. Checkout then fails with "<gateway> gateway unreachable: no answer within 20 s" instead of holding the customer's page. A non-JSON answer (an HTML error page, a firewall) is reported with the gateway's name and HTTP status.
- **A real Test button.** **Test** in Providers makes a real call: a payment request that is never paid, a token request, or a signed lookup. It shows success only when the gateway accepts it; otherwise it shows the gateway's own code and message. Before, several of them reported success for almost any answer, and Sipay's never called Sipay at all.
- **Readiness notes.** The card shows a caveat under some gateways (IDPay, SEP, PayPing, and the gateways that cannot take account payments).

### Callback addresses

| Gateway | WebYar (Iran) | RESPOK (International) |
|---|---|---|
| Zibal, NextPay (the customer comes back with a GET) | `https://app.webyar.ai/<workspace>/billing?payment=<id>&provider=<name>&…` | not offered |
| SEP, IDPay, PayPing (the result is POSTed as a form) | `https://api.webyar.ai/api/billing/account-return?payment=<id>&provider=<name>` | not offered |
| Stripe, PayPal (return pages) | (not offered in Iran) | `https://app.respok.app/<workspace>/billing?payment=<id>&provider=<name>&…` |
| Webhooks (Stripe, PayPal, Lemon Squeezy, PayTR) | (not offered in Iran) | `https://api.respok.app/api/billing/webhook/<name>` |

The app's billing page cannot receive a POST. So SEP, IDPay and PayPing send their result to the API's **return hop**. The hop accepts the form or a GET query, flattens PayPing's `data` JSON, and redirects (303) to the payment's own billing page on this platform's app; it redirects nowhere else. Register **both** `app.webyar.ai` and `api.webyar.ai` as the website/callback domain wherever a panel asks. The Test button sends the same callback a real checkout sends, so a domain the gateway refuses fails there.

### "Already verified"

Zibal, NextPay, IDPay and PayPing verify by the reference stored on the payment, like ZarinPal. If a verify takes the money but its answer is lost (a restart, a network cut, the 20 s timeout), the next try gets "already verified": Zibal 201, NextPay -49, IDPay 101 or 200, PayPing 409 with code 110. That answer settles the pending payment once, under the same amount and unique-reference checks. Zibal's 201 carries no amount, so the amount is read from Zibal's `/v1/inquiry`. If no amount can be read, the payment stays pending and is logged `REVIEW`; it is not failed. SEP verifies by a second, unbound reference (`RefNum`), so its "already verified" (ResultCode 2) still settles nothing on its own (logged `REVIEW`). That is why SEP's verify waits 120 s instead of 20 s. If a `REVIEW ... gateway says already verified` line still appears for SEP, the customer has paid: check the payment in SEP's panel and settle it by hand (Finance → the account → credit the amount, category `correction`, the RefNum in the reason).

---

### 4.1 Zibal (WebYar, IRR)

Going live since 2026-10-30: steps, probe and smoke test in section 1b. This section is the audit.

| Field in Providers | Where to get it |
|---|---|
| **Merchant code** (`merchant`, required) | Zibal panel → the gateway → merchant code. The merchant `zibal` is Zibal's sandbox (any payment "succeeds", no money moves), so it is refused on save and on the card. |

- API: `gateway.zibal.ir/v1/request`, `/start/{trackId}`, `/v1/verify`, `/v1/inquiry`. Amounts are **Rial**, sent as is.
- Callback: GET to the app's billing page (`trackId`, `success`, `status`, `orderId`). Register `app.webyar.ai` on the gateway. If the gateway has an IP list, add **5.39.70.213** (192.99.68.134 before 2026-10-28); otherwise Zibal answers 115.
- Zibal now needs a valid `Referer` on the redirect to `/start/…`. A normal browser redirect sends one.
- The old **Lazy mode** switch sent an empty `multiplexingInfos`, which Zibal refuses (no "self" beneficiary). It is removed and ignored.
- Verify results: 100 = verified, 201 = already verified (see above), 202 = not paid or failed (the payment ends). Anything else leaves the payment pending.
- No refunds API is used. Refund in the Zibal panel, then book a debit in Super Admin → Finance → Accounts → Adjust.

### 4.2 PayPing (WebYar, IRR)

| Field | Where to get it |
|---|---|
| **Bearer token** (`bearer_token`, required) | PayPing panel → Developers → a token with the payment scope. |

- The adapter now uses **API v3**: `api.payping.ir/v3/pay` → `paymentCode`, `/v3/pay/start/{code}`, and `/v3/pay/verify` with `paymentRefId`, `paymentCode` and `amount`. v2 (`/v2/pay`, `gotoipg`) is retired, so the old adapter would no longer work.
- **Amounts are Toman** in every PayPing service. The Rial amount is divided by 10, and only an exact division is sent. When VAT makes the total land on an odd Rial, the VAT of a PayPing checkout is rounded to whole Toman (down by the odd Rial, or up to the next Toman when the VAT is smaller than that; at most 9 Rial; the credit itself never changes). An amount without VAT that is not whole Toman is refused before any payment row exists (400 `AMOUNT_NOT_WHOLE_TOMAN`, with a message to the customer), never sent to PayPing.
- Callback: PayPing **POSTs** a form (`status`, `errorCode`, `data` JSON with `paymentCode`, `paymentRefId`, `amount`). It goes to the API hop: register `api.webyar.ai` (and `app.webyar.ai`) as the return domain.
- PayPing returns an unverified payment to the payer after **10 minutes**. A verify that answers 202 or 5xx is still settling and stays pending. A 4xx ends the payment.

### 4.3 NextPay (WebYar, IRR)

| Field | Where to get it |
|---|---|
| **API key** (`api_key`, required) | NextPay panel → the gateway → API key. |

- API: `nextpay.org/nx/gateway/token` (code -1 = token issued), `/payment/{trans_id}`, `/verify` (code 0 = verified, -49 = already verified).
- **Units: defect fixed.** NextPay's `amount` is **Toman unless `currency` says otherwise**. The adapter sent the Rial amount without a currency, which would have charged a **tenth** of the price. It now always sends `currency: 'IRR'`. Verify sends the same Rial amount, and NextPay refuses another amount.
- Callback: GET to the app's billing page (`trans_id`, `order_id`, `amount`). Register `app.webyar.ai`.
- Verify -2 ends the payment. Any other code leaves it pending; the codes in circulation disagree, so they are shown as numbers.

### 4.4 SEP — Saman (WebYar, IRR)

| Field | Where to get it |
|---|---|
| **Terminal number** (`terminal_id`, required) | The terminal number SEP issued (digits only). |
| Merchant key | Not used: SEP's OnlinePG needs only the terminal number. Now optional. |

- API: `sep.shaparak.ir/onlinepg/onlinepg` (action `token`, status 1 = token), `/OnlinePG/SendToken?token=…`, and `/verifyTxnRandomSessionkey/ipg/VerifyTransaction` with `RefNum` and `TerminalNumber`. ResultCode 0 = verified, 2 = already verified. Amounts are **Rial**.
- Callback: SEP **POSTs** a form (`State`, `Status`, `RefNum`, `ResNum`, `Token`, `TraceNo`, `Amount`, …). It goes to the API hop. A return without `RefNum` (cancelled at the bank) ends the payment without calling SEP.
- The verified amount is read from `TransactionDetail.OrginalAmount` (SEP's own spelling), then `OriginalAmount`, then `AffectiveAmount`.
- SEP reverses a payment that is not verified within **30 minutes**.
- **Reachability: warning.** SEP answers only registered server IPs, in practice from inside Iran. From the production server it did not answer within 15 s (probed 2026-10-12 from the old box in Canada, 192.99.68.134; the server is 5.39.70.213, an OVH box in Europe, since 2026-10-28). The readiness card says so. Before switching SEP on, have the server's IP registered with SEP and press **Test**. Without that, every checkout fails after 20 s.

### 4.5 IDPay (WebYar, IRR)

| Field | Where to get it |
|---|---|
| **API key** (`api_key`, required) | IDPay panel → web service. |

- API: `api.idpay.ir/v1.1/payment` → `id`, `link`; `/payment/verify` with `id` and `order_id`. Status 100 = verified; 101 and 200 = already verified. Amounts are **Rial**.
- **Sandbox: defect fixed.** Live `idpay` always sends `X-SANDBOX: 0`. Its stored "test mode" switch is removed and ignored: the string `'false'` read as on, which would have sent real customers to IDPay's sandbox. To test, use the separate **IDPay-Test** gateway (`idpay_test`), which always sends `X-SANDBOX: 1` and is admins-only.
- Callback: IDPay **POSTs** by default (`status`, `track_id`, `id`, `order_id`). It goes to the API hop.
- **Reachability: warning.** IDPay did not answer from the production server within 15 s in the October 2026 probe, and the service has been reported shut down. The readiness card says so. Press **Test** before anything else.

### 4.6 Stripe (RESPOK, USD/EUR/GBP/TRY)

| Field | Where to get it |
|---|---|
| **Secret Key** (`secret_key`, required) | dashboard.stripe.com → Developers → API keys: `sk_live_…`, or a restricted `rk_live_…` with Checkout Sessions write, Refunds write and Balance read. A `pk_…` key is refused. `sk_test_…` runs test mode, which only Super Admins are offered. |
| **Webhook Signing Secret** (`webhook_secret`, required) | Developers → Webhooks → endpoint **`https://api.respok.app/api/billing/webhook/stripe`** → Signing secret (`whsec_…`). Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`. |

- One Checkout Session per payment, cards only, inline `price_data` in **minor units** (cents; kuruş for TRY, 2 decimals). It expires after 31 minutes. Verified by `GET /v1/checkout/sessions/{id}`: `complete` + `paid`, with Stripe's own amount and currency.
- Return: `…/billing?payment=<id>&provider=stripe&session_id=cs_…`; cancel adds `canceled=1`, which expires the open session.
- Refunds made in Stripe arrive as `charge.refunded` (running total) and are taken back once.
- Test: `GET /v1/balance`; it shows "Stripe HTTP <status>: <message>" when Stripe refuses.

### 4.7 PayPal (RESPOK, USD/EUR/GBP; no TRY)

| Field | Where to get it |
|---|---|
| **Client ID**, **Client Secret** (required) | developer.paypal.com → Apps & Credentials → the **Live** REST app. |
| **Webhook ID** (required) | The same app → Webhooks → **`https://api.respok.app/api/billing/webhook/paypal`**, events `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`. Its id. |
| Sandbox Mode | **Off** for live. Read strictly now: it used to treat the stored `'false'` as on and call `api-m.sandbox.paypal.com` with live credentials. On = admins-only. |

- Orders v2, intent CAPTURE, decimal `value` from minor units. The server captures on the customer's return (`token=<order id>`); an already captured order is read back. Refunds arrive as `PAYMENT.CAPTURE.REFUNDED`.
- Test: an OAuth token with the stored credentials.

### 4.8 Gateways that cannot take an account payment yet

Simple billing confirms a payment by looking it up from the server (`verifyPayment`) or by a signed webhook naming the payment. These gateways have neither in this platform, so the readiness card shows **Cannot confirm** for every account currency, whatever their settings:

| Gateway | Credentials (Providers) | Webhook / notes |
|---|---|---|
| **Lemon Squeezy** | API Key, Store ID, Variant ID, Webhook Signing Secret | Webhook-only (`https://api.respok.app/api/billing/webhook/lemon_squeezy`, events `order_created`, `order_refunded`). Test Mode is read strictly. |
| **iyzico** | API Anahtarı, Gizli Anahtar (Test Modu → sandbox-api.iyzipay.com) | **Defect fixed:** requests were signed with a header that was neither IYZWS v1 nor v2, so iyzico would refuse every call. They are now signed with **IYZWSv2**, as iyzico's official client signs, and the checkout form is initialized at `/payment/iyzipos/checkoutform/initialize/auth/ecom` (no hyphen, as in the official client; it was `iyzi-pos`, which does not exist). Its callback is unsigned and is not accepted as proof of payment. |
| **PayTR** | Mağaza No, Mağaza Anahtarı, Mağaza Salt (Test Modu → `test_mode=1`) | Notification URL `https://api.respok.app/api/billing/webhook/paytr` (HMAC-checked; answered `OK`). The Test button now asks for a real test-mode iFrame token. |
| **Sipay** | Merchant Key, App Key, App Secret | The Test button now asks Sipay for an API token (it used to make no call). The checkout request (`paySmart3D`, hash key) was not verified against Sipay's current documents; review it before use. |
| **Paratika** | Üye İşyeri Kodu, API Kullanıcı, API Şifre | The adapter still calls Asseco's **integration (test)** host `entegrasyon.asseco-see.com.tr`; it needs the production host before use. The Test button now passes only when a session is issued. |
| **Craftgate** | API Key, Secret Key (Test Modu → sandbox-api.craftgate.io) | **Defect fixed:** requests were signed with an HMAC and `x-auth-version: v1`, which Craftgate refuses. They are now signed as Craftgate's official client signs (SHA-256 of URL + key + secret + random key + body, version `1`), with the payment group `LISTING_OR_SUBSCRIPTION`. |

Taking account payments with any of these needs a server-side lookup (for example iyzico's checkout-form retrieve, or Craftgate's `GET /payment/v1/checkout-payments/{token}`) and a review against the provider's documents. That is work for when one of them is wanted.

### 4.9 Switching one of these on

1. Enter the credentials (4.1 to 4.7) and save. A credential of the wrong kind is refused with the reason.
2. Register the callback domains (`app.webyar.ai` and `api.webyar.ai` for the Iranian gateways), the server IP **5.39.70.213** (since 2026-10-28) where the gateway has an IP list, and the webhook URLs for Stripe and PayPal.
3. Press **Test**. It must succeed; for SEP and IDPay, this also proves the gateway answers this server.
4. Finance → Gateways: switch it on for its currency. The readiness card must show **Listed**.
5. Make a small real payment, as in the ZarinPal and Paddle smoke tests: success with a receipt; reload shows the same receipt; a cancel ends as failed; the gateway's panel shows the same amount.
