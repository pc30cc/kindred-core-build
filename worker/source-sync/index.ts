/**
 * Standalone Data Hub Source-Sync worker entry.
 *
 * Polls public.ai_source_sync_jobs and processes them via the shared
 * processOne() routine in server/services/ai-agent/sourceWorker.ts.
 * Never claims ai_kb_jobs. No Express. No frontend. No HTTP server.
 *
 * Env:
 *   SUPABASE_URL                              required
 *   SUPABASE_SERVICE_ROLE_KEY                 required
 *   SUPABASE_ANON_KEY                         optional (defaulted if missing —
 *                                             this worker only uses the
 *                                             service-role client)
 *   WORKER_ID | AI_KB_WORKER_ID               optional
 *   WORKER_INTERVAL_MS | AI_KB_WORKER_INTERVAL_MS | AI_KB_WORKER_POLL_MS
 *   WORKER_LOCK_TTL_SECONDS | AI_KB_WORKER_LOCK_TTL_SECONDS
 */

import os from 'node:os';
import type { ServerConfig } from '../../server/config.js';
import { processOne, getWorkerInfo } from '../../server/services/ai-agent/sourceWorker.js';

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = parseInt(v || '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function buildConfig(): ServerConfig {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('[ai-source worker] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  // Anon key is unused by sourceWorker (only service client is used). Keep a
  // safe placeholder so we don't force operators to wire the anon key into
  // the worker container.
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'unused-by-source-sync-worker';
  return {
    port: 0,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    corsOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    selfHostBillingUnlimited: false,
  };
}

let started = false;
let stopping = false;
let timer: NodeJS.Timeout | null = null;

export function startSourceSyncWorker(): void {
  if (started) return;
  started = true;

  // Map new env names onto the AI_KB_WORKER_* names that sourceWorker.ts
  // already reads, so we have a single resolution path.
  if (!process.env.AI_KB_WORKER_ID && process.env.WORKER_ID) {
    process.env.AI_KB_WORKER_ID = process.env.WORKER_ID;
  }
  if (!process.env.AI_KB_WORKER_INTERVAL_MS) {
    process.env.AI_KB_WORKER_INTERVAL_MS =
      process.env.WORKER_INTERVAL_MS || process.env.AI_KB_WORKER_POLL_MS || '5000';
  }
  if (!process.env.AI_KB_WORKER_LOCK_TTL_SECONDS && process.env.WORKER_LOCK_TTL_SECONDS) {
    process.env.AI_KB_WORKER_LOCK_TTL_SECONDS = process.env.WORKER_LOCK_TTL_SECONDS;
  }

  const config = buildConfig();
  const info = getWorkerInfo();
  const workerId =
    process.env.AI_KB_WORKER_ID ||
    `${os.hostname?.() || 'host'}-${process.pid}-source-sync`;
  const pollMs = clampInt(process.env.AI_KB_WORKER_INTERVAL_MS, 5000, 1000, 60_000);
  const idleLogMs = clampInt(process.env.AI_KB_WORKER_IDLE_LOG_MS, 60_000, 5000, 600_000);

  // Restrict claimable job types based on WORKER_KIND so a dedicated
  // file-ingest worker never accidentally claims website crawl jobs (and
  // vice versa). 'all' / 'source-sync' fallback to "no filter" when
  // explicitly requested via AI_SOURCE_JOB_TYPES env override.
  const kind = (process.env.WORKER_KIND || 'source-sync').trim().toLowerCase();
  let jobTypes: string[] | undefined;
  if (kind === 'file-ingest') jobTypes = ['file_ingest'];
  else if (kind === 'source-sync') jobTypes = ['website_sync', 'website_rebuild'];
  else jobTypes = undefined; // 'all' / dev
  const envOverride = (process.env.AI_SOURCE_JOB_TYPES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envOverride.length > 0) jobTypes = envOverride;

  console.log('[ai-source worker] started', {
    workerId, pollMs, lockTtl: info.lockTtlSeconds, kind, jobTypes: jobTypes || 'all',
  });

  let lastIdleLog = 0;
  const tick = async () => {
    if (stopping) return;
    try {
      const res = await processOne(config, { jobTypes });
      if (!res.processed) {
        const now = Date.now();
        if (now - lastIdleLog >= idleLogMs) {
          lastIdleLog = now;
          console.log('[ai-source worker] idle');
        }
      }
    } catch (e: any) {
      console.warn('[ai-source worker] tick error:', e?.message);
    } finally {
      if (!stopping) timer = setTimeout(tick, pollMs);
    }
  };
  timer = setTimeout(tick, 1000);

  const shutdown = (sig: string) => {
    console.log('[ai-source worker] shutdown', { signal: sig });
    stopping = true;
    if (timer) clearTimeout(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep the event loop alive even if all timers are unref'd elsewhere.
  const keepAlive = setInterval(() => {}, 1 << 30);
  process.on('exit', () => clearInterval(keepAlive));
}

const isMain = (() => {
  try {
    const u = new URL(import.meta.url);
    return !!process.argv[1] && u.pathname.endsWith(
      (process.argv[1].replace(/\\/g, '/').split('/').pop() || '')
    );
  } catch { return false; }
})();

if (isMain) startSourceSyncWorker();