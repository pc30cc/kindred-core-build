# SEO canonical storage — final report

## Status

**READY — CANONICAL SEO CUTOVER VERIFIED.** Canonical storage is authoritative
for writes and preferred for reads, legacy full writes are stopped, the
production backfill is complete and idempotent. Cleanup remains disabled; no
legacy SEO row was deleted, truncated or dropped.

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

## Regression guard against legacy writes

`src/test/seo/e2eSmoke.test.ts` runs a full `processCrawl` with a database
proxy that **throws on any access to `seo_pages` or `seo_links`**. The crawl
still completes and persists 3 canonical URLs, 3 observations, 3 memberships,
4 link edges, issues, a crawl summary, and `listCrawlPages` still returns all
3 pages. This proves the legacy model is no longer structurally required.

## Link-graph deduplication experiment

Same real pipeline: crawl X writes 4 edges; identical crawl X+1 writes **0**
new edges (existing rows are re-touched via `last_seen_crawl_id`); changing
exactly one internal link href writes **1** new edge. A repeated crawl of the
production site therefore stores 0 instead of ~1,750 link rows.

## Current-state efficiency (EXPLAIN, production)

The latest-state query (canonical URL joined to `current_observation_id`:
status, title, canonical state, indexability, incoming links, first/last seen,
active flag) plans as
`Index Scan seo_urls_site_last_seen_idx -> Nested Loop -> observations pkey`,
31 ms, no sequential scan and no observation replay. Membership-by-crawl
plans as a seq scan only because the table holds 201 rows; the composite
primary key `(crawl_id, url_id)` covers it at scale. No additional index was
justified, so none was added.

## Identical / changed / removed / restored experiment

Real `processCrawl` worker path, legacy writes disabled
(`src/test/seo/e2eSmoke.test.ts`):

| Crawl | Canonical URLs | Full observations | Memberships | Link edges | Legacy pages/links |
| --- | ---: | ---: | ---: | ---: | ---: |
| A initial | +3 | +3 | +3 | +4 | 0 / 0 |
| B identical | +0 | +0 | +3 | +0 | 0 / 0 |
| C one URL changed | +0 | +1 (changed 1) | +3 | +0 | 0 / 0 |
| D one URL removed | +0 | +1 (removed 1) | +2 | +0 | 0 / 0 |
| E URL restored | +0 | +2 (restored 1) | +3 | +0 | 0 / 0 |

D and E each write a second observation because removing/restoring the
`/about` link also legitimately changes the home page's content hash.

## Production consistency (read-only, after cutover)

111 canonical URLs, 156 observations, 201 memberships, 2,066 current edges,
320 canonical issue references, 30 canonical performance references.
Duplicate canonical URLs 0, duplicate memberships 0, orphan observations 0,
orphan memberships 0, unresolved issue refs 0, unresolved performance refs 0,
canonical URLs without a current observation 0.

52 of 2,066 edges are internal links whose target was never crawled
(out-of-scope or excluded paths); they are retained as unresolved targets by
design — that is exactly the broken/uncrawled-link signal the reports need.

## Storage efficiency

| Metric | Value |
| --- | ---: |
| Legacy page rows represented | 201 |
| Unique canonical URLs | 111 |
| Canonical observations | 156 |
| Duplicate page payloads avoided | 45 (22.4%) |
| Memberships (compact rows) | 201 |
| Observation deduplication ratio | 156 / 201 = 0.78 |
| Legacy link rows | 3,502 |
| Canonical current edges | 2,066 |
| Link reduction ratio | 0.59 (41% fewer rows) |
| Rows avoided per repeated identical crawl | ~100 page payloads + ~1,750 link rows |

Observations (156) exceed canonical URLs (111) because a URL legitimately
gains one observation each time its SEO-relevant state actually changes
across history — 45 of the 201 historical page rows were genuine changes.

## Tests

86 SEO/retention tests pass (hashing, canonical repository, A–E crawl
experiment, backfill idempotency, workspace/site isolation, retention
safeguards, cleanup-disabled guards). Server typecheck clean, changed files
lint-clean, preview build OK. The 28 unrelated pre-existing failures elsewhere
in the suite (billing, widget, invitation chain-order fixtures) are untouched
by this work.

## Cleanup

Every destructive retention/cleanup function remains fenced with
`RAISE EXCEPTION` in non-dry-run mode and executable by `service_role` only.
No SEO cleanup or latest-N pruning has been enabled.
