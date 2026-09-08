# Workers — Multi-Worker Deployment

One image (`Dockerfile.worker`) runs every standalone worker. The `WORKER_KIND`
env var selects which loop runs inside the container, so each worker can be a
separate Coolify service on the same server without maintaining a second
Dockerfile.

## Worker kinds

| `WORKER_KIND` | Loop                              | Queue table                |
|---------------|-----------------------------------|----------------------------|
| `intelligence` (default) | AI KB Builder pipeline | `public.ai_kb_jobs`        |
| `source-sync` | Data Hub website source sync      | `public.ai_source_sync_jobs` |
| `seo-crawler` | SEO / Website Audit crawler + backlink scans + keyword research + performance audits (all pluggable vendors) | `public.background_jobs` (`job_type IN ('seo_crawl','seo_backlink_scan','seo_keyword_research','seo_performance_audit')`) |
| `all`         | Both loops in same process (dev only) | both                  |

`all` logs a warning. Use only for local/small deploys.

### Grouping kinds onto one container

`WORKER_KIND` also accepts a comma-separated list, so any subset of kinds can
share a single container instead of requiring one container per kind — e.g.
`WORKER_KIND=seo-crawler,channels,invitations` runs exactly those three loops
in one process, while another container runs the rest with
`WORKER_KIND=intelligence,source-sync,regression-runner`. This is useful when
you want fewer containers than kinds without going all the way to `all`
(every kind, no isolation). Order and whitespace in the list don't matter;
an unknown kind anywhere in the list fails startup with a clear error.

## Coolify setup

Create two services from the same repo, same `Dockerfile.worker`:

1. **Intelligence Worker**
   - `WORKER_KIND=intelligence`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
2. **Source Sync Worker**
   - `WORKER_KIND=source-sync`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. **SEO Crawler Worker** (also handles backlink scans, keyword research and
   performance audits — one poller, one process, claiming all four
   `background_jobs` job types)
   - `WORKER_KIND=seo-crawler`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (same two secrets as every
     other worker kind — this worker is given nothing extra; Core remains
     the authorization boundary, and the worker only ever trusts a
     `seo_crawls`/`seo_backlink_scans`/`seo_keyword_research_runs`/
     `seo_performance_audits` row that Core itself created). If the
     plan-gated `seo_backlinks` / `seo_keywords` / `seo_performance` modules
     are enabled for any plan, this same process also reads
     `platform_backlinks_provider_config` / `platform_keywords_provider_config`
     / `platform_performance_provider_config` through the service client to
     reach the configured vendor for each — no separate credential or env
     var is given to it. Rank Tracking does NOT run on this worker: it has
     no user-triggered job, only a periodic watchlist refresh, so it runs as
     a ticker inside the Backend API process instead (see below).
   - Optional: `SEO_CRAWLER_USER_AGENT` (default `KindredSeoBot/1.0
     (+self-hosted)`), `SEO_WORKER_INTERVAL_MS` (default `5000`),
     `SEO_WORKER_LOCK_TTL_SECONDS` (default `120`)
   - No public port, no public UI. The end user never sees the crawler
     engine (SiteOne) — all SEO business logic, normalization, scoring and
     UI belong to this codebase.
   - Resource limits: recommend 0.5–1 vCPU / 512MB–1GB RAM per instance to
     start; scale instance count (not size) if audit volume grows, since
     each crawl is already bounded by plan-resolved page/duration/byte
     limits (server/services/seo/limits.ts) and never blocks the event loop
     for long stretches (page fetches are async with per-request timeouts).
     A backlink scan is one outbound HTTP call to the vendor, so it adds
     negligible load next to the crawler.
   - Graceful shutdown: on `SIGTERM`/`SIGINT` the worker stops claiming new
     jobs immediately and waits up to 30s for any in-flight crawl/scan to
     reach a heartbeat/completion boundary before exiting; a job still
     running past that window is safely picked up again once its lock TTL
     expires (crash-recovery, not data loss —
     `background_jobs.lock_expires_at`).

No domain or port required for any of these services.

## SEO Rank Tracking ticker (runs on the Backend API, not a worker)

Unlike Backlinks and Keyword Research, Rank Tracking has no user-triggered
"run" — it's a persistent per-site keyword watchlist that gets refreshed on
a schedule. `server/services/seo/rankTrackingTicker.ts` is started from
`server/index.ts` (the Backend API process) alongside the other
observability tickers, on a 15-minute `setInterval`. It acquires a
cluster-wide lease (`server/services/observability/tickerLease.ts`, same
mechanism as `alertingTicker.ts`) before each run so horizontally-scaled API
replicas never double-check the same keyword. It no-ops entirely unless a
platform Rank Tracking provider is configured and active
(`platform_rank_tracking_provider_config`). No extra env var or worker
deployment is required for it — it ships with the Backend API container.

## Backend API production env

The Backend API container should NOT run worker loops in production:

- `AI_KB_INTELLIGENCE_WORKER_INPROC` unset / `0`
- `AI_SOURCE_SYNC_WORKER_INPROC`     unset / `0`
- `AI_KB_WORKER_INPROC`              unset / `0` (deprecated)

If `AI_KB_WORKER_INPROC=1` is detected, the server logs a deprecation warning
and starts the corresponding loop in-process for backward compatibility.

## Env reference (all kinds)

| Preferred                  | Legacy fallback                              |
|----------------------------|----------------------------------------------|
| `WORKER_ID`                | `AI_KB_WORKER_ID`                            |
| `WORKER_INTERVAL_MS`       | `AI_KB_WORKER_INTERVAL_MS` / `AI_KB_WORKER_POLL_MS` |
| `WORKER_LOCK_TTL_SECONDS`  | `AI_KB_WORKER_LOCK_TTL_SECONDS`              |

## Local commands

```
npm run worker                  # default kind=intelligence
npm run worker:intelligence
npm run worker:source-sync
npm run worker:seo-crawler
npm run worker:all
```