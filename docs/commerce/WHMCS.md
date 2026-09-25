# WHMCS Connector

Status: addon **1.1.0**, read-only. Tested on the isolated WHMCS 9.0.1 /
PHP 8.3 installation and its MariaDB schema (see §Testing).

A signed-in WHMCS client can ask the Web Yar widget about **their own**
services, domains, invoices, orders and support tickets, and any visitor can
ask about the public product catalogue, published announcements and public
knowledge articles. Network notices respect WHMCS’s login requirement. The assistant answers from WHMCS,
read on demand for that question. No customer or content rows are modified,
and no source mirror, index or per-turn tool audit is stored in Web Yar.
WHMCS still stores the short-lived security nonces and identity grants.

```
plugins/webyar-whmcs/                      the WHMCS addon (PHP, zero runtime deps)
server/services/commerce/connectors/whmcs.ts          signed client for the addon API
server/services/commerce/whmcs/{identity,gateway,cache,guard,normalize}.ts
server/services/ai-agent/commerce-tools/whmcs{Intent,Runner}.ts   AI stage
shared/commerce/whmcs.ts                   contract shared by server and UI
src/components/plugins/WhmcsConfigPanel.tsx          Plugins → WHMCS
```

## 1. Installation (merchant)

Requirements: WHMCS 8.0+, PHP 7.2+ (whatever your WHMCS version supports),
HTTPS on the WHMCS System URL, and the Web Yar `commerce` plan module.

1. Web Yar → **Plugins → WHMCS** → *Download WHMCS addon* (`/downloads/webyar-whmcs.zip`).
2. Extract the archive into the WHMCS root. It adds `modules/addons/webyar/` only.
3. WHMCS admin → *System Settings → Addon Modules → Web Yar* → **Activate**, then
   **Configure** and tick the admin roles that may manage it.
4. *Addons → Web Yar*: the preconfigured Web/API addresses are read-only.
   Server operators can override `WEBYAR_APP_URL` / `WEBYAR_API_URL` in PHP;
   earlier saved addresses remain a fallback. Click **Connect to Web Yar**. Log in, pick the workspace, approve. You land
   back in WHMCS with a *Connected* status.
5. Web Yar → **Plugins → WHMCS**: turn on the account sections the assistant
   may read. **Only the public catalogue is on after pairing**; services,
   domains, invoices, orders, tickets and the three new content sources start off.
6. Super Admin → **Plugins → WHMCS** has a master switch, an AI switch and
   nine section switches. They apply before cache reads and merchant requests.
   Workers refresh the cached policy within 15 seconds. Maintenance mode also stops AI reads.

The chat widget is added to the client area automatically (an addon setting
can turn this off). Pairing is the same authorization-code + PKCE flow as
WooCommerce (SECURITY.md §Pairing); the consent page shows the real WHMCS
defaults instead of toggles.

**Upgrade**: upload the new archive over the old folder; WHMCS runs the
addon's `upgrade` function, which only ever adds tables/columns. Click
**Check connection** afterward to negotiate the three new content capabilities,
then enable the desired sources in the workspace. No content migration is needed.

**Uninstall**: *Addon Modules → Web Yar → Deactivate* drops the addon's own
`mod_webyar_*` tables only. No WHMCS client, service, domain, invoice, order
or ticket data is touched. Disconnecting from the Web Yar side revokes the
installation credential; WHMCS data is likewise untouched.

Customer data has no background sync, heartbeat or polling. Addon release
checks run separately through WHMCS cron. The Web Yar sync worker's reconcile sweep explicitly
excludes WHMCS (`catalogIndexedProviders()`), and the dashboard's "Check
connection" button is the only health probe (§8).

## 2. How a question is answered

