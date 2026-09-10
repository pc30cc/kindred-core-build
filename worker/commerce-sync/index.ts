/**
 * Standalone Commerce sync worker entry — same shape as
 * worker/source-sync/index.ts. Polls public.commerce_sync_jobs via the
 * lease-based commerce_claim_sync_job RPC (server/services/commerce/sync.ts)
 * and periodically enqueues bounded incremental reconciliation for
 * connected stores. No Express, no frontend.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
 *   PLUGIN_SECRETS_MASTER_KEY                 required (installation secrets)
 *   WORKER_ID                                 optional
 *   COMMERCE_WORKER_POLL_MS                   optional, default 5000
 *   COMMERCE_WORKER_RECONCILE_MS              optional, default 900000 (15m)
 */
import os from 'node:os';
import type { ServerConfig } from '../../server/config.js';
import { claimNextSyncJob, runSyncJobOnce, enqueueSyncJob } from '../../server/services/commerce/sync.js';
import { runCapabilityHandshake } from '../../server/services/commerce/pairing.js';
import { getServiceClient } from '../../server/supabase.js';

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = parseInt(v || '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function buildConfig(): ServerConfig {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('[commerce-sync worker] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return {
    port: 0,
    supabaseUrl,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'unused-by-commerce-sync-worker',
    supabaseServiceRoleKey,
    corsOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    selfHostBillingUnlimited: false,
    pluginSecretsMasterKey: process.env.PLUGIN_SECRETS_MASTER_KEY,
  };
}

let started = false;
let stopping = false;
let pollTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;

export function startCommerceSyncWorker(): void {
  if (started) return;
  started = true;

  const config = buildConfig();
  const workerId = process.env.WORKER_ID || `commerce-sync-${os.hostname()}-${process.pid}`;
  const pollMs = clampInt(process.env.COMMERCE_WORKER_POLL_MS, 5_000, 1_000, 60_000);
  const reconcileMs = clampInt(process.env.COMMERCE_WORKER_RECONCILE_MS, 900_000, 60_000, 3_600_000);

  console.log('[commerce-sync worker] starting', { workerId, pollMs, reconcileMs });

  const tick = async () => {
    if (stopping) return;
    try {
      const job = await claimNextSyncJob(config, workerId);
      if (job) {
        await runSyncJobOnce(config, job as any);
        // A job may have re-queued itself (bounded page budget) — poll again
        // immediately rather than waiting a full interval.
        pollTimer = setTimeout(tick, 50);
        return;
      }
    } catch (err) {
      console.error('[commerce-sync worker] tick failed:', err instanceof Error ? err.message : err);
    }
    pollTimer = setTimeout(tick, pollMs);
  };

  /**
   * Periodic bounded reconciliation (spec §18) — webhooks/events are not
   * sufficient on their own (a plugin can miss delivering one). This never
   * full-syncs: incremental_sync jobs use the connection's stored cursor
   * (modified_after), so each tick only asks the store for what changed
   * since the last successful pass. Also refreshes connection health via
   * the capability handshake so a plugin update / recovered store is
   * noticed without waiting on the next admin-initiated "Test connection".
   */
  const reconcile = async () => {
    if (stopping) return;
    try {
      const sb = getServiceClient(config);
      const { data: connections } = await sb
        .from('commerce_connections')
        .select('id, workspace_id')
        .is('revoked_at', null)
        .in('health', ['connected', 'degraded', 'offline']);
      for (const conn of connections ?? []) {
        await runCapabilityHandshake(config, conn.id).catch(() => {});
        await enqueueSyncJob(config, conn.workspace_id, conn.id, 'reconciliation').catch(() => {});
      }
    } catch (err) {
      console.error('[commerce-sync worker] reconcile failed:', err instanceof Error ? err.message : err);
    }
    reconcileTimer = setTimeout(reconcile, reconcileMs);
  };

  void tick();
  reconcileTimer = setTimeout(reconcile, reconcileMs);
}

export function stopCommerceSyncWorker(): void {
  stopping = true;
  if (pollTimer) clearTimeout(pollTimer);
  if (reconcileTimer) clearTimeout(reconcileTimer);
}
