# SEO / Website Audit

A native feature: a workspace member can crawl and analyze the technical SEO
health of a website that is **already registered in that workspace**
(`workspace_domains` — the same table `Settings → Domains` uses; no separate
"sites" concept exists). There is deliberately **no domain-ownership
verification** — registration in the workspace is the only authorization
check.

## Architecture

```
Web App → Core API (server/routes/seo.ts)
            → server/services/seo/{siteResolver,limits,crawlService}.ts
            → generic job queue (server/services/jobs/*, background_jobs)
                → SEO Crawler Worker (worker/seo-crawler/, WORKER_KIND=seo-crawler)
                    → server/services/seo/crawler/* (fetch, HTML parse, robots, sitemap, BFS)
                    → server/services/seo/crawler/linkGraph.ts (link-graph finalize)
                    → server/services/seo/rules/* (issue rules)
                    → server/services/seo/scoring/score.ts (SEO Health Score)
            → Supabase/Postgres (seo_crawls, seo_pages, seo_links, seo_issues,
              seo_issue_pages, seo_sitemaps, seo_performance_results)
            → SEO UI (src/pages/app/seo/SeoPage.tsx)
```

`background_jobs` is a fully generic async job queue with no SEO knowledge —
any future worker kind (DNS checks, SSL checks, uptime, performance audits)
can reuse it. All SEO-specific state lives in the `seo_*` tables, which
reference a job by id but own their own richer status/progress fields.

The crawl **never** runs synchronously inside an API request. `POST
/api/seo/:workspaceId/crawls` only enqueues a job and returns immediately;
the actual crawl happens in a separate worker process/container.

## Security model

- **No arbitrary URL crawling.** The client sends only `{ siteId }`. The
  server resolves the canonical URL from `workspace_domains` itself
  (`server/services/seo/siteResolver.ts`) before ever creating a job. There
  is no endpoint anywhere that accepts a URL from the client.
- **Tenant isolation, multiple layers.** Every route calls
  `authorizeWorkspaceAccess` first; every DB read/write is additionally
  scoped by `workspace_id` in the query itself (never trusting a resource id
  alone); every `seo_*` table carries its own `workspace_id` FK.
- **SSRF-hardened transport**, reused (not reimplemented) from the Data Hub
  crawler: `shared/net/hostGuard.ts` (blocklist primitives) +
  `server/services/ai-agent/crawler/safeCrawlFetch.ts`'s `assertHopAllowed`
  (per-hop redirect revalidation) and `pinnedFetch` (connect-time DNS
  pinning against rebinding). See `server/services/seo/crawler/seoFetch.ts`.
- **Crawl scope.** `isSameDomain()` (www-stripped exact-host match) gates
  every fetch and every enqueue: `example.com` authorizes crawling any path
  under `example.com`, but never an external domain discovered on a page,
  and never a subdomain (`admin.example.com` requires its own separate
  registration).
- **Plan-aware limits**, resolved server-side, never trusted from the
  client: `server/services/seo/limits.ts` (`seo_max_pages_per_crawl`,
  `seo_max_depth`, `seo_max_duration_seconds`, byte caps, concurrency,
  frequency, etc).
- **Least-privilege worker.** The SEO crawler worker needs only
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — the same two secrets every
  other worker in this repo already has. It carries no platform secrets it
  doesn't use.

## Scoring

`server/services/seo/scoring/score.ts` — versioned (`score_version`),
deterministic, never touched by an LLM. Penalty = severity weight ×
log-dampened affected-count factor × percent-of-site factor. The full
breakdown (which issues cost how many points) is persisted on
`seo_crawls.score_breakdown` and shown in the Overview tab.

## Performance auditing (Lighthouse/Unlighthouse)

**Schema contract only in V1** — `seo_performance_results` exists with the
full column set (Performance/Accessibility/Best-Practices/SEO scores, LCP,
CLS, INP, FCP, TBT) so the API/UI contract is stable, but no
`performance-worker` ships yet. This was an explicit, permitted scope
decision so the core crawler could be fully production-ready rather than
shipping two half-finished workers. The UI's Performance tab says so
honestly instead of showing fake data.

