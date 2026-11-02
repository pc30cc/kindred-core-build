/**
 * Colleague calls (team calls): the people side — who may be rung, who is
 * already on a call, and how the colleague on the other end is drawn.
 * docs/operations/TEAM_CALLS.md, "Product rules".
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isSeatLocked } from '../../lib/workspaceAuth.js';
import { hydrateUserAvatars } from '../storage/urlResolver.js';
import {
  TEAM_CALL_ENTRY_SOURCE,
  TEAM_CALL_LIVE_STATES,
  isRingingNow,
  readTeamCallMeta,
  type TeamCallPeer,
  type TeamCallRow,
} from './teamCall.js';

/**
 * A call placed this long ago and still marked live is taken for a row
 * nothing ended (a visitor who vanished, a colleague call whose end never
 * reached the server), not for a call the member is still on: it must not
 * make them unreachable for good. The room check (teamCallTicker.ts) ends a
 * colleague call whose room is empty within a minute or so; this is the guard
 * for the case where nothing could ask the room.
 */
const LIVE_CALL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Calls placed before this instant no longer hold anyone (LIVE_CALL_MAX_AGE_MS). */
export function liveCallCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - LIVE_CALL_MAX_AGE_MS);
}

/** The member's row in the workspace (null when they are not one). Throws on a failed read. */
async function membership(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<{ suspended: boolean } | null> {
  const { data, error } = await getServiceClient(config)
    .from('workspace_members')
    .select('user_id, suspended_at')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`team_call_membership_read_failed: ${error.message}`);
  return data ? { suspended: !!(data as { suspended_at: string | null }).suspended_at } : null;
}

/**
 * Whether [userId] is an active member of [workspaceId]: a membership row,
 * not suspended, and a seat the plan has not paused. A platform admin is not
 * a member by being an admin: a colleague call is between two members.
 * What placing and answering a call need. Throws on a failed read.
 */
export async function isActiveMember(config: ServerConfig, workspaceId: string, userId: string): Promise<boolean> {
  const member = await membership(config, workspaceId, userId);
  if (!member || member.suspended) return false;
  return !(await isSeatLocked(config, workspaceId, userId));
}

/**
 * Whether [userId] is still a member of [workspaceId] who may stay in a call
 * already under way: a membership row, not suspended. A seat the plan paused
 * since does not count — that is a plan change, and a plan change never cuts
 * a call in flight (docs/operations/TEAM_CALLS.md, "Plan": deny on create,
 * allow on continuity). Throws on a failed read.
 */
export async function remainsMember(config: ServerConfig, workspaceId: string, userId: string): Promise<boolean> {
  const member = await membership(config, workspaceId, userId);
  return !!member && !member.suspended;
}

/**
 * Which of [userIds] cannot be rung, or ring anyone, right now:
 *   - in a colleague call that is ringing (with ring left), connecting or
 *     active, as its caller or its callee, in any workspace — one person has
 *     one phone line;
 *   - in any other live call: the call the server marked them in
 *     (`operator_call_availability.in_call`, whose call is still connecting
 *     or active), or a call-centre or chat call they took that is.
 * A manual "busy" availability status is not a call, and does not count, nor
 * does a call placed more than LIVE_CALL_MAX_AGE_MS ago.
 *
 * This is the early answer, read before the plan's provider and the phones
 * are looked up. The colleague-call half is decided again, atomically, when
 * the call is placed: public.team_call_place (migration 293) applies the same
 * rule under a lock per member, so two calls placed at the same moment that
 * share a member can never both ring. Throws on a failed read: a call is
 * never placed on a guess.
 */
