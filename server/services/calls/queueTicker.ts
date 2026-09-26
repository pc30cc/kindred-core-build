/**
 * Phase 8C/8D — Periodic queue maintenance.
 *
 *   • expireStaleEntries  — entries past expires_at → 'expired'
 *   • reapStaleOffers     — offered too long → re-queue or 'missed'
 *   • autoAssignQueued    — find an eligible operator for the oldest
 *     'queued' entry per workspace+channel and offer it.
 *
 * All steps are best-effort, idempotent, single-process. Workspace-scoped
 * iteration so one bad workspace can't poison the rest.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { expireStaleEntries, reapStaleOffers, offerEntry, type QueueEntry } from './queue.js';
import { pickOperatorForOffer } from './routing.js';

const INTERVAL_MS = 10_000;

async function autoAssignWorkspace(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_queue_entries')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('state', 'queued')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(20);
  if (!data || data.length === 0) return 0;

  // Track operators who already hold an offer so we don't double-assign
  // someone if multiple entries happen to be queued. That includes offers
  // made on EARLIER ticks that are still pending: an offer lives longer than
  // one 10s tick, and remembering only this tick's offers let one operator
  // ring for two calls at once while a free colleague got none.
  const { data: liveOffers } = await sb
    .from('call_queue_entries')
    .select('offered_to_user_id')
    .eq('workspace_id', workspaceId)
    .eq('state', 'offered')
    .not('offered_to_user_id', 'is', null);
  const offeredInThisTick = new Set<string>(
    (liveOffers || []).map((o) => (o as { offered_to_user_id: string }).offered_to_user_id),
  );
  let assignments = 0;

  // Group by channel to keep offers symmetrical per type.
  const byChannel: Record<'audio' | 'video', QueueEntry[]> = { audio: [], video: [] };
  for (const e of data as QueueEntry[]) byChannel[e.channel as 'audio' | 'video'].push(e);

  for (const ch of ['audio', 'video'] as const) {
    for (const entry of byChannel[ch]) {
      const operatorId = await pickOperatorForOffer(
        config,
        workspaceId,
        ch,
        Array.from(offeredInThisTick),
      );
      if (!operatorId) break; // no more operators for this channel
      try {
        await offerEntry(config, entry.id, operatorId);
        offeredInThisTick.add(operatorId);
        assignments++;
      } catch {/* race or state moved — fine */}
    }
  }
  return assignments;
}

async function autoAssignAllWorkspaces(config: ServerConfig): Promise<number> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_queue_entries')
    .select('workspace_id')
    .eq('state', 'queued')
    .limit(200);
  if (!data || data.length === 0) return 0;
  const workspaces = Array.from(new Set(data.map((d) => (d as any).workspace_id as string)));
  let total = 0;
  for (const ws of workspaces) {
    try {
      total += await autoAssignWorkspace(config, ws);
    } catch (err: any) {
      console.warn('[callQueue] auto-assign failed for ws', ws, err?.message || err);
    }
  }
  return total;
}

/**
 * Whether any entry is 'queued' or 'offered'. Every step of a pass acts only
 * on those two states, so when this is false the pass would change nothing.
 * One index-only read (call_queue_has_active_entries() over
 * idx_call_queue_active, migration 218) instead of an UPDATE and two SELECTs
 * every 10s against a table that only grows — ~29k statements a day on an
 * install where nobody is calling.
 *
 * The RPC rather than a `.in('state', …)` filter: PostgREST binds filter
 * values as parameters, and once Postgres moves that statement to a generic
 * plan the partial index is unusable and the probe reads the whole table
 * (measured: 1,870 buffers vs 1). A database without migration 218 falls
 * back to the filter; a read that fails outright says "true", so the pass
 * runs exactly as before.
 */
async function hasActiveEntries(config: ServerConfig): Promise<boolean> {
  const sb = getServiceClient(config);
  const probe = await sb.rpc('call_queue_has_active_entries');
  if (!probe.error) return probe.data === true;
  const { data, error } = await sb
    .from('call_queue_entries')
    .select('id')
    .in('state', ['queued', 'offered'])
    .limit(1);
  return !!error || (data || []).length > 0;
}

let passRunning = false;

export function startCallQueueTicker(config: ServerConfig): void {
  setInterval(async () => {
    // A pass slower than the interval (a slow database, many workspaces)
    // must not have the next one stacked on top of it.
    if (passRunning) return;
    passRunning = true;
    try {
      if (!(await hasActiveEntries(config))) return;
      try { await expireStaleEntries(config); } catch (err: any) {
        console.warn('[callQueue] expiry sweep failed:', err?.message || err);
      }
      try { await reapStaleOffers(config); } catch (err: any) {
        console.warn('[callQueue] reap stale offers failed:', err?.message || err);
      }
      try { await autoAssignAllWorkspaces(config); } catch (err: any) {
        console.warn('[callQueue] auto-assign failed:', err?.message || err);
      }
    } finally {
      passRunning = false;
    }
  }, INTERVAL_MS).unref();
}