```
client-area page (WHMCS)                          Web Yar
────────────────────────                          ───────
ClientAreaFooterOutput hook
  ├─ guest: widget snippet only
  └─ signed in: ensure grant (§3), mint a 5-min
     signed assertion, add it to the snippet ───▶ POST /api/widget/commerce/identity
                                                   verify → bind grant to the widget visitor

visitor asks "is my invoice paid?" ─────────────▶ AI engine, generation stage
                                                   1. deterministic intent (§6) → invoices.list
                                                   2. connection selection (§7)
                                                   3. binding → grant (one DB read)
                                                   4. session.check  ─────────┐
                                                   5. invoices.list ──────────┤ signed HTTPS, ≤3 per turn
api.php  ◀─────────────────────────────────────────────────────────────────────┘
  verify signature + nonce → section enabled? → grant live? → client not closed?
  → WHMCS user permission on that account? → reader with ownership WHERE
                                                   6. normalize → ≤6 KB evidence + rules
                                                   7. model answers from that evidence only
```

The browser never talks to the addon API and never sees the installation
secret. The model never sees the secret, the grant id, or the raw responses.

## 3. Identity

**What counts as proof.** Only a WHMCS login. A name, email, client id,
service id or invoice number typed into the chat is never proof, and the
addon ignores any ownership claim that does not come from a live grant.

**Grant** (addon, `lib/Grants.php`): "PHP session S is logged in as WHMCS
User U acting for Client Account C". Created on a client-area page render,
stored in `mod_webyar_grants`, referenced from the PHP session. It ends on:

| Event | Mechanism |
|---|---|
| Logout, or a new login in the same browser | `UserLogout` / `UserLogin` hooks |
| Switching to another client account | next page render sees a different client → new grant, old one revoked |
| Idle > 30 min (no client-area page render) | `IDLE_SECONDS = 1800`, checked on every read |
| Older than 12 h regardless of activity | `ABSOLUTE_SECONDS = 43200` |
| Password change | `UserChangePassword` hook revokes all of that user's grants |
| Client account closed or deleted | `ClientClose` / `ClientDelete` hooks + a live status check per read |
| Admin disconnects the addon / revokes all | admin page |

Refresh writes at most once per 5 min while browsing; ordinary page views
read the grant from the PHP session and write nothing.

**Assertion** (`whmcs1.<payload>.<hmac>`): the signed hand-off from the
client-area page to the widget. Payload: `v, typ, iss` (installation),
`wid` (workspace), `aud`, `iat`, `exp` (addon mints 300 s), `jti`, `gid`
(grant), `uid`, `cid`, `sub` (opaque subject hash), optional `name`,
`email`. Web Yar checks, in order: prefix, size, HMAC with that
installation's secret, schema, workspace, audience, `iat` not in the future
(60 s skew), `exp` not passed, lifetime ≤ 600 s, age ≤ 600 s, installation
belongs to a live WHMCS connection of that workspace, and the `jti` nonce is
unused (replay). Pages carrying an assertion are sent `private, no-store`.

**Binding** (`commerce_customer_links`): one row per (connection, visitor).
A repeated page load verifies the grant and reconciles the profile; unchanged data costs reads and no writes
(measured, §9). A different grant or client account updates the row once; a new
(user, client) pair moves `subject_since`, and conversation turns older than
that are left out of the prompt, so a previous user's answers never reach
the next user. One grant binds one visitor: binding it elsewhere revokes the
old binding.

**Shared browser / account switch.** The page also carries an opaque
`data-commerce-subject`; when it changes, the loader asks the widget for a
fresh visitor, so user B does not inherit user A's conversation.

**Every private read re-asks WHMCS.** Web Yar never decides a grant is still
valid: each turn with a private read starts with a live `session.check`. On
`grant_invalid` the binding is marked revoked, the grant's cache entries are
dropped, and the visitor is asked to sign in. There is no stale fallback on
an authorization error.

## 4. Authorization on every private read

In the addon (`lib/Api/Router.php`), all must pass, in this order:

1. the WHMCS admin allowed that section (addon settings);
2. the grant is live and names exactly this user and client account;
3. the client account is not closed;
4. the WHMCS **user** holds the matching permission on that account, read
   live from the `tblusers_clients` pivot, or `GetUserPermissions` when the
   pivot is unavailable, and fail closed on error. Owners have all;
