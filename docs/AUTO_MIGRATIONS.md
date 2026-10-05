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
one `psql` can use; the session pooler on port 5432 works too, the
transaction pooler on 6543 does not). Until this secret exists, the workflow
logs a warning and exits successfully without doing anything — it will never
fail your pipeline just because the secret is missing. Connect as a superuser
(`postgres` on Supabase): the chain creates roles and extensions.

### 2. Baseline an already-provisioned database

A database that already holds some or all of `database/migrations/` but has
no ledger must have those files recorded before the first automated run.
Otherwise the workflow re-runs them and fails on the first non-idempotent
statement. This covers a database built by hand (`SELF_HOST_GUIDE.md`) and
the hosted Supabase project built from `supabase/migrations/`.

Nothing is recorded on trust. `scripts/db/baseline-verify.sh` decides file by
file from the database's own catalog:

```bash
# read-only on the target; builds a reference chain on a THROWAWAY server
REFERENCE_ADMIN_URL="postgresql://postgres:…@scratch-host:5432/postgres" \
TARGET_DATABASE_URL="postgres://…" \
  ./scripts/db/baseline-verify.sh report
```

It applies the chain one file at a time to a reference database on the
throwaway server (a superuser there; the same PostgreSQL major as the
target, with pgvector if the target has it). After each file it records every
object the file added, changed or removed:

- functions with their bodies, security and settings;
- triggers with their enabled state;
- constraints, columns, indexes, RLS policies and rules;
- `service_role` grants, types, sequences and extensions.

Every one of those changes is then looked up on the target. Each file gets
one verdict:

| Verdict | Meaning |
| --- | --- |
| `applied` | its changes are on the target, or later files' changes to the same objects are |
| `pending` | the target still has the objects as they were before this file |
| `partial` | some of each: the file stopped half-way, or someone undid part of it |
| `drift` | an object it touches matches no file's version: changed by hand |
| `unverifiable` | it changes nothing the catalog shows: data-only, `anon`/`authenticated` grants, storage parameters, or changes later superseded either way |

Then:

```bash
REFERENCE_ADMIN_URL=… TARGET_DATABASE_URL=… ./scripts/db/baseline-verify.sh mark
```

`mark` records the `applied` files and nothing else. It refuses to write
anything while:

- a file is `partial` or `drift`;
- a `pending` file comes before an `applied` one (`migrate-database.sh` would
  run the old file after newer ones);
- an `unverifiable` file before the last applied one is undecided. Read each
  such file and name it in `ASSUME_APPLIED="a.sql b.sql"` (it ran, record it)
  or `RUN_AGAIN="c.sql"` (let `migrate-database.sh` run it now).

`report` also warns about files the ledger already records but the catalog
says are not applied.

The hosted project, checked read-only on 2026-10-05: its catalog matches
the chain through `251_production_parity.sql`. Every kind of object
(functions, triggers, constraints, columns, indexes, policies,
`service_role` grants, types, views) hashes identically, outside the reviewed
differences in `scripts/db/schema-parity-allowlist.txt`. Function bodies are
compared as written, so 61 functions whose text differs from production's
only in comments, whitespace, or a `public.` prefix under
`search_path=public` are listed there one by one, each with both hashes, after
their code lines were compared with production's. So the verdicts are 208
`applied` (251 included: its changes are already there), 42 `unverifiable`,
and nothing `pending`, `partial` or `drift`. Those 42 must be decided one by
one before `mark` runs there.

### The unverifiable files

`scripts/db/baseline-evidence.sql` checks, read-only, whether the effect of
each of them is present. It reports counts and booleans only. **Never put a
file in `RUN_AGAIN` without reading it.** Several are not safe to run twice
on a database that already has the full schema:

| File | Run again on a complete database |
| --- | --- |
| `004` | inserts the 6 global feature flags a second time (NULL `workspace_id` never conflicts) |
| `016` | recreates `operator_activity_samples`, which `223` dropped |
| `029` | marks as verified again emails an admin has since reset |
| `045` | grants `authenticated` read access to `widget_platform_settings` again, webhook secret included, until `046` runs |
| `069` | turns deliberately empty widget texts back into NULL |
| `116` | backfills billing V2 (below) |
| `201` | fails: it names `billing_v2_invoice_arm_dunning`, which `251` replaced |
| `244` | closes again support tickets an operator reopened |

Each of the others is idempotent on its own: guarded `IF [NOT] EXISTS`,
grants and revokes that repeat the current state, or updates limited to rows
not yet changed.

On the hosted project the evidence was read on 2026-10-05:

- **8 files whose only catalog change is a function production holds with
  other comments**: `011` and `139` (`_ai_kb_apply_generated`), `072`
  (`ensure_active_conversation`), `088` and `092` (`wi_execute_idempotent`),
  `127` (`admin_reset_settings_tables`), `129`
  (`billing_v2_schedule_invoice_notifications`), `157`
  (`billing_v2_resolve_billing_recipient`). Production's version of each has
  the same arguments, result, security, settings and code lines as the
  chain's final one (the allowlist entries). The effect is present: record
  them with `ASSUME_APPLIED`.
- **33 of the other 34: the effect is present.** Record them with `ASSUME_APPLIED`.
  This covers seeds, backfills, customer-role grants, dropped objects and
  storage parameters. Two caveats remain, and both are Supabase's own
  platform state, not something these files can change there:
  - `000`'s `ALTER DEFAULT PRIVILEGES … REVOKE` is not in effect. Supabase
    keeps default grants for `anon` / `authenticated` on objects that
    `postgres` and `supabase_admin` create.
  - `217` leaves two such default function grants, held by `supabase_admin`.

  Every existing function and table is locked down explicitly: 0 definer
  functions open to customers outside `217`'s allow-list, 0 executable by
  `PUBLIC`.
- **`116_billing_v2_backfill.sql`: not applied.** Production has no
  `legacy_migration` periods, 3 subscriptions without a billing anchor and 3
  workspaces without a wallet account, and it bills on the V1 engine.
  - Running 116 would move live subscriptions to the V2 engine: a change in
    how customers are billed, not a schema catch-up.
  - Recording it with `ASSUME_APPLIED` keeps today's billing.
  - Leaving it to run (`RUN_AGAIN`) is the decision to move to V2, and it
    belongs to the owner. Note that the file runs without a transaction and
    ends with a check that can raise, leaving its earlier updates committed.

If you are instead starting from a brand-new, empty database, skip this
step. Let the workflow (or a manual run of `migrate-database.sh`) apply the
full chain from scratch. That is the case for:

- a fresh plain PostgreSQL;
- a fresh Supabase project;
- the target of `scripts/db/move-data.sh`, which runs `migrate-database.sh`
  itself ([`DATABASE.md`](DATABASE.md)).

## Manual run

These scripts work outside CI too, e.g. from your own machine or a Coolify
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
