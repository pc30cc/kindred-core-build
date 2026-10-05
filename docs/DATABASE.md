# Database — plain PostgreSQL or Supabase

Webyar needs exactly one external data service: a **PostgreSQL 15+ database**.
It can be a server you run yourself, a managed PostgreSQL, or a Supabase
project used purely as a database. All three work the same way, and moving
between them means setting a new `DATABASE_URL` and copying the data across
(§6).

Nothing else from Supabase is required. Auth is first-party (`profiles`,
`user_credentials` and `auth_sessions`, issued by the Express server). Files
live in the storage providers configured in Super Admin. Realtime runs over
Centrifugo, with polling as the fallback. The browser never talks to the
database or to Supabase: it talks only to the backend API.

---

## 1. How the server reaches the database

`server/db` gives the code a single entry point. Call sites never choose how
the database is reached (`getServiceClient()`, `serviceClientFor()` and every
worker client come from `server/db/index.ts`). `DATABASE_MODE` decides it
once, at boot, for the backend and every worker:

| `DATABASE_MODE` | Default when | Data | Supabase services |
| --- | --- | --- | --- |
| `postgres-only` | `DATABASE_URL` is set | PostgreSQL directly over a `pg` pool. supabase-js still builds the queries, and an in-process PostgREST-compatible engine (`server/db/postgrest`) turns them into SQL. | **None.** No REST, Realtime, Auth, Storage or Edge Functions. `SUPABASE_URL` and `SUPABASE_*_KEY` are **ignored** even when still set; boot logs which ones. They cannot bring a Supabase service back, and the signing root never falls back to the old service-role key. |
| `postgres+supabase-services` | never (opt-in) | as `postgres-only` | Only the optional ones in §7, with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| `supabase-rest` (legacy) | `DATABASE_URL` is empty | Supabase's REST API (PostgREST) over HTTPS, with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | as before |

A combination that contradicts itself is refused at boot instead of guessed
at. Examples: `postgres-only` without `DATABASE_URL`, or `supabase-rest`
together with `DATABASE_URL`. **There is no fallback between modes.** When the
direct connection is down, the process waits for it
(`DATABASE_CONNECT_ATTEMPTS`) and then exits; it never switches to Supabase's
REST API. `GET /api/health/database` reports the mode.
`src/test/database/databaseMode.test.ts` holds these rules.

Use `postgres-only` for every new install and for every move.

Each pooled connection is prepared once, so it matches what PostgREST gives
the server on Supabase:

- `SET ROLE service_role`. This is the role the server always used. It holds
  the grants the migrations hand out, plus `BYPASSRLS`, which the
  `FORCE ROW LEVEL SECURITY` tables need. The login role must be allowed to
  assume it (§4).
- `search_path = public, extensions`. The `extensions` entry is ignored where
  that schema doesn't exist.
- `request.jwt.claims = {"role":"service_role"}`, so `auth.role()` answers
  exactly as it did for the service-role key.
- `TimeZone = UTC`. This is Supabase's default, so timestamps and day
  boundaries come out the same on any server.

