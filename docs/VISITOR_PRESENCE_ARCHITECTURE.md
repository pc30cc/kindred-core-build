# Visitor Presence Architecture (Realtime-First, v2)

Companion to `docs/REALTIME_REGRESSION_CHECKLIST.md`. Operator presence was
migrated first; this document covers **visitor** presence, which has the same
shape but far higher cardinality (one row per anonymous browser tab).

## Architecture

```text
widget tab ──POST /api/realtime/visitor-presence──> backend
                    (session id verified against the HttpOnly visitor cookie)
                <── ws_url + connection token + subscription token
                    + presence_lease (HMAC, short TTL, bound to this session)
                    channel = vp:v2:{workspace_id}:{session_id}
widget tab ══ open WebSocket subscription ══> Centrifugo

widget heartbeat ──> presence_lease ──> backend skips the liveness write
                                        (no lease ⇒ it writes as before)

operators ──> listVisitorIntelligence()
                └─ candidates from Postgres (durable rows in the window)
                └─ resolveVisitorPresenceForSessions(candidates)
                      └─ ONE batched presence_stats call per 100 candidates
```

## Why v2

v1 sharded visitors into `vp:{workspace}:{shard}` and discovered the online set
by scanning all 16 shards. Discovery cost then grew with the number of online
visitors, and the shard payload grew unboundedly on a busy workspace.

v2 inverts the direction: **Postgres proposes, Centrifugo confirms.**

* One channel per session, so a read returns a count, not a member list.
* Candidates come from durable rows (creation, navigation, messages) inside a
  6-hour window — no liveness writes needed to stay discoverable.
* Realtime is asked only "are these K sessions connected?", batched 100 per
  call. Read cost scales with the page the operator is looking at, never with
  the workspace's traffic.

## Source of truth

| Question | Authority |
| --- | --- |
| Which sessions might be here? | Postgres (`visitor_presence` / `visitor_sessions` recency) |
| Is this candidate connected right now? | Centrifugo channel client count (realtime mode) / `visitor_presence.status` (database mode) |
| Which mode is this workspace in? | `resolveVisitorPresenceMode()` — control-plane resolver, never a bare `enabled` flag |
| May this heartbeat skip its write? | The per-session `presence_lease`, verified server-side |
| What page are they on, what did they do? | Postgres — always |

There is exactly one resolver. The Visitors list and
`/api/visitors/presence-by-conversation` both go through
`resolveVisitorPresenceForSessions()` + `applyVisitorPresence()`.

## Write discipline is per session, not per workspace

A workspace-wide "realtime is healthy" flag suppressed writes for every visitor,
including those whose socket never opened — they aged out and vanished. The
lease fixes this: it is issued only when the subscription is actually
established, is bound to `{workspace_id, session_id}`, is HMAC-signed and
short-lived, and is dropped by the widget the instant ownership is lost. No
lease ⇒ the heartbeat writes exactly as in database mode.

The widget re-negotiates ~60s before the earliest of token or lease expiry, and
re-checks on `visibilitychange` because a backgrounded tab's timers are
throttled.

## Bounded failover

Presence reads use `resolveCentrifugoApiEndpoints()`: cluster endpoint first,
then healthy enabled nodes. A failed batch retries **one** alternate endpoint,
then the workspace drops to database mode. No unbounded fan-out over nodes.

## Never a false offline

* Batch read fails on all attempted endpoints → `database` mode, liveness
  writes resume (with a jittered fallback TTL so a fleet does not fail back in
  lockstep).
* A per-channel error inside a successful batch → the result is marked
  non-authoritative and the stored status is kept.
* Absent from presence but with a fresh row inside the 45s handoff window →
  `unknown`. Only an aged row resolves to `offline`.

## Multi-tab, failure, recovery

* **Multi-tab** — tabs of one session share one channel; the client count is
  ≥1 until the last tab closes.
* **Node failure** — the socket closes, the lease is dropped immediately
  (heartbeats resume), the widget re-negotiates with jittered backoff capped at
  30s and may land on another node.
* **Redis failure** — cross-node counts degrade; a read failure drops the
  workspace to database mode rather than emitting false offline.
* **Recovery** — the fallback lease expires, mode resolution returns
  `realtime`, heartbeats go quiet again.

## What did not change

`visitor_touch_liveness` and its migration are untouched; only caller behaviour
changed. Redis remains realtime infrastructure, never an application database.

## Verification

* `bunx vitest run server/services/visitors server/services/realtime`
  — 57 unit tests: v2 channel parsing, one-batch-per-100 bounded reads, refusal
  to enumerate the online set, cache reuse, single-alternate-endpoint retry,
  database fallback, no-false-offline handoff, multi-tab, lease binding and
  expiry, and the write-discipline counters.
* `npm run test:realtime:cross-node` — real Redis + two Centrifugo nodes.
  Requires `redis-server` and the `centrifugo` binary on PATH; it cannot run in
  the build sandbox, so cross-node counts must be re-verified on a host that
  has them.