5. the reader's own SQL is scoped `WHERE userid = <client>`, so an id that
   belongs to someone else is *not found*, not *forbidden*.

In Web Yar, before any call: the connection is live, the capability was
negotiated, the workspace owner enabled the section (Plugins → WHMCS), and
the plan entitles it (`commerce`, plus `commerce_catalog`, `commerce_orders`
or `commerce_customer_history` by section, all existing capability keys).

| Section (owner switch) | WHMCS user permission | Plan entitlement |
|---|---|---|
| catalog | — (public) | commerce_catalog |
| announcements / knowledgebase | — (public content only) | commerce_catalog |
| networkstatus | live grant if WHMCS requires login | commerce_catalog |
| services | `products` | commerce_customer_history |
| domains | `domains` | commerce_customer_history |
| invoices | `invoices` | commerce_customer_history |
| orders | `orders` | commerce_orders |
| tickets | `tickets` | commerce_customer_history |

The API is a closed list of 17 operations (`health`, `catalog.search`,
`catalog.browse`, `session.check`, three `content.*` reads, and `list`/`get`
for each account section). There
is no generic API proxy, no SQL passthrough and no write operation: no pay,
renew, cancel, DNS, password, reboot, suspend or ticket submission.

## 5. Data: stored vs. queried only

### Stored by Web Yar

| Where | What | Why |
|---|---|---|
| `commerce_connections` (one row per WHMCS install) | base URL, origin, installation id, protocol/addon/WHMCS versions, negotiated capabilities, owner permissions, health, last success/error time and code | connection management |
| `plugin_secrets` | installation secret, AES-256-GCM (existing envelope) | request signing |
| `commerce_customer_links` (one row per visitor who signed in and chatted) | WHMCS client id, user id, grant id, subject_since, expiry, revoked_at | which grant to ask WHMCS about |
| `commerce_nonce_cache` | assertion `jti`, until expiry | replay protection |
| `contacts` (existing, on verified profile changes) | the WHMCS user's name and email on the chatting visitor's contact | the operator sees who they are talking to (same as the WooCommerce identity bridge) |
| conversation messages and `ai_agent_runs` (existing) | the visitor's question and the assistant's reply | the chat transcript, like any other reply. A reply may quote a figure it was given, such as an invoice balance |
| process memory only | cache entries (§8), rate/breaker counters, per-turn metric event | cost control; gone on restart |

### Queried on demand, no separate source storage

Services, domains, invoices (with line items), orders, tickets (with up to
3 reply excerpts of ≤ 600 chars), the product catalogue and prices, the
client's WHMCS permissions, whether the grant is still live, and bounded
announcement / knowledgebase / network excerpts. Raw WHMCS
responses, the evidence block given to the model, and ticket text are not
persisted, logged or put in metrics. Logs carry error codes only.

Readers select explicit columns. Never read: service passwords, IPs or
notes, ticket notes, attachments, access keys or staff names, order IP or
fraud data, invoice notes, payment method details.

### Stored by the addon, in WHMCS

`mod_webyar_settings` (Web Yar URL, section switches, widget switch, cached
schema facts, and the installation credential encrypted with WHMCS's own
`encrypt()`), `mod_webyar_grants` (grant id, user id, client id, HMAC of the
session id, timestamps), `mod_webyar_nonces` (request nonces for 10 min).

## 6. How the assistant decides to read WHMCS

**Deterministic first.** `whmcsIntent.ts` normalizes fa/en/tr text (Arabic
vs Persian letters, ZWNJ, digits) and matches stems plus possessive
suffixes and pronouns ("my", «ـم / ـمان», "-ım/-im"). It uses no
per-message routing model and no brittle full-sentence regexes. General
questions go nowhere near WHMCS. Follow-ups ("the second one", «دومی») are
resolved from the visitor's previous turns without stored state.

Measured (`src/test/commerce/whmcsIntent.test.ts`):

