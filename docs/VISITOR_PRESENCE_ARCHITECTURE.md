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
* A workspace with more than `VISITOR_PRESENCE_MAX_CANDIDATES` durable
  candidates in the window truncates the candidate list; those beyond the cap
  fall back to their stored status.
