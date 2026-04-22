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

  // Track operators we've already offered in THIS tick so we don't
  // double-assign someone if multiple entries happen to be queued.
  const offeredInThisTick = new Set<string>();
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

export function startCallQueueTicker(config: ServerConfig): void {
  setInterval(async () => {
    try { await expireStaleEntries(config); } catch (err: any) {
      console.warn('[callQueue] expiry sweep failed:', err?.message || err);
    }
    try { await reapStaleOffers(config); } catch (err: any) {
      console.warn('[callQueue] reap stale offers failed:', err?.message || err);
    }
    try { await autoAssignAllWorkspaces(config); } catch (err: any) {
      console.warn('[callQueue] auto-assign failed:', err?.message || err);
    }
  }, INTERVAL_MS).unref();
}
