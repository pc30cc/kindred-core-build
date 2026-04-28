# AI KB Builder — Worker Deployment Guide

The AI Knowledge Base Builder runs as **two processes**:

1. **Backend (Express)** — serves `/api/ai-kb/*`, creates `queued` jobs, gates on plan/module/credits.
2. **Intelligence Worker** — standalone process that polls `public.ai_kb_jobs`, crawls the verified workspace domain, and generates KB drafts via the shared AI provider.

> ⚠️ **Production rule:** `AI_KB_WORKER_INPROC` MUST stay **off** in production. Production deployments MUST run the worker as its own standalone container (`Dockerfile.worker`). The in-process flag exists only for local dev convenience.

---

## 1. Required env vars — Backend

| Var | Required | Notes |
|-----|----------|-------|
| `SUPABASE_URL` | ✅ | External Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role — **never** ship to frontend |
| `PORT` | optional | Defaults to `3001` |
| `CORS_ORIGINS` | recommended | Comma-separated list of allowed frontend origins |
| `AI_KB_WORKER_INPROC` | **must be unset / `0`** | Do NOT enable in production |

The backend reads AI provider credentials from the database (Super Admin → Providers → AI), not env vars. The worker reuses the same configuration via `server/services/ai/index.ts`.

## 2. Required env vars — Intelligence Worker

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `SUPABASE_URL` | ✅ | — | Same project as backend |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | Required to claim jobs and read AI provider config |
| `WORKER_ID` | optional | `ai-kb-<pid>-<rand>` | Unique per worker instance — useful when scaling |
| `AI_KB_WORKER_POLL_MS` | optional | `5000` | Job claim poll interval |
| `AI_KB_WORKER_STANDALONE` | set to `1` | `1` (in Dockerfile.worker) | Forces the loop to start |
| `CRAWLER_TIMEOUT_MS` | optional | `15000` | Per-page fetch timeout |
| `CRAWLER_MAX_BYTES` | optional | `2000000` | Per-page max body size |
| `CRAWLER_USER_AGENT` | optional | sensible default | Outgoing UA string |

The worker does **NOT** need `SUPABASE_ANON_KEY`, AI provider keys, or any frontend env vars.

---

## 3. Coolify deployment — Dockerfile.worker

1. **Coolify → New Resource → Application → Dockerfile**.
2. Repository: same repo as backend.
3. **Dockerfile path:** `Dockerfile.worker`.
4. **Build context:** repo root (`.`).
5. **Port exposure:** none — the worker has no HTTP listener.
6. **Health check:** disable HTTP health check; use Coolify's container running status.
7. **Environment variables:** add the worker vars from §2 (at minimum `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`).
8. **Replicas:** start with `1`. You can scale to multiple later — each instance must have a distinct `WORKER_ID`. The DB claim (`status='queued' → 'running'`) is conditional, so concurrent workers will not double-process the same job.
9. **Restart policy:** `unless-stopped` / `always`.
10. Deploy. Tail logs and look for:
    ```
    [ai-kb worker] started workerId=ai-kb-… interval=5000ms
    ```

## 4. Run worker on the same server as backend

Two safe options:

**A. Same Docker host, separate container (recommended).** Add a second service to your `docker-compose.yml`:

```yaml
  intelligence-worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    restart: unless-stopped
    environment:
      SUPABASE_URL: ${SUPABASE_URL}
      SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY}
      WORKER_ID: ai-kb-primary
```

Then: `docker compose up -d intelligence-worker`.

**B. Bare metal / systemd.** From the repo root on the same machine:

```bash
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  npx tsx worker/intelligence/index.ts
```

Wrap in a systemd unit with `Restart=always`. Do **not** rely on `AI_KB_WORKER_INPROC` — it should remain unset.

## 5. Run worker on a separate server

The worker only needs network access to Supabase. There is no requirement for it to live next to the backend.

1. Provision a separate VM / Coolify host / Kubernetes pod.
2. Clone the same repo (or pull a prebuilt image).
3. Build:
   ```bash
   docker build -f Dockerfile.worker -t intelligence-worker .
   ```
4. Run with the env vars from §2 (see §8 below).
5. Ensure outbound HTTPS to:
   - `SUPABASE_URL`
   - The configured AI provider endpoint (OpenAI / Anthropic / Gemini / etc.)
   - The verified workspace domains being crawled

