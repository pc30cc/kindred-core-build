# Taking payment gateways live

Only two gateways are going live:

- **ZarinPal**, for WebYar (Iran edition, IRR).
- **Paddle**, for RESPOK (International edition, USD/EUR), with automatic card renewal.

All other gateways stay in the Providers portal but **inactive** in Finance → Gateways. That covers Zibal, PayPing, NextPay, SEP, IDPay, Stripe, PayPal, Lemon Squeezy, iyzico, PayTR, Sipay, Paratika, Craftgate and manual. They will be checked when each one is switched on later. Do not switch them on.

Live and test are separate gateways that run the same code:

| Live | Its sandbox (already tested end to end) |
|---|---|
| `zarinpal` | `zarinpal_test` (and `internal_test`) |
| `paddle` | `paddle_sandbox` |

The live gateways have **no sandbox switch**. Live `zarinpal` always talks to `api.zarinpal.com` and `www.zarinpal.com`. Live `paddle` always talks to `api.paddle.com` and runs Paddle.js in `production`. A sandbox switch stored earlier is ignored. The only differences from the sandbox are the hosts and the credentials. Requests, verification, callbacks, webhooks, amounts and refunds are the same code.

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
- **IP restriction:** if the terminal has an IP whitelist, add the production server's address **192.99.68.134**. It is outside Iran, and ZarinPal answered from it in the 2026-10-12 probe. Without it, ZarinPal answers -10.
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
4. Switch the test gateways off: `zarinpal_test` and `internal_test` on WebYar, `paddle_sandbox` on RESPOK (or keep it admins-only).
5. Leave every other gateway inactive.
