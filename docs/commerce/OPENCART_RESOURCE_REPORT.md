# OpenCart Connector — Resource Report

What one question costs Web Yar and the store, per scenario. Every number
below comes from a run of `plugins/webyar-opencart/tests/integration/run.sh`
(`up`, then `test`) on 2026-09-24. Each number is labelled with how it was
obtained:

| Label | Meaning |
|---|---|
| **M** | **Measured** on a real OpenCart install: the extension installed through OpenCart's own installer, MariaDB's general query log or the extension's `_meta.db` counters, real HTTP. |
| **C** | **Counted**: the real Web Yar code (connector, gateway, identity bridge, AI stage) ran, but its database was an in-memory client that counts each select, insert and update per table. These are the statements Web Yar's code issues. They are **not** Postgres timings. |
| **E** | **Estimated**: arithmetic from M and C numbers, shown with the formula. |
| **U** | Unit test with stand-ins (mocks), for behaviour only. No cost claim. |

Nothing here was measured on a real customer's shop, on staging or in
production.

**Environment.** One container, all on 127.0.0.1:

- PHP 8.4 built-in server (one worker per store);
- MariaDB 10.11 (64 MB buffer pool, 30 connections);
- OpenCart 4.1.0.4, 3.0.5.1 and 4.1.0.0, each with two stores, OpenCart's
  demo catalogue and fictitious customers and orders (`seed.sh`);
- Node for Web Yar's side.

Times are loopback times. They show relative cost, not what a shopper sees
over the internet.

## 1. A storefront page view — M

| | 4.1.0.4 | 3.0.5.1 | 4.1.0.0 |
|---|---|---|---|
| SQL per page view, widget **on** | 117 | 107 | 118 |
| SQL per page view, widget **off** | identical (checked) | identical (checked) | identical (checked) |
| SQL issued by the extension | 0 | 0 | 0 |
| Network calls the extension makes on page load | 0 | 0 | 0 |
| Identity assertion in the HTML | none | none | none |

All of that SQL is OpenCart core's own. The widget is one `<script>` tag
built from the stored settings: no query, no HTTP, no session write.

The page-view check ignores two things that vary for reasons unrelated to
the extension:

- OpenCart's probabilistic session GC (`DELETE FROM session WHERE expire < …`
  plus `OPTIMIZE TABLE session`), which lands on random requests;
- the reads a cold file cache adds on the first request after a cache clear.

Both occur with the widget on and with it off.

**Opening the chat** (only then) makes one same-origin request to the store's
context endpoint (**U**: loader tests; at most once per page, rate limited to
20 per 10 minutes per session). Its full cost on the store, OpenCart startup
included (**M**):

| | 4.1.0.4 | 3.0.5.1 | 4.1.0.0 |
|---|---|---|---|
| SQL total | 25 | 23 | 25 |
| of which writes | 5 | 4 | 5 |

These writes are OpenCart core's per-request bookkeeping for a signed-in
customer: `UPDATE customer` (language and IP), the cart merge, and the
session save. The extension itself writes nothing on this request.

## 2. One signed API request on the store — M

Everything MariaDB executed for one request, OpenCart's startup included. The
"extension" column is the extension's own share, from its `_meta.db` counter.
The extension's write is the replay-guard nonce (`INSERT IGNORE`). On 1 request
in 50 it adds a second write that prunes nonces older than 10 minutes
(`DELETE … LIMIT 50`).

| Operation | 4.1.0.4 total SQL | 4.1.0.4 extension | 3.0.5.1 total SQL | 3.0.5.1 extension | 4.1.0.0 total SQL | 4.1.0.0 extension |
|---|---|---|---|---|---|---|
| `health` | 20 (2 writes) | 1 (1 write) | 17 (2 writes) | 1 (1 write) | 20 (2 writes) | 1 (1 write) |
| `search (guest)` | 21 (2 writes) | 2 (1 write) | 18 (2 writes) | 2 (1 write) | 22 (3 writes) | 2 (1 write) |
| `product details x1` | 24 (2 writes) | 4 (1 write) | 21 (2 writes) | 4 (1 write) | 24 (2 writes) | 4 (1 write) |
| `product details x5` | 23 (2 writes) | 4 (1 write) | 20 (2 writes) | 4 (1 write) | 23 (2 writes) | 4 (1 write) |
| `reviews` | 22 (2 writes) | 3 (1 write) | 19 (2 writes) | 3 (1 write) | 22 (2 writes) | 3 (1 write) |
| `orders list` | 23 (2 writes) | 4 (1 write) | 20 (2 writes) | 4 (1 write) | 23 (2 writes) | 4 (1 write) |
| `order details` | 29 (3 writes) | 8 (1 write) | 24 (2 writes) | 8 (1 write) | 27 (2 writes) | 8 (1 write) |
| `tracking` | 23 (2 writes) | 4 (1 write) | 20 (2 writes) | 4 (1 write) | 24 (3 writes) | 4 (1 write) |

