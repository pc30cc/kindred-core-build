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

Code: `server/services/widget/configSnapshot.ts` (snapshot, config builder),
`server/lib/memoCache.ts` (single flight, stale-while-revalidate, LRU, rebuild
budget), `server/lib/cacheBus.ts` (cross-node invalidation),
`server/middleware/bodyParsers.ts` (the text/plain body), `public/widget/loader.js`
(`requestBootstrap`, `isCurrentBootstrap`).

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
  the old shape plus `protocol: 2`, and GET /config is served from the same
  snapshot. Nothing changes for it.
- **New loader, old backend:** an old backend ignores a text/plain body
  (`req.body` is `{}`), so it answers 400 / no CORS headers (a network error) /
  something resolved from the page origin alone — never with `protocol: 2`.
  The loader drops any bootstrap answer that lacks `protocol >= 2` or names a
  different workspace, and sends the same body once more as
  `application/json`; that answer is used and GET /config is asked as before.
  The session manager's re-bootstrap does the same. Cost during the window: one
  extra request per page view, no functional change (fresh_visitor and the
  commerce subject reset ride in the JSON re-send).
- 401 / 403 / 404 and a `{disabled, protocol: 2}` answer are final, as they
  always were (no second request); 5xx are retried as before.
- Rolling back either app is the same mix and equally safe.

Kill switch: `WIDGET_CONFIG_CACHE_TTL_MS=0` on the backend restores the
uncached reads without a deploy of the loader.