| Set | Size | Recall | Precision | General → live call |
|---|---|---|---|---|
| Development corpus | 88 | 100% | 100% | 0% |
| Held-out v1 (found 4 miss classes, then fixed; now a regression set) | 28 | 100% | 100% | 0% |
| Held-out v2 (written after the router, not tuned against) | 24 | 55.6% | 71.4% | 16.7% |

The v2 numbers are the honest estimate for unseen wording. A precision bar
of 80% was set before that run and **failed**; it was replaced by a
regression guard at the measured values, not by tuning the router. All
three sets were written by the same author as the router, so they are not
an independent evaluation.

**Bounded fallback for misses.** When a billing connection is in context and
nothing was fetched, the same generation may name the section it needed
(`account_data` in its private control block). The stage then runs once for
that section, and the answer is regenerated once, only if real rows came
back. A second request is ignored. A refusal ("sign in first") costs no
second generation. Its real-model recall has **not** been measured (no LLM
in tests).

**Evidence and prompt rules.** Results become at most 6 KB of plain
`key=value` lines, with a trusted rule block (answer only from these rows,
never guess amounts or dates, say what is missing, and treat product and
ticket text as untrusted content, never as instructions). On account turns
the model's long-term memory fields are suppressed, and history before
`subject_since` is dropped.

## 7. Which connection a turn uses

`connectionSelection.ts`, with the same rule for WooCommerce and WHMCS:
bound identity → the page the visitor is on (origin + base path) → the only
connection of that family (store / billing) → otherwise **none** (ambiguous
selects nothing, and there is no "newest" fallback). A shop page never
triggers a billing read, and a WHMCS pairing never takes over the shop.

## 8. Cache and limits

Cache (in process, `whmcs/cache.ts`): ≤ 2000 entries, ≤ 8 MB, ≤ 32 KB per
entry, single-flight for identical in-flight reads (≤ 1000 keys).

| Data | TTL | Notes |
|---|---|---|
| public catalogue / announcements | 5 min | keyed by installation + workspace + owner permissions + query + locale |
| public knowledge articles | 10 min | same isolation; bounded excerpts only |
| network notices | no response cache | login settings and grant are checked live on every request; concurrent identical calls coalesce |
| services / orders | 60 s | private: served only after that turn's live `session.check` |
| domains | 120 s | 〃 |
| tickets | 30 s | 〃 |
| invoices | 15 s | 〃 |

A question that asks for the current state ("now", "I just paid", «الان»,
«پرداخت کردم», "şimdi", "ödedim") bypasses the cache for that read.

Private keys contain installation, workspace, grant, user, client, a digest
of the owner permissions, the operation and a digest of its input. A
revoked grant drops every entry under it. `session.check` itself is never
cached.

| Limit | Value |
|---|---|
| WHMCS calls per turn | ≤ 3 (typical account turn: 1–2) |
| turn deadline / per-call timeout | 6 s / 4 s |
| retry | once, only for a transient error or 5xx on an idempotent read, only if ≥ 1.5 s remain |
| response size | 64 KB max (both sides) |
| list page | ≤ 10 items + `has_more`; catalogue search ≤ 5, browse ≤ 10 |
| evidence to the model | ≤ 6000 bytes |
| Web Yar → one install | 60-request burst, 1/s sustained; 4 concurrent |
| Web Yar → one identity | 12-request burst, 1 per 5 s sustained; 2 concurrent |
| circuit breaker | opens after 3 failures for 30 s, then one probe |
| addon rate gate (APCu, when present) | 240/min per installation, 30/min per grant |
| request freshness / replay | ±300 s clock skew; nonces kept 600 s |
| "Check connection" | 6/min per workspace + connection + IP, coalesced, 10 s UI cooldown |
| connection health writes | only when health changes; `last_seen_at` at most every 15 min |

## 9. Resource report

**Measured** here means counted by the test harness: HTTP requests via a
signing-verifying WHMCS simulator, database round trips via a counting
Supabase fake, and SQL statements via Illuminate on SQLite. **Latency was
not measured.** The `ms` column is mocked in-process time, not network or
WHMCS time.

Web Yar, per chat turn, added on top of the existing pipeline
(`src/test/commerce/whmcsStage.test.ts`):

