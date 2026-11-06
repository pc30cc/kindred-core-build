# Several backend processes in one container (`BACKEND_PROCESSES`)

The backend (WebYar's Coolify app 25, RESPOK's 32) is one Node process by
default: `Dockerfile.server` runs `npx tsx start.ts`, and `server/start.ts`
only loads `server/index.ts`. One process runs JavaScript on one core,
whatever the host has (32 on `host.respok.app`).

`BACKEND_PROCESSES` lets the container run several processes with
`node:cluster`, each serving HTTP on port 3001. **Unset, empty or `1` is the
one process, as before**: the same start and the same log lines, and nothing
new logged. The only new modules it loads are the cluster seam
(`server/cluster/client.ts`, `server/cluster/metricsRelay.ts`, imported by
`index.ts`, the security middleware and the monitoring collector) and one
unref'd timer of the login-attempt map; all of it stays inert in one process.
The cache-bus scopes below (the first commit of this change) do change the
one process slightly, on purpose: see "Caches and metrics across the
workers".

It ships off. Switch it on only when the measurements say one core is the
limit (see "When to switch it on").

## The setting

| `BACKEND_PROCESSES` | Result |
| --- | --- |
| unset, empty or `1` | One process, as before. |
| a whole number from `2` to `16` | That many processes, after the checks below. |
| anything else (`0`, `2.5`, `auto`, `17`…) | One process, and the line `[cluster] BACKEND_PROCESSES=<v> is not a whole number from 1 to 16; running one process`. A typo never crash-loops production. |

Refused (one process, and a `[cluster] … refused: <why>` line):

- the `supabase-rest` database mode: the cache bus does not reach other
  processes there (`server/lib/cacheBus.ts`);
- `AI_SOURCE_SYNC_WORKER_INPROC`, `AI_KB_WORKER_INPROC`,
  `AI_KB_INTELLIGENCE_WORKER_INPROC` or `AI_AGENT_REGRESSION_WORKER_INPROC`
  set to `1` (dev only; request routes kick those workers too);
- `DATABASE_POOL_MAX` or `DATABASE_MODE` not valid: left to `index.ts`,
  which stops with the same error as before.

Lowered, with a line: N is at most `floor((DATABASE_POOL_MAX - 1) / 2)` (7
with `DATABASE_POOL_MAX=15`), so the lead keeps a pool of at least 3 and every
other worker at least 1. The lead serves HTTP and runs every background loop
on its pool: with one connection, a single slow loop statement (up to the
120 s statement timeout) would make its requests and its other loops fail
after the pool's 15 s wait. 3 is the smallest pool the one process ever had.
Below `DATABASE_POOL_MAX=5` cluster mode is refused.
Warned: a value above the CPUs Node sees still starts (a container CPU quota
is not visible there).

The decision is `server/cluster/plan.ts` (pure; `src/test/cluster/plan.test.ts`).

Variables only the primary sets, honoured only in a process `node:cluster`
forked (a value set by hand in Coolify, a `docker exec … npx tsx scripts/…`
or a test run is ignored): `BACKEND_CLUSTER_ROLE` (`lead`/`follower`),
`BACKEND_CLUSTER_INDEX`, `BACKEND_CLUSTER_SIZE`, `BACKEND_CLUSTER_READY` and
each worker's own `DATABASE_POOL_MAX`.

## Roles

- **Primary** (`server/cluster/primary.ts`): forks and supervises the workers
  and holds the shared request-path state (the hub). It opens no database
  connection and loads no Express (`src/test/cluster/primaryImports.test.ts`).
- **Lead** (worker 0): HTTP and every loop that must run once per container.
  It is forked first; the followers are forked once it listens.
- **Followers** (workers 1..N-1): HTTP, and what each process needs for itself.

Each start call in `index.ts`'s listen callback is in one of two lists,
checked by `src/test/cluster/loopPlacement.test.ts`:

