# Data retention & SEO storage model

Two independent subsystems, introduced by `database/migrations/169_data_retention.sql`
and `database/migrations/170_seo_url_observation_model.sql`. Neither deletes any
existing data on install: every seeded deleting policy ships `enabled = false`
(the visitor tracking policies of migration 281, below, included).

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

### Visitor tracking data (migration 281)
`281_widget_visitor_privacy.sql` seeds five `rolling`, `workspace_overridable`
policies for the chat widget's visitor tracking tables — `visitor_sessions`
(by `last_seen_at`), `visitor_page_views` (`viewed_at`), `web_analytics_events`,
`widget_smart_events` and `widget_ai_nudges` (`created_at`) — at 395 days
(13 months), so visitor data need not be kept forever (GDPR / ePrivacy,
finding P-01). Like every other deleting policy they ship **disabled**, and
a Super Admin turns each one on in Super Admin → Data Retention (preview
first: the count of what the first run would delete). Re-running 281 never
touches a policy that is already there, so an enabled or tuned policy stays
as the Super Admin left it.

**Migration 171's fence holds for them too.** `visitor_data_retention_delete_batch`
refuses to delete (`retention_cleanup_not_ready`), exactly as
`data_retention_delete_batch` has since 171: an enabled visitor policy
previews (its count works, per workspace), but its runs, the six-hourly
sweep's and "Run" alike, end `failed` with that error and delete nothing.
The fence stays until the owner lifts it in a reviewed migration of its
own, which replaces the function with the bounded per-workspace delete
(the statement is in 281's header, section 4).

A workspace may choose its own period (30–1095 days,
`widget_settings.visitor_data_retention_days`, Settings → Privacy requests →
Visitor privacy), which replaces the 395 days for its own rows once the
policy is enabled and the fence lifted; while it is disabled, that card says
nothing is deleted yet. `runTimeBased` sends such a policy to
`runPerWorkspace`, which counts and (once the fence is lifted) deletes
workspace by workspace with each one's period
(`visitor_data_retention_count_expired` / `_delete_batch`). The backend runs
the five every six hours itself (`server/services/privacy/visitorRetention.ts`,
first sweep 10 minutes after boot), whether or not the `retention` worker is
deployed; a disabled policy is skipped there (no run is opened, no row is
read for deletion, and `_delete_batch` itself refuses a disabled policy).
Once the fence is lifted, deleting a session deletes its page views and
presence (ON DELETE CASCADE) and unlinks its analytics events, calls and
article votes; conversations and their messages stay.

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
