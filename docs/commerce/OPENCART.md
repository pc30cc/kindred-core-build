# OpenCart Connector

Status: implemented on branch `claude/keen-sagan-9otkif`. Not merged or deployed.
Rollout is gated like WooCommerce: migration 214 adds the `opencart` plugin
with `rollout_status = 'coming_soon'`, `installable = false`. A platform admin
enables it in Super Admin → Plugins.

OpenCart is Web Yar's first **direct** commerce connector. The store answers
every question live, through a narrow signed endpoint of the
`webyar-opencart` extension. Web Yar keeps no copy of the catalogue, the
customers or the orders, and has no sync, indexing, crawl, embedding, cron or
heartbeat for it.

- Extension source: `plugins/webyar-opencart/`
- Server side: `server/services/commerce/connectors/opencart.ts`, `providers.ts`,
  `liveGuard.ts`, `metrics.ts`, `server/services/ai-agent/commerce-tools/directRunner.ts`
- Measured cost: [`OPENCART_RESOURCE_REPORT.md`](./OPENCART_RESOURCE_REPORT.md)

## 1. Supported versions

The versions were chosen from OpenCart's official source (GitHub tags and
branches `3.0.x.x`, `4.1.x.x`, as of 2026-09):

| OpenCart | PHP (OpenCart's own minimum) | Package | Tested on a real install |
|---|---|---|---|
| **4.1.0.x** | 8.1+ (4.1.0.0–4.1.0.3 allowed 8.0; the extension requires 8.1) | `webyar.ocmod.zip` | 4.1.0.0, 4.1.0.4 |
| **3.0.5.x** | 8.1+ | `webyar-oc3.ocmod.zip` | 3.0.5.1 |

Not supported:

- 4.0.x — superseded by 4.1, with a different route separator and older schema.
- 3.0.4.x and older — these run on PHP 7.x, which no longer gets security fixes.

Both wrappers check their version range and PHP 8.1 on install and on every
admin visit. An unsupported store shows a clear notice and installs nothing.

**Why there are two packages.** The major versions differ in exactly the
places an extension touches:

- extension layout: `extension/<code>/…` in 4.x, `upload/…` in 3.x;
- class naming: namespaces in 4.x, `ControllerExtensionModuleX` in 3.x;
- method separator in routes: `.` in 4.x, `/` in 3.x;
- the event API: an array in 4.x, positional arguments in 3.x;
- the price schema: specials folded into `product_discount` with a `type` column in 4.1, a separate `product_special` table in 3.0;
- where the SKU lives: `product.sku` in 4.1.0.0, the `product_code` table in 4.1.0.3 and later.

Everything that is not version-shaped lives in one core (`core/`), copied
into both packages. A small adapter (`Oc4Platform` or `Oc3Platform`) does the
rest, and it hands price, tax, currency, language and URL decisions to that
store's own objects. The 4.1 adapter even reuses the running release's own
price SQL fragments, because how a percentage discount becomes a price
**changed between 4.1.0.0 and 4.1.0.4**.

## 2. Install, upgrade, uninstall (merchant)

1. In Web Yar: **Plugins → OpenCart** → download the package for your version.
   - OpenCart 4.1: keep the file name **`webyar.ocmod.zip`**. OpenCart 4 derives the extension code, and with it the PHP namespace, from the file name.
2. OpenCart admin → **Extensions → Installer** → upload.
   - OpenCart 4.1: click **Install** next to the uploaded file.
   - OpenCart 3: the installer copies the files.
3. **Extensions → Extensions → Modules → Web Yar** → **Install**, then **Edit**.
4. Next to each store, click **Connect to Web Yar**. Pick the workspace and permissions on the Web Yar consent screen, then approve. You land on a result page on the store's own address, in the owner's language, with a **Back to the module** button; after a successful connection it returns to the module by itself after a few seconds.
5. Turn on the chat widget switch for the store (saved at once).

The Web Yar addresses (`https://app.webyar.ai`, `https://api.webyar.ai`) are
part of the package (`core/Endpoints.php`); there is nothing to type. A
staging or test install can point the extension elsewhere by defining
`WEBYAR_APP_URL`, `WEBYAR_API_URL` and `WEBYAR_UPDATE_PUBLIC_KEY` in
OpenCart's `config.php` (writing that file already means full control of the
shop, so this opens nothing new). Settings left over from 1.0.0
(`module_webyar_app_url` / `_api_url`) are deleted on the first admin visit.

