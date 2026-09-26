/**
 * AI Agent — Pass E10 — Scheduled Regression Worker (standalone).
 *
 * Polls public.ai_agent_regression_batches (queued) and
 * public.ai_agent_regression_schedules (enabled, due) and executes them.
 * Self-hosted; no external cron, no edge function, no MCP/webhooks.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  claimDueSchedule,
  claimQueuedBatch,
  enqueueRegressionBatch,
  findDueScheduleIds,
  findQueuedBatchIds,
  runRegressionBatch,
} from '../../server/services/ai-agent/regressionRunner.js';
import { loadConfig } from '../../server/config.js';
import { IdleBackoff, IdleIntervalSkipper, intFromEnv } from '../../server/services/jobs/idleBackoff.js';

const POLL_INTERVAL_MS = intFromEnv(
  process.env.REGRESSION_WORKER_INTERVAL_MS || process.env.WORKER_INTERVAL_MS,
  15_000,
  1000,
  300_000,
);
/** Ceiling for the idle poll: how long a queued batch may wait after a quiet spell. */
const MAX_IDLE_POLL_MS = intFromEnv(process.env.REGRESSION_WORKER_MAX_IDLE_POLL_MS, 60_000, POLL_INTERVAL_MS, 600_000);
const WORKER_ID = process.env.WORKER_ID || `regression-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function log(event: string, data: object = {}) {
  try { console.log(`[regression-worker] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[regression-worker] ${event}`); }
}

function loadEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return { url, key };
}

/** One poll of schedules and batches. Resolves true when anything was claimed. */
async function tick(sb: SupabaseClient): Promise<boolean> {
  const config = loadConfig();
  let found = false;

  // 1) Run due schedules — claim atomically then enqueue+run a batch.
  const dueIds = await findDueScheduleIds(sb, 5);
  for (const id of dueIds) {
    const claimed = await claimDueSchedule(sb, id);
    if (!claimed) continue;
    found = true;
    log('schedule due → enqueue batch', { scheduleId: id, ws: claimed.workspace_id });
    try {
      const batch = await enqueueRegressionBatch(config, {
        workspaceId: claimed.workspace_id,
        scheduleId: claimed.id,
        triggerType: 'scheduled',
      });
      const claimedBatch = await claimQueuedBatch(sb, batch.id);
      if (claimedBatch) {
        const r = await runRegressionBatch(config, batch.id);
        log('scheduled batch finished', { batchId: batch.id, ...r });
      }
    } catch (e) {
      log('schedule run error', { id, error: e?.message });
    }
  }

  // 2) Pick up any queued batches (manual or otherwise).
  const queuedIds = await findQueuedBatchIds(sb, 5);
  for (const id of queuedIds) {
    const claimed = await claimQueuedBatch(sb, id);
    if (!claimed) continue;
    found = true;
    log('queued batch claimed', { batchId: id, ws: claimed.workspace_id });
    try {
      const r = await runRegressionBatch(config, id);
      log('queued batch finished', { batchId: id, ...r });
    } catch (e) {
      log('queued batch error', { id, error: e?.message });
      await sb.from('ai_agent_regression_batches').update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        last_error: String(e?.message || 'unknown'),
      }).eq('id', id);
    }
  }
  return found;
}

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startRegressionWorker() {
  if (started) return;
  started = true;
  const env = loadEnv();
  const sb = createClient(env.url, env.key, { auth: { autoRefreshToken: false, persistSession: false } });
  log('started', { workerId: WORKER_ID, interval: POLL_INTERVAL_MS, maxIdleInterval: MAX_IDLE_POLL_MS });
  // setInterval, not a self-rescheduling timeout: a batch runs for minutes
  // inside tick() while the next interval still picks up the next one. Only
  // idle polls ease off, skipping a growing number of intervals up to
  // MAX_IDLE_POLL_MS; anything claimed resets it.
  const idle = new IdleIntervalSkipper(
    POLL_INTERVAL_MS,
    new IdleBackoff({ busyMs: POLL_INTERVAL_MS, idleMs: POLL_INTERVAL_MS, maxIdleMs: MAX_IDLE_POLL_MS }),
  );
  const run = () => {
    if (idle.skip()) return;
    void tick(sb)
      .catch((e) => {
        log('tick error', { error: e?.message });
        return false;
      })
      .then((found) => idle.record(found));
  };
  run();
  timer = setInterval(run, POLL_INTERVAL_MS);

  const shutdown = (sig: string) => {
    log('shutdown', { signal: sig });
    if (timer) clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain = (() => {
  try {
    const u = new URL(import.meta.url);
    return process.argv[1] && u.pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '');
  } catch { return false; }
})();
if (isMain) startRegressionWorker();