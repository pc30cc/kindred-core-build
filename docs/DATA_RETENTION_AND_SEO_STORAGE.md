# Data retention & SEO storage model

Two independent subsystems, introduced by `database/migrations/169_data_retention.sql`
and `database/migrations/170_seo_url_observation_model.sql`. Neither deletes any
existing data on install: every seeded deleting policy ships `enabled = false`.

## 1. Central data retention

### Source of truth
`public.data_retention_policies` — one canonical row per (table, lifecycle).
The DB, not the app, enforces coherence via the `data_retention_mode_shape`
CHECK constraint:

- `permanent` — no retention window may be set at all.
- `rolling` — requires a positive `hot_retention_days`.
- `latest_n_runs` — requires a positive `keep_last_n`.
- `archive_then_delete` — requires `archive_enabled` and a positive `archive_after_days`.

`public.data_retention_runs` records every execution: `running | completed |
partial | failed | skipped`, plus `rows_matched / rows_archived / rows_deleted /
bytes_archived / batches / error / metadata`.

### What is permanent (never deletable here)
Billing ledger, invoices and invoice lines, payments and payment allocations,
wallet ledger, AI run settlements, subscription periods, workspaces, profiles,
conversations, conversation messages, contacts, knowledge base articles.

These are seeded `retention_mode = 'permanent'`, category `financial` or `core`.
Three layers block deletion:
1. the CHECK constraint (a permanent policy cannot hold a deletion window),
2. `data_retention_delete_batch()` refuses permanent / disabled policies,
3. `retentionService.runPolicy()` short-circuits to `skipped` for
   `PROTECTED_CATEGORIES` (`financial`, `core`).

Product-level retention for conversations, messages, contacts, users,
workspaces and KB source content is explicitly **out of scope** until a
product retention behaviour is defined.

### Execution model
`server/services/retention/retentionService.ts`:
- bounded batches only (`batch_size`, hard cap `MAX_BATCHES_PER_RUN = 200`),
  with a short pause between batches — no long transactions, no table locks,
  no blind `DELETE`;
- idempotent: re-running after a failure simply continues from the remaining
  expired rows; a crashed run leaves a `running` row that the next pass closes;
- `dryRun` counts via `data_retention_count_expired()` and deletes nothing;
- `archive_then_delete` without a registered archive adapter finishes `partial`
  with `archive_adapter_unavailable` and deletes nothing.

Archiving goes through `server/services/retention/archive.ts` — a registry, not
a storage implementation. The intended production adapter is Parquet + ZSTD to
S3-compatible object storage; JSON/HTML are exports, not archive formats.

### Scheduling
`worker/retention/index.ts` (worker kind `retention`), controlled by
`RETENTION_INTERVAL_MS` and `RETENTION_DRY_RUN`.

### Admin surface
Super Admin → Data Retention (`/admin/retention`), served by
`server/routes/adminRetention.ts` behind `requirePlatformAdmin`. Permanent and
protected policies render read-only — no Edit / Run controls at all — and the
server rejects such requests independently of the UI.

## 2. SEO URL / observation model

`seo_pages` stored one full row per page per crawl, so an unchanged 50k-page
site cost 50k rows on every crawl. The new model separates identity from
observation:

- `seo_urls` — canonical URL per (workspace, site), stored once, never deleted
  by retention;
- `seo_crawl_url_membership` — which URLs were seen in which crawl (tiny row);
- `seo_crawl_observations` — a full observation row written **only** when the
  content hash of the comparison-relevant fields changes
  (`new | changed | unchanged | removed | restored`).

`server/services/seo/urlRepository.ts` owns hashing (`hashUrl`,
`computeObservationHash` — fixed field order, never `JSON.stringify` over an
arbitrarily ordered object), upserts, `finalizeCrawlUrlModel` (marks URLs
absent from this crawl as `removed`), `compareCrawlUrlSets` and
`getSeoStorageMetrics`.

Writes are wired into `crawlSite.ts` inside a `try/catch`: the new model must
never break an in-flight crawl. Reports still read the legacy tables — the new
model is additive until cutover.

`seo_retention_prune_crawl_details()` keeps the latest N **successful** crawls
per site, pruning page/link detail in bounded batches while keeping membership
rows, so historical trends survive.

### Backfill
`POST /api/admin/retention/seo-storage/backfill` (or the button on the SEO
storage tab) converts existing crawls incrementally, 25 crawls per pass.

## Rollout order
1. Apply migrations 169 and 170.
2. Run the SEO backfill to convergence.
3. Review policies in Super Admin; dry-run each one before enabling.
4. Enable the `retention` worker.
