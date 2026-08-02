/**
 * AI KB Builder — standalone worker entry.
 *
 * Production: run as a separate process/container (Dockerfile.worker).
 * Local dev: server/index.ts can also boot this loop in-process when
 * AI_KB_WORKER_INPROC=1 (default off) — same processor, no duplication.
 *
 * The worker polls public.ai_kb_jobs for queued rows, claims one with a
 * conditional UPDATE (status='queued' -> 'running'), then runs the
 * crawl → extract → AI generate pipeline. All operations are bounded by
 * the plan_snapshot captured at job creation so a plan downgrade mid-job
 * cannot expand the scope.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { processJob } from './processor.js';
import { DbJobQueueProvider, type JobQueueProvider } from '../../server/services/ai-kb/queue.js';
import { loadConfig } from '../../server/config.js';
import { drainKnowledgeBaseChangeEvents } from '../../server/services/ai-agent/knowledgeIndex/kbEvents.js';
import { drainEntitlementFanoutJobs } from '../../server/services/billing/entitlementFanout.js';

const POLL_INTERVAL_MS = parseInt(process.env.AI_KB_WORKER_POLL_MS || '5000', 10);
const WORKER_ID = process.env.WORKER_ID || `ai-kb-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const IDLE_LOG_INTERVAL_MS = parseInt(process.env.AI_KB_WORKER_IDLE_LOG_MS || '60000', 10);
const WORKER_CODE_VERSION = 'ai-kb-admin-json-retry-v2';
const REQUIRED_TABLES = [
  'ai_kb_jobs',
  'ai_kb_job_pages',
  'ai_kb_generated_articles',
  'ai_kb_usage',
  'ai_kb_job_events',
] as const;

export interface WorkerEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  workerId: string;
}

export function workerLog(event: string, data: Record<string, any> = {}) {
  // Single-line structured log so Coolify/Loki can parse easily.
  try {
    console.log(`[ai-kb worker] ${event}`, JSON.stringify(data));
  } catch {
    console.log(`[ai-kb worker] ${event}`);
  }
}
const log = workerLog;

function loadEnv(): WorkerEnv {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('[ai-kb worker] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return { supabaseUrl, supabaseServiceRoleKey, workerId: WORKER_ID };
}

export function createWorkerClient(env: WorkerEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

let lastIdleLogAt = 0;

/**
 * Phase 6-S5-R1 — one-way KB → AI index bridge.
 *
 * Knowledge Base writes only append neutral rows to
 * public.knowledge_base_change_events. This worker drains them on the AI
 * side and re-indexes only plan-entitled workspaces. Events are claimed with
 * an atomic FOR UPDATE SKIP LOCKED lease, so multiple replicas are safe.
 * Failures are released back to the queue with backoff and never propagate
 * back into the Knowledge Base product.
 */
async function drainKbEvents() {
  try {
    const summary = await drainKnowledgeBaseChangeEvents(loadConfig(), {
      batchSize: 100,
      workerId: WORKER_ID,
    });
    if (summary.claimed > 0) log('kb change events drained', summary);
  } catch (err: any) {
    log('kb change events drain error', { error: err?.message });
  }
}

/**
 * Phase 6-S5-R6 — durable entitlement fan-out consumer.
 *
 * Plan-definition edits and the platform AI kill switch persist a job row
 * before the admin request returns; this loop claims it under an owned,
 * expiring lease and walks the affected workspaces with a keyset cursor.
 * Restart-safe: progress is checkpointed per page, so a redeploy resumes
 * exactly where it stopped instead of losing the remainder.
 */
async function drainFanoutJobs() {
  try {
    const summary = await drainEntitlementFanoutJobs(loadConfig(), {
      workerId: WORKER_ID,
      limit: 1,
    });
    if (summary.claimed > 0) log('entitlement fan-out drained', summary);
  } catch (err: any) {
    log('entitlement fan-out drain error', { error: err?.message });
  }
}

