# Widget config cache and cross-node invalidation

A visitor's page view used to cost the backend about 33 database queries in
about 24 sequential round trips (POST `/api/widget/bootstrap`, then GET
`/api/widget/config`), plus two CORS preflights and two API round trips for the
browser. Now:

- **One API round trip, no preflight.** The loader posts the bootstrap to
  POST `/api/widget/boot` as a CORS-simple request (JSON body, no
  `Content-Type` header, so the browser labels it `text/plain`) with
  `include_config: true`, and the answer carries the GET /config body as
  `config`. `/boot` is the same handler as POST `/api/widget/bootstrap`; it is
  a separate path only so that an older backend, which cannot read that body,
  has no route for it (see Rollout).
- **Zero queries on a warm cache.** Both endpoints read a per-process
  *snapshot* of the workspace's inputs; the response is computed per request
  from it, with no I/O.
- **No preflight for the rest of the page view either.** POST `/api/widget/track`
  and POST `/api/realtime/visitor-presence` carry the session token in their
  text/plain JSON body when the backend says it reads it there (`protocol: 3`),
  so they are CORS-simple too (see [The page view's other calls](#the-page-views-other-calls)).
- **No per-visitor IP-block query** (a list snapshot, below), and rate limits
  that count visitors, not addresses ([Rate limits](#rate-limits-chat-and-call-widget)).

Code: `server/services/widget/configSnapshot.ts` (snapshot, config builder),
`server/lib/memoCache.ts` (single flight, stale-while-revalidate, LRU, rebuild
budget), `server/lib/cacheBus.ts` (cross-node invalidation),
`server/middleware/bodyParsers.ts` (the text/plain bodies), `public/widget/loader.js`
(`requestBootstrap`, `isCurrentBootstrap`, `fetchWithRetry`, `tokenPost`),
`server/middleware/security.ts` (pre-auth / per-IP limiters, IP blocklist),
`server/services/widget/security.ts` (`widgetRateLimit`, `readWidgetToken`).

## What is cached, and for how long

| Cache | Holds | Fresh for | Notes |
|---|---|---|---|
| Workspace snapshot | widget_settings row, entitlements, branding, workspace name, powered-by plan gate, pre-chat flags, published smart rules, AI nudge and AI agent snapshot (incl. agent logo URL), members + availability prefs, first 4 profiles with avatar URLs, logo and launcher-image URLs, effective call channels | `WIDGET_CONFIG_CACHE_TTL_MS`, default **60 s** | degraded build 5 s; no `widget_settings` row 15 s |
| Not-found answers | "this workspace does not exist" | 15 s | own LRU (¼ of the max, ≥100): random ids cannot evict real snapshots |
| Platform snapshot | widget_platform_settings (URL bases, welcome default, powered-by wording), the pre-chat policy, every `platform_branding_localized.platform_name`, the chat widget template catalog per edition (`widget_edition_settings.chat_templates`, migration 275) | 30 s | the catalog is its own read: a database without 275 reads as no catalog (not degraded); a failed read is degraded (5 s) and serves the process's last good catalog, also right after a `platform` clear; a process that has not read it yet serves the edition default meanwhile |
| `quota_full` | the monthly conversation quota answer | 60 s | usage has no write hook |
| Store orders (`config.commerce`) | whether the workspace has a store the AI can answer "track my order" for (`getStoreOrders`: its `commerce_connections`, the OpenCart policy, two plan entitlements) | 60 s | read only for a template with Core features (`default` / `intl` never); a failed read answers no row for 5 s; dropped by `widget:<ws>`, which a connection's disconnect, permission change, pairing and health change publish |

Computed **per request**, never cached: availability at the current time
(business hours and personal schedules switch exactly on time), the team's
online dots, the smart rules' `end_at` filter, the platform AI kill switch
(15 s cache of its own), content-hashed asset URLs (2 s manifest cache),
`apiBase` / `assetBase` from the request, the locale clamp, and everything about
the visitor: token, cookies, origin checks.

Rules common to the three caches:

- **Stale-while-revalidate.** Past its lifetime a GOOD entry is still served
  while one background rebuild runs. A rebuild that fails, or comes back
  degraded, keeps the old entry (retried every 5 s) for at most **10 minutes**;
  after that the request waits for a rebuild and a failure surfaces (500 as
  before). A database blip therefore no longer greys every launcher.
- **Degraded and not-found answers are never served stale.** A degraded
  snapshot (a read failed: 5 s), a "not found" (15 s) or a snapshot without a
  `widget_settings` row (15 s) is rebuilt in the foreground once that short
  lifetime is over, so a blip can never outlive it, even while background
  rebuilds are refused by the budget. A `widget_settings` read that failed
  does not switch the origin allow-list off: the bootstrap then reads the
  rules itself and fails closed.
- **Single flight** per key; a build that was running when its key was
  invalidated answers the requests already waiting on it but is never stored.
- **Rebuild budget.** Full snapshot rebuilds (~30 queries in 3 parallel waves
  with the entitlement cache warm, ~63 with it cold)
  are limited per process to `WIDGET_CONFIG_REBUILDS_PER_SEC` (default 25,
  burst 2×). A request over the budget waits up to 5 s for its turn, then gets
  `503` with `Retry-After: 1` (the loader retries 5xx); a background refresh over
  the budget is skipped. The existence check in front (one query) is not
  counted, so a flood of made-up workspace ids cannot starve real ones. Hits
  are always free.
- **One key per workspace.** PostgreSQL reads upper case, braces and missing
  hyphens as the same uuid, so every widget entry point (the bootstrap, the
  CORS middleware, the rate-limit key, the token gate, `resolveWorkspaceId`,
  the snapshot and origin-rule caches) uses the canonical spelling
  (`server/lib/workspaceId.ts`: lower case, 8-4-4-4-12). Another spelling of
  a real id reaches the same cache entry and bucket; a value that is no uuid
  answers 404 without a query or a cache entry.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WIDGET_CONFIG_CACHE_TTL_MS` | `60000` | Fresh lifetime of a workspace snapshot. A smaller value also shortens the platform (30 s), quota (60 s) and store-orders (60 s) caches. **`0` turns them all off** (every request reads, as before this change). `300000` is reasonable once the bus is known to work. |
| `WIDGET_CONFIG_CACHE_MAX` | `2000` | LRU bound of workspace snapshots per process (a snapshot is ~5–20 KB). |
| `WIDGET_CONFIG_REBUILDS_PER_SEC` | `25` | Rebuild budget per process; `0` = unlimited. |
| `WIDGET_BOOTSTRAP_PER_IP_PER_MIN` | `600` | Chat widget bootstraps per client address per minute (was 60). |
| `WIDGET_BOOTSTRAP_GLOBAL_PER_MIN` | `12000` | Chat widget bootstraps per **process** per minute (was 1200). |
| `CALL_WIDGET_BOOTSTRAP_PER_IP_PER_MIN` | `600` | Call widget bootstraps per client address per minute (was 60). |
| `CALL_WIDGET_BOOTSTRAP_GLOBAL_PER_MIN` | `6000` | Call widget bootstraps per **process** per minute (was 1200). |
| `WIDGET_PER_IP_PER_MIN` | `1200` | Every `/api/widget` and `/api/call-widget` request per client address per minute (was 300); also the `ip:` fallback of the workspace limiter. |
| `WIDGET_KB_SUGGEST_GLOBAL_PER_MIN` | `1800` | GET /api/widget/kb-suggest (instant answers) per **process** per minute. |

The six limits take a positive integer; anything else means the default. They
are read per request, so a restart with a new value is all it takes.

## Rate limits (chat and call widget)

Every page view of a site with the widget bootstraps once (a reload or a new
tab is a new page view), so the bootstrap limits count page views, and one
carrier-grade NAT or office address can carry hundreds of real visitors. They
used to be 60 per IP and 1200 per process per minute — the whole platform at 20
page views a second on one process, and a NAT of a few dozen active visitors
already refused (grey launcher). A bootstrap that hits the caches now costs no
database query, so the caps are sized for traffic, not for database cost:
what reaches the database is a snapshot **miss**, and those are bounded on
their own by `WIDGET_CONFIG_REBUILDS_PER_SEC`. The call widget's bootstrap is
free on a hit too (workspace memo + 60 s presence ticket), but a visitor it
has not seen costs its visitor queries (~5–8), so its process ceiling is half.

Layers a widget request passes, outermost first (all per process, in memory):

| Layer | Bucket | Default |
|---|---|---|
| `widgetBootstrapGlobalCeiling` / `callWidgetBootstrapGlobalCeiling` | the process | 12000 / 6000 per min |
| `widgetBootstrapRateLimiter` / `callWidgetBootstrapRateLimiter` | `req.ip` | 600 per min each |
| `widgetRateLimiter`, `widgetWorkspaceRateLimiter` (its `ip:` fallback) | `req.ip` | 1200 per min |
| `widgetSessionRateLimiter` / `callWidgetSessionRateLimiter` | the token's nonce (one per session lineage) | 300 / 120 per min |
| `widgetRateLimit(category)` on each chat route | see below | see below |
| `kbSuggestGlobalCeiling` (GET /kb-suggest only, after its `kb_suggest` bucket) | the process | `WIDGET_KB_SUGGEST_GLOBAL_PER_MIN`, 1800 per min |

`widgetRateLimit(category)` counts a request with a **valid, HMAC-signed,
workspace-bound `dvsid` visitor cookie** per visitor; a request without one
(first visit, Safari and other browsers that block third-party cookies,
non-browsers, a forged or other-workspace cookie) per (IP, workspace) at the
anonymous cap; and EVERY request, with a cookie or without, in the shared
bucket of its (IP, workspace), the true ceiling of one address whatever
cookies it minted. Workspace ids are canonicalised first, so respelling one
never opens a new bucket.
New cookies are minted only by bootstraps without one, or with
`fresh_visitor` (counted like one without), which that anonymous cap bounds.
The call widget's bootstrap (GET /api/call-widget/bootstrap) has the same
anonymous bucket for a request without a valid visitor cookie
(`takeAnonymousCallBootstrap`, `call_bootstrap`: 60 per minute per (IP,
workspace)): each such request mints a visitor and a `visitor_sessions` row
counted against the workspace's monthly visitor quota. On the chat side that
row comes from POST /track, whose `visitor_id` is the client's: its insert
branch, and that of POST /api/visitors/track, share one budget of 60 new
rows per minute per (IP, workspace) (`takeNewVisitorSession`). That slows
how fast one address can spend a workspace's monthly `max_visitors`; many
addresses still can. Page views of known sessions are not counted there.
IPv6 addresses count per /56 (as in the express-rate-limit layers), so a host
cannot rotate through its own /64. Per minute:

| Category | Routes | Per visitor | Anonymous (IP, workspace) | Shared, every request of one (IP, workspace) |
|---|---|---|---|---|
| `bootstrap` | POST /bootstrap | 30 | 120 | 1200 |
| `config` | GET /config, /manifest, /call-channels | 20 | 600 | 6000 |
| `default` | /track, /event, /action, … | 30 | 300 | 3000 |
| `poll` | /poll, /history, … | 60 | 600 | 6000 |
| `refresh` | /session/refresh | 20 | 200 | 2000 |
| `message` | /message, OTP, pre-chat, offline capture, … | 15 | 15 | 60 |
| `upload` | attachments | 10 | 10 | 40 |
| `transcript` | POST /conversations/:id/transcript (per 10 minutes) | 3 | 3 | 10 |
| `kb_suggest` | GET /kb-suggest (instant answers) | 30 | 30 | 300 |

GET /kb-suggest (instant answers while a first message is written) has its own
bucket and its own process ceiling: the help center's `/api/widget/kb/*` routes
(`publicKbRateLimiter`, `publicKbGlobalCeiling`, 2400 per minute per process)
never spend it, nor it theirs. Its answers are memoised in-process: per
workspace and words for 60 s, only the few articles an answer can show (no
summaries), at most 2,000 entries that found something and 2,000 that found
nothing (an LRU each, so made-up drafts never push a real one out); reading
times per article version, at most 20,000.

`message` and `upload` cost money (AI replies, offline-capture and OTP email,
storage), so they never grow with identities anyone can mint: without a cookie
an address keeps the old per-(IP, workspace) cap, and everything one address
sends one workspace, cookies or not, gets 4x it. A visitor quota can still be used up from many
addresses (or slowly from one): the limits bound it, they do not prevent it.

`config` is its own category now: an older loader asks GET /config on every
page view, which used to drain the bootstrap bucket twice. Identities are only
ever ones the server signed; never a raw workspace id (a pre-auth limit keyed
on one would let anyone drain a victim's quota) and never the token nonce (the
per-session layer is exactly one: `widgetSessionRateLimiter`).

**429s say how long.** Every widget and call-widget limiter answers 429 with
`retry_after` (the real seconds until its window resets) and a `Retry-After`
header, and passes through the widget's CORS first, so the 429 is as readable
as any other answer, under the existing rules: the chat widget's only by an
origin its workspace allows (`widgetCorsMiddleware`), the call widget's by the
calling origin as all of its answers always were (`callWidgetCors`; it decides
per route which origins may use a workspace). The call widget's pre-auth
limiters used to run before its CORS, so `l.js` saw a 429 as a network error.
`Access-Control-Expose-Headers: Retry-After` lets the loaders read the header.
The chat loader (`fetchWithRetry`) and the call widget's `l.js` retry a 429
**once**, after `min(retry_after or Retry-After, 10 s)` (2 s when neither is
named) plus 0–500 ms of jitter; a second 429 is final.

**Several processes.** Every limit above is per process. With N API processes
(replicas, regions) behind a balancer that spreads one client over them, that
client gets up to N times each per-IP and per-session figure, and the
platform N times each process ceiling. That is deliberate: these are abuse
backstops, not quotas, and a shared (Redis) limiter would put a network round
trip and a single point of failure in front of every request. Size the process
ceilings for one process; route by client IP at the balancer if exactness per
address is ever needed.

### Client IP (Cloudflare in front, origin reachable directly)

Every layer uses ONE client address: `server/utils/clientIp.ts` `getClientIp`,
installed as Express's `req.ip` (`installClientIpGetter`, server/index.ts). So
the express-rate-limit layers, the IP blocklist, brute-force counters, captcha
`remoteip`, audit rows, `widgetRateLimit`, `takeNewVisitorSession`, visitor
`ip_hash` and geo all agree.

- The **edge** is the address that connected to our outermost proxy: the
  socket peer when it is not ours, else X-Forwarded-For walked from the right
  past our own hops (private addresses and `TRUSTED_PROXY_IPS`). Traefik
  writes the TCP peer it saw there and drops whatever a client wrote, so a
  client cannot forge it. X-Real-IP is read only from our own proxy that sent
  no X-Forwarded-For at all (an nginx with just `X-Real-IP $remote_addr`), as
  a plain client, never as a Cloudflare hop. A proxy in front of the backend
  should append X-Forwarded-For (SELF_HOST_GUIDE.md's nginx sample does).
- When the edge is a **Cloudflare address** (`CLOUDFLARE_IPS`, default the
  ranges Cloudflare publishes, built into clientIp.ts), the client is
  `cf-connecting-ip` and the country `cf-ipcountry` (Cloudflare's HTTP proxy
  overwrites both). Any other edge IS the client, and cf-* headers are
  ignored: a client that reaches the origin (192.99.68.134) without
  Cloudflare can no longer choose its address or country. (Before 2026-10-17
  `cf-connecting-ip` was believed from any private peer, i.e. from Traefik for
  everyone, and `req.ip` was the Cloudflare edge, so all visitors behind one
  edge shared the express-rate-limit buckets.)
- A source range does not prove the request came through OUR zone: another
  Cloudflare account's TCP passthrough (Spectrum, a paid add-on) comes from
  Cloudflare and forwards the sender's own cf-* headers. Only Authenticated
  Origin Pulls with our own certificate, or a secret header added by a
  Transform Rule in the WebYar and RESPOK zones and checked by `getEdgeIp`,
  closes that.
- Limits that used to be shared by everyone behind one Cloudflare edge are
  now one person's, so they are sized for one: `authRateLimiter` 5 a minute
  (login, signup, captcha, brute-force check); `sessionActionRateLimiter` 30
  a minute (logout, logout-all, impersonate and its stop, so they never spend
  the login budget); `adminRateLimiter` 600 a minute (the admin dashboard
  opens with about 13 queries and refetches them on focus). The brute-force
  and abuse counters key on the same bucket as the limiters (an IPv6 address
  as its /56).
- Observed on vps-50cc1602 (2026-10-17): api.webyar.ai and api.respok.app are
  behind Cloudflare and also reachable directly; Traefik (coolify-proxy) has no
  `forwardedHeaders` settings, so it overwrites X-Forwarded-For / X-Real-Ip
  with the peer and passes cf-* through. The pinned header shapes are in
  `src/test/security/clientIp.test.ts`.
- Requests through app.*/api/ (the frontend nginx's BACKEND_URL is
  https://api.*, back through Cloudflare) and server-to-server calls through
  the public hostnames arrive as the server's own address, 192.99.68.134
  (RESPOK's: the same server). The SPAs call api.* directly, so browsers do
  not use that path. Never block that address.
- **Never** give Traefik `forwardedHeaders.insecure`, or private ranges in
  `forwardedHeaders.trustedIPs`: a client's X-Forwarded-For would then
  survive, and with a private TCP peer (docker-proxy hairpin) a forged
  Cloudflare address in it would be believed. Keep `TRUSTED_PROXY_IPS` unset
  (it is for our own proxies with a public address; never a CDN).
- Cloudflare's ranges change rarely and with notice:
  `.github/workflows/cloudflare-ips.yml` compares the built-in list with
  api.cloudflare.com/client/v4/ips every Monday and fails when they drift.
  Until a deploy, `CLOUDFLARE_IPS=default,<new range>` on the backends adds a
  range. A missing range only makes its edges plain clients (one bucket per
  edge, no country); nothing becomes spoofable.
- Still open, infrastructure: the origin itself accepts direct connections. A
  Traefik rule answering 403 to the Cloudflare-proxied hostnames when the
  connection is not from Cloudflare (the grey-cloud livekit.* / turn.* hosts
  and ACME on :80 must stay open) would close that for the apps outside this
  repo too; it leaves the Spectrum path above open, which Authenticated
  Origin Pulls closes as well. Owner's decision.

## IP blocklist

`ipBlockMiddleware` (every `/api/` request, before CORS) answers from ONE
per-process snapshot of the active `ip_blocklist` rows (`blocked_until IS NULL
OR blocked_until > now()`, the predicate of `is_ip_blocked()`), so a visitor's
first request no longer waits for an `is_ip_blocked` RPC. Refreshed at most
every 30 s, single flight, in the background; an `ipblock` invalidation (the
admin block / unblock routes publish it) makes every process reload before its
next answer. It still fails closed (503 `IP_CHECK_UNAVAILABLE`) when there is
nothing to answer from: never loaded, or the last good load is older than
5 min, and the reload fails (retried after 2 s). The key is unchanged: `req.ip`
(else the socket address), compared as text like the SQL function; an end
time is re-checked on every request.

## The page view's other calls

**POST /track** reads `widget_settings.store_raw_ip` (from the database on
every request, so the privacy toggle holds from the next request) and the
visitor's session together, then writes its rows together: a navigation is 2
database round trips instead of 5, an unchanged repeat 2 reads + at most one
presence write, a new session 4 trips instead of 6. Same operations, same
write set per branch (`src/test/widget/trackParallelWrites.test.ts`).

**CORS-simple /track and /visitor-presence.** With an `X-Widget-Token` header
and a JSON body these two were the last preflighted requests of a page view
(the preflight cache is per URL, ~2 h in Chromium, ~10 min in Safari). A
bootstrap answer with `protocol >= 3` tells the loader that this backend reads
the token as `widget_token` in a text/plain JSON body on exactly these two
paths (`readWidgetToken`, used by the token gate, the CORS decision, the
per-session and workspace limiters and visitor-presence alike — the same
verifier, the same Origin binding, the same session bucket; never from the
query string). The loader then sends both with no request header at all.
Against any other backend it sends today's JSON + header request.
`Access-Control-Max-Age` is one constant for both widgets: 7200 s (Chromium's
ceiling).

## Cross-node invalidation (PostgreSQL LISTEN/NOTIFY)

Every writer of a snapshot input calls `publishCacheInvalidation([...])` after
its write succeeds (the list is pinned by
`src/test/widget/widgetCachePublishCoverage.test.ts`). That runs this process's
handlers at once, then sends `pg_notify('webyar_cache', …)` through the normal
pool. Every **API** process (`server/index.ts`) holds one extra connection that
runs `LISTEN webyar_cache` and applies what other processes publish. Workers
and scripts only publish.

Scopes: `widget:<ws>`, `widget` (all), `origin:<ws>`, `host:<domain>`,
`entitlements:<ws>`, `user:<id>` (every snapshot whose team has that user),
`platform`, `ipblock`, `all`. `widget:<ws>` also drops the call widget's
bootstrap memo (`server/services/callCenter/bootstrapCache.ts`), and
`platform` its platform settings: call center settings and department edits
publish `widget:<ws>`, platform call center settings `platform`.

The chat widget template is resolved per request with no I/O, from the
workspace snapshot (`widget_template_id`, `widget_template_options`, plan
applied) and the catalog in the platform snapshot
(`shared/chatTemplateCatalog.ts`), into `templateId` and `templateOptions`;
its display names never reach the widget. So a Super Admin save
(`PUT /api/admin/widget-catalog`) publishes only `platform`, and a
workspace's pick goes through the settings `PATCH`, which publishes
`widget:<ws>` and `origin:<ws>` as for any other field. The bootstrap is not
cached in the browser: a change shows on the next page view (an open tab keeps
its template until it reloads).

Writers that publish besides the settings pages: workspace deletion
(`widget:`, `origin:`, `entitlements:`), user deletion and the GDPR
anonymiser (`user:`), the legacy storage migration (`user:` / `widget:`), and
the signup trial plan (`handleWorkspaceEntitlementChanged`).

- **It only makes changes visible sooner.** No cache relies on it: the TTLs
  above hold whether or not the bus works. With the bus, an owner's change
  normally shows on the next page view on every node.
- **Needs the primary, directly.** A read replica or a transaction-mode pooler
  (port 6543) accepts `LISTEN` but never delivers notifications. Each listener
  therefore sends itself a heartbeat NOTIFY every 30 s through the publish path
  and counts as active only while it comes back; the log says
  `cross-node invalidation active` / `INACTIVE`. If `DATABASE_URL` ever points
  at a replica, a separate listen URL to the primary will be needed.
- **+1 connection per API process** (the pool keeps its `DATABASE_POOL_MAX`).
- Every (re)connect, and a heartbeat returning after a gap, RESYNCS this
  process's caches (`all` with `resync: true`): notifications sent meanwhile
  are lost, but nothing known changed. The snapshot, platform and quota caches
  mark their entries expired instead of dropping them (the next request is
  answered from the old copy and ONE gated background rebuild follows), and
  the IP blocklist reloads in the background while it keeps answering (a
  reload already running is not kept). So a dropped LISTEN connection no
  longer makes every active workspace rebuild its snapshot in the
  foreground at once. The call widget bootstrap memo keeps its entries (they
  live 30 s). Origin rules, entitlements and lock state have no stale path
  and still drop theirs: each active workspace's next bootstrap reloads them
  (~36 queries, outside the rebuild budget), one TTL's worth of their normal
  reloads arriving together.
- supabase-rest mode (no `DATABASE_URL`): local only, nothing listens.
- RESPOK has its own database, so its channel is naturally separate.
- `pg_notify` lives in `pg_catalog`; no migration, no grant.

Staleness bound for a write that does **not** publish (a direct SQL edit, a
writer not listed yet, a trial or period ending by the clock): the TTL —
60 s by default — plus at most one more TTL for the nested per-process caches
the snapshot is built from (entitlements 60 s, platform AI settings 15 s,
control planes 10–30 s). `quota_full` may lag up to 60 s; the server still
refuses an over-quota first message and the widget then switches to the form.

## Rollout: one release, either app first

Frontend (apps 24 / 33, serves `loader.js`) and backend (apps 25 / 32)
auto-deploy independently, in any order. Both orders are safe:

- **New backend, old loader** (cached in an open tab, or the frontend not yet
  deployed): the old loader sends JSON without `include_config`; the answer has
  the old shape plus `protocol` (3), and GET /config is served from the same
  snapshot. It keeps sending /track and /visitor-presence with the header,
  which the backend still reads. Nothing changes for it.
- **New loader, old backend:** the CORS-simple bootstrap goes to POST
  `/api/widget/boot`, a route an old backend does not have: it answers before
  any bootstrap work (its token gate: 401, or 404, usually with no CORS
  headers, so a network error), mints no token and sets no visitor cookie.
  (Posting that body to `/bootstrap` instead would let an old backend, which
  reads only JSON, resolve the workspace from the page origin, and on a site
  whose domain is verified for ANOTHER workspace set that workspace's visitor
  cookie on every page view.) The loader drops any answer that lacks
  `protocol >= 2` or names a different workspace, and sends the same body once
  more as `application/json` to `/bootstrap`; that answer is used and GET
  /config is asked as before. The session manager's re-bootstrap does the
  same. Cost during the window: one extra request per page view, and a
  console network error on cross-origin pages; fresh_visitor and the commerce
  subject reset ride in the JSON re-send.
- Every answer the current handler writes carries `protocol`, errors
  included: a 400 / 403 / 404 / 5xx with it is final (no second request), as a
  bootstrap error always was; an error without it came from a backend that has
  no `/boot`. A 429 on `/boot` is final after its one wait (both paths share
  the bootstrap budget). `{disabled, protocol}` is final.
- /track and /visitor-presence go CORS-simple only after a bootstrap answer
  with `protocol >= 3`, taken from every bootstrap (the session manager's
  re-bootstraps too), so a backend rolled back mid-page is followed. A
  `protocol: 2` backend (the first half of this work alone) gets the header
  form. When a body-token request still reaches an older process (a rolling
  deploy keeps old and new backend containers side by side for a while) and
  fails (a network error) or is refused (401, or 400 from a process that
  cannot read the body), it is sent once more with the header, and on
  success the page keeps the header form.
- Rolling back either app is one of these mixes.

Kill switch: `WIDGET_CONFIG_CACHE_TTL_MS=0` on the backend restores the
uncached reads without a deploy of the loader.