These are **session** settings. That is why a connection through a
*transaction* pooler (Supabase's port 6543, or pgBouncer in transaction mode)
is refused at startup instead of half-working.

### What "PostgREST-compatible" means here

The engine reproduces the PostgREST version the production project runs —
**14.5**, read from the `application_name` of its connections — for
everything the code uses: filters, embeds and their hints, `count`,
pagination, `single` / `maybeSingle`, insert / upsert (including
`defaultToNull: false`), update, delete, RPC (including functions that write),
the error codes (`PGRST116`, `PGRST103`, `PGRST2xx`, SQLSTATEs) and the HTTP
statuses.

`src/test/integration/postgrestEngineParity.pg.test.ts` proves it: 160
supabase-js calls, each compared with what a real PostgREST 14.5 answered
(data, error, count, status, key order) **and** with what the database held
afterwards — every row of every fixture table and the identity counters — so a
write that PostgREST rolls back and the engine keeps (or the reverse) fails
the suite. The recording is in `postgrestParity/expected.json`; re-record it
with `record.ts` when production moves to another PostgREST version.

There are no deliberate differences. Two things worth knowing, both identical
on PostgREST 14.5 and the engine:

- Whatever makes PostgREST answer with an error after the work ran —
  `.single()` over anything but one row, an offset past the end of an exactly
  counted result — rolls the whole request back, writes made inside a
  function included (`src/test/integration/engineRpcRollback.pg.test.ts`).
- `.maybeSingle()` is enforced by supabase-js on the client. A writing RPC or
  mutation that returns several rows under `.maybeSingle()` gets an error,
  but its writes stay — on PostgREST too. Use `.single()` where a multi-row
  write must not be kept.

(PostgREST before 14.4 re-applied an `or()` filter to the rows a PATCH or
DELETE returned; 14.4 fixed it, so production no longer behaves that way.)

Reads are capped at **1000 rows** per request (`DATABASE_MAX_ROWS`), the same
cap Supabase's API applies, so the code behaves the same on both.

---

## 2. Requirements

- **PostgreSQL 15 or newer.** CI runs on 16 and 17, and on Supabase's image
  (see *What CI proves* below for which suite runs where).
- **pgvector** for AI knowledge retrieval (`ai_knowledge_chunks.embedding`).
  Without it, everything else works: migration 250 skips the column with a
  notice. Images that ship it include `pgvector/pgvector:pg17` (used by the
  bundled compose file) and every Supabase project.
- A **direct** or **session-mode** connection, not a transaction pooler.
- For running the migrations: a **superuser**, because `000` creates
  `service_role` with `BYPASSRLS`, and the chain creates extensions. On
  Supabase, `postgres` is enough. On a managed service with no superuser,
  check that its admin role may create `BYPASSRLS` roles.

### What CI proves, and on which server

Production runs PostgreSQL 17 with pgvector 0.8.0 on Supabase. Local
development used PostgreSQL 16 with pgvector 0.6.0.

| Suite | What it proves | Server |
| --- | --- | --- |
| Plain PostgreSQL migration chain | the whole chain applies from empty through `migrate-database.sh`, and a second run applies nothing; `verify-migration-security.sql`; code names no column the schema lacks (`check-code-columns.py`) | `postgres:16` (no pgvector), `pgvector/pgvector:pg17` |
| ″ — `move-data-test.sh` | §6: check, success, retry, four kinds of failure rolled back, Supabase-like target and the reverse move | both of the above |
| ″ — `baseline-verify-test.sh` | the verified baseline (docs/AUTO_MIGRATIONS.md) | both of the above |
| Integration — `postgrestEngineParity.pg.test.ts` | the engine against PostgREST 14.5's recorded answers and database state, 160 cases | `pgvector/pgvector:pg16` |
| Integration — `engineRpcRollback.pg.test.ts` | a writing set-returning function under `.single()` leaves nothing behind | ″ |
| Integration — `productionParity251.pg.test.ts` | 251's plan-and-access functions, seat capacity, the new-workspace trigger, and that 251 runs twice unchanged, on a database built by the whole chain | ″ |
| Integration — `postgresOnlyAcceptance.pg.test.ts` | the main paths under `postgres-only`, with outbound requests refused (below) | ″ |
| Hosted Supabase full migration chain | `supabase/migrations` on Supabase's own image | Supabase CLI |

`postgresOnlyAcceptance.pg.test.ts` sets `DATABASE_URL`, leaves the old
`SUPABASE_*` variables set, and does not enable unlimited billing. It
refuses and records every outbound request that is not to this machine.
On production's plan policy (trial signups and the trial plan's limits) it
covers:

- signup, verification, login and the session cookie;
- workspace creation, with the second refused by the plan and allowed by an
  override;
