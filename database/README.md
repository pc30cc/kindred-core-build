# Database Migrations

These SQL files are designed to run against your Supabase/Postgres database.

## How to apply

### Migration order (CRITICAL — run in order)

0. `000_selfhost_roles_bootstrap.sql` — **self-host only prerequisite.** Creates
   the Supabase-compatible `anon` / `authenticated` / `service_role` roles when
   they are missing. No-op on hosted Supabase. Every later migration (and the
   RLS policies in 001) references these roles by name, so the chain cannot
   start without them.
1. `001_core_tables.sql` — Profiles, workspaces, members, helper functions
2. `002_workspace_features.sql` — Branding, domains, contacts, conversations, messages, widget settings
3. `003_visitors_kb_config.sql` — Visitor sessions/presence, knowledge base, provider configs, translations, audit logs, feature flags, email templates
4. `004_seed_defaults.sql` — Default feature flags
5. `005_platform_ai_agent_settings.sql` — Platform-wide AI agent settings
6. `006_platform_ai_agent_settings_singleton.sql` — Singleton constraint for the above
7. `007_entitlement_fanout_jobs.sql` — Durable entitlement fan-out queue (lease ownership)
8. `008_entitlement_fanout_generations.sql` — Generation-aware fan-out
9. `009_fanout_cursor_generation_and_ai_kb_tx.sql` — Generation-bound cursors, concurrency-safe enqueue, transactional AI-KB draft mutations
10. `010_fanout_rpc_security_and_kb_state_machine.sql` — `SECURITY DEFINER` privilege lockdown, generated-article state machine, slug-seed contract
11. `011_ai_kb_slug_namespace_lock.sql` — (workspace, locale) slug-namespace lock + unique-violation retry
12. `012_ai_kb_acl_reassert_guarded.sql` — re-asserts the 010/011 least-privileged ACL with `pg_roles`-guarded statements, so the chain also completes where a role is absent

> **Why 012 exists instead of a fix to 011.** 011 has already shipped to the
> hosted Supabase project (`supabase/migrations/20260803090000_…`), so under the
> forward-only rule it is frozen. 012 achieves the same portability outcome
> without touching it.

### Self-host prerequisites

The chain targets a Supabase-shaped database. Before `001`, a plain PostgreSQL
cluster needs:

- the three roles — handled automatically by `000_selfhost_roles_bootstrap.sql`;
- Supabase's `auth` schema and `auth.uid()` / `auth.jwt()`, provided by GoTrue.
  Run the Supabase Postgres image (or `supabase/postgres`) rather than stock
  `postgres:16` if you want the RLS policies in 001–003 to apply.

### What CI actually proves

Three separate jobs, with deliberately distinct scopes — do not cite one as
evidence for another:

| Job | Chain | Database |
| --- | --- | --- |
| **AI-KB tail migration compatibility** | `000` + `007`→`012` only | stock `postgres:16`, pristine, no function reset, no pre-seeded roles |
| **Hosted Supabase full migration chain** | every file in `supabase/migrations`, real timestamp order, via `supabase db reset` | Supabase CLI stack |
| **Self-host full migration chain** | every file in `database/migrations`, `000`→`012`, filename order, `ON_ERROR_STOP=1` | `supabase/postgres:15.8.1.060` + the **official** `supabase/auth:v2.194.0`, pinned by digest `sha256:2b352c02…` (`auth migrate`) |

The self-host job bootstraps auth the way a self-hoster does: the pinned GoTrue
image runs `auth migrate` against the database *before* the chain is applied, so
`auth.users` and `auth.schema_migrations` come from the official Auth migrations
— never from a handcrafted fixture. `verify-selfhost-chain.sql` fails if
`auth.users`, `auth.schema_migrations` (non-empty), `auth.uid()` or `auth.jwt()`
is absent.

The Auth image is referenced by **immutable digest**, not by the mutable tag
alone, and a preflight step pulls it, `docker image inspect`s it and runs
`auth --help` asserting that the `migrate` subcommand exists — so an
unpullable, repointed or renamed image fails as itself instead of masquerading
as a migration failure.

Both full-chain jobs then run `scripts/ci/verify-hosted-chain.sql` /
`scripts/ci/verify-selfhost-chain.sql` for structure and
`scripts/ci/verify-migration-security.sql` for the privilege posture. The tail
job is a compatibility check, **not** full-chain release evidence.

