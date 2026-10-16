# Widget config cache and cross-node invalidation

A visitor's page view used to cost the backend about 33 database queries in
about 24 sequential round trips (POST `/api/widget/bootstrap`, then GET
`/api/widget/config`), plus two CORS preflights and two API round trips for the
browser. Now:

- **One API round trip, no preflight.** The loader posts the bootstrap as a
  CORS-simple request (JSON body, no `Content-Type` header, so the browser
  labels it `text/plain`) with `include_config: true`, and the answer carries
  the GET /config body as `config`.
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
| Platform snapshot | widget_platform_settings (URL bases, welcome default, powered-by wording), the pre-chat policy, every `platform_branding_localized.platform_name` | 30 s | |
| `quota_full` | the monthly conversation quota answer | 60 s | usage has no write hook |

Computed **per request**, never cached: availability at the current time
(business hours and personal schedules switch exactly on time), the team's
online dots, the smart rules' `end_at` filter, the platform AI kill switch
(15 s cache of its own), content-hashed asset URLs (2 s manifest cache),
`apiBase` / `assetBase` from the request, the locale clamp, and everything about
the visitor: token, cookies, origin checks.

Rules common to the three caches:

- **Stale-while-revalidate.** Past its lifetime an entry is still served while
  one background rebuild runs. A rebuild that fails, or comes back degraded,
  keeps the old entry (retried every 5 s) for at most **10 minutes**; after
  that the request waits for a rebuild and a failure surfaces (500 as before).
  A database blip therefore no longer greys every launcher.
- **Single flight** per key; a build that was running when its key was
  invalidated answers the requests already waiting on it but is never stored.
- **Rebuild budget.** Full snapshot rebuilds (~30 queries in 3 parallel waves)
  are limited per process to `WIDGET_CONFIG_REBUILDS_PER_SEC` (default 25,
  burst 2×). A request over the budget waits up to 5 s for its turn, then gets
  `503` with `Retry-After: 1` (the loader retries 5xx); a background refresh over
  the budget is skipped. The existence check in front (one query) is not
  counted, so a flood of made-up workspace ids cannot starve real ones. Hits
  are always free.
- Keys are lower-cased workspace ids.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WIDGET_CONFIG_CACHE_TTL_MS` | `60000` | Fresh lifetime of a workspace snapshot. A smaller value also shortens the platform (30 s) and quota (60 s) caches. **`0` turns all three off** (every request reads, as before this change). `300000` is reasonable once the bus is known to work. |
| `WIDGET_CONFIG_CACHE_MAX` | `2000` | LRU bound of workspace snapshots per process (a snapshot is ~5–20 KB). |
| `WIDGET_CONFIG_REBUILDS_PER_SEC` | `25` | Rebuild budget per process; `0` = unlimited. |
| `WIDGET_BOOTSTRAP_PER_IP_PER_MIN` | `600` | Chat widget bootstraps per client address per minute (was 60). |
| `WIDGET_BOOTSTRAP_GLOBAL_PER_MIN` | `12000` | Chat widget bootstraps per **process** per minute (was 1200). |
| `CALL_WIDGET_BOOTSTRAP_PER_IP_PER_MIN` | `600` | Call widget bootstraps per client address per minute (was 60). |
| `CALL_WIDGET_BOOTSTRAP_GLOBAL_PER_MIN` | `6000` | Call widget bootstraps per **process** per minute (was 1200). |
| `WIDGET_PER_IP_PER_MIN` | `1200` | Every `/api/widget` and `/api/call-widget` request per client address per minute (was 300); also the `ip:` fallback of the workspace limiter. |

The five limits take a positive integer; anything else means the default. They
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

`widgetRateLimit(category)` counts a request with a **valid, HMAC-signed,
workspace-bound `dvsid` visitor cookie** per visitor, plus a shared ceiling for
all such requests of one (IP, workspace); a request without one (first visit,
Safari and other browsers that block third-party cookies, non-browsers, a
forged or other-workspace cookie) per (IP, workspace) at the anonymous cap.
New cookies are minted only by bootstraps without one, which that anonymous
cap bounds. Per minute:

| Category | Routes | Per visitor | Anonymous (IP, workspace) | Shared, all visitors of one (IP, workspace) |
|---|---|---|---|---|
| `bootstrap` | POST /bootstrap | 30 | 300 | 3000 |
| `config` | GET /config, /manifest, /call-channels | 20 | 600 | 6000 |
| `default` | /track, /event, /action, … | 30 | 300 | 3000 |
| `poll` | /poll, /history, … | 60 | 600 | 6000 |
| `refresh` | /session/refresh | 20 | 200 | 2000 |
| `message` | /message, OTP, pre-chat, … | 15 | 60 | 240 |
| `upload` | attachments | 10 | 40 | 160 |

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

### Client IP behind a CDN (open question)

The express-rate-limit layers and the IP blocklist key on Express's `req.ip`,
which follows `trust proxy` (`TRUST_PROXY`, default `loopback, linklocal,
uniquelocal`). `widgetRateLimit` keys on `utils/clientIp.ts` `getClientIp`,
which believes `cf-connecting-ip` from **any private peer** (and
`TRUSTED_PROXY_IPS`). This repo cannot tell which is right in production:

- **Is Cloudflare in front of `api.webyar.ai` and `api.respok.app`, and what are
  `TRUST_PROXY` / `TRUSTED_PROXY_IPS` on apps 25 and 32?** If Cloudflare proxies
  them and `TRUST_PROXY` does not list Cloudflare's ranges, `req.ip` is a
  Cloudflare edge address: every visitor behind one edge shares one per-IP
  bucket (the raised caps soften that, they do not fix it) and an IP block of a
  visitor's address never matches.
- Switching `req.ip` to `getClientIp` is **not** the fix: a client that reaches
  the origin (192.99.68.134) through Traefik directly, without Cloudflare, could
  then choose its own bucket by sending `cf-connecting-ip`.
- The fix, once the answer is known: either set `TRUST_PROXY` to Cloudflare's
  published ranges (plus the private ranges) so `req.ip` becomes the visitor,
  or lock the origin to Cloudflare and only then honour `cf-connecting-ip`, for
  every layer together.

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
`platform`, `ipblock`, `all`.

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
- Every (re)connect, and a heartbeat returning after a gap, flushes this
  process's caches (`all`): notifications sent meanwhile are lost.
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
- **New loader, old backend:** an old backend ignores a text/plain body
  (`req.body` is `{}`), so it answers 400 / no CORS headers (a network error) /
  something resolved from the page origin alone — never with `protocol: 2`.
  The loader drops any bootstrap answer that lacks `protocol >= 2` or names a
  different workspace, and sends the same body once more as
  `application/json`; that answer is used and GET /config is asked as before.
  The session manager's re-bootstrap does the same. Cost during the window: one
  extra request per page view, no functional change (fresh_visitor and the
  commerce subject reset ride in the JSON re-send).
- /track and /visitor-presence go CORS-simple only after a bootstrap answer
  with `protocol >= 3`, taken from every bootstrap (the session manager's
  re-bootstraps too), so a backend rolled back mid-page is followed. A
  `protocol: 2` backend (the first half of this work alone) gets the header
  form.
- 401 / 403 / 404 and a `{disabled, protocol}` answer are final, as they
  always were (no second request); 5xx are retried as before, a 429 once.
- Rolling back either app is the same mix and equally safe.

Kill switch: `WIDGET_CONFIG_CACHE_TTL_MS=0` on the backend restores the
uncached reads without a deploy of the loader.
