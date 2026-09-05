# Visitor Presence Architecture (Realtime-First, Phase 2)

Companion to `docs/REALTIME_REGRESSION_CHECKLIST.md`. Operator presence was
migrated first; this document covers **visitor** presence, which has the same
shape but far higher cardinality (one row per anonymous browser tab).

## Architecture — before

```text
widget tab ──heartbeat every 60s──> POST /api/widget/action
                                       └─> RPC visitor_touch_liveness()
                                             └─> UPDATE visitor_presence
                                             └─> UPDATE conversations.updated_at
operators ──poll──> SELECT visitor_presence WHERE updated_at > now()-30min
```

Every connected visitor produced a write every 60 seconds, forever, whether or
not anything changed. Postgres was the presence store, the liveness clock, and
the fan-out point at the same time.

## Architecture — after

```text
widget tab ──POST /api/realtime/visitor-presence──> backend
                    (session id verified from the HttpOnly visitor cookie)
                <── ws_url + connection token + subscription token
                    channel = vp:{workspace_id}:{shard}, subject = vs_{session_id}
widget tab ══ open WebSocket subscription ══> Centrifugo (membership = presence)

operators ──> listVisitorIntelligence()
                └─> resolveVisitorPresence()   (central resolver)
                      ├─ realtime mode: read the needed shards via admin API
                      └─ database mode: read visitor_presence as before
```

Membership of a presence shard **is** the liveness signal. While the
subscription is live, the widget stops sending liveness heartbeats entirely;
navigation still posts, because a page view is durable business data rather
than a liveness ping.

## Source of truth

| Question | Authority |
| --- | --- |
| Is this visitor connected right now? | Centrifugo shard membership (realtime mode) / `visitor_presence.status` (database mode) |
| Which mode is this workspace in? | `resolveVisitorPresenceMode()` — control-plane resolver, never a bare `enabled` flag |
| What page are they on, what did they do? | Postgres (`visitor_presence.current_page`, `visitor_page_views`) — always |

There is exactly one resolver. No surface reads Centrifugo presence or
interprets `visitor_presence.status` on its own: the Visitors list and
`/api/visitors/presence-by-conversation` both go through
`resolveVisitorPresence()` + `applyVisitorPresence()`.

## Sharding

Channels are `vp:{workspace_id}:{shard}` with `shard = hash(session_id) % 16`.

* Reading a specific set of sessions touches only their shards.
* Discovering the whole online set costs 16 admin calls, not one per visitor —
  and results are cached briefly, so operator polling does not fan out.
* Shards are workspace-scoped. There is no global `visitors:all` channel, and
  `channelBelongsToWorkspace()` deliberately rejects `vp:` so the generic widget
  subscribe endpoint cannot mint a presence-shard token.

Centrifugo namespace `vp` sets `allow_presence_for_client: false`,
`join_leave: false`, `history_size: 0`: visitors share a shard, so only the
backend (admin API key) may enumerate members.

## Healthy realtime flow

1. Widget tracks, receives its session id (identity stays in the HttpOnly cookie).
2. Widget negotiates presence; backend derives channel + subject from the
   verified session and signs both tokens.
3. Subscription opens → the widget suppresses liveness heartbeats.
4. Operators resolve presence from shard membership. No visitor liveness writes
   occur; `db_liveness_writes_while_realtime_healthy` stays at 0.

## Database fallback flow

Any shard read failure, unhealthy provider, disabled presence, or non-Centrifugo
vendor puts the workspace into `database` mode:

* `shouldWriteVisitorLiveness()` starts returning `true`, so widget heartbeats
  resume writing `visitor_presence` (with a jittered TTL, so a whole fleet does
  not fail back in lockstep).
* Reads fall back to `visitor_presence`.
* A visitor is **never** reported offline because realtime failed. Absent from
  presence but with a fresh row inside the 45s handoff window resolves to
  `unknown`; only an aged row resolves to `offline`.

## Multi-tab, failure, recovery

* **Multi-tab** — every tab is its own Centrifugo client but shares the subject
  `vs_{session_id}`, so presence dedups to one visitor and closing one tab does
  not take the session offline.
* **Node failure** — the socket closes, the widget re-negotiates with jittered
  backoff (capped at 30s) and may be routed to a different node; membership is
  Redis-shared in Modes 2/3, so operators keep seeing the visitor.
* **Redis failure** — cross-node membership degrades, shard reads become
  partial or fail, and the resolver drops to database mode rather than emitting
  false offline.
* **Recovery** — the fallback lease expires, the next mode resolution returns
  `realtime`, heartbeats go quiet again.

## What did not change

`visitor_touch_liveness` and its migration are untouched; only caller behaviour
changed (in realtime mode it is invoked with a very large minimum interval so it
coalesces instead of writing, and `conversations.updated_at` is not bumped).
Redis remains realtime infrastructure, never an application database.

## Verification

* `bunx vitest run server/services/visitors server/services/realtime`
  — 55 unit tests, including sharding bounds, bounded fan-out, cache reuse,
  fallback on read failure, no-false-offline handoff, multi-tab, and the
  write-discipline counters.
* `npm run test:realtime:cross-node` — real Redis + two Centrifugo nodes.
  Requires `redis-server` and the `centrifugo` binary on PATH; it cannot run in
  the build sandbox, so cross-node membership must be re-verified on a host that
  has them.

## Remaining risks

* The cross-node integration test has not been executed in this environment
  (no `redis-server`/`centrifugo` binaries available).
* `server/routes/visitors.ts` `/track`, `/disconnect` and `/network/batch` still
  write `visitor_presence` directly. These are lifecycle/business writes rather
  than periodic liveness ticks, so they do not scale with connection time, but
  they are not yet routed through the write-discipline gate (`/heartbeat` is).
* Presence-shard reads are cached per workspace; a very large workspace with
  many operator viewers will still issue up to 16 admin calls per cache window.
