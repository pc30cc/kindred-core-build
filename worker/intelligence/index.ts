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

const POLL_INTERVAL_MS = parseInt(process.env.AI_KB_WORKER_POLL_MS || '5000', 10);
const WORKER_ID = process.env.WORKER_ID || `ai-kb-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

export interface WorkerEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  workerId: string;
}

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

async function tick(sb: SupabaseClient, queue: JobQueueProvider, env: WorkerEnv) {
  try {
    const job = await queue.claimNext(env.workerId);
    if (!job) return;
    try {
      await processJob(sb, env, job);
    } catch (err: any) {
      console.error('[ai-kb worker] job failed', job.id, err?.message);
      await queue.failJob(job.id, err?.message || 'unknown');
      await queue.recordEvent(job.id, job.workspace_id, 'error', 'Job failed', { error: err?.message });
    }
  } catch (err: any) {
    console.error('[ai-kb worker] tick error:', err?.message);
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
  console.log(`[ai-kb worker] started workerId=${env.workerId} interval=${POLL_INTERVAL_MS}ms`);
  const run = () => tick(sb, queue, env).catch((e) => console.error('[ai-kb worker]', e));
  run();
  timer = setInterval(run, POLL_INTERVAL_MS);
  timer.unref?.();
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
