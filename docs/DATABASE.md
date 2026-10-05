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

`server/db` gives the code a single entry point with two drivers. Call sites
never choose between them (`getServiceClient()`, `serviceClientFor()` and every
worker client come from `server/db/index.ts`):

| Driver | Chosen when | What happens |
| --- | --- | --- |
| `postgres` | `DATABASE_URL` is set | The server connects to PostgreSQL directly over a `pg` pool. supabase-js still builds the queries, and an in-process PostgREST-compatible engine (`server/db/postgrest`) turns them into SQL. No Supabase service is involved. |
| `supabase-rest` (legacy) | `DATABASE_URL` is empty | The previous behaviour: Supabase's REST API (PostgREST) over HTTPS, with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. It is kept so that an install that has not set `DATABASE_URL` yet keeps running unchanged. |

Use `postgres` for every new install and for every move.

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

The engine reproduces PostgREST **13** (the version Supabase runs) for
everything the code uses: filters, embeds and their hints, `count`, `single` /
`maybeSingle`, upsert, RPC, ranges, the error codes (`PGRST116`, `PGRST2xx`,
SQLSTATEs) and the HTTP statuses. Two parts of the test suite prove it:

- `src/test/integration/postgrestEngineParity.pg.test.ts` runs 125
  supabase-js calls through the engine and compares data, error, count,
  status and key order with answers recorded from a real PostgREST 13.0.8
  (`postgrestParity/expected.json`).
- When the engine was built, every `.select()` string in `server/` and
  `worker/` (1,073 of them) was run against both a real PostgREST and the
  engine over the same database. All gave identical results.

There is one deliberate difference. With `return=representation` (a mutation
followed by `.select()`), PostgREST applies an `or()` filter a second time to
the returned rows. The engine applies it once, as the code intends. On
Supabase, this PostgREST behaviour makes the GDPR anonymiser's
`identity_merges` delete remove nothing. On the `postgres` driver it works.

Reads are capped at **1000 rows** per request (`DATABASE_MAX_ROWS`), the same
cap Supabase's API applies, so the code behaves the same on both.

---

## 2. Requirements

- **PostgreSQL 15 or newer.** CI runs on 16 and 17, and on Supabase's image.
- **pgvector** for AI knowledge retrieval (`ai_knowledge_chunks.embedding`).
  Without it, everything else works: migration 250 skips the column with a
  notice. Images that ship it include `pgvector/pgvector:pg17` (used by the
  bundled compose file) and every Supabase project.
- A **direct** or **session-mode** connection, not a transaction pooler.
- For running the migrations: a **superuser**, because `000` creates
  `service_role` with `BYPASSRLS`, and the chain creates extensions. On
  Supabase, `postgres` is enough. On a managed service with no superuser,
  check that its admin role may create `BYPASSRLS` roles.

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
   `{"status":"ok","driver":"postgres","role":"service_role",…}`.
4. `SUPABASE_URL` and `SUPABASE_*_KEY` may stay set. They then serve only the
   optional Supabase Realtime transport (§7), and removing them later is
   safe.

To roll back, unset `DATABASE_URL` and restart. The legacy driver comes back
with no other change.

**Schema changes afterwards.** The hosted project was built from
`supabase/migrations` and has no `public._schema_migrations` ledger. Before
`scripts/migrate-database.sh` or `deploy-migrations.yml` ever runs against it,
record what is already applied:
`DATABASE_URL=… ./scripts/migrate-database-mark-baseline.sh`
(docs/AUTO_MIGRATIONS.md). Otherwise the script would replay the whole chain.

---

## 6. Moving the data: Supabase ⇄ PostgreSQL

`scripts/db/move-data.sh` copies all application data from one database to
another, in either direction.

```sh
SOURCE_DATABASE_URL=postgresql://…  TARGET_DATABASE_URL=postgresql://… \
  bash scripts/db/move-data.sh
```

What it does:

1. **Builds the target's schema from `database/migrations`** with
   `migrate-database.sh`. The schema is never copied from the source:
   Supabase keeps extensions in an `extensions` schema and plain PostgreSQL
   keeps them in `public`, and a schema dump carries one layout into the
   other.
