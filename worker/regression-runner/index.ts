/**
 * AI Agent — Pass E10 — Scheduled Regression Worker (standalone).
 *
 * Polls public.ai_agent_regression_batches (queued) and
 * public.ai_agent_regression_schedules (enabled, due) and executes them.
 * Self-hosted; no external cron, no edge function, no MCP/webhooks.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { dataClientFor, workerDatabaseConfig } from '../../server/db/index.js';
import {
  claimDueSchedule,
  claimQueuedBatch,
  enqueueRegressionBatch,
  findDueScheduleIds,
  findQueuedBatchIds,
  runRegressionBatch,
} from '../../server/services/ai-agent/regressionRunner.js';
import { regressionScheduleMayRunServer } from '../../server/services/ai-agent/customerSafe.js';
import { loadConfig } from '../../server/config.js';
import { IdleBackoff, IdleIntervalSkipper, intFromEnv } from '../../server/services/jobs/idleBackoff.js';
import { InFlightJobs, settleWithin } from '../../server/services/jobs/inFlight.js';

const POLL_INTERVAL_MS = intFromEnv(
  process.env.REGRESSION_WORKER_INTERVAL_MS || process.env.WORKER_INTERVAL_MS,
  15_000,
  1000,
  300_000,
);
/** Ceiling for the idle poll: how long a queued batch may wait after a quiet spell. */
const MAX_IDLE_POLL_MS = intFromEnv(process.env.REGRESSION_WORKER_MAX_IDLE_POLL_MS, 60_000, POLL_INTERVAL_MS, 600_000);
const WORKER_ID = process.env.WORKER_ID || `regression-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
/** Batches this process runs at once (see server/services/jobs/inFlight.ts). */
const MAX_CONCURRENT_BATCHES = intFromEnv(process.env.REGRESSION_WORKER_MAX_CONCURRENT, 2, 1, 10);
const inFlight = new InFlightJobs(MAX_CONCURRENT_BATCHES);

function log(event: string, data: object = {}) {
  try { console.log(`[regression-worker] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[regression-worker] ${event}`); }
}

function loadEnv() {
  const { supabaseUrl, supabaseServiceRoleKey } = workerDatabaseConfig('[regression-worker]');
  return { url: supabaseUrl, key: supabaseServiceRoleKey };
}

/**
 * Closes a batch this worker claimed and could not finish. Scoped to
 * `running`, so a batch an operator cancelled meanwhile stays cancelled.
 */
export async function failClaimedBatch(sb: SupabaseClient, batchId: string, error: string): Promise<void> {
  await sb.from('ai_agent_regression_batches').update({
    status: 'failed',
    finished_at: new Date().toISOString(),
    last_error: error.slice(0, 1000),
  }).eq('id', batchId).eq('status', 'running');
}

/** Runs a batch this worker claimed, holding a slot while it runs. */
async function runClaimedBatch(
  sb: SupabaseClient,
  config: ReturnType<typeof loadConfig>,
  batchId: string,
  kind: string,
  release: () => void,
): Promise<void> {
  inFlight.add(batchId);
  release();
  try {
    const r = await runRegressionBatch(config, batchId);
    log(`${kind} batch finished`, { batchId, ...r });
  } catch (e) {
    // A batch that threw stays `running` forever otherwise: nothing reclaims
    // one, and the schedule has already moved on to its next run.
    log(`${kind} batch error`, { id: batchId, error: e?.message });
    await failClaimedBatch(sb, batchId, String(e?.message || 'unknown')).catch(() => {});
  } finally {
    inFlight.delete(batchId);
  }
}

/** One poll of schedules and batches. Resolves true when anything was claimed. */
async function tick(sb: SupabaseClient): Promise<boolean> {
  // Every slot busy: leave the queue alone (it counts as work, so the poll
  // does not back off while batches run).
  if (inFlight.full) return true;
  const config = loadConfig();
  let found = false;

  // 1) Run due schedules — claim atomically then enqueue+run a batch.
  const dueIds = await findDueScheduleIds(sb, 5);
  for (const id of dueIds) {
    if (inFlight.full) return true;
    // The slot is held from the claim on, so an overlapping interval cannot take it too.
    const release = inFlight.reserve();
    try {
      found = (await runDueSchedule(sb, config, id, release)) || found;
    } finally {
      release();
    }
  }

  // 2) Pick up any queued batches (manual or otherwise).
  const queuedIds = await findQueuedBatchIds(sb, 5);
  for (const id of queuedIds) {
    if (inFlight.full) return true;
    const release = inFlight.reserve();
    try {
      const claimed = await claimQueuedBatch(sb, id);
      if (!claimed) continue;
      found = true;
      log('queued batch claimed', { batchId: id, ws: claimed.workspace_id });
      await runClaimedBatch(sb, config, id, 'queued', release);
    } finally {
      release();
    }
  }
  return found;
}

/** Claims one due schedule and runs its batch. Resolves true when the claim was won. */
async function runDueSchedule(
  sb: SupabaseClient,
  config: ReturnType<typeof loadConfig>,
  id: string,
  release: () => void,
): Promise<boolean> {
  const claimed = await claimDueSchedule(sb, id);
  if (!claimed) return false;
  // The Advanced tools are a plan feature (ai_advanced_tools, owner
  // 2026-11-03): a plan without it runs no customer schedule.
  if (!(await regressionScheduleMayRunServer(config, claimed))) {
    log('schedule skipped: ai_advanced_tools not in plan', { scheduleId: id, ws: claimed.workspace_id });
    return true;
  }
  log('schedule due → enqueue batch', { scheduleId: id, ws: claimed.workspace_id });
  try {
    const batch = await enqueueRegressionBatch(config, {
      workspaceId: claimed.workspace_id,
      scheduleId: claimed.id,
      triggerType: 'scheduled',
    });
    const claimedBatch = await claimQueuedBatch(sb, batch.id);
    if (claimedBatch) await runClaimedBatch(sb, config, batch.id, 'scheduled', release);
  } catch (e) {
    log('schedule run error', { id, error: e?.message });
  }
  return true;
}

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startRegressionWorker() {
  if (started) return;
  started = true;
  const env = loadEnv();
  const sb = dataClientFor(env.url, env.key);
  log('started', { workerId: WORKER_ID, interval: POLL_INTERVAL_MS, maxIdleInterval: MAX_IDLE_POLL_MS, maxConcurrentBatches: MAX_CONCURRENT_BATCHES });
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

  // A batch still running dies with the process and nothing reclaims a
  // `running` batch, so it is failed here instead of left running forever.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const abandoned = inFlight.ids();
    log('shutdown', { signal: sig, inFlight: abandoned });
    if (timer) clearInterval(timer);
    await settleWithin(
      Promise.all(abandoned.map((id) => failClaimedBatch(sb, id, `worker_shutdown: the worker was stopped (${sig}) while this batch ran`))),
      5000,
    );
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

const isMain = (() => {
  try {
    const u = new URL(import.meta.url);
    return process.argv[1] && u.pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '');
  } catch { return false; }
})();
if (isMain) startRegressionWorker();