## Remaining risks

* The cross-node integration test has not been executed in this environment
  (no `redis-server`/`centrifugo` binaries available).
* `server/routes/visitors.ts` `/track`, `/disconnect` and `/network/batch`
  still write `visitor_presence` directly. These are lifecycle/business writes
  rather than periodic liveness ticks, so they do not scale with connection
  time, but they are not routed through the lease gate (`/heartbeat` is).
* A workspace with more than `VISITOR_PRESENCE_MAX_CANDIDATES` candidates
  truncates the candidate list; those beyond the cap
  fall back to their stored status.

## Token/lease renewal without reconnect

The widget renews its Centrifugo connection token, subscription token and
presence lease **in place** over the live socket (`refresh` + `sub_refresh`),
scheduled ~60s before the earliest expiry. The socket is dropped only when the
cluster hands out a different node (`ws_url` changed), when Centrifugo rejects
the renewal, or when realtime stops being authoritative for the workspace. A
healthy visitor therefore keeps one connection for the whole visit instead of
reconnecting once per token TTL.

## Candidate discovery (why an idle visitor does not vanish)

The operator list is the union of two disjoint candidate sources, resolved by
one batched `presence_stats` read:

1. **PostgreSQL, short recency window** — sessions with a recent *durable*
   write (creation, navigation, message). These writes exist for business
   reasons and are not periodic.
2. **Ephemeral candidate index** — sessions holding a live presence lease but
   silent for hours.

The index is never PostgreSQL. A per-session periodic `UPDATE`, whatever it is
called, is a heartbeat: at 1M connected visitors even a 10-minute cadence is
~1.6k writes/second carrying no business fact, and it makes an idle visitor
look freshly active because `visitor_presence.updated_at` is what the UI reads
as recency.

```
MODE 2 / MODE 3 (app_routed_redis, load_balanced_redis)
  Centrifugo            → presence truth
  Redis/Valkey          → ZSET  vp:index:{workspace_id}
                            member = session_id
                            score  = lease_expires_at (epoch ms)
  PostgreSQL            → durable/business data ONLY

MODE 1 (single_memory, small deployments)
  Centrifugo            → presence truth + `channels` scan for discovery
```

Writes happen only on presence negotiation and in-place lease renewal
(`ZADD`), never on a timer. Stale members expire by score, so no reliable
disconnect event is required, and a member whose socket actually died is
corrected by `presence_stats = 0` — Redis is a discovery index, not truth.

The `channels` scan is restricted to Mode 1 on purpose: Centrifugo returns
every matching active channel with no pagination, which is unacceptable for
large deployments.

Configuration: `VISITOR_CANDIDATE_INDEX_REDIS_URL`, falling back only to
`REALTIME_REDIS_URL` (the realtime engine's own Redis, which this index is
designed to share). A generic `REDIS_URL` is deliberately NOT accepted, so
presence discovery can never drift into an unrelated cache/job instance.

Index memory is bounded on the WRITE path: at most once per workspace per
45 s a renewal also runs `ZREMRANGEBYSCORE key -inf now` and refreshes the
24 h safety TTL. GC therefore does not depend on an operator opening the
Visitors page, and the steady-state cost of a renewal stays a single `ZADD`.

Discovery is a TRUE UNION: live indexed candidates and recent durable rows
are merged BEFORE the final `limit`, with indexed candidates taking the
slots first. A visitor silent for hours but still holding a lease cannot be
pushed out of the page by `limit` merely-recent rows. When no index can answer — Mode 2/3
without a Redis URL, or Redis momentarily unreachable — discovery degrades to
the wide durable window (`CANDIDATE_WINDOW_MS`, 6h) so no visitor is lost;
it never degrades into periodic writes.

Invariant while realtime is healthy:

```
Periodic PostgreSQL liveness writes  = 0
Periodic PostgreSQL candidacy writes = 0
```

The client is `server/lib/redisClient.ts`, a ~200-line RESP2 client with a
per-command timeout and a failure cooldown — no new runtime dependency, and
every failure mode degrades to "no index" rather than to wrong data.

## Provider health is topology-aware

`resolveRealtimeProvider()` no longer decides Centrifugo's health from the
single cluster-level `api_url`. When the node registry has nodes (Mode 2/3),
the provider is usable if **at least one enabled node is not `down`** in the
node-health registry; `healthy` requires all of them. Only a registry-less
(Mode 1) deployment falls back to probing `api_url` directly.

## Cross-node proof

`scripts/realtime/cross-node-integration.ts` covers `vp:v2` end to end against
two real Centrifugo nodes on a shared Redis engine: a visitor subscribed on
node 2 is counted by a batched `presence_stats` read issued on node 1, the
visitor cannot read presence itself (namespace forbids it), and the count
returns to 0 on disconnect.
