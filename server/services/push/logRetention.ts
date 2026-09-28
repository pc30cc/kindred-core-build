/**
 * NOTIFICATION LOG CLEANUP.
 *
 * `push_dispatch_log` gains a row for every notification sent to every
 * operator's phones — iPhone and Android alike. The row is what stops the
 * same notification being sent twice, and what Super Admin's diagnostics
 * list; neither needs it for long, and nothing ever removed one. Super Admin
 * offered "delivery log retention (days)" for as long as the setting has
 * existed, and this is the first code that reads it.
 *
 * Two ways in, one path:
 *  • automatically, from the server process a few minutes after boot and
 *    then every few hours, while `dispatch_log_auto_purge` is on;
 *  • on demand, from Super Admin's "Clean up now".
 *
 * Deleting happens in batches (`purge_push_dispatch_log`, migration 236) so
 * no statement holds the table for long; a database without that function
 * gets one plain delete instead. The day of rows before the cutoff is never
 * at risk — the retention is at least one day — so a provider retrying a
 * delivery an hour later still finds its row and stays silent. Never throws
 * out of the janitor.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { loadPushPlatformSettings } from './platformSettings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows per statement. */
const BATCH = 5000;
/** Statements per run: 1,000,000 rows, then the next run carries on. */
const MAX_BATCHES = 200;
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 1–365 whole days, whatever was stored or sent. */
export function clampRetentionDays(value: unknown): number {
  const days = Math.trunc(Number(value));
  if (!Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, days));
}

/** The instant before which rows go, for a retention of `days`. */
export function retentionCutoff(days: number, now = Date.now()): string {
  return new Date(now - clampRetentionDays(days) * DAY_MS).toISOString();
}

/**
 * Removes every log row older than `days` and records the run. Returns how
 * many rows went.
 */
export async function purgeDispatchLog(config: ServerConfig, days: number): Promise<number> {
  const sb = getServiceClient(config);
  const before = retentionCutoff(days);
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { data, error } = await sb.rpc('purge_push_dispatch_log', { p_before: before, p_batch: BATCH });
    if (error) {
      // A database without migration 236: one plain delete does the same.
      const { count, error: deleteError } = await sb
        .from('push_dispatch_log')
        .delete({ count: 'exact' })
        .lt('created_at', before);
      if (deleteError) throw new Error(deleteError.message);
      removed += count ?? 0;
      break;
    }
    const count = Number(data ?? 0);
    removed += count;
    if (count < BATCH) break;
  }
  await recordRun(config, removed);
  return removed;
}

/** When the last cleanup ran and what it took, for Super Admin to show. */
async function recordRun(config: ServerConfig, removed: number): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('push_platform_settings')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (!id) return;
    await sb
      .from('push_platform_settings')
      .update({ dispatch_log_purged_at: new Date().toISOString(), dispatch_log_purged_count: removed })
      .eq('id', id);
  } catch {
    // Only a record of the run; the rows are already gone.
  }
}

export interface DispatchLogStats {
  total: number;
  /** Rows the retention would remove right now. */
  expired: number;
  oldest: string | null;
  retentionDays: number;
  autoPurge: boolean;
  lastPurgedAt: string | null;
  lastPurgedCount: number | null;
}

/**
 * What the log holds, and what a cleanup would take — at the saved
 * retention, or at `days` when the screen is showing one not saved yet.
 */
export async function dispatchLogStats(config: ServerConfig, days?: number): Promise<DispatchLogStats> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('push_platform_settings')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const settings = (row ?? {}) as Record<string, unknown>;
  const retentionDays = clampRetentionDays(days ?? settings.dispatch_log_retention_days ?? 30);

  const [{ count: total }, { count: expired }, { data: oldestRow }] = await Promise.all([
    sb.from('push_dispatch_log').select('id', { count: 'exact', head: true }),
    sb
      .from('push_dispatch_log')
      .select('id', { count: 'exact', head: true })
      .lt('created_at', retentionCutoff(retentionDays)),
    sb.from('push_dispatch_log').select('created_at').order('created_at', { ascending: true }).limit(1).maybeSingle(),
  ]);

  return {
    total: total ?? 0,
    expired: expired ?? 0,
    oldest: (oldestRow as { created_at?: string } | null)?.created_at ?? null,
    retentionDays,
    autoPurge: settings.dispatch_log_auto_purge !== false,
    lastPurgedAt: (settings.dispatch_log_purged_at as string | null | undefined) ?? null,
    lastPurgedCount:
      settings.dispatch_log_purged_count == null ? null : Number(settings.dispatch_log_purged_count),
  };
}

/** One automatic pass: nothing while the switch is off. */
export async function runDispatchLogJanitorOnce(config: ServerConfig): Promise<number | null> {
  try {
    const policy = await loadPushPlatformSettings(config);
    if (policy.dispatch_log_auto_purge === false) return null;
    const removed = await purgeDispatchLog(config, policy.dispatch_log_retention_days);
    if (removed > 0) console.log(`[push] notification log cleanup removed ${removed} rows`);
    return removed;
  } catch (err) {
    console.warn('[push] notification log cleanup failed:', (err as Error)?.message ?? err);
    return null;
  }
}

export function startDispatchLogJanitor(config: ServerConfig): void {
  setTimeout(() => { void runDispatchLogJanitorOnce(config); }, FIRST_RUN_DELAY_MS);
  setInterval(() => { void runDispatchLogJanitorOnce(config); }, RUN_INTERVAL_MS);
}