### Live `service_role` execution proof

`verify-migration-security.sql` proves both directions inside transactions that
are rolled back:

* **Denial** — `anon` and `authenticated` are `SET LOCAL ROLE`-ed into and each
  of the nine RPCs is really called (18 combinations).
* **Execution** — `service_role` runs the complete fan-out lifecycle for real
  (`enqueue → claim → advance → complete`, plus the `fail` retry path) and all
  four AI-KB RPCs, asserting their actual return values.

Each AI-KB RPC is called with a non-existent id and must return exactly
`{"ok": false, "error": "not_found"}` — `ok=false` alone is rejected, because an
unrelated body failure would report that too. The fan-out proof asserts the
exact row state after every step (lease ownership, cursor generation, released
claim, counters, backoff), not just the status string, and the queue table is
audited across the complete privilege matrix (`SELECT/INSERT/UPDATE/DELETE/
TRUNCATE/REFERENCES/TRIGGER`) for `PUBLIC`, `anon` and `authenticated`.

The script **requires** `-v require_ai_kb=0|1`, aborts without it and accepts
**only** the literals `0` and `1` — any other value (empty, `true`, a typo) is a
hard error rather than a silent "not required". `1` (hosted chain) makes the
live AI-KB proof mandatory; `0` (self-host chain, whose AI-KB tables ship only
in `supabase/migrations`) limits the live proof to the fan-out lifecycle.

### Rules

- **Forward-only.** Never edit a migration that has already shipped. Fix it
  with a new, higher-numbered file.
- **Apply each file exactly once, in ascending order.** Re-applying an older
  migration on top of a newer one can recreate a stale function overload that
  a later `CREATE FUNCTION` then fails on. Re-running the *head* is safe and
  idempotent.
- **Mirrored for hosted Supabase.** Files that must also run on the managed
  Supabase project have a byte-identical copy under `supabase/migrations/`.
  `src/test/kb/aiKbMutationHardening.test.ts` and
  `src/test/integration/migrationMirrorParity.test.ts` fail the build if the
  two copies drift apart functionally.
- **Least privilege is re-asserted, not assumed.** Dropping a function
  destroys its ACL and the recreated function is `EXECUTE`-able by `PUBLIC`.
  Any migration that drops/recreates a `SECURITY DEFINER` function must
  re-run the `REVOKE ... FROM PUBLIC` / `GRANT ... TO service_role` block.

### Via Supabase Dashboard
1. Go to your Supabase project → SQL Editor
2. Run each file in ascending order (001 → … → 010)

### Via CLI
```bash
for f in database/migrations/*.sql; do
  echo "== $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

### Verifying the security posture after migrating

No `SECURITY DEFINER` function in `public` may be executable by `PUBLIC`:

```sql
SELECT proname, proacl
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND prosecdef
  AND (proacl IS NULL OR proacl::text ~ '(^|,)=X');
```

The query must return **zero rows**. The same invariant is asserted in CI by
`src/test/integration/aiKbMutationStateMachine.pg.test.ts`.

### After migration

1. Sign up in the app to create your user profile
2. Create a workspace via the onboarding page
3. This automatically creates default branding and widget settings records
4. Configure branding in Settings → Branding

## Verification integrity (Phase 6-S5-R7.5.1)

`scripts/ci/internal-rpc-signatures.sql` is the **single source of truth** for the
internal RPC surface (5 entitlement fan-out RPCs + 4 AI-KB RPCs). Every CI
verification script `\ir`s it, and it fails hard when

* a declared signature does not resolve (`to_regprocedure` → NULL), or
* a second, un-audited overload of an audited function name exists.

Consequently none of the three database proofs (hosted full chain, self-host
full chain, security audit) can pass while auditing zero functions.
`scripts/ci/verify-migration-security.sql` additionally requires `anon`,
`authenticated` and `service_role` to exist, and proves denial **live** by
`SET LOCAL ROLE`-ing into each customer role and actually calling all nine RPCs
inside a rolled-back transaction. `src/test/ci/verificationIntegrity.test.ts`
re-derives the signatures from `database/migrations/*.sql` so the inventory
cannot drift away from the schema.
