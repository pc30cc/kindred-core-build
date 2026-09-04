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
