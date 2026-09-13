# Complete SEO storage corrections safely

## Confirmed code gaps
- `server/services/seo/crawler/crawlSite.ts`: `upsertPage` writes full legacy pages, then attempts canonical observations without preserving the full report payload; link handling appends legacy edges.
- `server/services/seo/crawler/linkGraph.ts`: `finalizeLinkGraph` reads and updates legacy pages/links.
- `server/services/seo/urlRepository.ts`: canonical writes are non-atomic, errors can be ignored, disappearance processing is incompletely paginated, and observation hashing omits report-relevant fields.
- `server/services/seo/crawlService.ts`: `listCrawlPages` and `listCrawlLinks` read legacy tables; `compareWithPreviousCrawl` compares issue summaries.
- `server/services/seo/rules/engine.ts`, `performanceAuditService.ts`, and `server/services/webAnalytics/reportService.ts` depend on legacy page/link data.
- `worker/seo-crawler/index.ts` runs crawl, link finalization, issue evaluation and canonical finalization.
- Migration 170's backfill creates memberships without full observations; it cannot support a safe read cutover.

## Implementation
1. Inspect live schema, privileges, foreign keys, crawl/job state and row counts. Complete the API/frontend/export dependency inventory. Record checksums for migrations 169–172 without altering them.
2. Introduce forward-only migrations 173+ for atomic scoped canonical writes, effective/current observation references, compact memberships, summary/progress records and necessary indexes. Use the existing URL canonicalizer and one deterministic hash implementation for live crawling and backfill.
3. Preserve every report-relevant field in changed observations. Exclude volatile timing fields from content-change detection, retaining per-crawl measurements separately where reports need them. Reuse effective observations for unchanged and unchanged-restored pages; represent removals without duplicating full payloads.
4. Deduplicate link targets and version each source's outgoing edge set only when it changes. Preserve historical graph access using crawl references rather than repeated URL strings. Keep all legacy edges untouched.
5. Introduce a single compatibility repository for page/link lists, details, issues, performance results, analytics, comparisons and exports. Preserve API response shapes and existing issue references; legacy fallback is explicit per not-yet-migrated crawl, never triggered silently by errors.
6. Implement chronological, bounded, resumable backfill with persisted checkpoints and failure tracking. Reuse the canonical write rules; preserve legacy IDs needed for compatibility. Validate counts, scope, observation coverage and payload parity before marking a crawl migrated.
7. Switch the actual crawler to canonical storage only once compatible readers and issue references are ready. Fail visibly on storage errors; no accidental legacy dual-write. Finalize removals only for complete successful crawls, not truncated, failed or cancelled scans.
8. Persist compact crawl summaries and expose storage-efficiency metrics in the existing diagnostics area. Prepare latest-five eligibility while preserving current observations, referenced details, active jobs/reports and summaries. Keep every destructive cleanup fence and disabled policy unchanged.

## Technical verification
- Test initial/identical/changed/added/removed/restored URLs, canonical/indexability changes, workspace/site isolation, concurrency and membership uniqueness.
- Test backfill reruns and interruption/resumption, historical comparisons, current reads, compatibility responses and legacy integrity.
- Run a realistic crawl twice through the actual worker/write path in isolated test data. Report exact canonical, membership, observation, link-version and legacy row deltas; distinguish this experiment from live production counts.
- Run database, backend, crawler, SEO and retention tests plus lint; inspect automated build/typecheck results. EXPLAIN primary current/history queries before judging index redundancy.
- Apply only reviewed forward migrations and controlled backfill. Report any unavailable production access or verification as a blocker rather than inferring success.

## Delivery criteria
Provide before/after counts, deduplication and estimated byte savings, remaining legacy dependencies, migration list, test evidence and cleanup status. Declare READY only after the real crawler's second identical crawl avoids full duplicate storage and all compatibility/safety checks pass. Otherwise list precise blockers and declare NOT READY.

No changes to migrations 169–172, no rollback, no destructive cleanup, no deletion/truncation/drop of legacy SEO tables, and no Edge Functions.