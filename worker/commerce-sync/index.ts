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
 *   COMMERCE_WORKER_MAX_IDLE_POLL_MS          optional, default 30000
 *   COMMERCE_WORKER_RECONCILE_MS              optional, default 900000 (15m)
 */
import os from 'node:os';
import { envFlagEnabled, type ServerConfig } from '../../server/config.js';
import { claimNextSyncJob, runSyncJobOnce, enqueueSyncJob } from '../../server/services/commerce/sync.js';
import { runCapabilityHandshake } from '../../server/services/commerce/pairing.js';
import { catalogIndexedProviders } from '../../server/services/commerce/connectors/registry.js';
import { getServiceClient } from '../../server/supabase.js';
import { IdleBackoff } from '../../server/services/jobs/idleBackoff.js';

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
    // Logging switches. These workers build their ServerConfig by hand
    // instead of calling loadConfig(), so without these three lines the
    // request-path logging flags would silently NOT reach the writers this
    // container runs. envFlagEnabled() is the same parsing rule loadConfig()
    // uses: only the literal `off` disables, so omitting the env var here
    // leaves every write exactly as it is today.
    productAnalyticsLoggingEnabled: envFlagEnabled('PRODUCT_ANALYTICS_LOGGING'),
    deliveryDiagnosticsLoggingEnabled: envFlagEnabled('DELIVERY_DIAGNOSTICS_LOGGING'),
    complianceAuditLoggingEnabled: envFlagEnabled('COMPLIANCE_AUDIT_LOGGING'),
  };
}

const LONG_OFFLINE_MS = 60 * 60_000;

function succeededWithin(lastSuccessAt: string | null | undefined, ms: number): boolean {
  const at = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  return Number.isFinite(at) && Date.now() - at < ms;
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
  const maxIdlePollMs = clampInt(process.env.COMMERCE_WORKER_MAX_IDLE_POLL_MS, 30_000, pollMs, 300_000);
  const reconcileMs = clampInt(process.env.COMMERCE_WORKER_RECONCILE_MS, 900_000, 60_000, 3_600_000);

  console.log('[commerce-sync worker] starting', { workerId, pollMs, maxIdlePollMs, reconcileMs });

  // The first idle poll still waits pollMs; only a queue that stays empty
  // eases off, to maxIdlePollMs, and any claimed job resets it. An empty
  // queue used to be asked every 5s around the clock (17,280 claims a day)
  // although jobs arrive a few times an hour.
  const backoff = new IdleBackoff({ busyMs: 50, idleMs: pollMs, maxIdleMs: maxIdlePollMs });

  const tick = async () => {
    if (stopping) return;
    let claimed = false;
    try {
      const job = await claimNextSyncJob(config, workerId);
      if (job) {
        claimed = true;
        await runSyncJobOnce(config, job);
        // A job may have re-queued itself (bounded page budget) — poll again
        // immediately rather than waiting a full interval.
      }
    } catch (err) {
      console.error('[commerce-sync worker] tick failed:', err instanceof Error ? err.message : err);
    }
    if (stopping) return;
    pollTimer = setTimeout(tick, backoff.next(claimed));
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
      // Catalogue-indexed providers only. A live-queried billing connection
      // (WHMCS) has no index to reconcile, and a periodic handshake to every
      // installation would be exactly the background heartbeat that design
      // rules out — its health comes from real reads and the owner's
      // "Check connection" button (docs/commerce/WHMCS.md).
      const { data: connections } = await sb
        .from('commerce_connections')
        .select('id, workspace_id')
        .is('revoked_at', null)
        .in('health', ['connected', 'degraded', 'offline'])
        // Only indexed stores are reconciled. Direct stores (OpenCart) and
        // billing systems (WHMCS) are never polled or synced: their health
        // comes from real requests and the manual check.
        .in('provider_type', catalogIndexedProviders());
      for (const conn of connections ?? []) {
        await runCapabilityHandshake(config, conn.id).catch(() => {});
        // A store that has been unreachable for over an hour — typically one
        // that went away without disconnecting — would only fail the job
        // through every retry and leave a dead-letter row behind: a dozen
        // writes each pass, forever. A shorter outage still gets its job,
        // whose retries may well outlast it. The handshake above runs every
        // pass either way, so a store that comes back is synced on the pass
        // that notices.
        const { data: after } = await sb
          .from('commerce_connections')
          .select('health, last_success_at')
          .eq('id', conn.id)
          .maybeSingle();
        if (after?.health === 'offline' && !succeededWithin(after.last_success_at, LONG_OFFLINE_MS)) continue;
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
