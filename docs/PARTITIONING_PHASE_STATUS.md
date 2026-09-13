# Phase 3 — PostgreSQL Partitioning

**Status: READY — PARTITIONING PHASE VERIFIED**

PostgreSQL 17.6. Forward-only migrations 176–181. Migrations 169–175 untouched.

---

## 1. Audit

Live row counts and sizes at migration time (production), plus observed growth:

| Table | Rows | Size | Timestamp column | Rows/day | 12-month projection | Verdict |
|---|---|---|---|---|---|---|
| workspace_health_snapshots | 2,262 | 936 kB | `captured_at` | ~516 | ~190k | **PARTITION NOW** |
| operator_activity_samples | 1,290 | 680 kB | `bucket` | ~294 | ~107k, scales with operator count | **PARTITION NOW** |
| security_events | 228 | 248 kB | `created_at` | <10 | <5k | DO NOT PARTITION |
| ai_runs | 189 | 240 kB | `created_at` | <10 | usage-driven | PREPARE, NOT YET |
| ai_usage_events | 164 | 304 kB | `occurred_at` | <10 | usage-driven | PREPARE, NOT YET |
| ai_usage_logs | 148 | 176 kB | `created_at` | <10 | usage-driven | PREPARE, NOT YET |
| seo_crawl_observations | 156 | 488 kB | `observed_at` | crawl-driven | deliberately deduplicated in Phase 2 | DO NOT PARTITION |
| seo_crawl_url_membership | 201 | 160 kB | `created_at` | crawl-driven | bounded by retention latest-N | DO NOT PARTITION |
| ai_agent_runs | 49 | 256 kB | `created_at` | <5 | small | DO NOT PARTITION |
| background_jobs | 28 | 120 kB | `created_at` | queue-sized, self-pruning | small | DO NOT PARTITION |
| audit_logs | 18 | 48 kB | `created_at` | <5 | small | DO NOT PARTITION |
| business_metrics_hourly | 7 | 80 kB | `bucket` | 24/day max | ~9k | DO NOT PARTITION |
| channel_inbound_events / channel_delivery_attempts / bot_visits / conversation_events | 0 | <50 kB | — | no production traffic yet | DO NOT PARTITION |

### Classification

**A. PARTITION NOW** — `workspace_health_snapshots`, `operator_activity_samples`.
Both are pure append-only telemetry, written by a ticker rather than by user
action, so their volume is a function of uptime and operator count, not of
customer behaviour. They are the only two tables in the database whose daily
insert rate is already in the hundreds. They are also the *cheapest* moment to
convert: a few thousand rows copy in well under a second inside one
transaction, which is impossible once they hold tens of millions.

**B. PREPARE BUT DO NOT PARTITION YET** — `ai_usage_events`, `ai_runs`,
`ai_usage_logs`. These will grow with AI adoption, but today they hold a few
hundred rows each, and they are financially coupled (`ai_run_settlements`,
`ai_usage_event_conflicts`). Partitioning them now would mean rewriting keys on
billing-adjacent data with no measurable benefit. The partition infrastructure
in migration 176 is generic: adding one of them later is a single migration
following the 178/180 pattern.

**C. DO NOT PARTITION** — everything else above. Having a timestamp column is
not a reason to partition. `seo_crawl_observations` in particular is already
bounded by the Phase 2 deduplication work (201 legacy pages → 156 observations),
and the SEO crawl tables are bounded by the latest-N retention policy.

Financial/ledger tables (`billing_*`, `ai_run_settlements`) were explicitly
excluded — no evidence justifies touching them.

---

## 2. Migrations

| # | Responsibility |
|---|---|
| **176** `partition_infrastructure` | 8 `SECURITY DEFINER`, `service_role`-only functions: `partition_managed_tables`, `partition_ensure_month`, `partition_ensure_future`, `partition_ensure_all`, `partition_inventory`, `partition_exact_count`, `partition_health`, `partition_retention_candidates`. |
| **177** `partition_discovery_fix` | Corrects `partition_managed_tables()`: `pg_partitioned_table.partattrs` is an `int2vector`, which is **0-indexed**, so `partattrs[1]` found nothing. Caught by the first partitioning attempt failing loudly rather than silently mis-reporting. |
| **178** `partition_workspace_health_snapshots` | Converts `workspace_health_snapshots` to monthly RANGE on `captured_at`. |
| **179** `partition_rls_hardening` | Enables RLS on every partition (existing and future) and revokes `anon`/`authenticated` on them. |
| **180** `partition_operator_activity_samples` | Converts `operator_activity_samples` to monthly RANGE on `bucket`. |
| **181** `retention_partition_integration` | Read-only `retention_partition_preview(policy_key)` linking partitions to the retention system. |