## Deployment (Coolify)

See `docs/WORKERS_DEPLOYMENT.md` — add one more service from the existing
`Dockerfile.worker` image with `WORKER_KIND=seo-crawler`. No public port, no
domain, container-running-status healthcheck (already built into the shared
image). Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (required),
`SEO_CRAWLER_USER_AGENT`, `SEO_WORKER_INTERVAL_MS`,
`SEO_WORKER_LOCK_TTL_SECONDS` (all optional, sane defaults).

## Backlinks module (plan-gated, provider-agnostic)

A second, independently plan-gated module living alongside the crawler,
sharing its worker process (one poller, one container — a backlink scan is a
single vendor HTTP call, not a multi-page crawl, so it doesn't warrant its
own container) but with its own result tables:

```
Web App → Core API (server/routes/seo.ts, /backlink-scans routes)
            → server/services/seo/{backlinksLimits,backlinkService}.ts
            → generic job queue (background_jobs, job_type=seo_backlink_scan)
                → SEO Crawler Worker (worker/seo-crawler/, WORKER_KIND=seo-crawler
                  — same process as the crawl loop; claims both job types)
                    → worker/seo-backlinks/processScan.ts
                    → server/services/seo/backlinks/ (pluggable provider adapter)
            → Supabase/Postgres (seo_backlink_scans, seo_backlinks,
              platform_backlinks_provider_config)
            → SEO UI (SeoPage.tsx's Backlinks tab)
```

- **Plan-gated, opt-in by default.** Unlike the always-on crawl module, the
  `seo_backlinks` module defaults to `false` in every plan's entitlements
  (`server/services/billing/capabilityRegistry.ts`) — a platform admin must
  explicitly enable it per plan (`/admin/plans`) before any workspace on that
  plan can use it. Its own limits (`seo_backlinks_max_per_scan`,
  `seo_backlinks_workspace_concurrent_scans`,
  `seo_backlinks_scan_frequency_hours`) are resolved the same way as the
  crawler's, in `server/services/seo/backlinksLimits.ts`.
- **Pluggable vendor, platform-level config.** The actual backlink-data
  vendor is never hardcoded into call sites: `server/services/seo/backlinks/`
  defines a small adapter interface (`types.ts`) with one concrete
  implementation today (`providers/dataforseo.ts`, DataForSEO's `live`
  Backlinks API — one synchronous HTTP call per scan, no task polling). Which
  vendor is active is a single platform-level config row
  (`platform_backlinks_provider_config`, same singleton-credential shape as
  `platform_sms_provider_config`), set from `/admin/seo-integrations`. Adding
  a second vendor is one new adapter file plus one branch in
  `resolveProvider()` — no route or UI call site changes.
- **Credential never reaches the browser.** The admin UI only ever sees
  `hasCredentials: boolean` and the login (never the password); the actual
  vendor credential is read only by `server/services/seo/backlinks/index.ts`
  through the service-role client.
- **No arbitrary URL, same as the crawler.** `POST /:workspaceId/backlink-scans`
  takes only `{ siteId }`; the target URL is resolved server-side from
  `workspace_domains` via the same `siteResolver.ts` the crawler uses.

## Keyword Research module (plan-gated, provider-agnostic)

A third module, structured identically to Backlinks: same worker process,
same job-queue pattern, its own result tables and its own plan-gated limits.

```
Web App → Core API (server/routes/seo.ts, /keyword-runs routes)
            → server/services/seo/{keywordsLimits,keywordResearchService}.ts
            → generic job queue (background_jobs, job_type=seo_keyword_research)
                → SEO Crawler Worker (worker/seo-crawler/, WORKER_KIND=seo-crawler
                  — same process as the crawl + backlink scan loops; claims
                  all three job types)
                    → worker/seo-keywords/processRun.ts
                    → server/services/seo/keywords/ (pluggable provider adapter)
            → Supabase/Postgres (seo_keyword_research_runs, seo_keyword_results,
              platform_keywords_provider_config)
            → SEO UI (SeoPage.tsx's Keywords tab)
```