- an operator message, stored, counted and published through Centrifugo;
- an AI-credit invoice;
- a file uploaded to local storage and read back;
- AI knowledge retrieval over pgvector embeddings;
- the invitations worker.

It passes only if nothing went to Supabase or anywhere else.

---

## 3. A fresh install

### 3a. Bundled PostgreSQL (docker compose)

```sh
cp .env.docker.example .env
# In .env set at least:
#   POSTGRES_PASSWORD=$(openssl rand -hex 32)
#   PLATFORM_SIGNING_SECRET=$(openssl rand -hex 32)
#   (plus the other secrets the file lists)
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

`docker-compose.postgres.yml` adds:

- `postgres`: `pgvector/pgvector:pg17`, with its data in the `postgres-data`
  volume. It is reachable only on the compose network, plus
  `127.0.0.1:${POSTGRES_PORT:-5432}` for `psql` and `pg_dump`.
- `migrate`: runs `scripts/migrate-database.sh` once per start, before the
  backend and workers start. It applies only the files not yet in the ledger.

It also points the backend and workers at that database. `DATABASE_URL` is
derived from `POSTGRES_PASSWORD` unless you set one yourself.

### 3b. Your own PostgreSQL server

```sh
# 1. As a superuser: the database, and the role the application logs in as.
psql -c "CREATE DATABASE webyar"
psql -c "CREATE ROLE webyar_app LOGIN PASSWORD '…'"

# 2. The schema, as the superuser. Every file in database/migrations, in
#    order, recorded in public._schema_migrations so a re-run applies only
#    new files:
DATABASE_URL=postgresql://postgres:…@db-host:5432/webyar ./scripts/migrate-database.sh

# 3. Let the application act as service_role (§4):
psql -d webyar -c "GRANT service_role TO webyar_app"

# 4. The application:
DATABASE_URL=postgresql://webyar_app:…@db-host:5432/webyar
PLATFORM_SIGNING_SECRET=$(openssl rand -hex 32)
```

Logging the application in as the superuser itself also works. The bundled
compose file does exactly that. A dedicated role is the safer choice.

### 3c. Supabase used only as the database

1. In the Supabase dashboard, open **Project Settings → Database → Connection
   string** and take either:
   - **Direct connection**: `postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres`
     (IPv6 only, unless the project has the IPv4 add-on), or
   - **Session pooler**: `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
     (works over IPv4).

   Never use the **transaction pooler** (port 6543); the server refuses it.
   TLS is used automatically for any non-local host. Use
   `DATABASE_SSL=verify-full` with `DATABASE_SSL_CA=<Supabase CA file>` to also
   verify the certificate.
2. **New project:** build the schema with the same script,
   `DATABASE_URL=<that string> ./scripts/migrate-database.sh`. Here `000` and
   `000a` find Supabase's roles and `auth` schema already in place and change
   nothing.
   **Existing project** (the hosted one, built from `supabase/migrations`):
   the schema is already there; see §5.
3. Set `DATABASE_URL` and `PLATFORM_SIGNING_SECRET` on the backend and workers.
   `SUPABASE_URL` and `SUPABASE_*_KEY` are then optional (§7).

---

## 4. Roles

`database/migrations/000_selfhost_roles_bootstrap.sql` creates the three
roles the chain grants to, when they are missing: `anon`, `authenticated` and
`service_role` (`NOLOGIN`, `BYPASSRLS`). `000a_selfhost_auth_compat.sql`
provides the `auth` names the older migrations refer to: an empty
`auth.users` / `auth.sessions` stub and `auth.uid()`, `auth.role()`,
`auth.email()` and `auth.jwt()` with Supabase's semantics. On Supabase both
files are no-ops.

The server's login role must be able to `SET ROLE service_role`:

