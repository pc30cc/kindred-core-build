# Analytics Storage — Phase 3A Result

Status of each component, and whether Phase 3B may begin.

Nothing in this document is stored in the database. Every number was
measured by running the thing, and is reported here only.

---

## Verdict

# NOT READY FOR PHASE 3B

**Reason: the production environment could not be reached.**

This is not a failure of the code. Every component below passes on a real
runtime against real object storage and a real embedded query engine. What
is missing is the one thing that cannot be substituted: **verification
against the actual WebYar production deployment and its actual Analytics
Primary vendor.**

Per the standing instruction — *"if production is not reachable, do not stop
the phase, but the verdict must be NOT READY — production environment
unavailable; do not pass off any artificial validation as production
validation"* — the verdict is NOT READY, and none of the measurements below
are offered as production evidence.

### What was tried

| Probe | Result |
|---|---|
| `https://api.webyar.ai/internal/channels/ready` | `401` + `{"error":"Unauthorized","reason":"missing_credential"}` — this is **our** application responding, so the real backend is alive |
| `https://api.webyar.ai/api/admin/providers/analytics-storage` | `401 {"error":"Not authenticated"}` |
| `https://api.webyar.ai/api/admin/this-route-does-not-exist` | `401 {"error":"Not authenticated"}` — an unknown admin route answers identically, so **auth fires before routing**; the 401 says nothing about whether the endpoint exists |
| `https://webyar.ai` | Serves a different application (`tanstack_start_ts`), not this codebase |

Because every `/api/admin/*` path is rejected before routing, the production
Analytics Primary's **identity is unknown** from here. Which vendor it is,
whether it is configured, and whether SigV4 round-trips against it cannot be
determined without Super Admin credentials.

### What Phase 3B needs before it can start

1. Super Admin access to the production backend, or an operator running
   `scripts/analytics-production-verify.mjs` inside the production
   environment and reporting its output.
2. A live `PUT` / `GET` / `LIST` / `DELETE` round trip against the **real**
   Analytics Primary under `analytics/_health/workspace=<uuid>/year=…/…`,
   with the Hive-style `=` in the key. This is the specific thing that
   MinIO cannot stand in for — see the SigV4 note below.
3. A real historical backfill over real workspace data, and a parity run
   comparing it against PostgreSQL.

---

## Component status

### Primary — **verified on a real vendor, not on production's vendor**

Real S3-compatible round trips succeed: PUT, GET-back, LIST and DELETE
against Hive-partitioned keys.

**A real bug was found and fixed here.** SigV4 signs the percent-encoded
path, and the driver was sending `workspace=<uuid>` literally while signing
something else. Every analytics write to every S3 vendor returned
`403 SignatureDoesNotMatch`. It survived two phases because the existing
suites stubbed `fetch` and asserted on *which bucket* was reached, never on
whether the signature was valid.

`src/test/storage/s3SignatureCanonicalization.test.ts` now recomputes the
signature independently and rejects on mismatch, exactly as a server does —
and its first test tampers with a signature to prove the stub really
verifies. 16 tests.

This is precisely why production verification matters: the bug was invisible
to every test that did not talk to something that checks signatures.

### Replicas — verified

Mirror writes, dirty marking on failure, bounded resumable sync walks, and
the promotion gate (a replica that has not been proven complete cannot be
promoted; a forced promotion says so explicitly). A failing replica does not
compromise the primary, and a healthy sibling is unaffected.

### DuckDB — verified

`@duckdb/node-api` loads on the target runtime. Node `v22.23.2`,
`zstdCompressSync` present.

### Spool — verified under real process death

Crash tests run against real containers, not simulated failures:

| Scenario | Result |
|---|---|
| `SIGKILL` (exit 137) | replayed exactly once |
| `SIGTERM` (exit 0) | replayed exactly once |
| `docker restart` / container destroyed | replayed exactly once from the named volume |

Measured ingestion (this run, on the VPS):

| Rate | p50 | p95 | p99 | max | bytes/event |
|---|---|---|---|---|---|
| 100/s | 0.112 ms | 0.429 ms | 3.988 ms | 3.988 ms | 774.9 |
| 500/s | 0.077 ms | 0.237 ms | 5.296 ms | 7.279 ms | 779.3 |
| 1000/s | 0.055 ms | 0.139 ms | 0.350 ms | 3.202 ms | 779.7 |

Capacity, from the **measured** frame size (780.4 bytes), at the 2 GiB
default and 2× safety:

| Rate | Outage survived |
|---|---|
| 100/s | 3.82 h |
| 500/s | 0.76 h |
| 1000/s | 0.38 h |

To survive a 24-hour outage: **12.6 GiB** at 100/s, **62.8 GiB** at 500/s,
**125.6 GiB** at 1000/s. Sizing is configurable via
`ANALYTICS_SPOOL_MAX_BYTES`; see `docs/DEPLOYMENT.md`.

### Parity — verified, and now stateless

Both sides run for real: PostgreSQL through the real report service, S3
through real Parquet and real DuckDB. The runner detects an intentional
divergence as intentional and an undeclared one as a regression.

It no longer persists anything, and it no longer runs automatically on any
customer request path.

### Backfill — verified, and now stateless

Rebuilds a workspace-day from the source tables, replaces the speed layer's
objects with a canonical set, and verifies the rebuilt row count against the
source. Idempotent: sealing twice leaves exactly one canonical set.

This run: 90 days rebuilt in 3757 ms → 90 objects, 661045 bytes, 27720
source rows.

Erasure: `unsealDays` clears the seal so a redacted day is rebuilt from the
post-erasure source, which is what makes deletion actually reach the object
layer.

### Query performance — measured

| Window | Objects scanned | Bytes fetched | Total |
|---|---|---|---|
| 1 day | 1 | 7,323 | 422 ms |
| 7 days | 7 | 51,219 | 446 ms |
| 30 days | 30 | 220,273 | 677 ms |
| 90 days | 90 | 661,045 | 1888 ms |

Partition pruning is exact — a 30-day window opens 30 objects, not 90.

---

## Test and typecheck state

| Check | Result |
|---|---|
| `src/test/analytics` + `src/test/storage` | **756 passed / 756**, 46 files |
| Frontend typecheck (`tsconfig.json`) | **0 errors** |
| Server typecheck (`tsconfig.server.json`) | 16 errors — **identical to the pre-analytics baseline at `4ee9078`**, same 5 files, all in `worker/*` and `backupAgent.ts`, none touched by this work |

The server baseline was established by checking out `4ee9078` in a separate
worktree on the same machine with the same `node_modules` and running the
same command. The cause is two copies of `@supabase/supabase-js` (root and
`server/node_modules`), which predates all analytics work.

---

## Constraints honoured

- `writeMode: s3_only` — **not enabled**; the admin route refuses it with
  `409 phase_locked`, asserted in `analyticsStorageIsolation.test.ts`
- `readMode: s3` — **not enabled**; same refusal, same assertion
- PostgreSQL writes on the source tables — **untouched**
- No table, column or function dropped
- No historical data deleted
