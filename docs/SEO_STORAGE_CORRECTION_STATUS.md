# SEO corrective work — incomplete

## 2026-09-13 continuation verification

No migrations 174+ or production data mutations were performed in this continuation. Migrations 169–173 remain immutable; cleanup remains disabled.

Live read-only validation: 201 legacy pages, 3,502 legacy links, 2 successful crawls, 0 canonical URLs, 0 observations, 0 memberships. Duplicate canonical identities, duplicate memberships, orphan observations and orphan memberships are all zero **because canonical storage is empty**, not because backfill passed. There are 111 distinct scoped legacy URLs missing from canonical storage and 2 successful crawls missing memberships.

Added an actual `processCrawl` A/B experiment to `src/test/seo/e2eSmoke.test.ts`. This runs the real worker/crawler/rules/report modules with deterministic network responses and an **in-memory database**, not PostgreSQL or production. Exact row deltas:

| Crawl | Canonical URLs | Full observations | Memberships | Legacy pages | Legacy links |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | +3 | +3 | +3 | +3 | +4 |
| B (identical) | +0 | +0 | +3 | +3 | +4 |

Canonical observation deduplication works for this fixture, but the mandatory legacy-write acceptance gate fails: B still writes three complete legacy pages and four links. The characterization test explicitly documents that defect; a passing characterization is **not** a passing cutover acceptance test. Across A/B, 3 observations / 6 memberships implies 50% canonical observation avoidance (3 avoided observations); total storage savings and bytes are not measured and cannot be inferred while dual writes remain.

Targeted verification: 24 tests passed (12 hash, 5 actual-module pipeline including A/B, 7 retention safeguards), zero failed. Changed C and removal/restoration D/E experiments, PostgreSQL concurrency/migration tests, production backfill, and current/read cutover remain unperformed.

Additional compatibility dependency confirmed: `seo_performance_results.page_id` references legacy `seo_pages.id`, alongside `seo_issue_pages.page_id` and legacy link source/target foreign keys. Cutting off legacy page writes before adapting these references would break downstream persistence.

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