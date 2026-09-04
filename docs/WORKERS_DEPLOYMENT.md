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
| `seo-crawler` | SEO / Website Audit crawler       | `public.background_jobs` (`job_type='seo_crawl'`) |
| `all`         | Both loops in same process (dev only) | both                  |

`all` logs a warning. Use only for local/small deploys.

## Coolify setup

Create two services from the same repo, same `Dockerfile.worker`:

1. **Intelligence Worker**
   - `WORKER_KIND=intelligence`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
2. **Source Sync Worker**
   - `WORKER_KIND=source-sync`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. **SEO Crawler Worker**
   - `WORKER_KIND=seo-crawler`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (same two secrets as every
     other worker kind — this worker is given nothing extra; Core remains
     the authorization boundary, and the worker only ever trusts a
     `seo_crawls` row that Core itself created)
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
   - Graceful shutdown: on `SIGTERM`/`SIGINT` the worker stops claiming new
     jobs immediately and waits up to 30s for any in-flight crawl to reach a
     heartbeat/completion boundary before exiting; a crawl still running
     past that window is safely picked up again once its lock TTL expires
     (crash-recovery, not data loss — `background_jobs.lock_expires_at`).

No domain or port required for any of these services.

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