- a superuser always can, and so can `postgres` on Supabase;
- any other role needs `GRANT service_role TO webyar_app;`. On PostgreSQL
  16+, a membership granted `WITH SET FALSE` (or the one a `CREATEROLE` user
  gets for a role it creates) is not enough: grant it `WITH SET TRUE`.

If the login role can't do this, every query fails, and the error names the
`GRANT` that fixes it. Running as the login role instead would be quietly
wrong: tables with `FORCE ROW LEVEL SECURITY` (AI pricing, rate cards and
wallets) would read as empty. `DATABASE_ROLE=none` runs as the login role on
purpose.

---

## 5. Switching the running production install to `DATABASE_URL`

This changes how the server connects. It moves no data. The database is
still the same Supabase project.

1. Take the project's session-pooler or direct connection string (§3c).
2. Set on the backend **and every worker**:
   ```sh
   DATABASE_URL=<connection string>
   PLATFORM_SIGNING_SECRET=<the current SUPABASE_SERVICE_ROLE_KEY value>
   ```
   `PLATFORM_SIGNING_SECRET` is the root of the server's own HMAC keys: widget
   sessions, visitor cookies, signed attachment links, realtime topics and
   recording tokens. Until now these were derived from the service-role key.
   Using the **same value** keeps every existing session and link valid. A
   new random value works too, but it logs every widget visitor out and
   invalidates links already sent.
3. Restart. `GET /api/health/database` should answer
   `{"status":"ok","mode":"postgres-only","driver":"postgres","role":"service_role",…}`.
4. `SUPABASE_URL` and `SUPABASE_*_KEY` may stay set. Under `postgres-only`
   they are ignored (boot names them), so removing them later changes
   nothing. Realtime keeps running on Centrifugo, already first in
   production's provider order. Supabase Realtime, second in that order, is
   no longer offered; set `DATABASE_MODE=postgres+supabase-services` only to
   keep it during a transition.

To roll back, unset `DATABASE_URL` and restart. The legacy driver comes back
with no other change.

**Schema changes afterwards.** The hosted project was built from
`supabase/migrations` and has no `public._schema_migrations` ledger. Before
`scripts/migrate-database.sh` or `deploy-migrations.yml` ever runs against it,
record what it already holds with `scripts/db/baseline-verify.sh`
(docs/AUTO_MIGRATIONS.md). That script records a file only when its changes
are found in the database's catalog. Otherwise `migrate-database.sh` would
replay the whole chain.

---

## 6. Moving the data: Supabase ⇄ PostgreSQL

`scripts/db/move-data.sh` copies all application data from one database to
another, in either direction. It has two modes:

```sh
# read-only on both sides: what a move would do, and whether it can
SOURCE_DATABASE_URL=postgresql://…  TARGET_DATABASE_URL=postgresql://… \
  bash scripts/db/move-data.sh check

# the move
SOURCE_DATABASE_URL=postgresql://…  TARGET_DATABASE_URL=postgresql://… \
  bash scripts/db/move-data.sh run
```

**`check`** writes nothing to either database: every session it opens is
`default_transaction_read_only`. It reports the server versions, whether the
target can hold pgvector data, how many migrations the target still lacks,
whether the source role can read every row and the target role owns every
table, the size of the copy, and who is still connected to the source. When
the target's schema is already complete, it also checks that every source
column has a place on the target and runs `scripts/db/schema-diff.sh`. Run it
as often as you like, against production too.

**`run`** goes through these phases. Each failure message says what had
already changed.

