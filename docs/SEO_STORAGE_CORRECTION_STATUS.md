# SEO corrective work — incomplete

## Verified live baseline
2026-09-13: 201 legacy pages, 3,502 legacy links, zero canonical URLs, zero observations, zero memberships, zero enabled destructive policies. No backfill or cleanup was run during this correction.

## Changes applied
- Forward migration 173 (`173_seo_storage_scope_guard.sql`) adds three scope-validation triggers. Live catalog confirms all three are enabled. Canonical rows must belong to the specified workspace/site; memberships and observations must agree with their URL/crawl scope; effective observations must belong to the same canonical URL.
- Full report payload is now passed to observation storage by `crawlSite.ts`.
- Observation hashing includes report payload fields, recursively stabilizes object keys and excludes volatile crawl measurements.
- Migrations 169–172 remain unchanged; no legacy data was deleted or tables dropped.

## Concrete legacy dependencies
- `server/services/seo/crawler/crawlSite.ts`: `upsertPage` still writes legacy pages; outgoing links still append legacy rows. Canonical storage is still secondary, not authoritative.
- `server/services/seo/crawler/linkGraph.ts`: `finalizeLinkGraph` reads and updates legacy links/pages.
- `server/services/seo/crawlService.ts`: `listCrawlPages`, `listCrawlLinks` read legacy storage; `compareWithPreviousCrawl` uses issue summaries.
- `server/services/seo/rules/engine.ts`: issue evaluation reads legacy pages/links.
- `server/services/seo/performanceAuditService.ts`: performance selection reads legacy pages.
- `server/services/webAnalytics/reportService.ts`: status reporting reads legacy pages.
- `worker/seo-crawler/index.ts`: orchestrates the legacy-backed pipeline.
- `server/services/seo/urlRepository.ts`: secondary canonical writes, comparison, metrics and incomplete legacy backfill RPC entry point.
- Live `seo_issue_pages.page_id` still references `seo_pages`; removing legacy writes before adapting issue references would break issue persistence.

## Validation performed
- 12 observation-hash tests passed.
- 4 existing real-module crawler pipeline smoke tests passed against the in-memory database fixture.
- 7 retention guard tests passed.
- Targeted ESLint completed without diagnostics; latest automated preview build reported OK.
- Live migration trigger existence verified. Database mutation/concurrency tests have not been run.
- Existing security-linter warnings remain outside this migration: mutable function search paths, public extensions, broadly executable pre-existing functions and disabled leaked-password protection. The new trigger function has a fixed search path and execution revoked from browser roles.

## Remaining acceptance blockers
Atomic canonical writer, current-state references, normalized/versioned link graph, full read compatibility, issue-reference compatibility, resumable payload-preserving backfill, summaries, eligibility validation, complete API/frontend/export inventory, EXPLAIN analysis and storage diagnostics remain incomplete.

The required actual identical-crawl experiment has NOT been run. Exact crawl #1/#2 row deltas and deduplication ratio are therefore not available. Hash tests are not evidence of successful storage cutover. No READY claim is justified.

Cleanup remains disabled and fenced. No production data backfill has been attempted.

NOT READY — SEO CORRECTIONS STILL INCOMPLETE