What the rest is: OpenCart's framework startup (settings, store, language,
currency, customer group, cart clean-up). OpenCart runs it for every request;
the extension cannot avoid it without editing core. There is **no**
`REPLACE INTO session` on API calls, because the extension suppresses the
empty machine session's write. An occasional third write (`DELETE FROM
session WHERE expire < …`) is OpenCart's probabilistic session GC, and it
lands on random requests.

No request is N+1:

- product details for 5 ids cost the same 4 queries as for 1;
- the order list is 4 queries whatever the page size (at most 10);
- 3.0's own `getProducts()` (one query per product) is not used.

## 3. One chat turn, both sides — store M, Web Yar DB C

Run by the real connector, gateway, identity bridge and AI commerce stage
against the real store (`src/test/commerce/opencartLive.e2e.test.ts`),
OpenCart 4.1.0.4. The workspace has **two** OpenCart stores connected (to
exercise store selection), except where noted. Each turn carries the page
the visitor is on, as the widget sends it; that page picks the store
(`connectionSelection.ts`).

Columns:

- **Store calls**: HTTP calls to the store.
- **Store SQL**: the extension's queries, summed over the turn's calls.
- **Resp. B**: response bytes received from the store.
- **Evidence B**: bytes handed to the model (cap 7,000).
- **Web Yar DB**: SELECT / INSERT / UPDATE statements issued by Web Yar's
  code, with the tables behind them.
- **ms**: wall time on loopback.

| Scenario | Store calls | Store SQL | Resp. B | Evidence B | Web Yar DB (S/I/U) | tables (S/I/U) | ms |
|---|---|---|---|---|---|---|---|
| handshake (pairing / manual check) | 1 | – | – | – | 1/0/1 | connections 1/0/1 | 40 |
| unrelated question | 0 | – | – | – | 1/0/0 | connections 1/0/0 | 4 |
| product search (guest) | 1 | 2 | 1620 | 1104 | 4/1/1 | connections 1/0/0, conversations 2/0/1, links 1/0/0, audit 0/1/0 | 29 |
| repeat search (warm cache) | 0 | 0 | 0 | 1104 | 3/1/0 | connections 1/0/0, conversations 1/0/0, links 1/0/0, audit 0/1/0 | 1 |
| price/stock of selected product (follow-up) | 1 | 4 | 1091 | 816 | 3/1/0 | connections 1/0/0, conversations 1/0/0, links 1/0/0, audit 0/1/0 | 19 |
| 5 identical concurrent searches | 1 | 2 | 892 | 581 | 5/1/0 | connections 5/0/0, audit 0/1/0 | 20 |
| orders as guest | 0 | 0 | 0 | 98 | 3/1/0 | connections 1/0/0, conversations 1/0/0, links 1/0/0, audit 0/1/0 | 1 |
| widget open, signed in (first bind) | 0 | – | – | – | 2/2/0 | connections 1/0/0, nonce 0/1/0, links 1/1/0 | 1 |
| widget re-open, same customer | 0 | – | – | – | 2/1/0 | connections 1/0/0, nonce 0/1/0, links 1/0/0 | 1 |
| order list (signed in) | 1 | 4 | 776 | 460 | 4/1/1 | connections 1/0/0, conversations 2/0/1, links 1/0/0, audit 0/1/0 | 13 |
| order details + tracking (follow-up) | 2 | 12 | 2163 | 1195 | 4/1/1 | connections 1/0/0, conversations 2/0/1, links 1/0/0, audit 0/1/0 | 35 |
| order id tampering | 1 | 0 | 0 | 71 | 3/1/0 | connections 1/0/0, conversations 1/0/0, links 1/0/0, audit 0/1/0 | 12 |
| orders after logout | 1 | 0 | 0 | 99 | 3/1/0 | connections 1/0/0, conversations 1/0/0, links 1/0/0, audit 0/1/0 | 13 |
| account switch (bind other customer) | 0 | – | – | – | 2/1/1 | connections 1/0/0, nonce 0/1/0, links 1/0/1 | 1 |
| orders after account switch | 1 | 4 | 544 | 275 | 4/1/1 | connections 1/0/0, conversations 2/0/1, links 1/0/0, audit 0/1/0 | 15 |
| search as wholesale customer (group price) | 1 | 4 | 800 | 567 | 4/1/1 | connections 1/0/0, conversations 2/0/1, links 1/0/0, audit 0/1/0 | 13 |
| sign-out reported by the widget (unlink) | 0 | – | – | – | 0/0/1 | links 0/0/1 | 0 |
| store switch (store 1, no link there) | 0 | 0 | 0 | 98 | 3/1/0 | connections 1/0/0, conversations 1/0/0, links 1/0/0, audit 0/1/0 | 0 |
| store timeout | 1 | 0 | 0 | 117 | 1/1/1 | connections 1/0/1, audit 0/1/0 | 6005 |
| store circuit open | 0 | 0 | 0 | 126 | 1/1/0 | connections 1/0/0, audit 0/1/0 | 0 |
| product search (guest), workspace with one store | 1 | 2 | 892 | 581 | 4/1/1 | connections 1/0/0, conversations 2/0/1, links 1/0/0, audit 0/1/0 | 17 |
| 120 distinct searches (bounded cache) | 120 | – | – | – | 120/120/0 | connections 120/0/0, audit 0/120/0 | 1911 |

3.0.5.1 and 4.1.0.0 give the same store calls and Web Yar statements in
every row, with response bytes within ±3 % (checked by script on
`final-e2e-oc3.json` and `final-e2e-oc40.json` from the same run). Store
queries differ only in 4.1.0.0's "order details + tracking (follow-up)" at
13 store queries instead of 12. The replay guard's nonce prune (1 request in
50) is the only extension query that varies from run to run.

How to read the Web Yar DB column for a guest product search: 4 SELECT,
1 INSERT, 1 UPDATE, with two stores (the page picks one) and with one store
(row "workspace with one store") alike:

- `commerce_connections` ×1: the workspace's active connections, one indexed
  read. In production the generation stage reads them once per turn and
  shares them with every commerce stage. The page, or the only store,
  settles the choice here.
- (Only with several stores and **no** page context, as with an older
  widget or another channel: `conversations` ×1 and
  `commerce_customer_links` ×1 to use the store the visitor is signed in to
  as a tiebreaker. Otherwise nothing is selected; there is no "newest"
  fallback.)
- `conversations` ×1 and `commerce_customer_links` ×1: the conversation's
  visitor and follow-up refs, and this visitor's link on the chosen store.
- `conversations` ×1 SELECT and ×1 UPDATE: only when the listed ids changed.
  The follow-up refs are merged into `metadata` (a re-read, so a concurrent
  writer of another metadata key is not overwritten).
- `commerce_tool_audit`: **one** multi-row INSERT per turn, whatever the
  number of calls (at most 8 rows).

Nothing is written for health on a successful call. Nothing product-,
price- or order-shaped is written anywhere.

## 4. Protection and bounds — M (store) / C (Web Yar)

| Behaviour | Result |
|---|---|
| Unrelated question | 0 store calls, 1 SELECT (connections) |
| Same question again within 60 s | 0 store calls (cache hit) |
| 5 identical concurrent questions | 1 store call (single-flight) |
| Guest asks about orders | 0 store calls; told to sign in |
| Store hangs (never answers) | 1 call, cut at the turn deadline: 6,005 ms total, no retry after a timeout |
| After 3 transport failures in 60 s | circuit open: 0 store calls, 0 ms |
| 120 distinct questions (half fa, half en) | 120 store calls, 120 audit INSERTs; cache stays bounded: 121 entries (these 120 plus 1 left by the previous step) / 35,847 bytes (limits 500 / 4 MB) |
| Heap growth over those 120 turns | 2,269 KB (Node, includes garbage not yet collected) |
| Order id of another customer | 1 call, `order_not_found`, 0 order rows returned |
| After logout on the store | 1 call, `identity_expired`, nothing cached shown |

## 5. Stored vs queried

| | Stored in Web Yar | Read live from OpenCart, per question, not stored |
|---|---|---|
| Store | connection row (ids, origin, store id, versions, capabilities, permissions, health, last error) | language, currency, customer group and tax rules, applied by the store on each request |
| Products | nothing | search results, details, prices, specials, quantity tiers, options, stock, attributes, images, URLs |
| Reviews | nothing | approved reviews (text trimmed) |
| Customer | one link row per (store, visitor): external id, opaque `session_ref`, group id, expiry, cutoff time | status and session validity on every private read |
| Orders | nothing | list, details, items, totals, status history, tracking, returns |
| Conversation | ≤10 product ids, ≤10 order ids, last search terms/page, ≤12 store links (`metadata.commerce_refs`) | – |
| Audit | one row per tool call: tool, duration, ok, error code, cache hit | – |

## 6. Web Yar storage growth — E

Per commerce turn, from §3:

- at most one `commerce_tool_audit` row per store call or cache hit, so 1
  to 3 rows;
- no new row for anything else. The link row is per (store, visitor), and
  the refs replace the previous ones.

| | Formula | Value |
|---|---|---|
| Rows written per 1,000 commerce turns | ≈ 1,000 × (1 to 3 audit rows) | 1,000 – 3,000 audit rows, 0 catalogue rows |
| Web Yar DB statements per 1,000 guest search turns, one store | 1,000 × (4 SELECT + 1 INSERT + 1 UPDATE) | 4,000 SELECT, 1,000 INSERT, ≤1,000 UPDATE |
| Store requests per 1,000 search turns with a 30 % cache hit rate (an assumed rate) | 1,000 × 0.7 × 1 | 700 requests ≈ 700 × 21 SQL (M per request) |
| Catalogue data kept in Web Yar for a 10,000-product store | – | 0 bytes; nothing to sync, re-index or vacuum |

## 7. Not measured

- PHP memory per request on the store. The extension reads at most 10 rows
  per list and caps each response at 128 KB (Web Yar's side). There is no
  separate profile.
- Postgres timings for Web Yar's statements (§3 counts them; it does not time them).
- A real pairing round trip. The stores were http on loopback, which Web
  Yar's pairing rightly refuses. The credential was written by
  `fake_pair.php` with the extension's own classes.
- Third-party themes, page caches, CDNs, real network latency.
- Any real customer's shop. No load was put on one.
