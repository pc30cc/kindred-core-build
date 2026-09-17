# Analytics Storage — Database Audit

What Web Analytics storage keeps in PostgreSQL, and what it stopped keeping.

The rule this audit is written against: **analytics stores and reads data;
it is not a system that records its own history.** The database holds the
configuration needed to find the data and the minimum state needed to keep
it correct. Everything else is computed when asked and returned to the
caller.

---

## 1. Required — what PostgreSQL still holds

### 1.1 `app_runtime_config` → key `analytics_storage_pool`

One row. The topology, without which nothing can find the objects.

| Field | Why it cannot be computed |
|---|---|
| `enabled` | Whether analytics writes to object storage at all |
| `primary` | Which vendor holds the canonical objects |
| `replicas` | Which vendors mirror them |
| `replicationEnabled` | Whether mirroring is on |
| `prefix` | The namespace objects are written under |
| `knownPrefixes` | Every prefix ever used — **a deletion requirement**: a workspace purge must find objects written under an old prefix, or they survive the deletion |
| `batchRows`, `batchBytes`, `flushIntervalMs` | Operator-tuned batching |
| `format` (`parquet`), `compression` (`zstd`) | Declared so the wire shape is stable |
| `writeMode`, `readMode` | Which phase the migration is in |
| `revision` | Compare-and-set token — a concurrency guard, not a write counter |
| `replicaState[vendor]` | See below |

`replicaState` is four fields per replica, and only because **promotion
correctness depends on them**:

- `syncedAt` / `syncedFrom` — proven to hold everything the current primary
  holds. Promoting a replica without this loses data.
- `dirtyAt` — a known replication gap. *When* it happened is kept; *why* is
  not. There is no reason string and no error string.
- `sync` — a resumable walk's cursor, so a bounded sync can continue.

**No credentials.** The pool names vendors; the credentials stay in the
general storage pool and are never duplicated or returned to the browser.

### 1.2 `analytics_day_seals`

One row per workspace-day, recording **one fact: this day is canonical**
(the batch layer replaced the speed layer's objects). Without it, the
sealing pass rebuilds the same day forever.

`sealed_at` is the only column any code reads — the sealing pass issues one
SELECT, for `workspace_id, day, sealed_at`. As of migration
`20260917090000` it is also the only column written.

### 1.3 The source tables — unchanged

`visitor_sessions`, `visitor_page_views`, `web_analytics_events`,
`web_analytics_funnels`. These are the analytics data itself, written by
the existing PostgreSQL path exactly as before. **Nothing in this work
stops, alters, or deletes any of them.**

---

## 2. Removed — what no longer touches the database

### 2.1 Per-flush and per-failure telemetry

| Removed | Was |
|---|---|
| `record_analytics_storage_write` | A PostgreSQL write on **every flush**, incrementing `objectsWritten` / `rowsWritten` / `bytesWritten` and stamping `lastWriteAt` / `lastReplicationAt` |
| `record_analytics_storage_error` | A PostgreSQL write on **every failure**, storing `lastError` / `lastErrorAt` |

Both SQL functions remain in the database — nothing is dropped. No code
calls them, and the test double now **throws** if anything does, so a write
path that starts reporting itself again fails the suite instead of passing
quietly.

Fields gone from the pool record: `objectsWritten`, `bytesWritten`,
`rowsWritten`, `bufferedRows`, `lastWriteAt`, `lastReplicationAt`,
`lastError`, `lastErrorAt`, and the whole `s3Read` block (`queries`,
`failures`, `lastQueryAt`, `lastQueryMs`, `lastError`, `lastErrorAt`).

### 2.2 Parity state

`analytics_parity_state` (a runtime-config key), `persistParity()` and
`readParityState()` are gone. A parity run is a question asked and answered
in the moment: it reads both stores, compares, and **returns** the result.
It writes nothing. The suite asserts this directly — a run that leaves any
new key behind fails.

`shadowCompare()` is gone from the customer request path entirely. No
customer-facing read (overview, funnel results, anything else) triggers a
comparison as a side effect.

### 2.3 Instance census

`analytics_instance_census`, `recordAnalyticsInstance()`,
`readAnalyticsInstances()`, `acknowledgeMultiInstanceDurability()` and the
heartbeat that fed them: removed. Backend instances no longer register
themselves in the database.

### 2.4 Readiness checklist

`server/services/analytics/readiness.ts` and the Cutover Readiness card are
removed. The checklist was assembled from stored history — seal counts,
parity age, instance count, error state — which is exactly what analytics
no longer keeps.

The two signals underneath it that still matter did not go away; they moved
to `analyticsRuntimeGuards.test.ts`, which pins that ZSTD support, the query
engine, and the spool directory each **report** their absence rather than
throwing.

### 2.5 Day-seal bookkeeping

Six columns stopped being written (migration `20260917090000`):
`attempts`, `last_error`, `row_count`, `objects_written`,
`source_row_count`, `verified`. Four fed the deleted readiness card; the
other two were a retry counter and a vendor error string.

A failed rebuild now writes **nothing at all**, rather than a row carrying
an error. The day is simply still unsealed, which is what makes the next
cycle retry it.

Verification did not stop — `sealWorkspaceDay` still compares rebuilt rows
against the source and returns `verified`, `rows` and `sourceRows` to its
caller. The result is reported, not recorded.

### 2.6 Logging and metrics

`emitLog` and `emitMetric` have **zero references** in
`server/services/analytics/` and `server/services/webAnalytics/store/`.

### 2.7 Backfill and verification

Neither writes to the database. Backfill issues SELECTs against the source
tables and writes Parquet objects; `parity.ts` opens no database client at
all. Both return their results to the caller in the moment.

---

## 3. No new tables

No table was created for logging, metrics, health, history or monitoring.
Specifically absent: `analytics_logs`, `analytics_metrics`,
`analytics_health`, `analytics_history`, `analytics_events_log`,
`analytics_query_logs`, `analytics_parity_history`,
`analytics_backfill_history`.

Two tables were created across this work, both before this simplification:

- `analytics_day_seals` — batch-layer bookkeeping, now one fact per row
- (no other)

`analytics_storage_pool` is a **key in the existing `app_runtime_config`
table**, not a table.

---

## 4. Nothing destructive

Per the standing constraints, this work does **not**:

- drop any table, column or SQL function
- delete any historical row
- stop any PostgreSQL write on the source tables
- enable `writeMode: s3_only`
- enable `readMode: s3`

Columns and functions that stopped being written keep whatever the previous
build recorded. They are still there to read; they only stop accumulating.
