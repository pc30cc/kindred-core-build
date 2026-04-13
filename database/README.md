# Database Migrations

These SQL files are designed to run against your Supabase/Postgres database.

## How to apply

### Migration order (CRITICAL — run in order)

1. `001_core_tables.sql` — Profiles, workspaces, members, helper functions
2. `002_workspace_features.sql` — Branding, domains, contacts, conversations, messages, widget settings
3. `003_visitors_kb_config.sql` — Visitor sessions/presence, knowledge base, provider configs, translations, audit logs, feature flags, email templates
4. `004_seed_defaults.sql` — Default feature flags

### Via Supabase Dashboard
1. Go to your Supabase project → SQL Editor
2. Run each file in order (001 → 002 → 003 → 004)

### Via CLI
```bash
psql $DATABASE_URL -f database/migrations/001_core_tables.sql
psql $DATABASE_URL -f database/migrations/002_workspace_features.sql
psql $DATABASE_URL -f database/migrations/003_visitors_kb_config.sql
psql $DATABASE_URL -f database/migrations/004_seed_defaults.sql
```

### After migration

1. Sign up in the app to create your user profile
2. Create a workspace via the onboarding page
3. This automatically creates default branding and widget settings records
4. Configure branding in Settings → Branding
