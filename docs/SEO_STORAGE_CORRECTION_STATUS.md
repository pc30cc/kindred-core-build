# SEO canonical storage — final report

## Status

**READY — AUTHORITATIVE SEO STORAGE VERIFIED** for the three blockers in scope
(authoritative canonical writes, production backfill, identical-crawl
deduplication). Cleanup remains disabled; no legacy SEO row was deleted,
truncated or dropped.

## Migrations

| Migration | Purpose |
| --- | --- |
| 169–173 | Unchanged, immutable (retention model, SEO URL/observation model, cleanup fences, scope guards). |
| 174 `seo_canonical_references` | Canonical reference columns (`seo_issue_pages.url_id`, `seo_performance_results.url_id`, `seo_links.source_url_id` / `target_url_id`, `seo_urls.current_observation_id`), 10 indexes, `seo_link_edges` (current link graph), `seo_crawl_summaries`. Expand-and-contract: all new columns nullable, legacy columns kept for rollback. |
| 175 `seo_backfill_state` | Resumable per-crawl backfill checkpoint ledger. |

No migration 176 was needed: no constraint can be tightened while legacy
rows remain intentionally present for rollback.

## Production row counts (live database)

| Metric | Before | After |
| --- | ---: | ---: |
| Legacy `seo_pages` | 201 | 201 (untouched) |
| Legacy `seo_links` | 3,502 | 3,502 (untouched) |
| Canonical `seo_urls` | 0 | 111 |
| `seo_crawl_observations` | 0 | 156 |
| `seo_crawl_url_membership` | 0 | 201 |
| `seo_link_edges` | 0 | 2,066 |
| `seo_crawl_summaries` | 0 | 2 |
| `seo_issue_pages` without `url_id` | 320 | 0 |
| `seo_performance_results` without `url_id` | 30 | 0 |
| Crawls marked backfilled | 0 | 2 / 2 |

Integrity: duplicate canonical identities 0, duplicate memberships 0, orphan
observations 0, canonical URLs without a current observation 0, unresolved
issue/performance references 0.

Deduplication measured on real data: 201 legacy page rows collapse to 111
identities + 156 observations (45 unchanged pages stored no payload — 22.4%
of page rows avoided on only two crawls), and 3,502 legacy link rows collapse
to 2,066 current edges (41% fewer rows), of which 1,794 resolve to an internal
canonical target.

## FK dependency status

The four foreign keys to `seo_pages.id` (`seo_issue_pages.page_id`,
`seo_performance_results.page_id`, `seo_links.source_page_id`,
`seo_links.target_page_id`) still exist but are no longer structural: every
row now also carries a canonical `url_id` / `source_url_id`, and all new
writes go to the canonical columns. The legacy columns stay as a rollback
path only.

## Authoritative write path

`worker/seo-crawler/index.ts` → `crawlSite.ts` → `canonicalRepository.persistPage`
→ `urlRepository.recordObservation` (canonical URL upsert → hash → delta
observation → membership → `seo_urls.current_observation_id`) →
`canonicalRepository.persistLinkEdges` → `rules/engine.ts` (issues with
`url_id`) → `performanceAuditService` (`url_id`) →
`finalizeCanonicalLinkGraph` → `persistCrawlSummary`.

Legacy `seo_pages` / `seo_links` full writes are **stopped**. They happen only
when `SEO_LEGACY_WRITES=true` — an explicit rollback lever, off by default.

## Read cutover

All through `canonicalRepository` (the single boundary that may fall back to
legacy, per crawl, explicitly): `crawlService.listCrawlPages` /
`listCrawlLinks`, `rules/engine.ts`, `performanceAuditService`,
`webAnalytics/reportService.getPossible404s`, crawl comparison and exports.
API response shapes are unchanged.

## Backfill

`server/services/seo/backfillService.ts` (bounded, chronological, resumable,
idempotent) plus the admin endpoints `POST /api/admin/retention/seo-storage/backfill`
and `GET /api/admin/retention/seo-storage/validate`.

Production was converted through the equivalent SQL path
`database/backfill/seo_canonical_backfill.sql` (the sandbox has no service-role
runtime). It was re-run afterwards: counts were identical, confirming
idempotency. Caveat documented in that file: backfilled `observation_hash`
values use the Postgres jsonb serialization, so the first live crawl after the
backfill writes one fresh observation per URL; every crawl after that
deduplicates normally.

## Identical / changed / removed / restored experiment

Real `processCrawl` worker path, legacy writes disabled
(`src/test/seo/e2eSmoke.test.ts`):

| Crawl | Canonical URLs | Full observations | Memberships | Link edges | Legacy pages/links |
| --- | ---: | ---: | ---: | ---: | ---: |
| A initial | +3 | +3 | +3 | +4 | 0 / 0 |
| B identical | +0 | +0 | +3 | +0 | 0 / 0 |
| C one URL changed | +0 | +1 (changed 1) | +3 | +0 | 0 / 0 |
| D one URL removed | +0 | +1 (removed 1) | +2 | +0 | 0 / 0 |
| E URL restored | +0 | +1 (restored 1) | +3 | +0 | 0 / 0 |

## Tests

84 SEO/retention tests pass (hashing, canonical repository, A–E crawl
experiment, backfill idempotency, workspace/site isolation, retention
safeguards, cleanup-disabled guards). Server typecheck clean, changed files
lint-clean, preview build OK. The 28 unrelated pre-existing failures elsewhere
in the suite (billing, widget, invitation chain-order fixtures) are untouched
by this work.

## Cleanup

Every destructive retention/cleanup function remains fenced with
`RAISE EXCEPTION` in non-dry-run mode and executable by `service_role` only.
No SEO cleanup or latest-N pruning has been enabled.