| Phase | Writes to | On failure |
| --- | --- | --- |
| 1. Preflight (as `check`). Also stops when a target table holds rows and the source has no table of that name: the copy would not replace them and the schemas could not match, so what happens to them is left to you | nothing | nothing changed |
| 2. Confirmation: type `replace`, or `YES=1`. It comes **before** anything is written, and lists the migrations phase 3 will apply | nothing | nothing changed |
| 3. Target schema: `scripts/migrate-database.sh` on the target, if migrations are missing. A migration can convert or delete rows already on the target, not only change its schema (251 does both; it keeps legacy tables that still hold rows) | the **target's schema**, and rows a migration converts | **Not undone.** Migrations are forward-only and run outside phase 6's transaction. Files before the failing one are applied and recorded in `_schema_migrations`. The failing file is not recorded and may be **partly** applied, because files run statement by statement (some cannot run in one transaction, e.g. `CREATE INDEX CONCURRENTLY`). No data was copied. Fix the cause and run again; if the failing file is not safe to run twice, first undo the part of it that applied. |
| 4. Schema match: the target must present the source's schema (functions, triggers, constraints, columns, policies, rules, grants…) up to the reviewed differences in `scripts/db/schema-parity-allowlist.txt` | nothing | no data copied; the migrations phase 3 applied stay applied |
| 5. Source snapshot: per-table row count and content checksum, `pg_dump --data-only`, checksums again | nothing | something wrote to the source during the dump; no data copied to the target (phase 3's migrations stay applied) |
| 6. Load and validate, in **one transaction** on the target | the target's data | **The copy is rolled back** (below); phase 3's migrations are not part of it and stay applied |
| 7. Final check: committed target vs. source snapshot, the schema match again, the source's checksums again | nothing | the target is committed. If the source changed after the snapshot, those writes are **not** on the target, so stop the writer and run again. |

Phase 6 in detail, all inside one transaction:

1. Switch off the tables' own triggers, exactly the ones that are on. They
   would re-run side effects the source already holds, such as seeding
   billing rows for every loaded workspace.
2. Make the foreign keys that form a cycle between tables
   `DEFERRABLE INITIALLY DEFERRED`, e.g. `workspace_subscriptions` ⇄
   `billing_subscription_periods` and `billing_payments` ⇄
   `billing_payment_intents` ⇄ `billing_wallet_deposits`. Rows that reference
   each other cannot be loaded one table at a time.
3. Empty `public`'s tables, `TRUNCATE … RESTART IDENTITY` (no `CASCADE`).
4. Load the rows. Every other foreign key is **enforced** as each table goes
   in.
5. `SET CONSTRAINTS ALL IMMEDIATE`, which checks the deferred keys on every
   row. Then put those keys back as `NOT DEFERRABLE` and every trigger back in
   its earlier mode (`ENABLE`, `ENABLE ALWAYS`, `ENABLE REPLICA`; a disabled
   trigger stays disabled).
6. Before `COMMIT`:
   - check every validated foreign key again;
   - check that every sequence is ahead of the rows it numbers;
   - check that every table's row count **and content checksum** equal the
     source snapshot's.

The checksum covers each row as `jsonb`, so column order does not matter. It
is limited to the source's columns, with pgvector values compared as `real[]`.
The session's output settings are pinned so equal values hash equally on both
servers.

If any of this fails, the transaction rolls back. The target's rows,
triggers, foreign keys and the sequences its columns own are exactly as they
were before phase 6. `TRUNCATE … RESTART IDENTITY` in the same transaction
makes the dump's `setval()` on them transactional. A sequence that no column
owns is the one thing PostgreSQL does not roll back. The script records those
first and sets them back after a failure (there are none in the chain today).

Phase 6 needs the role that **owns the tables**, the one that ran the
migrations (`postgres` on Supabase), plus `BYPASSRLS` or ownership without
`FORCE RLS` to load past row-level security. It does not need a superuser.
The source role must be able to read every row: a role that RLS would filter
is refused, not silently copied in part. The target's public data is replaced,
and its ledger (`public._schema_migrations`) is kept. The source is only ever
read.

`scripts/ci/move-data-test.sh` runs all of this in CI on `postgres:16` and
`pgvector/pgvector:pg17`, against throwaway databases:

- `check` changes nothing, with both databases set to refuse writes;
- success into an empty target, and a retry over a populated one;
- a source row orphaned under a `NOT VALID` foreign key;
- a source sequence behind its rows (fails after `setval()` ran), with a
  sequence no column owns;
- a reviewed type difference that rounds a value, which only the content
  checksum can see;
- a writer on the source during the dump;
- a Supabase-like target owned by a non-superuser `BYPASSRLS` role, with
  `FORCE RLS` tables, and the move back out of it;
- refusals for an RLS-filtered source role, a target role that does not own
  the tables, and the same database twice.

After every failure the target's rows, triggers, constraints and sequences
are compared with their state before the run.

### Stop every writer to the source first

Phase 5 refuses a source that changes during the dump, and phase 7 detects
one that changed afterwards. But only a source with **no writer at all**
gives a consistent copy. Stop all of these, and keep them stopped until the
application points at the target:

- the **backend** (`backend` service). It also runs in-process tickers:
  billing, retention, notifications, rollups, the realtime outbox, and, when
  their `*_WORKER_INPROC` flags are set, the KB, source-sync, regression and
  invitation workers;
- **every worker container**, whatever its `WORKER_KIND`: `intelligence`,
  `source-sync`, `file-ingest`, `regression-runner`, `channels`,
  `invitations`, `seo-crawler`, `commerce-sync`, `retention`, `all`;
- the **channels gateway** and the **AI runtime**. They hold no database
  credentials but call the backend; stopping them keeps queued work from
  piling up;
- anything else connected to the source. `check` lists the sessions by
  `application_name`. On the hosted project:
  - Supabase **Edge Functions**. Two legacy ones are deployed and unused (§7);
    make sure nothing invokes them;
  - **scheduled jobs**. The hosted project's database has neither the
    `pg_cron` nor the `pg_net` extension installed, so nothing in it runs on
    a schedule. Supabase's own launcher processes for them run, with no jobs.

The client tools must be at least as new as the newer server. The simplest
way is to run the script from the matching image:

```sh
docker run --rm -it --network host -v "$PWD":/app -w /app \
  -e SOURCE_DATABASE_URL -e TARGET_DATABASE_URL \
  pgvector/pgvector:pg17 bash scripts/db/move-data.sh check
```

`--network host` lets the container reach a database published on the
host's `127.0.0.1`, such as the bundled one.

### Supabase → your own PostgreSQL

1. Start only the new database. With the bundled one (§3a), run
   `docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres`.
   With your own server (§3b), create the database and roles. The script
   builds the schema itself.
2. Stop the application.
3. `SOURCE_DATABASE_URL=<Supabase session-pooler or direct URL>`,
   `TARGET_DATABASE_URL=<new server>`. Run `check`, then `run`.
4. Set `DATABASE_URL` to the new server, keep `PLATFORM_SIGNING_SECRET` and
   `PLUGIN_SECRETS_MASTER_KEY` unchanged (§5), and start the application.
   Signed sessions, links and the encrypted plugin secrets in the database
   depend on them.

To go back, point `DATABASE_URL` at the source again. It was only read, so
it holds everything up to the moment the application stopped. Writes made on
the target since then are not on it.

### Your own PostgreSQL → Supabase

The same steps with source and target swapped. The target is a Supabase
project's connection string. A brand-new, empty project is the simple case,
since the script builds its schema. An existing project that was built from
`supabase/migrations` must first have its ledger baselined with
`scripts/db/baseline-verify.sh` (§5). Otherwise the script would replay the
whole chain on it.

### Moving the file storage

Uploaded files (avatars, attachments, recordings) are not in the database.
They live in the storage providers configured in Super Admin → Storage, and
the database stores only their keys. A database move leaves them where they
are.

---

## 7. Supabase services that remain optional

Only with `DATABASE_MODE=postgres+supabase-services` (or the legacy driver):

| Feature | Needs | Without it (`postgres-only`) |
| --- | --- | --- |
| Supabase Realtime transport | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Centrifugo carries realtime; it is the first transport in the provider order (production runs on it today). The order in Super Admin skips Supabase Realtime, and polling remains only as the last fallback when Centrifugo is unreachable. |
| Cleanup of legacy `auth.users` rows on user deletion | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Skipped: identity lives in `public.profiles` / `user_credentials`, and nothing reads `auth.users` |

The channels gateway and the AI runtime never get database credentials. They
refuse to start with `DATABASE_URL`, `PLATFORM_SIGNING_SECRET` or the
service-role key set.

### What is left on the hosted Supabase project, and the plan for it

Inspected read-only. Nothing has been deleted.

- **Two Edge Functions** are deployed. Nothing in this repository calls them:
  the browser, widget, backend and workers reach only the backend API. Plan:
  check their invocation logs over a full billing cycle. If there are none,
  delete them in the dashboard after the move. Before that, they are one of
  the writers to stop (§6).
- **`auth.users`** holds one legacy row. Sign-in uses `profiles` +
  `user_credentials` (every profile has credentials) and first-party
  `auth_sessions`. Plan: leave the row; it is unused. A move copies only
  `public`, so the row stays on the Supabase project and nothing on the
  target depends on it. Remove it there only once the project is retired.
- **Storage** buckets are empty. Files live in the providers configured in
  Super Admin.

## 8. Environment reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | The database. Its presence makes `postgres-only` the default mode. |
| `DATABASE_MODE` | `postgres-only` with `DATABASE_URL`, else `supabase-rest` | `postgres-only`, `postgres+supabase-services` or `supabase-rest` (§1). |
| `PLATFORM_SIGNING_SECRET` | — (`SUPABASE_SERVICE_ROLE_KEY` only under `supabase-rest`) | Root of the server's HMAC keys; at least 32 characters. Required with `DATABASE_URL`. Keep it across a move (§5). |
| `PLUGIN_SECRETS_MASTER_KEY` | — | Encrypts plugin and channel secrets stored in the database. Keep it across a move, or those secrets cannot be read. |
| `DATABASE_SSL` | `disable` for localhost and container names, `require` otherwise | `disable`, `require` (encrypted, not verified) or `verify-full`. `sslmode=` in the URL works too. |
| `DATABASE_SSL_CA` | — | CA certificate, as PEM text or a file path, for `verify-full`. |
| `DATABASE_POOL_MAX` | `10` for the backend; `3` per worker container (`5` for `all` or several kinds) | Most connections this process opens (below). |
| `DATABASE_ROLE` | `service_role` | Role every session assumes. The login role must be allowed to `SET ROLE` to it (§4). `none` means stay the login role. |
| `DATABASE_SCHEMAS` | `public` | Exposed schemas, as PostgREST's `db-schemas`. |
| `DATABASE_MAX_ROWS` | `1000` | Row cap on reads; `0` means no cap. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `120000` | Per-statement timeout. |
| `DATABASE_APPLICATION_NAME` | `webyar` | Shown in `pg_stat_activity`. |
| `DATABASE_CONNECT_ATTEMPTS` | `30` | Boot-time wait for the database, 2 s apart. |
| `DATABASE_ALLOW_TRANSACTION_POOLER` | — | `1` disables the port-6543 refusal. Only for a pooler you know runs in session mode. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | — | Only with `DATABASE_MODE=postgres+supabase-services` (§7) or `supabase-rest`. Ignored under `postgres-only`. |

### Connections: the budget across processes

Under `supabase-rest`, every process reached the database through
PostgREST's single pool: 11 connections on the hosted project. With
`DATABASE_URL`, **each process has its own pool**:

- the backend, the server process;
- every worker container;
- the `migrate` job while it runs.

The channels gateway and the AI runtime hold no database credentials.

A pool opens connections only as queries need them, up to its maximum, and
closes them after 30 s idle. So the worst case is the sum of the maxima:

```
DATABASE_POOL_MAX(backend) + Σ DATABASE_POOL_MAX(each worker container)
  ≤ max_connections − superuser_reserved − what else connects
```

On the hosted project (read on 2026-10-05) `max_connections` is 60, with 3
reserved, and Supabase's own processes hold about 11. That leaves about 45
for the application. With the defaults, the backend (10) plus, say, seven
worker containers (7 × 3) comes to 31 at most. That is more than the 11 the
whole application has today through PostgREST, and well within the limit.
Each process logs its maximum at boot ("pool up to N connection(s)").
Sum them before adding containers or raising `DATABASE_POOL_MAX`. A server
that runs out refuses new connections to every client, Supabase's own
included.

Two more sources of database load were looked at:

- `GET /api/platform/public/config` runs on every page load. It needs four
  database operations, and its response is now kept in memory
  (`server/services/platformPublicConfig.ts`):
  - for at most 30 s;
  - dropped by every Super Admin write to branding, localized branding,
    platform region settings or the widget platform settings;
  - one load at a time.

  `src/test/database/platformPublicConfigCache.test.ts` counts the database
  operations: 4 for the first request and 0 for every repeat within the TTL,
  25 concurrent cold requests share one load of 4, and a write shows on the
  next read. Another backend replica can serve the old values for at most
  the TTL.
- The engine's schema cache. One load is 4 catalog queries, about 65 ms
  (median of 12) for the 316 tables and 696 functions of the full chain on
  PostgreSQL 16. It reloads every 5 minutes, and on a request naming
  something it does not know, at most once a second. Code that names a
  column the database lacks would hit that path on every call;
  `scripts/ci/check-code-columns.py` keeps such names out of the code.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `DATABASE_URL points at a transaction-mode pooler (port 6543)` at startup | Use the session pooler or the direct connection (§3c). |
| `DATABASE_ROLE: login role "x" cannot SET ROLE service_role` | Run the `GRANT` the message names (§4). |
| `DATABASE_ROLE: role "service_role" does not exist` | The migrations have not run on this database: `scripts/migrate-database.sh`. |
| `self-signed certificate` / `unable to verify` | `DATABASE_SSL=require` (encrypted, not verified), or `verify-full` with `DATABASE_SSL_CA`. |
| `no pg_hba.conf entry … no encryption` | The server requires TLS but `sslmode=disable` (or a local host name) turned it off. Set `DATABASE_SSL=require`. |
| AI knowledge answers fail with `column "embedding" does not exist` | The server has no pgvector. Install it (or use `pgvector/pgvector:pg17`), then apply `database/migrations/250_postgres_portability.sql` once more by hand. Its ledger entry stops the script from doing so. |
| `move-data.sh`: "These source columns do not exist on the target" | The source has columns no migration creates. Add them with a migration, then run it again. Nothing was written. |
| `move-data.sh`: "The target's schema does not match the source's" | `schema-diff.sh` lists each difference. A function, trigger or constraint the target lacks would change what the application does there. Bring the schemas together with a migration, or, after review, add the difference to `scripts/db/schema-parity-allowlist.txt`: the object's kind and key, its two definitions (the hashes `schema-fingerprint.sql` prints, `-` where it is absent) and the reason. An entry covers that object between exactly those two definitions; anything else still fails. Function bodies are compared as written — string literals, comments and whitespace included — so a comment-only edit is a difference too. The content checksum still catches a reviewed difference that changes data. |
| `move-data.sh`: "Something wrote to the source" | A writer is still running (§6, *Stop every writer*). Nothing was written to the target. |
| `pg_dump: server version mismatch` | Run the script from a newer client image (§6). |
| Widget visitors logged out after the switch | `PLATFORM_SIGNING_SECRET` differs from the old service-role key (§5). |

`GET /api/health/database` reports the driver, the server's major version, the
role queries run as and the round-trip time. It never reports the host or the
credentials.