| Scenario | WHMCS HTTP | DB select | DB insert | DB update | evidence bytes |
|---|---|---|---|---|---|
| general question (no WHMCS intent) | 0 | 0 | 0 | 0 | 0 |
| platform disabled | 0 | 1 | 0 | 0 | 0 |
| guest asks for invoices | 0 | 3 | 0 | 0 | 143 |
| announcements / knowledgebase, cold | 1 | 2 | 0 | 0 | 273 |
| network notices, guest conversation | 1 | 4 | 0 | 0 | 284 |
| source disabled in Super Admin | 0 | 1 | 0 | 0 | 55 |
| plans, cold cache | 1 | 2 | 0 | 1 | 718 |
| plans, warm cache | 0 | 0 | 0 | 0 | 752 |
| customer lists services (cold) | 1 | 4 | 0 | 1 | 814 |
| same, warm cache | 1 (`session.check`) | 3 | 0 | 0 | 848 |
| follow-up "the second one" | 2 | 3 | 0 | 0 | 470 |
| another customer's invoice id | 1 | 4 | 0 | 0 | 47 |
| WHMCS unreachable | 2 (one retry) | 4 | 0 | 0 | 54 |
| 5 identical concurrent questions | 1 total | – | – | – | – |

Counts include a cold platform policy lookup where applicable. Policy is
coalesced and held in process for 15 seconds. The `DB update` for existing
account/catalog reads is the connection's `last_seen_at`, at most once per
15 minutes. **Content reads perform zero Web Yar inserts/updates**, including
on failure. There is no WHMCS tool-audit insert on any path.

Identity binding (`whmcsIdentity.test.ts`): the first bind costs link +
nonce + contact writes. Every later page load with the same grant and unchanged profile costs
**0 writes**. The loader posts every signed-in page so profile changes and
previously failed contact synchronization are not hidden by a binding cache.

WHMCS addon, per request (`ResourceCostTest.php`, SQLite):

| Operation | SELECT | INSERT (nonce) | response bytes |
|---|---|---|---|
| health | 1 | 1 | 395 |
| catalog.search / browse | 3 | 1 | 770 / 1296 |
| session.check | 4 | 1 | 198 |
| services/domains/invoices/orders/tickets `.list` | 5 | 1 | 491–730 |
| invoices.get / tickets.get / orders.get | 6 / 6 / 7 | 1 | 423–676 |
| client-area page, guest | 1 | 0 | – |
| client-area page, first signed-in view | 2 | 1 (grant) | – |
| client-area page, next signed-in view | 1 | 0 | – |

No N+1: lists join or batch-load (currency, product names, departments) in
fixed statement counts. Settings load in one query, and schema facts are
cached at activation instead of introspected per request.

**Estimated, not measured**: real latency (dominated by the WHMCS host;
the 4 s / 6 s bounds cap it), MySQL plans on large WHMCS databases (every
reader filters on an indexed `userid`/`id` column of core WHMCS tables), and
Web Yar memory (bounded by the cache caps above: ≤ 8 MB plus limiter maps).

## 10. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Health *Authentication error* | secret mismatch (reinstalled addon, restored DB) | Addons → Web Yar → Connect again |
| Health *Unreachable* | System URL offline, firewall, not HTTPS | open `<SystemURL>/modules/addons/webyar/api.php` from outside (it should answer JSON 405/401, not HTML) |
| Health *Needs attention*, `schema_unsupported` | addon tables missing or a WHMCS table lacks a column | deactivate + activate the addon; check the WHMCS version |
| Assistant says "sign in" although signed in | widget injection off, a page cache served a guest page, or assertion clock skew > 60 s | enable injection; exclude client-area pages from caching; fix server time (NTP) |
| "You don't have access to invoices" | the WHMCS user lacks that permission on the account | account owner grants it in WHMCS → Account → User Management |
| "Not enabled for the assistant" | section switched off in Plugins → WHMCS | turn it on |
| Account questions on the shop site are ignored | by design: the shop page selects the store connection | ask on the WHMCS site |
| Nothing about WHMCS at all | plan lacks the `commerce` module, or two WHMCS installs and the page matches neither | check the plan; each install must live on its own origin/path |

