# Production database mode — runbook

**Status: since 2026-10-07 the production WebYar backend and its six workers
use WebYar's own self-hosted PostgreSQL 17 on the Coolify server**, still in
`DATABASE_MODE=postgres-only`. See
[Self-hosted PostgreSQL](#self-hosted-postgresql-since-2026-10-07). The
hosted Supabase project holds the data as of the cutover and is the
fallback.

The sections after that one describe the Supabase period (2026-10-05 to
2026-10-07) and the 2026-10-06 rehearsal. They are kept as history and for
their findings.

## Self-hosted PostgreSQL (since 2026-10-07)

**The server**
- Coolify database `webyar-postgres` (`oqzy9q4ovntam9jgf7nxzqun`), image
  `pgvector/pgvector:pg17`: PostgreSQL 17.11 with pgvector 0.8.7.
- Network `coolify` only, no public port, 2 GB memory limit.
- Volume `postgres-data-oqzy9q4ovntam9jgf7nxzqun`.
- Tuned with `ALTER SYSTEM` (the kit's `setup_db.sh`):
  - `shared_buffers` 384MB, `effective_cache_size` 1GB, `work_mem` 8MB;
  - `log_min_duration_statement` 2s;
  - `pg_stat_statements` preloaded;
  - `max_connections` 100.
- Database `webyar` is production. `webyar_staging` is the write-free copy
  the move read, and may be dropped later.
- Roles:
  - `postgres` owns the tables.
  - `webyar_app` is the application login: `NOINHERIT`, connection limit 60,
    member of `service_role` `WITH SET TRUE`, as on Supabase.

**The connection**
- The seven apps use
  `postgresql://webyar_app:…@oqzy9q4ovntam9jgf7nxzqun:5432/webyar?sslmode=disable`.
- That variable is the only one the move changed. Signing and encryption
  secrets, `DATABASE_MODE`, pools (backend 3, workers 1) and application
  names are as before.
- The pooler's 15-connection budget no longer applies. Fourteen of 100
  connections were in use after the move.

**Backups**
- Coolify's scheduled backup takes a `pg_dump` of `webyar` daily at 02:13 UTC
  and keeps the last 14 on the server.
- The first one ran right after the move and succeeded (3.2 MB).
- There is no off-site copy: Coolify has no S3 storage configured. Add one.

**Migrations**
- The ledger `public._schema_migrations` is complete: the chain at `fa0e79d`,
  250 files, built by `scripts/migrate-database.sh`.
- `schema-diff.sh` against the Supabase schema found 0 unexpected
  differences.
- Apply new migrations from the server with that script, as `postgres`,
  against `webyar`. GitHub Actions cannot reach this database.

**How it moved (2026-10-07)**

Everything is in the kit `/root/webyar-rollout/20261007-selfhosted/`, root
only.

1. Stop the seven apps through Coolify, keeping their containers and images.
   - `api.webyar.ai` then answers 503, Coolify's catch-all. WooCommerce
     events (retried on 5xx for about 15 minutes) and webhooks are retried,
     not dropped.
2. Check that Supabase is write-quiet: no table changed in 20 s.
3. Take one exported snapshot of Supabase (05:41:03 UTC): `pg_dump` of
   `public` and `widget_archive`, with `move-data.sh`'s row counts and
   content checksums taken in the same snapshot (313 tables, 19,127 rows).
4. Load the snapshot into `webyar_staging`, which proves equal to it. Then
   `scripts/db/move-data.sh run`, unmodified, from `webyar_staging` into
   `webyar`, with every phase passing. Then `widget_archive` and the
   publication.
5. Recheck Supabase: unchanged since the snapshot, so nothing was left behind.
6. Change `DATABASE_URL` on the seven apps.
7. Redeploy through the queue at the commits already running.
8. Verify:
   - every container's `DATABASE_URL` points to the new host;
   - each app logs `database: postgres oqzy9q4ovntam9jgf7nxzqun:5432/webyar … PostgreSQL 17, role service_role`;
   - `/api/health/database` is ok at 3 ms (36 ms on Supabase);
   - there are no database errors in the logs;
   - no `webyar_app` session is left on Supabase;
   - Supabase is no longer written.

Downtime of `api.webyar.ai` was about 4 minutes (05:40:39 to 05:44:20 UTC);
the last worker was back at 05:45:12. A first attempt at 05:30 aborted
before any configuration change: a glob in the window script picked a file
instead of the backup directory. That attempt restored service on Supabase
automatically after about 6 minutes.

**What was not copied**
- Supabase-managed schemas that WebYar does not use: `auth`, plus `storage`,
  `realtime` and `vault` (all empty).
- The data of the owner-only, empty
  `public.verification_admin_idempotency`.

**Shared writer found and stopped**
- Coolify app 10 (API.Destekly, an older backend at `17c093d`) was still
  running WebYar's background tickers on the same Supabase database over
  REST: about 31,000 writes a day (billing schedulers, invitations, deletion
  jobs, call queue).
- With WebYar moved, it would have acted on stale data. The owner stopped it
  (2026-10-07 05:14:47 UTC); its settings were not changed.
- Do not start it again unless it is pointed at the self-hosted database.

**Rollback**
- Supabase has the data only up to 05:41:03 UTC.
- To roll back the configuration, the kit's `restore_from_snapshot.sh apply`
  (`CONFIRM=restore`) puts the seven `DATABASE_URL` rows back byte for byte;
  then run `deploy_all.sh`.
- Writes made on the self-hosted database since the cutover are then not on
  Supabase. Move them back first: `move-data.sh` with Supabase as target,
  which needs Supabase's `postgres` role.

## The Supabase period (2026-10-05 to 2026-10-07)

The 2026-10-05 switch was a connection-mode change only: the database, its data and its schema
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
| 29 backend, 30 WooCommerce, 28 frontend | #270's merge (#266 plus the attachment storage label fix, which runs in 29) | 2026-10-06, auto-deploy on merge; every merge to `main` redeploys these three |
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

Attachment storage label (fixed in #270):
`conversation_attachments.storage_provider` said `local` for every attachment,
because the operator and widget init routes and platform support read the
setting's `provider` key while the stored setting has `provider_name`. The
bytes went to the configured provider all along (Bunny, mirrored to Arvan;
`storage_usage_logs.provider_name`). Init now resolves the label the way the
upload resolves the provider, and a successful upload records the provider it
used. Reads and deletes never used the label: they resolve the provider from
the setting and use `storage_path`. Earlier rows are corrected only where the
upload log names one provider for the same workspace and key (kit:
`attachments_provider_fix.sql`, a count-checked transaction); the kit README
records that correction and the round trip after the deploy.

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

This section is the rollback of the 2026-10-05 switch: from `postgres-only`
on Supabase back to Supabase REST. For today's self-hosted database, see
**Rollback** under
[Self-hosted PostgreSQL](#self-hosted-postgresql-since-2026-10-07).

The kit is on the server, root only: `/root/webyar-rollout/20261005-postgres-only/`.
It holds the Coolify variable rows of the seven apps as they were before the
switch, the deploy and restore scripts and the `webyar_app` credential; its
`README.md` repeats these commands.

`rb` queues an ordinary Coolify deployment of one app at one exact commit
(`deploy.php`, through Coolify's queue, two deployments at a time). Coolify
(v4.3.23; read from its code on this server) clones `main`, fetches and checks
out that commit (an explicit commit is never replaced by the branch head), and
skips the build when an image `<app uuid>:<commit>` exists and no build setting
changed since the app's last successful deployment; otherwise it builds that
commit with the app's Dockerfile. Removing runtime-only variables (B, step 1)
is not a build change. `ROLLBACK=1` does not change that decision for these
Dockerfile apps; it only lets Coolify queue a deployment for a commit already
queued.

Do not count on old images: Coolify's forced Docker cleanup runs every hour
here and deletes every image no container uses (extra tags included, keeping
each app's newest two) and the whole build cache. Two ways around it, both
verified (see [Rebuilding the rollback commits](#rebuilding-the-rollback-commits-verified-2026-10-06)):

- **Load the kept images first** (fastest): `$D/rebuild/rollback_load.sh A`
  (or `B`) loads the option's images from the kit's files and tags them as
  `<app uuid>:<commit>`, so Coolify skips every build. Run it right before
  the `rb` lines, not an hour earlier. A tag Coolify already has is left
  alone. `DRY_RUN=1` only checks the files and prints what it would do
  (run for A and B on 2026-10-06: all files intact, every app mapped).
- **Let Coolify rebuild**: without it, each `rb` builds its commit from Git.

Set up (every rollback):

```
D=/root/webyar-rollout/20261005-postgres-only
docker cp $D/deploy.php coolify:/tmp/ && docker cp $D/restore_env.php coolify:/tmp/
docker exec -u root coolify chmod 644 /tmp/deploy.php /tmp/restore_env.php
# rb <app id> <app uuid> <full commit>: deploy that commit; Coolify reuses its image if present, else builds it
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
$D/rebuild/rollback_load.sh A        # optional: kept images, no builds
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
$D/rebuild/rollback_load.sh B        # optional: kept images, no builds
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
of it. After a rollback, the next merge to `main` redeploys 29, 30 and 28 at
`main`'s head.

### Rebuilding the rollback commits (verified 2026-10-06)

This was not a production rollback drill: nothing was deployed, restarted or
replaced, and no production variable was used. The work ran on the production
server outside Coolify, one build at a time; the scripts and logs are in the
kit's `rebuild/`.

- **Builds.** Both options need nine distinct builds (a Dockerfile at a
  commit):
  - backend: 10ae91f, 530f1e7;
  - frontend: 10ae91f, 530f1e7;
  - worker: 687e6fe, 530f1e7, b334ea7, d3bda54, d6033b9.

  App 30 at 10ae91f takes the worker built from 687e6fe: the two commits have
  identical worker inputs and differ only in documentation. Each was built the
  way Coolify builds these apps:
  - a fresh shallow clone of `main`, then fetch and checkout of the exact
    commit;
  - the app's Dockerfile, BuildKit, `--network host`;
  - `--no-cache`, because the hourly cleanup leaves no build cache.

  Build arguments: none for the backend and workers, because no build step
  reads one; for the frontend, Coolify's `VITE_API_BASE_URL`, the only
  variable its build reads. All nine builds succeeded (clone + build,
  measured):

  | Image | 10ae91f / 687e6fe | 530f1e7 | b334ea7 | d3bda54 | d6033b9 |
  | --- | --- | --- | --- | --- | --- |
  | backend | 55 s | 47 s | | | |
  | worker | 80 s | 82 s | 94 s | 92 s | 82 s |
  | frontend | 383 s | 358 s | | | |

- **Same files as Coolify's builds** (`rebuild/compare/`, SHA-1 of every
  file, `node_modules` included):
  - Workers 687e6fe, b334ea7 and d6033b9 match the images Coolify built at the
    same commits (apps 18, 21 and 27) file for file: 30,124, 29,968 and
    29,941 files, no difference, both on Node 20.20.2.
  - The 10ae91f frontend matches the image Coolify built at 731774f, which
    runs now: 97 files, identical.
  - The 10ae91f backend differs from Coolify's 731774f backend in one file
    of 5,457, `services/ai-billing/decimal.ts`, which is the #266 fix that
    731774f adds.
- **Isolated startup** (`rebuild/checks/`), every image with random dummy
  secrets:
  - The network was internal with no route out; the frontend ran with no
    network at all.
  - Postgres-only commits ran against a throwaway PostgreSQL holding that
    commit's migration chain. Pre-switch commits ran against a throwaway
    PostgREST over it, behind `/rest/v1`, with its own keys.

  All 14 checks passed:
  - Both backends answered `GET /api/health` with 200.
  - Each worker kind a rollback starts on each worker image was still running
    after 30 s, Docker reported it healthy, and it logged its start. The kinds
    were commerce-sync, channels, intelligence, regression-runner, seo-crawler
    and source-sync.
  - Both frontends served the app, the widget manifest and the Android version
    file.
- **Kept outside Docker** (`rebuild/images/*.tar.gz`, root only; no secret in
  them): nine gzip files, 1.4 GB in all (backend 85 MB, frontend 63 MB, worker
  225 MB each), with SHA-256 sums. Each was proven:
  - the image was removed from Docker and loaded back from its file alone
    (backend and frontend 2–4 s, a worker 35–48 s);
  - the loaded image has the same image id;
  - it passed the same startup check again.

**Expected recovery time** (estimates from the measurements above and
Coolify's own deployment records on this server, two deployments at a time;
not measured as a rollback):

- With `rollback_load.sh` first: about 1 min (A) or 3 min (B) to load, then
  about 3 min for A (6 deployments) and about 4 min for B (8). Deployments
  that skipped the build here took 60–81 s for the backend, 25–32 s for the
  frontend and 46 s for a worker.
- Letting Coolify rebuild: about 12 min for A and 15 min for B. A deployment
  with a build took about 2.5 min for the backend or a worker and 7.5–10 min
  for the frontend, the longest single step.

Neither path is instantaneous. The old containers keep serving until each new
one is healthy.

## Self-hosted PostgreSQL rehearsal (2026-10-06)

**Outcome: the copy to a self-hosted PostgreSQL 17 was rehearsed and verified
end to end, and no production service was switched.** The live switch stopped
before it began because safe isolation could not be achieved (below).
Production stayed on project `bdycuenbjztkgnaqonfm` in `postgres-only` mode the
whole time, with no maintenance window. Evidence is in the kit's `rehearsal/`
folder, root only.

### What was built and verified (nothing here wrote to production)

- **Temporary server:** Coolify database `webyar-rehearsal-pg17`
  (`vk5tdhrhens6rrmp1ouuysqt`).
  - Image `pgvector/pgvector:pg17`: PostgreSQL 17.11 with pgvector 0.8.7
    (production has 17.6 / 0.8.0).
  - Network `coolify` only, no published port, 1 GB memory limit.
  - Volume `postgres-data-vk5tdhrhens6rrmp1ouuysqt` (205 MB).
  - Stopped afterwards through Coolify; the volume is kept.
  - `rehearsal/start_pg17.php` starts it again (with `RH_ACTION=stop` it
    stops it); the kit README has the commands.
- **Pre-test configuration snapshot:**
  - Every stored variable row of apps 29, 30, 21, 18, 24, 27, 19 and 28,
    kept as ciphertext.
  - A present/absent matrix of the database keys, plus app rows, settings and
    images.
  - `restore_from_snapshot.sh check` compares the live configuration with it.
- **Consistent backup:** one `REPEATABLE READ` transaction exported its
  snapshot at 14:41:23 UTC.
  - `pg_dump` (client 17) dumped `public` and `widget_archive` in that
    snapshot: 3.4 MB.
  - In the same snapshot, `move-data.sh`'s own row counts and content checksums
    were taken: 313 tables, 19,047 rows.
- **Schema:** the migration chain at `fa0e79d` (250 files) was applied by
  `scripts/migrate-database.sh` to the new server.
  - `schema-diff.sh` between production and that database: **0 unexpected
    differences**, 71 reviewed (the allowlist).
  - So functions, triggers, enums, indexes, constraints, sequences, views,
    policies and service_role grants match.
- **Data:** the backup was loaded into a chain-built `webyar_frozen`.
  - `webyar_frozen` equalled production at the snapshot: every count and
    checksum matched.
  - Then `scripts/db/move-data.sh run` copied `webyar_frozen` into the target,
    unmodified and with every phase passing:
    - schema match;
    - the source unchanged during the dump;
    - one-transaction load with every foreign key enforced;
    - every sequence ahead of its rows;
    - 314 tables, identical content.
- **Not in the chain:**
  - `widget_archive` (1 table, 2 rows, its function, trigger, RLS and grants)
    was restored from the backup and equals the snapshot.
  - The `supabase_realtime` publication (`public.team_messages`) was
    recreated. It is inert there: nothing subscribes, and WebYar's realtime
    runs over Centrifugo.
- **Roles:**
  - `anon`, `authenticated` and `service_role` came from migration `000`.
  - `webyar_app` was added: `LOGIN NOINHERIT`, a member of `service_role`
    `WITH SET TRUE`, with its own password, root-only.
- **Application access, isolated:**
  - The images production runs now (backend `fa0e79d` and the six workers) ran
    on an internal Docker network with no route out (proved) whose only other
    member was the new server.
  - They used a disposable clone of the target, logging in as `webyar_app`.
    Every secret was a random dummy.
  - Backend:
    - `/api/health` returned 200.
    - `/api/health/database` reported `ok`, `postgres-only`, server 17, role
      `service_role`, 2–3 ms.
    - `/api/plans` returned the copy's 3 plans.
    - `/api/platform/public/config` returned 200.
  - Each worker kind (`commerce-sync`, `channels`, `intelligence`,
    `regression-runner`, `seo-crawler`, `source-sync`) stayed healthy for
    30 s, logged its start and held sessions on the new server.
  - The clone was dropped afterwards. Nothing could leave the host, so no mail,
    push, AI or channel call was made.

### Left out on purpose

These are Supabase-managed:
- `auth`: 27 tables. Neither `webyar_app` nor `service_role` may read them,
  and WebYar's identity lives in `public` (`000a` provides the stub).
- `storage`, `realtime` and `vault`: every table `service_role` can read is
  empty. That is 7 of 8 in `storage` and 2 of 3 in `realtime`; the unreadable
  ones are their migration ledgers. `vault` holds no secret.
- `supabase_migrations`, `graphql`, `graphql_public` and `pgbouncer`.
- The `extensions` schema's Supabase helpers and its 6 event triggers (pg_graphql, pg_cron,
  pg_net and PostgREST watchers).
- The extensions `pg_stat_statements` and `supabase_vault` (allowlisted).

`public.verification_admin_idempotency` is owner-only (`postgres`, no grant to
`service_role`) and used only by two `SECURITY DEFINER` functions. Its data was
not readable with our credential. Its heap was 0 bytes at the snapshot, so it
was empty. Its definition comes from the chain.

### Findings

- **The Supabase session pooler drops startup options.** `PGOPTIONS` and the
  URL's `options` both have no effect. Measured: a session arrives as plain
  `webyar_app`, not read-only, with `row_security` on.
  - `move-data.sh` therefore cannot read production as `service_role` through
    the pooler. Its read-only session setting does not apply there, though it
    only ever issues reads.
  - `schema-diff.sh` run as bare `webyar_app` reports a false difference on
    `workspace_invitations.token`: `webyar_app` has no USAGE on `extensions`,
    so the default prints as `extensions.gen_random_bytes`. Run it with the
    source session set to `service_role`, as `rehearsal/schema_diff_prod.sh`
    does.
- **`move-data.sh` needs a source with no writer, and production always
  writes.** A 90 s sample saw 10 tables change, among them leases, presence,
  heartbeats and commerce sync. A real move therefore needs the application
  stopped (DATABASE.md §6). The rehearsal used the snapshot-consistent
  `webyar_frozen` instead.
- **A real move out of production also needs the table owner (`postgres`)**
  for `verification_admin_idempotency`. That credential is not held, and its
  password must not be reset.

### Why there was no live switch

These blockers applied to a temporary switch-and-return with no downtime.
The one-way move of 2026-10-07 dealt with them as follows:
- A maintenance window: with the backend stopped, Coolify's catch-all answers
  503, so plugin events and webhooks are retried.
- Every writer stopped first, app 10 included.
- No return trip, so nothing has to be reconciled.
- The owner tests after the move.

- **No maintenance mode.** Holding traffic would need a gate in the shared
  Coolify proxy. The frontend (28) calls the backend through its public
  hostname, so an IP allowlist would let all of it through.
- **WooCommerce plugin events can't be held without loss.** A 400/401/403/404/422
  response dead-letters an event at once, and 401/403 also forces re-pairing.
  A 5xx response is retried 6 times over about 15.5 minutes, then
  dead-lettered.
- **Widget messages can't be held either.** A message that fails needs the
  visitor to press retry.
- **Webhooks would land on the temporary database.** Signed payment webhooks
  (Stripe, Paddle, Lemon Squeezy, PayTR), LiveKit, Gmail push and Telegram
  would be acknowledged and recorded there. Those are real writes that would
  have to be reconciled into Supabase by hand.
- **Workers would redo production work.** Pointed at a copy, they would run
  pending and scheduled production work again: channel sends, AI runs and
  billing. Pausing them is possible, but the paused work would then have to
  be reconciled.
- **No test account.** `/root/webyar-test-account.env` is absent, so the
  login, inbox, realtime and attachment checks could not run with a
  legitimate login.

### Restoring the configuration (prepared, not needed)

`rehearsal/restore_from_snapshot.sh` has two modes:
- `check` is read-only. It compares every stored row of the eight apps with
  the snapshot. Result: 251 rows, 0 differences, the same images.
- `apply` needs `CONFIRM=restore`. In one transaction it puts the database keys
  back byte for byte; then redeploy each app through the queue with `rb`
  (above).

The rehearsal never changed a variable, so the check stayed at 0 differences
and nothing was redeployed.

### Final database destination

All seven consumers (29, 30, 21, 18, 24, 27, 19) still use project
`bdycuenbjztkgnaqonfm`:
- through the session pooler `aws-1-eu-north-1.pooler.supabase.com:5432`;
- as `webyar_app.bdycuenbjztkgnaqonfm`;
- with `DATABASE_MODE=postgres-only`.

Checked at 14:53 UTC, after the rehearsal:
- Every running container's `DATABASE_URL` points there, and each is healthy.
- No container was restarted during the rehearsal.
- The backend's `/api/health/database` reports `ok`, `postgres-only`,
  `service_role`.
- Production's `pg_stat_activity` on PostgreSQL 17.6 (system id
  `7623125441096521075`) shows 10 `webyar_app` sessions: the usual 9 plus the
  check's own.

The frontend (28) has no database variable.

## Migrations

Since 2026-10-07 the production database (self-hosted `webyar`) has a
complete `public._schema_migrations` ledger: the chain at `fa0e79d`, 250
files.

Apply new files from the server with `scripts/migrate-database.sh` against
`webyar`, as `postgres`. The database has no public port, so
`deploy-migrations.yml` cannot reach it; keep the `DATABASE_URL` Actions
secret unset.

The hosted Supabase project still has no ledger. Never run the script
against it.
