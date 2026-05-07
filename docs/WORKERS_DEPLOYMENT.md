# Workers — Multi-Worker Deployment

One image (`Dockerfile.worker`) runs every standalone worker. The `WORKER_KIND`
env var selects which loop runs inside the container, so each worker can be a
separate Coolify service on the same server without maintaining a second
Dockerfile.

## Worker kinds

| `WORKER_KIND` | Loop                              | Queue table                |
|---------------|-----------------------------------|----------------------------|
| `intelligence` (default) | AI KB Builder pipeline | `public.ai_kb_jobs`        |
| `source-sync` | Data Hub website source sync      | `public.ai_source_sync_jobs` |
| `all`         | Both loops in same process (dev only) | both                  |

`all` logs a warning. Use only for local/small deploys.

## Coolify setup

Create two services from the same repo, same `Dockerfile.worker`:

1. **Intelligence Worker**
   - `WORKER_KIND=intelligence`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
2. **Source Sync Worker**
   - `WORKER_KIND=source-sync`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

No domain or port required for either service.

## Backend API production env

The Backend API container should NOT run worker loops in production:

- `AI_KB_INTELLIGENCE_WORKER_INPROC` unset / `0`
- `AI_SOURCE_SYNC_WORKER_INPROC`     unset / `0`
- `AI_KB_WORKER_INPROC`              unset / `0` (deprecated)

If `AI_KB_WORKER_INPROC=1` is detected, the server logs a deprecation warning
and starts the corresponding loop in-process for backward compatibility.

## Env reference (all kinds)

| Preferred                  | Legacy fallback                              |
|----------------------------|----------------------------------------------|
| `WORKER_ID`                | `AI_KB_WORKER_ID`                            |
| `WORKER_INTERVAL_MS`       | `AI_KB_WORKER_INTERVAL_MS` / `AI_KB_WORKER_POLL_MS` |
| `WORKER_LOCK_TTL_SECONDS`  | `AI_KB_WORKER_LOCK_TTL_SECONDS`              |

## Local commands

```
npm run worker                  # default kind=intelligence
npm run worker:intelligence
npm run worker:source-sync
npm run worker:all
```