async function tick(sb: SupabaseClient, queue: JobQueueProvider, env: WorkerEnv) {
  try {
    // Probe before claim so we can log race losses distinctly.
    const { data: candidate } = await sb
      .from('ai_kb_jobs')
      .select('id, workspace_id, status')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!candidate) {
      const now = Date.now();
      if (now - lastIdleLogAt >= IDLE_LOG_INTERVAL_MS) {
        lastIdleLogAt = now;
        log('idle — no queued jobs', { workerId: env.workerId });
      }
      return;
    }

    log('queued job found', { jobId: (candidate as any).id });
    const job = await queue.claimNext(env.workerId);
    if (!job) {
      log('claim skipped/race lost', { jobId: (candidate as any).id });
      return;
    }
    log('job claimed', { jobId: job.id, workspaceId: job.workspace_id, workerId: env.workerId });

    try {
      await processJob(sb, env, job);
      // processJob writes the authoritative final log ("job finished")
      // with up-to-date local counters, so we don't log stale ones here.
    } catch (err: any) {
      log('job failed', { jobId: job.id, error: err?.message });
      await queue.failJob(job.id, err?.message || 'unknown');
      await queue.recordEvent(job.id, job.workspace_id, 'error', 'Job failed', { error: err?.message });
    }
  } catch (err: any) {
    console.error('[ai-kb worker] tick error:', err?.message);
  }
}

async function runSchemaCheck(sb: SupabaseClient): Promise<boolean> {
  let ok = true;
  for (const table of REQUIRED_TABLES) {
    const { error } = await sb.from(table).select('*', { count: 'exact', head: true }).limit(1);
    if (error) {
      ok = false;
      log('schema check failed', { table, error: error.message });
    }
  }
  return ok;
}

async function waitForSchema(sb: SupabaseClient) {
  let attempt = 0;
  while (true) {
    const ok = await runSchemaCheck(sb);
    if (ok) {
      log('database reachable', {});
      log('schema check passed', { tables: REQUIRED_TABLES.length });
      return;
    }
    attempt += 1;
    const delay = Math.min(60_000, 2000 * Math.pow(2, Math.min(attempt, 5)));
    log('schema check retry scheduled', { attempt, delayMs: delay });
    await new Promise((r) => setTimeout(r, delay));
  }
}

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startAiKbWorker(envOverride?: Partial<WorkerEnv>) {
  if (started) return;
  started = true;
  const env: WorkerEnv = { ...loadEnv(), ...envOverride };
  const sb = createWorkerClient(env);
  const queue: JobQueueProvider = new DbJobQueueProvider(sb);
  const standalone = process.env.AI_KB_WORKER_STANDALONE === '1';
  const inproc = process.env.AI_KB_WORKER_INPROC === '1';
  log('started', {
    workerId: env.workerId,
    interval: POLL_INTERVAL_MS,
    codeVersion: WORKER_CODE_VERSION,
    standalone,
    inproc,
  });
  if (standalone) log('mode standalone', { workerId: env.workerId });
  else if (inproc) log('mode inproc', { workerId: env.workerId });

  const run = () =>
    tick(sb, queue, env)
      .catch((e) => console.error('[ai-kb worker]', e))
      .then(drainKbEvents)
      .then(drainFanoutJobs);

  // Run schema self-check first, then start the poll loop. Never crashes the
  // process — just retries with backoff so a temporary DB outage does not
  // turn into an infinite container restart loop.
  waitForSchema(sb).then(() => {
    run();
    timer = setInterval(run, POLL_INTERVAL_MS);
    if (inproc) timer.unref?.();
  });
  // NOTE: do NOT call timer.unref() here. In standalone mode the interval
  // is the only thing keeping the event loop alive — unref'ing it makes
  // the process exit immediately, which causes container restart loops.

  // In standalone mode, keep an open handle so the loop never exits even
  // before the schema check completes (otherwise the event loop would drain
  // during the initial backoff window).
  if (standalone) {
    const keepAlive = setInterval(() => {}, 1 << 30);
    process.on('exit', () => clearInterval(keepAlive));
  }

  // Keep the process alive cleanly and handle signals.
  const shutdown = (sig: string) => {
    log('shutdown', { signal: sig });
    if (timer) clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => {
    console.error('[ai-kb worker] uncaughtException', e);
  });
  process.on('unhandledRejection', (e) => {
    console.error('[ai-kb worker] unhandledRejection', e);
  });
}

// Standalone entry — only runs the loop when this module is the main one.
const isMain = (() => {
  try {
    const u = new URL(import.meta.url);
    return process.argv[1] && u.pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '');
  } catch { return false; }
})();

if (isMain || process.env.AI_KB_WORKER_STANDALONE === '1') {
  startAiKbWorker();
}