- **Plan-gated, opt-in by default.** `seo_keywords` defaults to `false` in
  every plan's entitlements, same as Backlinks. Its limits
  (`seo_keywords_max_per_lookup`, `seo_keywords_workspace_concurrent_runs`,
  `seo_keywords_lookup_frequency_hours`) are resolved in
  `server/services/seo/keywordsLimits.ts`.
- **Pluggable vendor, platform-level config.** `server/services/seo/keywords/`
  follows the same adapter shape as Backlinks, with `providers/dataforseo.ts`
  calling DataForSEO's `google_ads/search_volume/live` endpoint. The active
  vendor is a single platform-level config row
  (`platform_keywords_provider_config`), set from `/admin/seo-integrations`.
- **Credential never reaches the browser**, same guarantee as Backlinks.
- **Seed keywords, not arbitrary crawling.** `POST /:workspaceId/keyword-runs`
  takes `{ siteId, seedKeywords }` (1–1000 keywords, bounded by the plan's
  `seo_keywords_max_per_lookup`); the provider returns search volume, CPC and
  a locally-derived competition level (low/medium/high) for each seed.

## Rank Tracking module (plan-gated, provider-agnostic)

Structurally different from the other two modules: there is no user-triggered
"run" to poll for completion. A workspace builds a persistent per-site
keyword watchlist, and a periodic ticker refreshes each tracked keyword's
search position on a schedule — so it does not use `background_jobs` or the
SEO Crawler Worker at all.

```
Web App → Core API (server/routes/seo.ts, /tracked-keywords routes)
            → server/services/seo/{rankTrackingLimits,rankTrackingService}.ts
            → Supabase/Postgres (seo_tracked_keywords — direct writes, no queue)

server/index.ts (Backend API process)
    → server/services/seo/rankTrackingTicker.ts (setInterval, 15 min,
      cluster-wide lease via tickerLease.ts — same pattern as
      alertingTicker.ts)
        → server/services/seo/rankTracking/ (pluggable provider adapter)
        → Supabase/Postgres (seo_rank_checks, seo_tracked_keywords)
        → SEO UI (SeoPage.tsx's Rank Tracking tab)
```

- **Plan-gated, opt-in by default.** `seo_rank_tracking` defaults to `false`
  in every plan's entitlements. Its limits (`seo_rank_tracking_max_keywords`,
  `seo_rank_tracking_check_frequency_hours`) are resolved in
  `server/services/seo/rankTrackingLimits.ts`.
- **Pluggable vendor, platform-level config.** `server/services/seo/rankTracking/`
  follows the same adapter shape as the other two modules, with
  `providers/dataforseo.ts` calling DataForSEO's `serp/google/organic/live`
  endpoint and scanning the result for the tracked domain. The active vendor
  is `platform_rank_tracking_provider_config`, set from
  `/admin/seo-integrations`.
- **Credential never reaches the browser**, same guarantee as the other
  modules.
- **No user-triggered run; the ticker is the only writer of rank data.**
  `POST /:workspaceId/tracked-keywords` only adds a keyword to the watchlist
  (bounded by `seo_rank_tracking_max_keywords`) with `next_check_at = now()`
  for an immediate first check; `rankTrackingTicker.ts` is the sole process
  that ever calls the vendor and writes `seo_rank_checks` /
  `seo_tracked_keywords.last_position`. A per-keyword provider error bumps
  `next_check_at` by 1 hour rather than leaving the keyword perpetually due.

## Known V1 limitations

- Performance/Lighthouse auditing is schema-only (see above).
- robots.txt "parse errors" are not distinguished from "no rules matched" —
  a malformed file degrades to "no directives" rather than surfacing a
  distinct parse-error state.
- Sitemap-vs-crawl comparison ("404 URLs in sitemap", "non-indexable URLs in
  sitemap") is computed against a bounded in-run sample of sitemap URLs
  (`seo_crawls.sitemap_summary`), not against every sitemap URL ever seen,
  to avoid unbounded fetches purely for reporting.
- Mixed-content detection is a regex heuristic (`http://` in an `src`/`href`
  attribute on an HTTPS page), not a full resource-load audit.