export async function busyMembers(config: ServerConfig, userIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const busy = new Set<string>();
  if (!ids.length) return busy;
  const sb = getServiceClient(config);
  const teamColumns = 'id, state, created_at, initiated_by, call_type, metadata';
  const recent = liveCallCutoff().toISOString();
  const [asCaller, asCallee, inCall, taken] = await Promise.all([
    sb.from('call_sessions').select(teamColumns)
      .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
      .in('state', [...TEAM_CALL_LIVE_STATES])
      .in('initiated_by', ids)
      .gte('created_at', recent),
    sb.from('call_sessions').select(teamColumns)
      .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
      .in('state', [...TEAM_CALL_LIVE_STATES])
      .in('metadata->team_call->>callee_user_id', ids)
      .gte('created_at', recent),
    sb.from('operator_call_availability').select('user_id, active_call_session_id')
      .in('user_id', ids)
      .eq('in_call', true),
    sb.from('call_sessions').select('assigned_agent_id')
      .in('assigned_agent_id', ids)
      .in('state', ['connecting', 'active'])
      .neq('entry_source', TEAM_CALL_ENTRY_SOURCE)
      .gte('created_at', recent),
  ]);
  for (const read of [asCaller, asCallee, inCall, taken]) {
    if (read.error) throw new Error(`team_call_busy_read_failed: ${read.error.message}`);
  }

  const now = new Date();
  for (const row of [...(asCaller.data ?? []), ...(asCallee.data ?? [])] as unknown as TeamCallRow[]) {
    // A ring that ran out is the ticker's to mark missed, not a call.
    if (row.state === 'ringing' && !isRingingNow(row, now)) continue;
    const meta = readTeamCallMeta(row);
    for (const id of [meta.caller_user_id, meta.callee_user_id]) if (ids.includes(id)) busy.add(id);
  }
  for (const row of (taken.data ?? []) as Array<{ assigned_agent_id: string | null }>) {
    if (row.assigned_agent_id) busy.add(row.assigned_agent_id);
  }

  const marked = ((inCall.data ?? []) as Array<{ user_id: string; active_call_session_id: string | null }>)
    .filter((r) => !busy.has(r.user_id) && !!r.active_call_session_id);
  if (marked.length) {
    const { data, error } = await sb.from('call_sessions').select('id')
      .in('id', [...new Set(marked.map((r) => r.active_call_session_id as string))])
      .in('state', ['connecting', 'active'])
      .gte('created_at', recent);
    if (error) throw new Error(`team_call_busy_read_failed: ${error.message}`);
    const live = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    for (const r of marked) if (live.has(r.active_call_session_id as string)) busy.add(r.user_id);
  }
  return busy;
}

/**
 * The colleagues [userIds] as a call draws them: profile name, photo from its
 * storage key through the provider in use. No name is null, no photo is null
 * (the apps draw the silhouette). Never an e-mail.
 */
export async function teamCallPeers(config: ServerConfig, userIds: readonly string[]): Promise<Map<string, TeamCallPeer>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, TeamCallPeer>();
  for (const id of ids) out.set(id, { user_id: id, name: null, avatar_url: null });
  if (!ids.length) return out;
  try {
    const { data } = await getServiceClient(config)
      .from('profiles')
      .select('id, full_name, avatar_storage_key')
      .in('id', ids);
    const rows = await hydrateUserAvatars(config, (data ?? []) as Array<{ id: string; full_name: string | null; avatar_storage_key?: string | null }>);
    for (const row of rows) {
      const name = typeof row.full_name === 'string' ? row.full_name.trim() : '';
      out.set(String(row.id), { user_id: String(row.id), name: name || null, avatar_url: row.avatar_url ?? null });
    }
  } catch (err) {
    // A call is never refused for a face: it goes on drawn without one.
    console.warn('[team-call] profiles unreadable:', err instanceof Error ? err.message : err);
  }
  return out;
}

/** The workspace's name, for the ring; null when unreadable. */
export async function workspaceDisplayName(config: ServerConfig, workspaceId: string): Promise<string | null> {
  try {
    const { data } = await getServiceClient(config).from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
    const name = (data as { name?: string | null } | null)?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}