2. Checks that the target has pgvector when the source does, and that
   **every source table and column exists on the target**. Any gap aborts
   the run, lists what is missing and writes nothing.
3. Asks you to type `replace`, unless `YES=1` is set.
4. Copies **only data**: `pg_dump --data-only` of schema `public`, loaded
   with triggers and FK checks off, inside **one transaction**. Either all of
   it lands or none of it does. Sequences come along.
5. Compares the **row count of every table** on both sides.

The target's existing public data is replaced, and its migration ledger is
kept. The source is only read. Stop the application, or put it in
maintenance, for the duration.

The client tools must be at least as new as the newer server. The simplest
way is to run the script from the matching image:

```sh
docker run --rm -it --network host -v "$PWD":/app -w /app \
  -e SOURCE_DATABASE_URL -e TARGET_DATABASE_URL \
  pgvector/pgvector:pg17 bash scripts/db/move-data.sh
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
   `TARGET_DATABASE_URL=<new server>` and run the script.
4. Set `DATABASE_URL` to the new server, keep `PLATFORM_SIGNING_SECRET`
   unchanged (§5), and start the application.

### Your own PostgreSQL → Supabase

The same steps with source and target swapped. The target is a Supabase
project's connection string. A brand-new, empty project is the simple case,
since the script builds its schema. An existing project that was built from
`supabase/migrations` must first have its ledger baselined (§5). Otherwise
the script would replay the whole chain on it.

### Moving the file storage

Uploaded files (avatars, attachments, recordings) are not in the database.
They live in the storage providers configured in Super Admin → Storage, and
the database stores only their keys. A database move leaves them where they
are.

---

## 7. Supabase services that remain optional

| Feature | Needs | Without it |
| --- | --- | --- |
| Supabase Realtime transport | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Centrifugo (the default first transport) and polling carry realtime; the provider order in Super Admin skips Supabase Realtime |
| Cleanup of legacy `auth.users` rows on user deletion | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Skipped: identity lives in `public.profiles`, and nothing reads `auth.users` |

The channels gateway and the AI runtime never get database credentials. They
refuse to start with `DATABASE_URL`, `PLATFORM_SIGNING_SECRET` or the
service-role key set.

---

## 8. Environment reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | The database. Its presence selects the `postgres` driver. |
| `PLATFORM_SIGNING_SECRET` | `SUPABASE_SERVICE_ROLE_KEY` | Root of the server's HMAC keys; at least 32 characters. Required with `DATABASE_URL`. |
| `DATABASE_SSL` | `disable` for localhost and container names, `require` otherwise | `disable`, `require` (encrypted, not verified) or `verify-full`. `sslmode=` in the URL works too. |
| `DATABASE_SSL_CA` | — | CA certificate, as PEM text or a file path, for `verify-full`. |
| `DATABASE_POOL_MAX` | `10` | Connections per process. |
| `DATABASE_ROLE` | `service_role` | Role every session assumes. The login role must be allowed to `SET ROLE` to it (§4). `none` means stay the login role. |
| `DATABASE_SCHEMAS` | `public` | Exposed schemas, as PostgREST's `db-schemas`. |
| `DATABASE_MAX_ROWS` | `1000` | Row cap on reads; `0` means no cap. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `120000` | Per-statement timeout. |
| `DATABASE_APPLICATION_NAME` | `webyar` | Shown in `pg_stat_activity`. |
| `DATABASE_CONNECT_ATTEMPTS` | `30` | Boot-time wait for the database, 2 s apart. |
| `DATABASE_ALLOW_TRANSACTION_POOLER` | — | `1` disables the port-6543 refusal. Only for a pooler you know runs in session mode. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | — | Only for §7, or for the legacy driver when `DATABASE_URL` is empty. |

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
| `pg_dump: server version mismatch` | Run the script from a newer client image (§6). |
| Widget visitors logged out after the switch | `PLATFORM_SIGNING_SECRET` differs from the old service-role key (§5). |

`GET /api/health/database` reports the driver, the server's major version, the
role queries run as and the round-trip time. It never reports the host or the
credentials.
