# Production database mode — runbook

**Status: switched and verified in production on 2026-10-05; the AI billing
decimal fix (#266) deployed and verified on 2026-10-06.** The production
WebYar backend and its six workers reach the hosted Supabase project's
PostgreSQL directly (`DATABASE_MODE=postgres-only`). What was measured and what
is still an estimate:
[Verified state](#verified-state-2026-10-06) below.

It is a connection-mode change only: the database, its data and its schema
stay where they are; no migration is replayed, no baseline is recorded and no
data is moved. See [`docs/DATABASE.md`](../DATABASE.md) for the modes.

No secret value belongs in this file. Credentials live only in Coolify and in
the protected rollback kit on the server.

## What runs where

Coolify on `analyticsme.site`. The seven switched services (Coolify app id,
`WORKER_KIND`, `DATABASE_POOL_MAX`):

| App id | Service | Kind | Pool |
| --- | --- | --- | --- |
| 29 | WebYar Express Backend (`api.webyar.ai`) | — | 3 |
| 30 | WooCommerce Worker | `commerce-sync` | 1 |
| 21 | Channels-Worker | `channels` | 1 |
| 18 | Intelligence Worker | `intelligence` | 1 |
| 24 | Regression AI Worker | `regression-runner` | 1 |
| 27 | Seo-Crawler | `seo-crawler` | 1 |
| 19 | Source Sync Worker | `source-sync` | 1 |

Auto-deploy on push to `main`: apps 29, 30 and the frontend (28). The others
deploy only when triggered in Coolify.

Not switched: the older second backend, **Coolify app 10**, keeps using Supabase
REST (PostgREST) with `SUPABASE_URL` / service-role key. Keep the hosted
project's REST, Auth and Storage services running for it.

## The connection

- Login role `webyar_app` on project `bdycuenbjztkgnaqonfm`: `LOGIN`,
  `NOINHERIT`, member of `service_role` with `SET` (the server runs
  `SET ROLE service_role` on each connection), `CONNECTION LIMIT 20`; no
  superuser, createdb, createrole, replication or bypassrls of its own.
- Through the **session** pooler: `aws-1-eu-north-1.pooler.supabase.com:5432`,
  user `webyar_app.bdycuenbjztkgnaqonfm`, `sslmode=require` (TLS 1.3). The
  direct host `db.<ref>.supabase.co` is IPv6-only and the server has no IPv6.
  Never the transaction pooler (6543).

## Connection budget

Supavisor admits at most **15** session-mode connections for this user
(measured: the 16th is refused with `EMAXCONNSESSION`). A pool opens
connections only up to its `DATABASE_POOL_MAX` and makes further queries wait
for a free one; it never opens more.

What can be open at once:

| Situation | Connections |
| --- | --- |
| Steady state: backend 3 + six workers × 1 | **9** |
| A deployment runs the old and the new container side by side until the new one is up, so it adds the new container's pool | backend +3, a worker +1 |
| Coolify on this server runs at most **2** queued deployments at a time (server setting `concurrent_builds` = 2); further ones wait. A push to `main` queues 28 (no database), 29 and 30; the Deploy button and the rollback kit's `deploy.php` join the same queue. The worst pair is the backend and one worker: 9 + 3 + 1 | **13** |
| Left under the cap of 15 | 2 |

The first allocation (backend 6, channels 2, the rest 1; 13 steady) would have
needed 13 + 6 + 1 = 20 during a push to `main` while a worker deployed; that is
why the pools are this small.

Throughput at these sizes: a connection holds one statement at a time, and a
round trip from the server to the pooler takes about 30 ms, so the backend's 3
serve about 90 statements a second. The REST traffic they replace, from all
services together, averaged 7 requests a second (2026-10-05, 15:00–16:00 UTC,
about 40 ms each), with one-second bursts of up to 133. Such a burst waits up
to about 1.5 s for a free connection; nothing is refused (a query fails only
after 15 s without one).

The first cutover was lower still: the containers being replaced used REST,
not PostgreSQL, so the old side held no connection (peak 9).

Rules that keep this true:

- Keep `steady + the two largest pools ≤ 13`. Raise a pool only by lowering
  another, or raise the pooler's pool size in the Supabase dashboard first and
  measure the new cap.
- Keep Coolify's `concurrent_builds` at 2 on this server, or recompute: each
  extra concurrent deployment adds up to the backend's pool.
- Deploy these apps only through the queue: a push, the Deploy button, or the
  kit's `deploy.php`. Coolify's API endpoints that create and deploy at once,
  and its MCP `Deploy` tool, start immediately (`no_questions_asked`) and do
  not wait for the limit, so each one adds its app's pool on top of the 13.
- Do not hold a session as `webyar_app` through the pooler (psql, a script)
  while a deployment runs; it takes one of the 15. Read-only checks go through
  the Supabase SQL editor, which connects as another user.
- A container that restarts (crash or `docker restart`) drops its connections
  before it opens new ones, so it adds nothing.

## Variables (per switched service, runtime only — never build-time)

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the session-pooler URL for `webyar_app` |
| `DATABASE_MODE` | `postgres-only` |
| `PLATFORM_SIGNING_SECRET` | the value `SUPABASE_SERVICE_ROLE_KEY` has — the signing root of sessions, widget cookies, signed links |
| `DATABASE_POOL_MAX` | see the table and the budget |
| `DATABASE_APPLICATION_NAME` | `webyar-backend`, `webyar-worker-<kind>` (the session pooler replaces it: `pg_stat_activity` shows `Supavisor`; count by `usename = 'webyar_app'`) |

Kept unchanged: every `SUPABASE_*` variable (ignored in postgres-only, needed
for a rollback), `PLUGIN_SECRETS_MASTER_KEY`, `CORE_INTERNAL_SECRET` and all
other secrets.

**Never change `PLATFORM_SIGNING_SECRET` or `PLUGIN_SECRETS_MASTER_KEY`.** A
new signing root logs everyone out and breaks signed links and widget
sessions; a new plugin master key makes stored channel credentials
unreadable. `DATABASE_URL` and `DATABASE_MODE` go together:
`DATABASE_MODE=postgres-only` without `DATABASE_URL` does not start.

## Checking the state

```
curl -s https://api.webyar.ai/api/health/database
# {"status":"ok","driver":"postgres","mode":"postgres-only","role":"service_role",...}
```

Each worker logs at start:
`database: postgres aws-1-eu-north-1.pooler.supabase.com:5432/postgres (ssl on), PostgreSQL 17, role service_role, mode postgres-only, pool up to N connection(s)`.

The kit's `verify.sh` prints, per container, the image, health, mode, those
log lines and its TCP connections to Supabase REST and to the pooler (REST
must be 0 for all seven). `pg_stat_activity` should show 9 sessions for
`webyar_app` in steady state.

`[ai-billing] recovery tick failed: invalid_decimal:…` should no longer
appear (fixed by #266, see below). If it does, a value reached
`D.fromString` in a form it does not accept; the pass stops before settling
anything, so look at it the same day.

## Verified state (2026-10-06)

Deployed (Coolify app → commit):

| App | Commit | Since |
| --- | --- | --- |
| 29 backend, 30 WooCommerce, 28 frontend | `6960097` (#266) code | 2026-10-06 07:55 UTC (auto-deploy on merge); a later docs-only merge to `main` redeploys them with the same code |
| 18 intelligence, 24 regression, 19 source-sync | `6960097` (#266) | 2026-10-06, queued with `deploy.php` |
| 21 channels, 27 SEO crawler | `687e6fe` (#263) | 2026-10-05; #265 and #266 do not change their code |
| 10 (older backend, REST) | `17c093d` | unchanged |

`687e6fe` is the switch; `10ae91f` (#265) only changed docs; `6960097` adds
the AI billing fix to the code paths of 29, 18, 24 and 19.

### Measured

- Pooler cap for `webyar_app`: 15 session connections; the 16th is refused
  with `EMAXCONNSESSION` (2026-10-05).
- Steady state: 9 connections from the seven services (TCP connections per
  container and `pg_stat_activity`, 2026-10-05 and 2026-10-06). Idle
  connections close after 30 s, so the count drifts between 7 and 9.
- Deployment overlap, sampled every 2–4 s from every container's TCP
  connections to the pooler (`pool_peak.sh` in the kit; a spike shorter than
  one sample could be missed):
  - #265 auto-deploy of 29 + 30 side by side, 2026-10-05 17:05: peak **13**.
  - #266 auto-deploy of 29 + 30, then 28, 18, 24 and 19 through the queue,
    2026-10-06 07:53–08:03: peak **12**.
- 2026-10-06, about 14 h after the switch: all seven containers healthy, no
  restarts, no `EMAXCONN`, connection-refused, timeout or `FATAL` lines in
  their logs, no TCP connection to Supabase REST (only app 10 has one), the
  database health endpoint `ok` / `postgres-only` / `service_role`, the same
  database instance, no migration ledger.
- Again after the #266 deploys (2026-10-06 08:04): the same on every container,
  each logging `mode postgres-only`, and no `recovery tick failed` line.

### Estimated (not measured)

- The budget bound itself: 9 + 3 + 1 = 13 is a calculation from the pool
  sizes and Coolify's two-deployment limit; the measured peaks stayed at or
  under it.
- Backend throughput at pool 3, about 90 statements a second, from a ~30 ms
  round trip and the REST request rate before the switch (see the budget).

### Production functional checks: passed (2026-10-06 08:57 UTC)

Run against production through the normal routes by `functional_test.mjs` (in
the kit), as an owner-authorized test account in its own workspace (slug
`ws_98b9076a`, widget on, no AI agent configured, no push devices), from a
throwaway container of the backend image with no production variables. All 28
checks passed (measured):

- Login with the cookie transport; the session is the test account's; a
  request without a cookie has no session; the inbox reads.
- Visitor message through the widget (signed visitor session for the allowed
  origin): stored once; the operator, connected to Centrifugo
  (`ws:<ws>:inbox`), received it live exactly once, 717 ms after the send.
- Operator reply: stored once; the visitor, subscribed to
  `ws:<ws>:conv:<conv>`, received it live exactly once, 287 ms after the send;
  the inbox got it once too.
- Duplicates: replaying the visitor message (same `client_message_id`)
  returned the same id and was neither stored nor delivered again; replaying
  the operator reply returned `duplicate: true`, stored and delivered once.
- Attachment (93-byte text file): uploaded, sent, delivered live once; the
  reopened conversation lists it; the operator and the conversation's visitor
  download it byte for byte (SHA-256); without a session 401; another
  visitor 403.

Cleanup: the stored object was deleted through `POST /api/storage/delete`
(Bunny and the Arvan replica), then the attachment row, the conversation with
its messages, and the contact through their routes. Rows no route removes
(3 timeline events, the AI engine's `skipped` run, the AI settings row created
on first use with the defaults, 2 storage-usage log rows, the month's usage
counter row holding only the test's counts) were deleted in one transaction
that checked every row count (kit: `functional/residual_cleanup.sql`). Every
workspace-scoped table is back to its pre-test count. The account's two login
sessions (revoked at logout) and two login-attempt audit rows are kept.

To run it again: put `TEST_EMAIL`, `TEST_PASSWORD`, `TEST_WORKSPACE_ID` (id or
slug) and `TEST_ORIGIN` in the root-only `/root/webyar-test-account.env`;
the test writes what it created to `/out/created.json`:

```
D=/root/webyar-rollout/20261005-postgres-only
IMG=$(docker inspect "$(docker ps --filter name=^vpvsddhbp640fdb9j4r5sfym- --format '{{.Names}}' | head -1)" --format '{{.Config.Image}}')
docker run --rm --env-file /root/webyar-test-account.env -v $D/functional_test.mjs:/kit/functional_test.mjs:ro \
  -v $D/functional:/out --entrypoint node "$IMG" --experimental-websocket /kit/functional_test.mjs
```

Then remove what it created with `functional_cleanup.mjs` (storage object,
attachment, conversation, contact; it refuses a file key outside the test
workspace, and the workspace-wide conversation delete must only run when the
test's conversation is the workspace's only one).

Known, pre-existing and harmless: `conversation_attachments.storage_provider`
records `local` for every attachment (the init route reads the setting's
`provider` key, the stored setting has `provider_name`). The bytes go to the
configured provider (Bunny; `storage_usage_logs.provider_name`), and reads
resolve the provider from the setting, not from that label.

### AI billing recovery (#266)

Numerics reach the server as JSON numbers, and `String()` prints one below
1e-6 in exponent notation; `D.fromString` rejected `8.8e-7`, and every
recovery pass failed from 2026-09-20. It now rewrites that form as the same
digits in plain notation (string only, no float arithmetic) and keeps the
12-place rule. The first pass after the deploy (2026-10-06 07:57 UTC), through
the existing idempotent mechanism, measured against a read-only snapshot taken
before it:

- 19 runs `USAGE_RECORDED` since 20–30 September (WebYar's own workspace,
  `ENFORCED`): each settled once, one ledger entry each, charge exactly
  (IRR cost × 4) rounded to 6 places, nothing absorbed; 50,103.627840 IRR in
  all. Balance 376,915.475120 → 326,811.847280, as predicted.
- 1 orphaned `RUNNING` run (24 September, no reservation) → `CANCELLED`.
- 13 settled `ESTIMATED` runs → `RECONCILED` (label only).
- Nothing left pending; no run anywhere has more than one settlement.

## Rollback

The kit is on the server, root only: `/root/webyar-rollout/20261005-postgres-only/`.
It holds the Coolify variable rows of the seven apps as they were before the
switch, the deploy and restore scripts and the `webyar_app` credential; its
`README.md` repeats these commands.

Do not count on old images: Coolify's Docker cleanup on this server runs every
hour (forced) and deletes every image no container uses, extra tags included,
keeping only each app's newest two or three. So each step below runs the
commit's image if it is still there and otherwise rebuilds that commit from Git
(about 2.5 min for the backend and a worker, about 9 min for the frontend).
`deploy.php` goes through Coolify's queue, two deployments at a time.

Set up (every rollback):

```
D=/root/webyar-rollout/20261005-postgres-only
docker cp $D/deploy.php coolify:/tmp/ && docker cp $D/restore_env.php coolify:/tmp/
docker exec -u root coolify chmod 644 /tmp/deploy.php /tmp/restore_env.php
# rb <app id> <app uuid> <full commit>: reuse the image if present, else build that commit
rb() {
  if docker image inspect "$2:$3" >/dev/null 2>&1; then R=1; else R=0; fi
  DEPLOY_APP_ID=$1 DEPLOY_COMMIT=$3 ROLLBACK=$R docker exec -e DEPLOY_APP_ID -e DEPLOY_COMMIT -e ROLLBACK coolify php artisan tinker --execute="require '/tmp/deploy.php';"
}
BE=vpvsddhbp640fdb9j4r5sfym WC=1pxev53a9ylbnn1jflmscups FE=vyc6ywzjtlw1es51km4arrl5 CH=8yooppd8yzfygezjfah3gupl
IN=a21qofxtx8g0vin1f7he88f6 RG=f31csnb3mvr3gdgppa7vcdzu SEO=uimjkt8awgjagabncll0lgap SS=nwypq2oag3roduru7djp53j1
```

**A. Undo only the AI billing fix** (stay on postgres-only). Runs settled
since stay settled; nothing to reverse.

```
P=10ae91fb6d885b744047dfb5f355d92d7495f98c S=687e6feb3b78a3edc02db76ec010e8af21eb77a3
rb 29 $BE $P; rb 30 $WC $P; rb 28 $FE $P
rb 18 $IN $S; rb 24 $RG $S; rb 19 $SS $S
```

**B. Undo the whole postgres-only switch.**

```
# 1. remove DATABASE_URL, DATABASE_MODE, PLATFORM_SIGNING_SECRET, DATABASE_POOL_MAX,
#    DATABASE_APPLICATION_NAME from the seven apps (both together, never one)
docker exec coolify php artisan tinker --execute="require '/tmp/restore_env.php';"
# 2. redeploy the pre-switch commits
O=530f1e7fd171b5c0a49ed311c4d46c5e4fc36361 C=b334ea73ce188eee5e6c25fb8049c3cf3e5901c3
I=d3bda54c83d2b5f0126538cbac00315ddf9561b0 W=d6033b99723b43be68fa33139aff0f57cc117fff
rb 29 $BE $O; rb 30 $WC $O; rb 28 $FE $O
rb 21 $CH $C; rb 18 $IN $I; rb 24 $RG $W; rb 27 $SEO $W; rb 19 $SS $W
```

Then check: `https://api.webyar.ai/api/health` → 200 and
`/api/health/database` → 404 (the old code has no such route), the workers'
logs, and the kit's `verify.sh` (REST connections come back, pooler goes to 0).
`PLATFORM_SIGNING_SECRET` equals the service-role key the old code signs with,
so sessions and signed links stay valid in both directions. Either rollback
only ever lowers the pooler connection count. The `webyar_app` role can stay
unused.

An application rollback never touches database data. Do not run
`move-data.sh`, `migrate-database.sh` or a baseline against production as part
of it.

## Migrations

Production has no `public._schema_migrations` ledger. `migrate-database.sh`
(and so `deploy-migrations.yml`) refuses to run against it until it is
baselined with `scripts/db/baseline-verify.sh` (docs/AUTO_MIGRATIONS.md); keep
the `DATABASE_URL` Actions secret unset until then.