**Every worker** (each process needs its own): `startCacheBusListener`
(each process's caches), `syncSeatEntitlementMode` and
`startInvitationWorker` (claims with SKIP LOCKED and a claim token, so
`/api/health/invitation-worker` stays 200 on every worker; its maintenance
sweep, `expire_invitations_v2` every 60 s, then runs N times a minute, and
since that function locks workspaces in no fixed order two sweeps can rarely
deadlock: Postgres aborts one and the next minute's sweep redoes it),
`startEmailOutboxWorker` (rows leased one at a time; a wake reaches only the
local outbox), `startPerfCollectors`, `startAutoActionsCache`,
`startNodeHealthRefresher`, and the widget manifest warm-up.

**Lead only** (inside `if (runsLoops)`): `startAttachmentJanitor`,
`startDispatchLogJanitor`, `startRecordingRetentionJanitor`,
`startVisitorDataRetention`, `startPrivacyWorker` (its boot recovery),
`startPrivacyExpirySweep`, `startWorkspaceDeletionWorker`,
`startUserDeletionWorker`, `startAiBillingRecovery`, `startSimpleBillingJob`,
`startLockExportWorker`, `startAlertingTicker` and the four logging-switch
banners, `startAutoActionsTicker`, `startFailoverTicker`,
`startReliabilityRollup`, `startEnforcementTicker`, `startCallQueueTicker`
(unleased), `startStaleConnectingSweep`, `startStaleActiveSweep`,
`startMaxmindUpdateTicker`, `startRankTrackingTicker`,
`startGmailWatchRenewalTicker`, `startNotificationEmailTicker`,
`startChatRoutingTicker`, `startConversationIdleCloseTicker`,
`startTeamCallTicker`, `startAppReviewVisitorsTicker`,
`startDatabaseBackupScheduler`, `startInvitationExpirySweeper`, and the
dev-only `startInProcessSourceWorker`, `intelligence` and `regression-runner`
workers (refused in cluster mode anyway).

So every loop with in-memory schedules (the rollup's due map, the sweep
cursors, the alert flap streaks, the idle-close delayed line) runs once per
container with today's code. The followers keep serving HTTP while the lead
is respawned; ticker leases (120 s) and claims expire as designed meanwhile.

`/api/ai-billing/admin/health`'s `recoveryScheduler` is per process: a
follower answering it shows `scheduled: false`.

## The hub: state that assumed one process

One copy per container, on the primary's single thread, run with the same
functions the single process uses (`server/cluster/hub.ts`). The seam is
`server/cluster/client.ts`: in the single process each facade calls today's
function on today's module state and sends nothing.

| | State | Module | When the primary does not answer (2 s) |
| --- | --- | --- | --- |
| H1 | privacy re-auth tokens (the worker sends only the sha256) | `services/privacy/reauth.ts` | fails closed: issuing answers 503, taking 401 `REAUTH_REQUIRED` |
| H2 | privacy job limits (5 exports, 2 deletions an hour) | `services/privacy/jobRateLimit.ts` | counted in the worker |
| H3 | login brute-force tracker (lock at 5 failures) | `middleware/loginAttempts.ts` | counted in the worker |
| H4 | the seven guess-or-send limiters: `authRateLimiter`, `emailRateLimiter`, invitation `otpLimiter` and `acceptLimiter`, commerce guest-verification and pairing, the colleague-call caller limiter | express-rate-limit's MemoryStore in the primary (`cluster/rateLimitHub.ts`) | counted in a MemoryStore of the worker; never a 500 |
| H5 | desktop-app roster and broadcasts, one sequence | `services/desktopApp/live.ts` | a heartbeat answers no new broadcast; adding or removing one answers 503 |
| H6 | call-request and ring-quiet limits | `services/calls/callRequestLimiter.ts` | counted in the worker |
| H7 | a callee's ring share | `services/calls/calleeRingLimit.ts` | counted in the worker |
| H8 | operator active/away, when no Redis URL is set | `services/widget/operatorActivityIndex.ts` | this worker's own stamps |
| H9 | keyed locks: `reply:` (the X-joined line, 5 s), `close:` (the closed line, 120 s), `ai:` (one AI run per conversation, 120 s), `ring:` (a colleague call's ring before its stop, 10 s) | `cluster/keyedLock.ts` | the caller proceeds, as when its wait passes its bound |
| H10 | the transcript claim | `cluster/claims.ts` | a Set in the worker |

A fallback is logged at most once a minute per operation. A timeout does not
mean the primary did nothing (it, or the worker's own event loop, may only
have been busy), so what an operation took there is given back: a lock or a
claim is released by its token, a desktop broadcast is removed by the id the
worker gave it (so the 503 holds and the admin's retry makes one), and a
call-request or ring ticket is given back when the late answer arrives. A
waiter whose worker exits mid-wait does not let the next one past the
holder. A lock or claim of a worker that exits is released. When `OPERATOR_ACTIVITY_REDIS_URL` or
`REALTIME_REDIS_URL` is set, Redis keeps precedence for operator activity.

## Caches and metrics across the workers

- Caches that used to clear only in the saving process are on the cache bus
  (`server/lib/cacheBus.ts`): `calls` (RTC/TURN endpoints, LiveKit, Agora,
  LiveKit readiness, call permissions and departments), `calls:<workspace>`,
  `realtime` (provider config, control plane, failover state, publishers),
  `geo:<key of the file>` (that MaxMind file's reader, after the updater's
  swap; a plan or settings save's `all` leaves the readers alone, and
  concurrent lookups share one open of the file),
  the plan stops on `entitlements`, and the lock state after a seat change
  (suspend, reinstate, remove) or a deleted contact, article or locked row,
  published on `entitlements:<workspace>` (it used to clear only in the
  process that saved, so routing elsewhere kept the old seat ranks for up to
  60 s). This also fixes the old/new container overlap of a deploy.
  It applies with the setting unset too: those saves now also send a
  NOTIFY, the `calls`, `realtime` and plan-stop caches also clear on every
  `all` and on the bus's resync after a reconnect, and MaxMind lookups share
  one open per file. Only cache misses follow from it.
- Request and realtime samples are relayed through the primary every second
  (`server/cluster/metricsRelay.ts`), so failover, alerting, the admin
  monitoring pages and `/metrics` see the whole container. Process samples
  (event-loop lag, memory) stay per worker; alert rules on them watch the
  lead's.

Accepted per worker, as with several replicas (each is listed in
`server/cluster/stateInventory.ts`, which `src/test/cluster/stateInventory.test.ts`
keeps complete): the hot-path abuse limiters and global ceilings
(docs/operations/WIDGET_CONFIG_CACHE.md, "Several processes"), the widget
category buckets and typing limit, the commerce guards, the AI playground
counters, the once-at-a-time guards whose real guard is in the database,
settings caches that lag 30-60 s after a Super Admin save on the other
workers, connections and warn-once memos.

## Connections

`DATABASE_POOL_MAX` (P) stays the backend container's total. The N workers
share P + 1 − N pool slots (the remainder to the lead first, and the lead
never below 3: when the even split would leave it less, it takes 3 and the
followers split the rest), and each holds
one cache-bus LISTEN connection, so **the container opens at most P + 1
connections for every N**, as one process does. The primary opens none.

| N (P = 15) | Pools | Container | Steady (+ 6 workers) | Deploy peak |
| --- | --- | --- | --- | --- |
| 1 (unset) | 15 | 16 | 22 | 39 |
| 2 | 7+7 | 16 | 22 | 39 |
| 3 | 5+4+4 | 16 | 22 | 39 |
| 4 | 3+3+3+3 | 16 | 22 | 39 |
| 6 | 3+2+2+1+1+1 | 16 | 22 | 39 |
| 7 (the most) | 3+1+1+1+1+1+1 | 16 | 22 | 39 |

The deploy peak is two backend containers side by side plus a worker
deploying at the same time: 2(P + 1) + 6 + 1, against `webyar_app`'s
connection limit of 60. The total pool shrinks a little as N grows (14 at
N=2, 12 at N=4); to keep about 16 pool slots at N=4, raise P to 19 (4+4+4+4,
a deploy peak of 47). With 4 connections kept spare for psql or a script,
2(P + 1) + 7 ≤ 56, so P ≤ 23.

The primary prints the plan, for example:

```
[cluster] BACKEND_PROCESSES=2: w0 lead (HTTP + background loops), w1 HTTP. DATABASE_POOL_MAX=15 is the container's total: pools 7+7 + 2 cache-bus LISTEN = 16 connections at most (one process: 16)
```

and each worker its own share (`pool up to 7 connection(s)`). Compare with
`SELECT application_name, count(*) FROM pg_stat_activity WHERE usename='webyar_app' GROUP BY 1`
(`webyar` and `webyar-cache-bus`).

Outside this count, unchanged: `pg_dump` as `webyar_backup` (the lead only),
the widget-bridge pool when `WIDGET_BRIDGE_DATABASE_URL` is set (2 per
process on that other database, so 2 × N with the setting on). A
`docker exec <backend> npx tsx scripts/…` opens its own pool sized by the
container's environment: run such scripts with `-e DATABASE_POOL_MAX=1`.

RESPOK: the same rule on `respok-postgres`. Before switching app 32 on,
count its `webyar_app` holders with the query above; the repository does not
list RESPOK's workers.

## Start, health, shutdown and crashes

- **Start.** The primary logs the plan, forks the lead, and the followers
  once the lead listens. `/api/health` answers 503 `{"status":"starting"}` on
  every worker until all of them listen, then 200 for the worker's whole life
  (a worker respawned later starts ready). So Coolify sees the new container
  healthy only once the whole cluster is up, and the old one keeps serving
  until then. `/api/health/cluster` (cluster mode only) gives counts:
  processes, alive, listening, ready, restarts. `/api/health/database`
  checks the pool of the worker that answered and names it (`worker`, its
  index; the single process's answer is unchanged).
  `/api/health/invitation-worker` stays 200: every worker runs that outbox.
- **Shutdown.** On SIGTERM the primary sends each worker exactly one SIGTERM
  and keeps answering the hub. Each worker drains as before
  (`services/jobs/processShutdown.ts`), then closes HTTP and exits. The
  primary keeps the listening socket while the lead still listens, so Traefik
  gets answers until the container exits. Any worker still running after
  `SHUTDOWN_TIMEOUT_MS` (25 s) + 5 s is SIGKILLed; the primary exits 0 after
  the last one. A second signal ends the primary at once (the workers then
  exit on the IPC disconnect), as a second signal ends one process.
- **Crashes.** A worker that exits after it listened is respawned with the
  same index, role and pool share, after 1 s doubling to 30 s (reset after
  60 s up). A respawn whose fork cannot start a process at all (`EAGAIN`,
  `EMFILE`, `ENOMEM`: Node reports an error, not an exit) counts as an exit
  and is retried the same way, so a slot is never left down for good. A
  slot never runs two processes: the followers are forked once, and a fork
  waits for the slot's pending respawn. Five unexpected exits of one index
  within five minutes, or a worker that exits before it ever listened during
  the first start, stop the others and exit 1, so Docker restarts the
  container as for a failed start. A dead primary ends the container: every
  worker exits when its IPC channel closes.
- **Stalls** are logged: a worker silent for 30 s, or one whose event loop
  lagged more than 1 s. The other workers' metrics are not relayed to a
  silent worker, nor to one whose IPC backlog is full, until it beats again
  (the primary's memory would grow with them otherwise). A follower is never
  killed for a stall: its connections go to the others.
- **The lead's watchdog.** The lead runs every once-per-container loop (chat
  routing, the call queue, the idle close, the team-call ticker, billing,
  alerting and its Telegram messages…), while `/api/health` keeps answering
  200 from the followers. So a lead silent for **90 s** after it listened
  (it beats every 5 s; `LEAD_WATCHDOG_MS` in `server/cluster/primary.ts`) is
  SIGKILLed and respawned as after a crash, with the line
  `[cluster] w0 (lead) has not been heard from for … s: its loops have
  stopped; SIGKILL and respawn`. Its hub locks are released, ticker leases
  expire as designed, and the followers keep serving. With one process the
  same wedge failed the health check instead.

## Logs (cluster mode only)

- the plan line above, and any lowered or warning line;
- `[cluster] w1 listening after 3.4 s`, then `[cluster] all 2 listening after …`;
- exit, respawn, crash-loop, watchdog and SIGKILL lines, and `[cluster] all workers exited`;
- `[cluster] roster: w0 120 req/min, lag p99 4 ms, rss 310 MB; w1 …` every 10
  minutes: how evenly Traefik's keep-alive connections spread;
- every worker line starts with `[wN] `, so `[shutdown] SIGTERM received`
  still matches.

## When to switch it on

Production at 22:10 UTC on 2026-11-05 ran at about 0.05% CPU per backend
container, host load average about 1.2: nothing shows one core as the limit.
Before switching on, on `host.respok.app`, read only:

1. `docker exec <backend> ps -o pid,ppid,args`: whether `sh -c` stays between
   npm (PID 1) and tsx. If it swallows SIGTERM, neither one process nor the
   primary drains today; that predates this switch.
2. The last replaced backend container's log: does `[shutdown] SIGTERM
   received` appear, and how long until it exits (Coolify's real stop grace;
   Docker's default is 10 s, below the 30 s bound above).
3. `docker inspect` of apps 25 and 32: CPU limits (`NanoCpus`, `CpuQuota`)
   and `Memory`. With one CPU there is nothing to gain; memory grows about N
   times one worker's RSS.
4. The names (never the values) of the variables: whether
   `REALTIME_REDIS_URL` or `OPERATOR_ACTIVITY_REDIS_URL` is set.
5. The `pg_stat_activity` count above on both databases.
6. `docker stats` and Super Admin's process trend at peak hours, at P = 15.

Switch it on when one core is the limit: more than about 60-70% of one core
sustained at peak, or an event-loop lag p99 above about 100 ms.

## Switching it on and off (Coolify apps 25 and 32)

RESPOK (app 32) first, with `2`, at a quiet hour; WebYar (app 25) a week
later the same way.

1. In Coolify, on the app's Environment Variables, add
   `BACKEND_PROCESSES=2`.
2. Redeploy without a build through the queue, as for the pool change:
   `/root/webyar-move/deploy.php` with the app's `DEPLOY_UUID` and
   `ROLLBACK=1` (CLAUDE.md, "Deploying and stopping"). Never Coolify's API
   create-and-deploy endpoints.
3. Check the log: the plan line (`pools 7+7 + 2 cache-bus LISTEN = 16`), two
   listening lines and `all 2 listening`, the loop banners once with `[w0]`;
   `/api/health/cluster` shows 2 of 2 listening; the backend's `webyar_app`
   connections stay at 16 or fewer.
4. With a test account: 6 wrong passwords lock the login; re-auth then a
   self-export works 10 times in 10; a reply after the AI writes one X-joined
   line; a double close writes one closed line and one rating card; a
   call-widget request, cancel, request rings the phones once; a colleague
   call rings and its cancel stops it; a desktop broadcast arrives; the
   monitoring page is stable across refreshes; a reset mail goes out within
   seconds.
5. On the next push to `main`, the old container's log shows
   `[cluster] SIGTERM received`, one `[shutdown]` line per worker and
   `all workers exited`, and Traefik no 502. Watch event-loop lag, 5xx, pool
   waits (`timeout exceeded when trying to connect`) and the roster for 48 h.

Go to 4 only when the roster shows a balanced share and lag is still the
limit (optionally `DATABASE_POOL_MAX=19` then, a deploy peak of 47).

**Off:** remove the variable (or set it to `1`) and redeploy the same way
(`ROLLBACK=1`). The result is exactly the one process; nothing to restore.
The hub's memory (re-auth tokens, login locks, the desktop roster) is lost,
as any restart loses it.

After each step, the owner's knowledge base is updated in Persian (CLAUDE.md,
"The knowledge base on the owner's Mac").

## Not done, on purpose

- Sticky routing: every connection comes from coolify-proxy; the client IP is
  only a header (`server/utils/clientIp.ts`).
- Database or Redis stores for the hub: hand migrations on two databases, and
  `operatorActivity.ts` and `desktopApp/live.ts` rule out Postgres for that state.
- Separate containers: they lose the shared disk (MaxMind, local backups).
- Dividing the per-worker ceilings by N: keep-alive pins connections, so the
  busiest worker would hit its share early.
- Killing stalled followers: only logged (the lead has its watchdog, above).
- The deploy-overlap issues that exist today with two containers (the call
  queue lease, the expiry-sweep claim, the privacy completion guard, the
  lock-export heartbeat) are separate changes.
- `CMD ["node", "--import", "tsx", "start.ts"]` instead of `npx tsx`: a
  separate decision for the owner, if step 1 above shows SIGTERM does not
  reach the app.
