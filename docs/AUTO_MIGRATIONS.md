# Automatic database migrations on push

`.github/workflows/deploy-migrations.yml` applies any new file under
`database/migrations/` to your production database automatically, on every
push to `main` that touches that folder. It's a thin wrapper around
`scripts/migrate-database.sh`, which is also runnable by hand.

## How it stays safe to re-run

A ledger table, `public._schema_migrations`, records every migration
filename the script has successfully applied. Each run only executes files
NOT already in that table, in filename order, and records each one
immediately after it succeeds. A push with no new migration files is a
no-op. This matters because several migrations in this chain are **not**
safely re-runnable on their own (e.g. a bare `CREATE POLICY` with no
`IF NOT EXISTS`/drop-first guard) — blindly re-running the whole folder on
every push would fail the second time.

## One-time setup

### 1. Add the `DATABASE_URL` secret

In the repo's GitHub Settings → Secrets and variables → Actions, add
`DATABASE_URL` — a plain Postgres connection string
(`postgres://user:password@host:5432/dbname`) pointing at your production
database. This works identically whether that database is a self-hosted
Postgres instance or your Supabase project's own Postgres (Supabase exposes
a direct connection string under Project Settings → Database — the same
one `psql` can use). Until this secret exists, the workflow logs a warning
and exits successfully without doing anything — it will never fail your
pipeline just because the secret is missing.

### 2. Baseline an already-provisioned database

If your database already has some or all of `database/migrations/` applied
— e.g. you followed `SELF_HOST_GUIDE.md`'s manual instructions when you
first deployed — you MUST mark those files as already applied before the
first automated run, or the workflow will try to re-run them and fail on
the first non-idempotent statement:

```bash
DATABASE_URL="postgres://..." ./scripts/migrate-database-mark-baseline.sh
```

This lists every current `database/migrations/*.sql` filename, asks for
confirmation, and records them in the ledger **without running them**. Run
it exactly once. If you are not sure your database is fully caught up to
the current chain, apply the chain manually first (`SELF_HOST_GUIDE.md`),
then run this.

If you are instead starting from a brand-new, empty database, skip this
step — just let the workflow (or a manual run of `migrate-database.sh`)
apply the full chain from scratch.

## Manual run

Both scripts work outside CI too, e.g. from your own machine or a Coolify
deploy hook:

```bash
DATABASE_URL="postgres://..." ./scripts/migrate-database.sh
```

## Scope

This automates the **self-host migration chain** (`database/migrations/`)
only — the chain applied via a plain Postgres connection string with
`psql`. The separate hosted-Supabase chain (`supabase/migrations/`,
timestamped files) is managed through Supabase's own CLI/dashboard tooling
(`supabase db push`) and is **not** touched by this workflow.
