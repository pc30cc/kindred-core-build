# Database Migrations

These SQL files are designed to run against your Supabase/Postgres database.

## How to apply

### Migration order (CRITICAL — run in order)

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

### Rules

- **Forward-only.** Never edit a migration that has already shipped. Fix it
  with a new, higher-numbered file.
- **Apply each file exactly once, in ascending order.** Re-applying an older
  migration on top of a newer one can recreate a stale function overload that
  a later `CREATE FUNCTION` then fails on. Re-running the *head* is safe and
  idempotent.
- **Mirrored for hosted Supabase.** Files that must also run on the managed
  Supabase project have a byte-identical copy under `supabase/migrations/`.
  `src/test/kb/aiKbMutationHardening.test.ts` fails the build if the two
  copies drift apart.
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