No inbound ports are required.

---

## 6. Runtime verification

Replace `$BASE` with your backend URL, `$JWT` with an operator session token, and `$WS` with a workspace UUID.

### 6a. `/api/ai-kb/source`

```bash
curl -s -H "Authorization: Bearer $JWT" \
  "$BASE/api/ai-kb/source?workspaceId=$WS" | jq
```

Expected: `source.can_scan=true`, `source.domain` set to the verified workspace domain, `modules.knowledge_base=true`, `modules.ai_kb_builder=true`, and a `plan.limits` object.

### 6b. Create a queued job

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"workspaceId":"'$WS'","locale":"en"}' \
  "$BASE/api/ai-kb/jobs" | jq
```

Expected: `201` with `job.status="queued"`. The backend does **not** crawl inline.

### 6c. Worker claims the job

In the worker logs, within ~5s (poll interval), look for a claim message and the `ai_kb_jobs` row's `status` flipping to `running` with `claimed_by` set to the worker's `WORKER_ID`.

### 6d. Job progresses to a terminal state

Poll the job:

```bash
curl -s -H "Authorization: Bearer $JWT" \
  "$BASE/api/ai-kb/jobs/<JOB_ID>" | jq '.job.status, (.generated|length)'
```

Expected terminal states:
- `completed` — finished within the plan's article cap.
- `partial` — credits exhausted mid-job; some drafts produced.
- `failed` — see `last_error` and the `ai_kb_job_events` table.

Generated drafts appear in `ai_kb_generated_articles`. Accept/publish flips them into `knowledge_base_articles`, after which they are immediately searchable from the existing widget KB.

---

## 7. Build the worker image

```bash
docker build -f Dockerfile.worker -t intelligence-worker .
```

## 8. Run the worker

```bash
docker run -d --name intelligence-worker --restart unless-stopped \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  -e WORKER_ID="ai-kb-prod-1" \
  intelligence-worker
```

Tail logs:

```bash
docker logs -f intelligence-worker
```

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `POST /jobs` → `409 no_scannable_domain` | No verified `workspace_domains` row and no profile `website_domain`. | Settings → Domains: add and verify a domain. The UI does not allow arbitrary URLs by design. |
| `POST /jobs` → `403` with `module: 'ai_kb_builder'` (or `knowledge_base`) | Workspace plan does not include the module. | Super Admin → Plans: enable `knowledge_base` and `ai_kb_builder` for the plan, or move the workspace to a plan that does. |
| Job moves to `failed` with `ai_provider_unavailable` / similar | No active AI provider configured, or its API key is missing/invalid. | Super Admin → Providers → AI: configure and activate a provider. The worker reuses this — do **not** add provider keys to the worker env. |
| Job ends as `partial` and `last_error` mentions credits | Workspace AI credits exhausted mid-job. | Top up credits. Already-generated drafts are kept and were billed; remaining pages are dropped without charge. |
| Job event log shows `Skipping off-domain link` or `Unsafe host blocked` | SSRF / off-domain protection working as intended. | No action needed. The worker only crawls the verified workspace domain and refuses private IPs. |
| Worker process running but jobs stay `queued` | Wrong `SUPABASE_URL`, wrong service role key, or worker connected to a different project. | Verify env. Confirm the worker logs show `[ai-kb worker] started …`. Check `ai_kb_jobs` is visible from the worker's credentials. |
| Multiple workers, jobs processed twice | Duplicate `WORKER_ID` or claim query bypassed. | Ensure each replica has a unique `WORKER_ID`. The claim is a conditional `update … where status='queued'` — no double-claim is possible when used correctly. |
| Backend boots but no worker exists | You forgot to deploy the worker container. `AI_KB_WORKER_INPROC` is intentionally off in prod. | Deploy `Dockerfile.worker`. Do NOT enable in-process mode. |

---

## 10. Production rule (repeat)

- ❌ **Never** set `AI_KB_WORKER_INPROC=1` in production.
- ✅ **Always** run a dedicated worker container built from `Dockerfile.worker`.
- ✅ The worker can run on the same server as the backend (separate container) **or** on a completely separate host — only Supabase + outbound HTTPS are required.
