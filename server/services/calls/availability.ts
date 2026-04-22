/**
 * Phase 8D — Operator call availability service.
 *
 * Per (workspace, user) row in `operator_call_availability`. Operators set
 * their own readiness; server marks `in_call=true` while a call session is
 * active. Cached briefly to keep the routing hot path off the DB.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type AvailabilityStatus =
  | 'unavailable'
  | 'available_audio'
  | 'available_video'
  | 'available_both'
  | 'busy';

export interface AvailabilityRow {
  user_id: string;
  workspace_id: string;
  status: AvailabilityStatus;
  in_call: boolean;
  in_call_since: string | null;
  active_call_session_id: string | null;
  last_heartbeat_at: string;
  updated_at: string;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { rows: AvailabilityRow[]; ts: number }>();

function key(ws: string): string { return `ws:${ws}`; }

export function invalidateAvailabilityCache(workspaceId?: string): void {
  if (!workspaceId) { cache.clear(); return; }
  cache.delete(key(workspaceId));
}

export async function listWorkspaceAvailability(
  config: ServerConfig,
  workspaceId: string,
): Promise<AvailabilityRow[]> {
  const hit = cache.get(key(workspaceId));
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.rows;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('operator_call_availability')
    .select('user_id, workspace_id, status, in_call, in_call_since, active_call_session_id, last_heartbeat_at, updated_at')
    .eq('workspace_id', workspaceId);
  const rows = (data ?? []) as AvailabilityRow[];
  cache.set(key(workspaceId), { rows, ts: Date.now() });
  return rows;
}

export async function getMyAvailability(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<AvailabilityRow | null> {
  const all = await listWorkspaceAvailability(config, workspaceId);
  return all.find((r) => r.user_id === userId) ?? null;
}

export async function setMyAvailability(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  status: AvailabilityStatus,
): Promise<AvailabilityRow> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('operator_call_availability')
    .upsert(
      {
        workspace_id: workspaceId,
        user_id: userId,
        status,
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,user_id' },
    )
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message || 'availability_write_failed');
  invalidateAvailabilityCache(workspaceId);
  return data as AvailabilityRow;
}

export async function markInCall(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  callSessionId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('operator_call_availability')
    .upsert(
      {
        workspace_id: workspaceId,
        user_id: userId,
        status: 'busy',
        in_call: true,
        in_call_since: new Date().toISOString(),
        active_call_session_id: callSessionId,
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,user_id' },
    );
  if (error) console.warn('[availability] markInCall failed:', error.message);
  invalidateAvailabilityCache(workspaceId);
}

export async function clearInCall(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  // We deliberately keep the manual status; just flip in_call off.
  const { error } = await sb
    .from('operator_call_availability')
    .update({
      in_call: false,
      in_call_since: null,
      active_call_session_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
  if (error) console.warn('[availability] clearInCall failed:', error.message);
  invalidateAvailabilityCache(workspaceId);
}

/** True when the operator can take a fresh call on the given channel. */
export function isEligible(row: AvailabilityRow, channel: 'audio' | 'video'): boolean {
  if (row.in_call) return false;
  if (row.status === 'busy' || row.status === 'unavailable') return false;
  if (channel === 'audio') return row.status === 'available_audio' || row.status === 'available_both';
  return row.status === 'available_video' || row.status === 'available_both';
}
