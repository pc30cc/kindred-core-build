# Production database mode — runbook

**Status: prepared, pending deployment and production verification
(2026-10-05).** This file describes the switch of the production WebYar
backend and its workers to the hosted Supabase project's PostgreSQL over a
direct connection (`DATABASE_MODE=postgres-only`). Prepared so far: the login
role, the Coolify variables on the seven services (the code they run now does
not read them yet) and the rollback kit. The switch takes effect only when
each service is deployed with the code that reads them. Until this line says
otherwise, production still runs through Supabase REST.

It is a connection-mode change only: the database, its data and its schema
stay where they are; no migration is replayed, no baseline is recorded and no
data is moved. See [`docs/DATABASE.md`](../DATABASE.md) for the modes.

No secret value belongs in this file. Credentials live only in Coolify and in
the protected rollback kit on the server.

## What runs where

Coolify on `analyticsme.site`. The seven services being switched (Coolify app
id, `WORKER_KIND`, `DATABASE_POOL_MAX`):

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
| Coolify on this server runs at most **2** deployments at a time (server setting `concurrent_builds` = 2); further ones wait in its queue. A push to `main` queues 28 (no database), 29 and 30; a manual worker deployment joins the same queue. The worst pair is the backend and one worker: 9 + 3 + 1 | **13** |
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

The first cutover is lower still: the containers being replaced use REST, not
PostgreSQL, so the old side holds no connection (peak 9).

Rules that keep this true:

- Keep `steady + the two largest pools ≤ 13`. Raise a pool only by lowering
  another, or raise the pooler's pool size in the Supabase dashboard first and
  measure the new cap.
- Keep Coolify's `concurrent_builds` at 2 on this server, or recompute: each
  extra concurrent deployment adds up to the backend's pool.
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
| `DATABASE_APPLICATION_NAME` | `webyar-backend`, `webyar-worker-<kind>` |

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

## Rollback

The rollback kit is on the server, root only:
`/root/webyar-rollout/20261005-postgres-only/` — its `README.md` has the exact
commands. It holds the Coolify variable rows of the seven apps as they were
before the switch (values and which keys existed), the images each app ran,
the deploy and restore scripts, and the `webyar_app` credential.

1. Restore the variables: delete the five added keys from the seven apps
   (`restore_env.php`) — `DATABASE_URL` **and** `DATABASE_MODE` both, never
   one without the other. `PLATFORM_SIGNING_SECRET` may also stay: it equals
   the service-role key, so signatures are valid either way.
2. Redeploy each app on its previous image with `deploy.php`
   (`ROLLBACK=1`, the commit listed in the kit's README) — no rebuild.
3. Check `/api/health` (200) and the workers' logs.

An application rollback never touches database data. Do not run
`move-data.sh`, `migrate-database.sh` or a baseline against production as part
of it.

## Migrations

Production has no `public._schema_migrations` ledger. `migrate-database.sh`
(and so `deploy-migrations.yml`) refuses to run against it until it is
baselined with `scripts/db/baseline-verify.sh` (docs/AUTO_MIGRATIONS.md); keep
the `DATABASE_URL` Actions secret unset until then.