---

## 3. Migration results (production)

| Table | Rows before | Rows after copy | Default-partition rows | Duplicate IDs | Rollback copy |
|---|---|---|---|---|---|
| workspace_health_snapshots | 2,262 | 2,262 | 0 | 0 | `workspace_health_snapshots_legacy` |
| operator_activity_samples | 1,290 | 1,290 | 0 | 0 | `operator_activity_samples_legacy` |

Each migration validates itself **inside the transaction** and aborts on any
mismatch of: row count, `min`/`max` timestamp, distinct workspace count,
duplicate IDs, or any row landing in the DEFAULT partition. Nothing was
deleted; the pre-partitioning tables were renamed, not dropped.

Live writes have continued into the partitioned tables since the swap
(2,282 and 1,297 rows at the time of writing, versus 2,262/1,290 copied), with
DEFAULT still at 0 — the running application is routing correctly with no code
change.

### Key and constraint preservation

PostgreSQL requires every unique constraint on a partitioned table to include
the partition key. Handled without weakening anything:

* `workspace_health_snapshots`: primary key `(id)` → `(captured_at, id)`.
  No table references it by foreign key, and no code looks a snapshot up by
  `id` alone.
* `operator_activity_samples`: primary key `(id)` → `(bucket, id)`. The
  **business** uniqueness rule, `UNIQUE (workspace_id, user_id, bucket)`, is
  preserved exactly as-is, because `bucket` is the partition key. The heartbeat
  `UPSERT … onConflict: workspace_id,user_id,bucket` is unchanged.

No unique constraint was dropped or relaxed. RLS policies, grants, defaults and
`gen_random_uuid()` behaviour were recreated identically on the new parents.

---

## 4. Partition layout

```
workspace_health_snapshots            (RANGE on captured_at)
├── workspace_health_snapshots_2026_09   ← all 2,262 migrated rows
├── workspace_health_snapshots_2026_10
├── workspace_health_snapshots_2026_11   ← current month
├── workspace_health_snapshots_2026_12
├── workspace_health_snapshots_2027_01
└── workspace_health_snapshots_default   ← 0 rows (safety net)

operator_activity_samples             (RANGE on bucket)
├── operator_activity_samples_2026_09 …  current month + 2 ahead
└── operator_activity_samples_default    ← 0 rows (safety net)
```

Future partitions are created automatically by the retention worker on every
tick (`ensureFuturePartitions`, current month + 2). A missing future partition
can therefore never break an insert — and even if creation failed entirely, the
DEFAULT partition accepts the row and the diagnostics raise it as critical.

### Indexes

| Index | Query it serves |
|---|---|
| `workspace_health_snapshots (workspace_id, captured_at DESC)` | workspace health timeline for a date range |
| `operator_activity_samples (workspace_id, bucket DESC)` | workspace online-time report |
| `operator_activity_samples (user_id, bucket DESC)` | per-operator activity timeline |

The old standalone `(bucket)` index was deliberately **not** recreated:
partition pruning now bounds time-range scans for free, so it would be a
redundant index on the hottest write path. BRIN was evaluated and rejected —
these tables are far below the size where BRIN beats a btree.

---

## 5. Query plans — pruning verified

```
EXPLAIN ANALYZE
SELECT id, captured_at FROM workspace_health_snapshots
WHERE workspace_id = $1 AND captured_at >= '2026-11-01' AND captured_at < '2026-12-01'
ORDER BY captured_at DESC LIMIT 50;

→ Seq Scan on workspace_health_snapshots_2026_11   (1 of 6 partitions scanned)
```

Only the single matching month is opened; the other four months and the DEFAULT
partition are pruned at planning time.

