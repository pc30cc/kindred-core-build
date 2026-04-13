# Database Migrations

These SQL files are designed to run against your Supabase/Postgres database.

## How to apply

### Via Supabase Dashboard
1. Go to your Supabase project → SQL Editor
2. Run each file in order: `001_core_tables.sql`, `002_workspace_features.sql`, `003_visitors_kb_config.sql`

### Via CLI
```bash
psql $DATABASE_URL -f database/migrations/001_core_tables.sql
psql $DATABASE_URL -f database/migrations/002_workspace_features.sql
psql $DATABASE_URL -f database/migrations/003_visitors_kb_config.sql
```

### Via Supabase CLI (if using supabase CLI locally)
```bash
supabase db push
```