## 11. Testing

| Suite | What it proves |
|---|---|
| `plugins/webyar-whmcs/tests` (PHPUnit, 55 tests) | the real addon readers and API on SQLite shaped like WHMCS: signature, replay, grant lifecycle, WHMCS user permissions, ownership (another client's id is not found), closed accounts, column allow-lists, catalogue visibility, widget injection, statement counts |
| the same 55 tests with `WEBYAR_TEST_DB=mysql` ([`tests/realdb`](../../plugins/webyar-whmcs/tests/realdb/README.md)) | every addon query against MariaDB/MySQL holding WHMCS's own `install.sql` schema plus the reconstructed later tables: real column types (`INT ZEROFILL` ids, `DECIMAL` amounts, `DATE` columns), collation and SQL dialect |
| `src/test/commerce/whmcsProtocol.test.ts` | TS and PHP sign byte-identical requests and assertions (shared vectors) |
| `whmcsIdentity`, `whmcsGateway`, `whmcsStage`, `whmcsIntent`, `connectionSelection`, `whmcsPairingCoexistence`, `connectionsRoute`, `whmcsConfigPanel` | forged/expired/replayed assertions, cross-workspace/installation isolation, logout/switch/permission change, cache isolation, limits, breaker, deadlines, fa/en/tr routing, pairing, panel behaviour |
| `src/test/ai-agent/whmcsAccountFallback.test.ts` | the bounded fallback through the real engine (model faked) |

Run: `npx vitest run src/test/commerce src/test/ai-agent/whmcsAccountFallback.test.ts`
and, in `plugins/webyar-whmcs`, `composer install && vendor/bin/phpunit`.

Validation on 2026-09-24:

- TypeScript: **397 passed, 41 skipped** (unconfigured unrelated live integration
  suites); the WHMCS-specific set has **107 passing tests**. Client/server
  typechecks pass. The model fallback test uses a simulated model.
- PHP 8.3.33: **55 tests / 322 assertions pass** on SQLite and on MariaDB 11
  with a separate, empty schema copied from the isolated installed WHMCS 9.0.1.
  The tests never truncate the installed WHMCS database.
- Installed signed HTTPS endpoint: unsigned request 401, valid health 200,
  replay 401, announcements 200, knowledgebase 200, guest network status 403
  with `NetworkIssuesRequireLogin=on`. Addon reports 1.1.0 and 9 capabilities.
- Actual addon page rendered in English and Persian. Automated checks cover
  direction, Google font choice, icon, locked addresses, forged URL POSTs and
  CSRF. The release zip builds successfully.

Content readers return at most five items, each with a title, up to 700
characters of excerpt and a scoped source link. Body selection is limited to
4096 characters. Knowledge search also checks translations, excludes private
articles, hidden category ancestors, orphan/cyclic categories and mixed hidden
links. More than 512 categories fails closed with an explicit limit result.
Announcements exclude drafts and future publications/translations. Network
results contain unresolved published notices, never server ids; no incidents
is not a guarantee of uptime. Reader tests confirm no view-counter writes.

Not proven by this release validation: every supported WHMCS/PHP version,
real-model natural-language recall, or production load/latency. Existing
held-out intent recall metrics remain documented by the intent suite; passing
unit tests do not imply perfect routing for every phrasing.

## 12. WooCommerce changes made alongside

- Connections are chosen per family (store / billing), so WHMCS never
  replaces the shop. Identity binding and guest verification resolve the
  exact installation instead of "the newest connection".
- `catalog_ready` gates only catalogue-indexed providers.
- Plugin `OrderController`: lookup, customer order list and tracking all
  enforce ownership (previously tracking had none, lookup only for one
  authorization kind, and the list trusted `customer_id`). Regression tests
  are in `plugins/webyar-woocommerce/tests/unit/OrderAuthorizationTest.php`.
  The plugin version is 1.2.1, so existing stores are offered the fix by the
  plugin's updater once Web Yar serves the new archive.
- The connector reads the tracking keys the plugin actually sends.
- The WooCommerce panel shows the WooCommerce connection only.

### Automatic addon updates (1.2.0)

Install 1.2.0 once on existing sites; earlier versions cannot bootstrap an updater.
After that, increment `Version::ADDON`, build and deploy the application normally.
`build-whmcs-addon-zip.mjs` publishes the ZIP plus its SHA-256 and byte length in
`/downloads/webyar-whmcs.json`. Both files must be deployed together. The API must
also be deployed to expose `/api/plugins/whmcs/updates`.

Connected installations check once per hour from the **CLI** `AfterCronJob` hook.
WHMCS cron must run normally, under the same account that owns the addon and its
update state. Customer page requests never check/download updates. The site-local
checkbox and Super Admin → Plugins → WHMCS → Automatic addon updates both default
on; either can pause updates. A disabled/maintenance platform also pauses them.
AI access is independent of the update switch. Policy/network failures fail closed;
checks retry in an hour. Pausing takes effect on the next check (it does not cancel
an installation already in progress).

Only the preconfigured HTTPS API/app hosts are contacted; WHMCS administrators
cannot change them through the addon form. The HTTPS publisher is the trust root
(the checksum detects corruption and mismatched deployments, not a compromised
publisher). Redirects, external manifest package paths, oversized archives, ZIP
symlinks, traversal, unexpected file types, syntax errors and incompatible minimum
PHP/WHMCS versions are rejected before replacing any installed code. Downgrades
and same-version reinstalls are skipped. Publish a higher patch version to roll
back a defective release. No release signing key is required by this transport.

Updates require cURL, ZipArchive, PHP tokenizer, writable addon parent and a
private working directory **on the same filesystem** as the addon. By default it
uses a mode-0700 installation-specific directory under the PHP temporary root.
Operators can set `WEBYAR_UPDATE_DIR` to an existing persistent private directory
outside the WHMCS web root, on the same filesystem; it is never editable in the
WHMCS page. Use a persistent directory to retain recovery files across temp cleanup
or reboots. Web PHP and cron should run as the same user to share update status.
OPcache on the web PHP pool must revalidate timestamps; deployments that disable
this need their own PHP pool reload after changing addon files.

The updater stages and parses every PHP file, then renames the old addon into
`previous` in the private directory and moves the new directory into place. A
failed second rename restores the old directory; a PHP shutdown handler also
attempts recovery. This is not a database migration or a functional health-check
rollback. An OS crash/kill between the two renames can require operator recovery:
stop cron and move `previous` back to `modules/addons/webyar` if the latter is absent.
Restore the previous files in the same way for a functional regression after first
pausing automatic updates. Database credentials, settings and grants are preserved.
The old files are retained for one successful update, with no extra web-accessible
copy. Short update status and last-check time are filesystem state, not DB logs.


### Contact identity lifecycle

The widget reconciles the signed WHMCS user's name and email on every page,
even when the login grant is unchanged. An existing guest contact is enriched
in place, preserving its visitor code, phone, notes, location and conversation
history. If the email already has a contact, only the current visitor's
sessions and conversations are attached to that contact. No contacts are
deleted. WHMCS users sharing a company account remain separate people.

Profile synchronization errors fail the identity request and are retried by
the loader (up to three attempts for network, 429 or 5xx errors). Repeating an
unchanged profile causes no database writes. Contact changes notify the
operator inbox and contact views; contact views also refresh every ten seconds
when realtime delivery is unavailable. No per-request database log is added.

Logout revokes account access and starts a fresh widget visitor on the next
signed-out page. It never erases the saved contact or conversation history in
the operator app. A different signed-in user must use a fresh visitor; stale
assertions cannot overwrite the previous person's contact. Disabling contact
sharing stops future profile synchronization without clearing existing data.

This behavior is delivered through the hosted loader and API; the WHMCS addon
remains version 1.2.0 and does not need reinstalling for this server-side fix.