**Language and look.** The settings page and the connection result page speak
the admin's language when the extension has it (fa, tr), otherwise the store's
default language, otherwise English. Persian pages are right-to-left in
Vazirmatn, others use Inter, both loaded from Google Fonts. One template
(`views/admin.twig`) serves 4.1 and 3.0 with its own styles, so it looks the
same on Bootstrap 5 and 3; every value in it is escaped explicitly.

**Automatic updates (1.1.0+).** A connected store keeps itself current unless
the owner turns **Update automatically** off (on by default):

- *Triggers.* Web Yar asks the store (signed `connector/update`) when it sees
  an older `_meta.connector_version` in any answer or at the handshake, at most
  once per 6 hours per store; the owner opening the settings page checks at
  most every 12 hours; **Check for updates** checks at once. There is no cron
  and no polling.
- *What is installed.* Only a release whose `manifest.json` carries a valid
  Ed25519 signature (`manifest.json.sig`) from Web Yar's release key. The
  public key is built into the extension; the private key lives only on the
  release host, never in the repository. The manifest must be strictly newer,
  on the same protocol, with a package for this OpenCart line at a fixed
  `/downloads/opencart/…zip` path, and the package must match its signed
  sha256 byte for byte.
- *How.* Every zip entry must be a plain file with an allowed extension under
  the extension's own folders (4.1: `extension/webyar/`; 3.0:
  `upload/{admin,catalog,system}/`) — no `..`, absolute paths or links —
  within size and count limits. Files are written one by one (staged, then
  renamed); the originals are backed up and restored if any write fails; a
  database lock allows one update at a time. OpenCart 4.1's
  `extension_path` / `extension_install` rows are updated so a later
  uninstall still removes everything.
- *Needs* PHP `sodium`, `zip` and `curl`, and write access to those folders;
  without them the page says so and the owner updates by hand as below.
- *Releasing.* `npm run build:opencart-plugin-zip` builds the packages and
  `manifest.json`; the manifest is then signed on the release host
  (`openssl pkeyutl -sign -rawin -inkey <key> -in manifest.json | base64 -w0 >
  manifest.json.sig`). A signed version is frozen: rebuilding keeps the signed
  archives byte for byte. `src/test/commerce/opencartRelease.test.ts` fails CI
  when the committed signature, archives and version disagree.

**Upgrade by hand** (automatic updates off, or once from 1.0.0, which cannot
update itself).

- OpenCart 3: upload the new zip in Extensions → Installer; it overwrites the
  old files.
- OpenCart 4.1: OpenCart's installer never overwrites existing files and will
  not remove them while the module is installed. To keep the connection, copy
  the contents of the new `webyar.ocmod.zip` over `extension/webyar/` (FTP or
  the host's file manager). The installer route (Modules → Uninstall,
  Installer → Uninstall → Delete, upload, Install, Modules → Install) works
  too, but uninstalling the module disconnects the store and clears its
  settings, so it must be connected again.

Settings and connections are kept on the copy-over path. The first admin
visit after the upgrade re-runs the idempotent install steps once: it ensures
the table, records the schema flags and re-registers the widget event
(delete, then add, so there are never two). This is tested on all three
versions, including that the files really changed
(`tests/integration/upgrade_check.sh`).

**Uninstall** (Modules → Web Yar → Uninstall) removes only what the extension
created:

- its event;
- every `module_webyar` setting row, including the encrypted credentials;
- its `oc_webyar_nonce` table;
- its key file in `DIR_STORAGE/webyar/`.

It also tells Web Yar to revoke each connected store, on a best-effort basis.
OpenCart's products, orders and customers are never touched; the tests check
that their counts are unchanged.

## 3. Connecting a store (and multi-store)

Pairing reuses Web Yar's authorization-code + PKCE flow (`SECURITY.md §Pairing`)
unchanged, with these OpenCart specifics:

