# Production database mode — runbook

Since 2026-10-05 the production WebYar backend and its workers reach the
hosted Supabase project's PostgreSQL directly (`DATABASE_MODE=postgres-only`).
This was a connection-mode change only: the database, its data and its schema
stayed where they were; no migration was replayed, no baseline was recorded
and no data was moved. See [`docs/DATABASE.md`](../DATABASE.md) for the modes.

No secret value belongs in this file. Credentials live only in Coolify and in
the protected rollback kit on the server.

## What runs where

Coolify on `analyticsme.site`. The seven services switched (Coolify app id,
`WORKER_KIND`, `DATABASE_POOL_MAX`):

| App id | Service | Kind | Pool |
| --- | --- | --- | --- |
| 29 | WebYar Express Backend (`api.webyar.ai`) | — | 6 |
| 30 | WooCommerce Worker | `commerce-sync` | 1 |
| 21 | Channels-Worker | `channels` | 2 |
| 18 | Intelligence Worker | `intelligence` | 1 |
| 24 | Regression AI Worker | `regression-runner` | 1 |
| 27 | Seo-Crawler | `seo-crawler` | 1 |
| 19 | Source Sync Worker | `source-sync` | 1 |

Auto-deploy on push to `main`: apps 29, 30 and the frontend (28). The others
deploy only when triggered in Coolify.

Not switched: the older second backend, **Coolify app 10**, still uses Supabase
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
- Supavisor caps this user at **15** concurrent session-mode connections
  (measured). The pools above add up to 13. A Coolify redeploy briefly runs
  the old and new container side by side, so keep the sum at 13 or below; raise
  a pool only by lowering another, or raise the pooler's pool size in the
  Supabase dashboard first.

## Variables (per switched service, runtime only — never build-time)

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the session-pooler URL for `webyar_app` |
| `DATABASE_MODE` | `postgres-only` |
| `PLATFORM_SIGNING_SECRET` | the value `SUPABASE_SERVICE_ROLE_KEY` has — the signing root of sessions, widget cookies, signed links |
| `DATABASE_POOL_MAX` | see the table |
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
