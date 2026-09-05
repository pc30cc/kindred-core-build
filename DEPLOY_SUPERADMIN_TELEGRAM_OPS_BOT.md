# Super Admin Telegram Ops Bot

A dedicated, private, read-only Telegram bot for technical operations questions.
It is intentionally **not** part of the customer channel pipeline and does not
persist chat history, AI usage rows or audit rows in PostgreSQL.

## What it does

- `/status` — DB read health, AI Runtime health, Realtime mode, Centrifugo node count/clients, Redis health.
- `/realtime` — per-node Centrifugo health, clients/users/channels, drain/accept-new state.
- `/redis` — Redis/Valkey latency, memory, ops/s, clients, evictions/rejections.
- `/privacy` — explains the no-persistence boundary.
- Free-text technical questions — sends a live read-only snapshot plus the
  question to the existing isolated AI Runtime and returns the answer.

The bot does **not** execute SQL writes, config changes, restart, drain/resume,
node mutations or any other operational action. If actionable controls are ever
added, implement them as a separate phase with explicit confirmation and audit
policy.

## Important: use a dedicated Telegram bot

Create a new bot in BotFather only for Super Admin operations.

**Never reuse a Telegram bot already connected as a customer channel.** This
worker uses long polling (`getUpdates`) and calls `deleteWebhook` at startup, so
reusing a channel bot token would disable that bot's webhook.

## Authorization

The worker accepts only:

1. Telegram updates from a `private` chat.
2. A sender whose numeric Telegram user id is present in
   `SUPERADMIN_TELEGRAM_ALLOWED_USER_IDS`.
3. Non-bot senders.

Unauthorized messages are silently ignored and are not logged.

## No-database-log contract

The bot-owned modules do not call database mutation methods and do not import
`executeAICompletion()`.

Free-text answers call `runtimeComplete()` directly. The AI Runtime is already
stateless and has no database client, so this path does not create:

- `ai_usage_logs`
- AI billing runs/events
- conversation rows
- audit rows
- Telegram queue/job rows
- message history rows

The bot may perform **read-only** database queries to read current platform
configuration and basic DB health.

The Telegram update offset, rate-limit state and in-flight request state are
process memory only. On restart they are lost. This is deliberate: durable
exactly-once processing would require persistence, which is outside this bot's
no-log goal.

The application never prints question/answer content to stdout. Telegram itself
is the transport and may retain messages according to Telegram's own service
behavior; this project cannot make Telegram's storage disappear.

## AI provider selection

Preferred order:

1. If `SUPERADMIN_TELEGRAM_AI_API_KEY` is configured, use the dedicated bot AI
   provider/model from environment variables.
2. Otherwise, read `app_runtime_config.default_ai_provider` and pass that config
   directly to the isolated AI Runtime.

Neither path uses the normal billable/logging AI orchestration layer.
Consequently, provider cost incurred by this bot is **not recorded in the app's
AI usage/billing ledger**. If you need cost accounting later without chat logs,
add an aggregated in-memory/Prometheus metric or a deliberately coarse billing
counter as a separate design decision.

## Coolify deployment

Create a new resource from the same GitHub repository.

- Build pack: Dockerfile
- Dockerfile: `Dockerfile.worker`
- No public domain/port is needed.
- Do not combine this worker with the customer `channels` worker in production.

Set:

```env
WORKER_KIND=superadmin-telegram
SUPERADMIN_TELEGRAM_BOT_TOKEN=...
SUPERADMIN_TELEGRAM_ALLOWED_USER_IDS=123456789
```

Also provide the normal server read/runtime variables used by this worker:

```env
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
AI_RUNTIME_URL=...
AI_RUNTIME_INTERNAL_SECRET=...
```

For Redis telemetry in multi-node Realtime, provide one of:

```env
VISITOR_CANDIDATE_INDEX_REDIS_URL=redis://:password@realtime-redis:6379/0
```

or:

```env
REALTIME_REDIS_URL=redis://:password@realtime-redis:6379/0
```

The Redis URL is never included in the AI prompt with credentials. Only a
sanitized endpoint plus selected runtime metrics are included.

See `.env.superadmin-telegram.example` for the complete list.

## Live snapshot semantics

Each command/question collects a fresh snapshot with **reads only**:

- DB: a minimal `app_runtime_config` read and latency measurement.
- AI Runtime: unauthenticated `/health` liveness probe.
- Realtime: configured topology plus direct Centrifugo `info` calls.
- Redis: `PING` + `INFO`, using the existing minimal Redis client.

For multi-node Centrifugo, each configured node is queried directly, so the bot
can report per-node client/user/channel counts without attributing the cluster
total to every node.

## Commands

```text
/status
/realtime
/redis
/privacy
/help
```

Any non-command text becomes one standalone technical question. No prior chat
turns are sent to the model and no conversation memory is persisted.

## Example question

```text
با وضعیت فعلی چه زمانی Node سوم لازم می‌شود و Redis HA را از چه نقطه‌ای باید فعال کنم؟
```

The model receives the current observed snapshot and the frozen architecture
rules. It is explicitly instructed not to claim that 100k/250k/500k/1M capacity
has been proven unless a production benchmark has actually been run.

## Tests

Targeted tests:

```bash
npx vitest run worker/superadmin-telegram/utils.test.ts worker/superadmin-telegram/noPersistence.test.ts
npm run typecheck:server
```

The `noPersistence` test is a regression guard: bot-owned modules must not
switch to the normal AI orchestration path or add a database mutation call.