- **Per store.** One OpenCart installation can serve several stores. Each one
  connects on its own. `register` carries `provider=opencart`,
  `externalStoreId` (OpenCart `store_id`), `storeUrl` (kept in
  `requested_base_url`, the same column WHMCS uses) and `platformVersion`.
  Web Yar creates **one installation per store** (`instance_key =
  store:<hash of store URL>`), each with its own secret and its own
  `commerce_connections` row (`store_id` = the store's base URL,
  `external_store_id` = OpenCart's id). Two stores of the same shop can be
  connected to two different workspaces without sharing anything.
- **https only.** Web Yar requires the redirect origin to equal the store
  origin, and https.
- **No admin token leaves the store.** The pairing callback is a *catalog*
  route on the store's own origin
  (`…webyar.callback` / `…webyar/callback`). The PKCE verifier stays in the
  store, encrypted with the store-local key in a 10-minute pending record. The
  browser only ever carries `state` and the single-use `code`.
- **Consent-screen permissions are stored.** `/approve` used to accept the
  owner's choices and drop them. They are now stored on the pairing request
  and applied at exchange, for WooCommerce too. A provider with its own
  permission defaults (WHMCS) keeps them.
- **Credentials at rest (store side).** The installation secret is
  AES-256-GCM encrypted with a random key kept in `DIR_STORAGE/webyar/local.key`,
  outside the database (OpenCart recommends moving `storage/` out of the web
  root). The installation id is bound in as AEAD data, so a database-only
  leak yields no usable secret.
- **Credentials at rest (Web Yar side).** Unchanged: `plugin_secrets`, via
  `server/lib/pluginCrypto.ts`.
- **Clone / origin change.** Web Yar only ever calls the approved origin. A
  copied shop cannot introduce customers, because the identity bind checks the
  browser `Origin` against the approved origin. The handshake (pairing or a
  manual check) marks the connection `stale_origin` when the store reports a
  different base URL or store id; the owner must reconnect.
- **Reconnect.** "Reconnect" in the OpenCart admin re-pairs. A new installation
  id invalidates every session reference issued before it: those references are
  AEAD-bound to the installation id.

OpenCart core shares customer accounts across all stores of an installation;
there is no core setting to restrict this, and `customer.store_id` only records
where the account was created. The extension's **Customer accounts** setting
can narrow identity to accounts registered in the connected store. Orders are
always limited to the connected store, in SQL.

## 4. Protocol

The Web Yar → store call is one catalog route:

```
POST {storeUrl}index.php?route=extension/webyar/module/webyar.api&op=<op>&store_id=<id>   (4.1)
POST {storeUrl}index.php?route=extension/module/webyar/api&op=<op>&store_id=<id>          (3.0)
```

It is signed exactly like every other `webyar-commerce/1` call
(`CONNECTOR_PROTOCOL.md`). The canonical path is `/opencart/v1/<op>`. A shared
vector (`plugins/webyar-opencart/tests/fixtures/signing-vector.json`) is
checked by both the TypeScript and the PHP tests.

The store checks each request in this order, cheapest and least trusting first:

1. POST only, and the body is 64 KB or less.
2. The operation is on the whitelist.
3. A connection exists for **this** store, and its installation matches.
4. The HMAC is valid (no database access up to this point).
5. The nonce is new, via an `INSERT IGNORE` into its own table.
6. The body's `store_id` equals the store OpenCart resolved for the request.
7. The merchant's toggle for this operation is on.
8. For private operations, the customer is re-validated (see §5).
9. The read itself.

| op | capability | private | merchant toggle | store queries (measured) |
|---|---|---|---|---|
| `health` | store.read | – | – | 1 (nonce) |
| `products/search` | products.read | – | – | 2 |
| `products/get` (≤10 ids) | products.read | – | – | 4 (+1 quantity tiers when one id) |
| `products/reviews` | reviews.read | – | reviews | 3 |
| `catalog/categories` | products.read | – | – | 2 |
| `orders/list` | orders.read | ✔ | orders | 4 |
| `orders/get` | orders.read | ✔ | orders | 8 |
| `orders/tracking` | tracking.read | ✔ | orders | 4 |
| `orders/returns` | returns.read | ✔ | orders | 4 |

There is no generic proxy, no SQL endpoint and no "call any route".

Every response carries `_meta.db` (queries/reads/writes/ms), so the store-side
cost is observable in production.

A machine call carries no cookie, so OpenCart opens an empty session for it.
The extension blanks that session's id before shutdown, so the core's session
`write()` is skipped. The measured log shows no `REPLACE INTO session` from
API calls.

## 5. Customer identity

**Introduction (browser, once per page, only when the chat is opened).**
The injected loader carries `data-commerce-context-url` and **no identity**.
When the visitor opens the chat, `loader.js` calls that same-origin endpoint
(`Cache-Control: no-store`, refused when `Sec-Fetch-Site` is cross-site,
rate limited per session to 20 per 10 minutes). For a signed-in customer the
store returns a 120-second, audience-bound, single-use (nonce) assertion,
signed with the installation secret. It contains:

- `external_customer_id`, `store_id`, `customer_group_id`;
- `email` and `name`, only to file the conversation under the right contact;
- an **opaque `session_ref`**: the OpenCart session id, encrypted with the
  *store-local* key. Web Yar can neither read it nor use it as a cookie.
  Encryption is deterministic, so the same session always yields the same
  reference.

Web Yar verifies:

- signature, audience, expiry, maximum age and nonce (the replay cache);
- that the connection belongs to the workspace, the installation matches and the store id matches;
- that the browser `Origin` is the approved origin.

It then **updates one link row per (connection, visitor) in place**:

- same customer and same reference → **no write** (only the replay nonce);
- new session of the same customer → 1 UPDATE;
- different customer → 1 UPDATE that also sets `private_cutoff_at`;
- first time → 1 INSERT + contact upsert.

A guest's page makes no identity call at all. If the tab had been linked and
the store now says "signed out", the loader calls `/identity/unlink`, which
ends this visitor's links and sets the cutoff.

**Continued access (every private read).** The link alone is never
permission. Web Yar sends `{customer id, session_ref}` in the signed body, and
the extension:

1. decrypts the reference (installation-bound);
2. reads that OpenCart session **read-only**, with the same SQL as core's DB
   session adapter and no write or extension, or reads the file engine;
3. requires it to be alive and to still belong to the same customer;
4. requires the account to still be enabled (and in scope).

Logout, session expiry, another customer in the same browser, a disabled
account, a reconnect and another store therefore all fail at the store. The
cost is two primary-key lookups. Session engines other than `db` and `file`
(the two OpenCart core engines) get `session_engine_unsupported`: private
data is refused, never guessed.

**Ownership** is decided by the store on every read, in SQL:
`customer_id = ? AND store_id = ? AND order_status_id > 0`. "Not yours",
"another store" and "does not exist" all get the same `order_not_found`.

**Guests.** A guest must sign in to the store to see orders. There is no
e-mail, phone or order-number path for OpenCart: its provider profile has
`guestOtp: false`, and the existing OTP route refuses OpenCart connections.
An order number typed into the chat is used only as the id the store
re-checks.

**After an identity change** (switch or sign-out), the generation stage drops
conversation turns older than `private_cutoff_at` from the model's history.
It also skips the rendered-history fallback in that case. The conversation's
follow-up references (`metadata.commerce_refs`) are tied to a subject hash, so
the previous customer's order ids are never reused.

## 6. What the AI can do

Tools run from the existing deterministic pre-generation stage (no model-driven
tool loop, no extra model call for routing):

| Question | Store calls |
|---|---|
| unrelated message | **0** (not even the conversation is read) |
| search / browse / budget ("زیر ۳۰ میلیون") | 1 |
| availability of a named product | 1 (+1 options when exactly one match has options) |
| «دومی رنگ مشکی داره؟» / "the second one" | 1 (details of that id) |
| "show more" | 1 (next page, same filters) |
| reviews | 1–2 |
| categories | 1 |
| "my orders" | 1 |
| "has my last order shipped?" | ≤2 (list + tracking) |
| "order 5001?" | 1 (store re-checks ownership) |
| my returns | 1 |

Hard bounds per turn:

- at most **3** store calls;
- a **6 s** overall deadline, and each call's timeout is the time left;
- **≤10** items per page (5 by default);
- **≤7 KB** of evidence;
- at most **1 retry**, only for a transient transport failure or a 5xx, re-signed, and only if at least 1.5 s remain;
- **no retry** for auth, permission, validation, not-found or timeout.

Intents and follow-ups are detected in Persian, English and Turkish.

What the model receives (and the prompt rules, `prompt.ts`):

- **Prices**: the store's `formatted` string. Currency, rounding and tax come
  from OpenCart's own `Currency::format` and `Tax::calculate` for the effective
  customer group and tax address. The model is told to quote it verbatim and
  never convert it. Hidden-for-guests prices arrive as
  `price=null, price_note=sign_in_to_see_prices`.
- **Specials**: active only (date window), with the end date.
- **Quantity tiers**: through the store's own model method.
- **Options**: the real option structure, and only the values the storefront
  offers (not stock-tracked, or in stock). Option quantities are never shown,
  and combinations are never invented; the model is told stock is per value.
- **Stock**: the state follows `config_stock_checkout` (back-order); the text
  is the store's stock status. Quantities are shown only when the store shows
  them (`config_stock_display`).
- **Reviews**: approved only, with the name the reviewer typed, rating, text and date.
- **Orders**:
  - the store's own (possibly custom, translated) status name, plus a
    category from the store's own "processing" and "complete" settings, never
    a fixed id;
  - totals in the order's own currency and rate;
  - comments only where the customer was notified;
  - `payment_status = not_reported_by_store`: OpenCart records none, so it is never inferred;
  - no address, e-mail, telephone, IP, affiliate `tracking` code or payment details;
  - a "view order" link to the extension's `order` route, which redirects the
    signed-in owner to their account page (OpenCart 4.1 account links need a
    session-bound `customer_token`).
- **Tracking**: OpenCart core has none (`order.tracking` is the *affiliate*
  code). The answer is `tracking_available=false, reason=no_tracking_source`
  unless a tracking extension supplies data (§8).
- **Links**: every link must be on the store's origin, or it is dropped. After
  generation, store links in the answer are repaired to the ones the store
  supplied (this turn or earlier in the conversation) or removed.

**Read-only.** No placing or cancelling orders, payments, refunds, coupons,
address changes or automatic returns. The model gets links and guidance only.

**Search quality, stated honestly.** Search is the store's own kind of match:
`LIKE` on product name and tags, plus exact model/SKU, with the question's
words ORed and ranked by how many match (Persian ی/ک and ZWNJ variants
included). It is not semantic search, and the model is told so
(`semantic_search=false`). OpenCart attributes are free text and options are
not variations, so an attribute filter ("size 43") is reported as unsupported
rather than guessed. The price filter compares against the store's pre-tax
default-currency price (converted from the display currency by the store's
rate) and is reported as `price_filter_basis=before_tax`.

## 7. Data: stored vs read live

**Stored in Web Yar** (metadata only; migration 214 is additive):

| Where | What |
|---|---|
| `commerce_connections` | id, workspace, installation, `provider_type='opencart'`, `store_id` (store base URL), `approved_origin`, `external_store_id`, `platform_version`, `connector_version`, `protocol_version`, capabilities, permissions, health, last success/error time + code, `last_health_check_at` |
| `commerce_pairing_requests` | transient: state, PKCE challenge, redirect URI, store scope, consent permissions (10 min) |
| `plugin_secrets` | the installation secret (encrypted, existing envelope) |
| `workspace_plugin_installations` | one row per connected store |
| `commerce_customer_links` | one row per (connection, visitor): external customer id, opaque `session_ref`, `customer_group_id`, expiry, `private_cutoff_at` |
| `commerce_nonce_cache` | replay nonces (existing, pruned) |
| `conversations.metadata.commerce_refs` | ids of the last listed products/orders (≤10 each), last search terms/page, ≤12 store links the model was given — for follow-ups |
| `commerce_tool_audit` | per call: tool name, duration, success, safe error code, cache hit (existing table; one multi-row INSERT per turn) |
| messages | the conversation's own messages, as for every conversation — tool responses are not stored separately |

**Never stored** (read live, per question, and dropped after the answer):
products, categories, prices, specials, stock, options, reviews, customers,
orders, order items, totals, history, returns, addresses, tracking, and raw
store responses. `commerce_products` stays empty for OpenCart connections.

**Stored in OpenCart by the extension:**
- `module_webyar` setting rows (per store; the credential encrypted);
- `oc_webyar_nonce` (one row per accepted signed request, pruned
  opportunistically past 10 minutes);
- `DIR_STORAGE/webyar/local.key`;
- one small counter in the shopper's own session (context rate limit).

## 8. Tracking extension point

Another extension can supply shipment tracking without modifying this one.
Register an OpenCart event on trigger `webyar/order/tracking`, then append
shipments to the second argument:

```php
// OpenCart 4.1 — catalog controller method of YOUR extension
public function webyarTracking(array &$order, array &$shipments): void {
	// $order = ['order_id' => int, 'store_id' => int, 'order_status_id' => int, 'shipping_method' => ?string]
	$shipments[] = [
		'carrier' => 'Post', 'tracking_number' => 'RR123456789IR',
		'tracking_url' => 'https://tracking.post.ir/?id=RR123456789IR',
		'status' => 'In transit', 'updated_at' => '2026-09-20', 'source' => 'my_extension',
	];
}
```

The event only fires for an order the extension has already verified belongs to
the signed-in customer and this store. Output is bounded (5 shipments) and
sanitized; a `tracking_url` must be http(s).

## 9. Cache, protection and audit

- **Public cache** (process-local, `liveGuard.ts`):
  - bounded to 500 entries, 4 MB, 24 KB per entry, LRU;
  - TTL 60 s for search and products, 5 min for reviews, 10 min for categories;
  - keyed by connection, installation, store, operation, input, language, and
    `guest` or customer and group;
  - entries are stored under the context the **store reports** having used,
    so group prices never mix and a stale customer reference answered as a
    guest is only cached as a guest answer;
  - "right now" questions bypass it;
  - with several replicas each keeps its own cache (worst case: one extra call
    per replica per TTL); nothing security-relevant depends on it.
- **Private data is never cached** across turns. Re-validating the session costs
  the same store round trip as reading the data, and on an auth or identity
  error nothing cached is shown.
- **Single-flight**: identical concurrent requests share one store call
  (measured: 5 concurrent → 1 call).
- **Per-store guard**:
  - at most 4 in-flight calls;
  - the circuit opens after 3 transport failures in 60 s, for 30 s;
  - while open, calls fail fast with no network traffic (measured: 0 calls, about 1 ms).
- **Health**: written only on transitions (degraded ↔ connected), at most once
  per 10 minutes while failing, never on a successful read. No heartbeat. The
  manual check is rate limited to once a minute across replicas
  (`last_health_check_at`).
- **Audit**:
  - every store call and cache hit is still one `commerce_tool_audit` row, not sampled;
  - a turn's rows go in **one multi-row INSERT** (bounded to 8 rows), in memory
    for the duration of the turn only: nothing queued outlives the request,
    and nothing grows;
  - best effort (a failed write is logged, never fails the answer), exactly
    like the existing single-row writer;
  - retention is the table's existing policy;
  - security audit events (pairing, disconnect, permission changes) are unchanged.
- **Metrics**: in-process counters on the existing Prometheus export:
  `commerce_live_reads_total` / `_ms_sum` / `_response_bytes_sum` /
  `_store_queries_sum` by provider, op and outcome, cache entries, bytes,
  hits and misses, and breaker opens. They have no ids and write nothing to
  the database.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "The store address must use https://" | OpenCart store URL is http; switch the store to https (Settings → Server) and reconnect. |
| Connect says `invalid_redirect` / `unsafe_origin` | The store resolves to a private address, or its URL differs from the address the browser returns to. |
| Update says `signature_invalid` / `package_checksum_mismatch` | The release was not signed by Web Yar or was altered on the way; nothing was installed. |
| Update says `not_writable` | PHP cannot write the extension's folders; fix permissions or update by hand. |
| Connection `stale_origin` | The store now reports another base URL or store id (clone, domain change). Reconnect from the OpenCart admin. |
| Connection `offline` after a check | Web Yar could not reach `index.php?route=…api`. Check maintenance mode (it answers HTML), firewalls and WAF rules for POST with `X-WebYar-*` headers. |
| `commerce_permission_denied` on every call | Signature refused: clock skew > 5 min on the store, or the credential was replaced (reconnect). |
| Orders never answer, customers are signed in | Session engine other than `db`/`file` (`session_engine_unsupported`), or **Let the assistant read customers' own orders** is off in the extension, or the orders permission is off in Web Yar. |
| Widget missing on a theme | The widget is added on `catalog/view/common/footer/after`. A theme that does not render `common/footer` needs the manual snippet (Settings → Integrations); the loader's own guard prevents a second copy. |
| "No products" for a Persian word | The product has no description in the chosen language (the store's own rule), or the word matches neither name nor tags. |

## 11. Tests

| What | Where | Real or stand-in |
|---|---|---|
| 68 plugin scenarios (signature, replay, skew, forged; visibility; specials/tiers/options/stock/tax/currency; price hiding; reviews; identity lifecycle: logout, expiry, switch, disabled, cross-store; ownership tampering; custom status; tracking absent; returns; merchant toggles; multi-store) | `plugins/webyar-opencart/tests/integration/scenarios.py` | **Real** OpenCart 4.1.0.4, 4.1.0.0, 3.0.5.1, MariaDB 10.11, PHP 8.4 — all 68 pass on each |
| Admin: form token, forged token, https rules, widget once per page / never in admin / off switch, 0 extension queries per page view, disconnect one store, credential encrypted | `admin_checks.py` | **Real** installs — 16/16 on each |
| Install / upgrade / uninstall through OpenCart's own installer | `oc_admin.py`, `upgrade_check.sh` | **Real** installs |
| Self-update: Web Yar push, admin button, admin-visit fallback; refusals (foreign signature, checksum mismatch, owner switched off); files really swapped, `extension_path` updated, no leftovers, shop still works | `update_check.py` against a loopback release server with a throwaway key | **Real** installs |
| Update manifest, zip entry rules (traversal, absolute, symlink, file types, targets), I18n, connection result page | `plugins/webyar-opencart/tests/unit/run.php` | Unit, no framework |
| The committed release is signed and matches its archives | `src/test/commerce/opencartRelease.test.ts` | The real committed files |
| Web Yar connector + gateway + identity bridge + AI stage against the store (17 steps incl. timeout, circuit and a one-store workspace) | `src/test/commerce/opencartLive.e2e.test.ts` (opt-in: `OPENCART_E2E_BASE`) | **Real** store; Web Yar DB is an in-memory **counting** stand-in; SSRF guard allows loopback |
| Connector, cache/breaker, direct stage, identity binding, pairing, intents, panel, loader | `src/test/commerce/opencart*.test.ts`, `liveGuard.test.ts`, `openCartConfigPanel.test.tsx`, `src/test/widget/commerceLazyContext.test.ts` | Unit tests with stand-ins |
| PHP core (signing vector shared with TS, crypto, identity, widget) | `plugins/webyar-opencart/tests/unit/run.php` | Unit, no framework |

Reproduce everything above on one machine (loopback only, fictitious data):

```
plugins/webyar-opencart/tests/integration/run.sh up     # MariaDB + OpenCart 4.1.0.4 / 3.0.5.1 / 4.1.0.0, two stores each
plugins/webyar-opencart/tests/integration/run.sh test   # install package via the admin, seed, run every suite; JSON in /tmp/wyoc/sp
plugins/webyar-opencart/tests/integration/run.sh down   # stop everything, delete /tmp/wyoc
```

**Not tested:**

- A real pairing round trip in the local run. Web Yar requires an https,
  non-private store, and the local stores are http on loopback; the credential
  is written with `fake_pair.php`, which uses the extension's own classes.
  (The demo store at open.webyar.ai pairs for real.)
- Third-party themes and page caches.
- Real LLM answers: the tests check what the model is *given*, not what it writes.
- Staging or production.

## 12. Known limitations

- Search is keyword `LIKE` (§6); relevance is only as good as product names and tags.
- The price filter is before tax.
- Guests' prices are in the store's default currency and the store's default
  tax location. A signed-in customer's currency and tax address come from
  their session.
- Stock per *combination* of options does not exist in OpenCart core. It is
  reported per value.
- The public cache is per replica (§9).
- The conversation's `ai_memory` (working memory) is not rewritten on an
  identity change. On commerce turns after a switch, the model gets neither
  the earlier history nor that stored memory. A turn with no commerce
  question at all does not look up the link, so it can still see memory
  written before the switch.
- The OpenCart admin UI text is English, Persian and Turkish. OpenCart
  language directories named other than `en-gb`, `fa-ir`/`fa` and
  `tr-tr`/`tr` fall back to English.