```
… WHERE workspace_id = $1 AND captured_at >= '2026-09-01' AND captured_at < '2026-10-01' …

→ Index Scan using workspace_health_snapshots_2026_09_workspace_id_captured_at_idx
  Index Cond: (workspace_id = … AND captured_at >= … AND captured_at < …)
  Execution Time: 1.379 ms
```

Pruning **and** the composite index are both used: one partition, one index
scan, no sequential scan of the data month.

---

## 6. Retention integration

`retention_partition_preview(policy_key)` reports the whole months a policy
would cover — partition name, range, estimated rows, estimated bytes — so the
eventual lifecycle is DETACH/DROP of a month rather than DELETE of millions of
rows.

It is read-only by construction. There is **no** drop or detach function
anywhere in this phase, in SQL or in TypeScript. The SQL function returns an
empty result, independently of the application layer, when the policy is:

* `permanent`, or in the `financial`/`core` category, or
* on a `billing_*` table or any table in the protected list, or
* disabled, or
* has no retention window.

The two telemetry policies were also corrected: `workspace_health_snapshots`
pointed at a `created_at` column that does not exist on that table (so the
row-based path could never have worked), now `captured_at`;
`operator_activity_samples` now `bucket`. Both record their `partition_column`.
Both remain **disabled**.

---

## 7. Partition manager

One component: `server/services/retention/partitionService.ts`. It is the only
caller of the partition DDL functions — no worker or route builds partition SQL
itself. Responsibilities: discover managed tables, create future monthly
partitions (idempotent), detect missing partitions, detect rows in DEFAULT,
report sizes and oldest/newest, and produce retention candidates.

It runs on the existing retention worker tick, before the retention sweep and
in its own try/catch, so a slow or failing retention run can never delay
partition provisioning.

---

## 8. Super Admin visibility

Super Admin → Data Retention → **Partitions** (`PartitionsPanel.tsx`), fully
translated in FA / EN / TR. Per table: partition count, current partition, next
partition ready yes/no, oldest, newest, total rows, total size, largest
partition, DEFAULT partition rows, retention policy, cleanup on/off, and a
health badge with the specific issues listed.

Actions, all safe: *Create missing future partitions*, *Create missing months*
(single table), *Validate layout*, *Dry run retention*. There is no Drop
Partition control.

### Monitoring

`validatePartitionLayout()` emits the alert codes consumed by both the worker
log and the admin badge: `rows_in_default_partition` (critical),
`next_partition_missing` (critical without a DEFAULT, warning with one),
`no_partitions`, `current_partition_missing`, `oversized_partition`.

---

## 9. Validation

| Check | workspace_health_snapshots | operator_activity_samples |
|---|---|---|
| Missing rows | 0 | 0 |
| Duplicate IDs | 0 | 0 |
| Duplicate `(workspace_id, user_id, bucket)` | n/a | 0 |
| Rows in DEFAULT partition | 0 | 0 |
| Timestamp range preserved | yes | yes |
| Workspace distribution preserved | yes | yes |
| RLS enabled on parent + every partition | yes | yes |

---

## 10. Tests

* `server/services/retention/partition.test.ts` — **14 new tests**: health
  derivation (healthy / missing next month with and without DEFAULT / rows in
  DEFAULT / no partitions), alert parity between worker and UI, idempotent
  creation, single-table targeting, preview behaviour for protected and
  disabled policies, RPC failures surfacing instead of reporting "no
  candidates", and an explicit assertion that the service never issues a
  drop/detach/truncate/delete call.
* `server/services/retention/*` — **21 passed**.
* SEO + retention suites — **107 passed**, unchanged by this phase.
* Monthly routing, month boundaries and idempotent creation are validated
  against production by migrations 178/180, which abort on any mismatch.
* Typecheck clean; production build OK.
* Full-suite run: 4,817 passed / 89 failed. Every failure is in unrelated,
  pre-existing areas (AI-agent instruction pages, billing entitlement tests,
  Super Admin branding i18n) and none touches retention, partitioning or SEO.

---

## 11. Destructive cleanup

Still disabled. The only enabled retention policies are the 13 `permanent`
ones, which delete nothing by definition. No partition has been detached or
dropped, no legacy table has been dropped, and no drop/detach code path exists.
`workspace_health_snapshots_legacy` and `operator_activity_samples_legacy` are
retained as rollback copies.
