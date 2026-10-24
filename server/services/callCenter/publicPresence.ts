/**
 * The call widget's public presence: whether an operator is available, and
 * (for the launcher styles that draw them) who.
 *
 * GET /api/call-widget/bootstrap sends it as `presence`:
 *   - `any_available` always: true when an operator-roled member's call
 *     center status is `available`, the rule routing and the ring use
 *     (push/callRing.ts `availableAgents`). The widget's header dot and
 *     text and its launcher's dot follow it; whether calls can be placed
 *     does not (`isOnline()` is the channel switches, as before);
 *   - `operators` only for `card` and `operator_face`
 *     (shared/callLauncherStyles.ts `callLauncherNeedsPresence`): at most 3
 *     available operators in the chat team's order (the order they joined the
 *     workspace, shared/widgetTeam.ts), each `{name, avatar_url}`. `name`
 *     is the profile's own name or null, never an e-mail or any part of
 *     one; `avatar_url` the user's own avatar or null (the widget then draws
 *     the person silhouette, never a letter). No id, role, count
 *     or status beyond "available": the bootstrap is public (its Origin can
 *     be forged).
 *
 * Kept per workspace for 30 s per process (concurrent misses share one load,
 * the map is bounded), so a page view reads no table on a hit. Dropped on
 * every process by the cache bus: `callpresence:<workspace>` (an operator
 * changed their status: PUT /api/call-center/agents/me/presence),
 * `widget:<workspace>` (settings, members), `user:<id>` (a profile's name or
 * avatar) and `platform`. There is no heartbeat behind a status: an operator
 * who closed the dashboard while `available` still counts, as for routing.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { onInvalidate } from '../../lib/cacheBus.js';
import { canonicalWorkspaceId } from '../../lib/workspaceId.js';
import { createStorageUrlResolver, hydrateUserAvatars } from '../storage/urlResolver.js';
import { widgetTeamMembers } from '../../../shared/widgetTeam.js';
import { launcherInitial } from '../../../shared/launcherStyles.js';

/** An operator as the call widget draws them: their photo, else the person silhouette (never a letter). */
export interface PublicCallOperator {
  name: string | null;
  avatar_url: string | null;
}

export interface PublicCallPresence {
  any_available: boolean;
  /** Empty unless asked for (`withOperators`). */
  operators: PublicCallOperator[];
}

/** Who answers calls: the call centre's own list (callRing.ts, routing.ts). */
const OPERATOR_ROLES = new Set(['owner', 'admin', 'team_lead', 'agent', 'support_agent']);
/** The launchers draw three at most (card: three faces; operator_face: the first). */
export const PUBLIC_CALL_OPERATORS_MAX = 3;

const TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;

type Entry = {
  at: number;
  workspace: string;
  /** The operators' user ids (never sent): a profile change drops the entry. */
  userIds: string[];
  value: Promise<PublicCallPresence>;
};
/** Map order = age (oldest first). */
const entries = new Map<string, Entry>();
const inflight = new Map<string, Entry>();

function workspaceKey(workspaceId: string): string {
  return canonicalWorkspaceId(workspaceId) ?? workspaceId.toLowerCase();
}

/** Drop one workspace's presence (both shapes), or everything. Loads in progress for it are not stored. */
export function invalidatePublicCallPresence(workspaceId?: string | null): void {
  if (!workspaceId) { entries.clear(); inflight.clear(); return; }
  const ws = workspaceKey(workspaceId);
  for (const map of [entries, inflight]) {
    for (const [key, entry] of map) if (entry.workspace === ws) map.delete(key);
  }
}

/**
 * A profile (name, avatar) changed: the entries that publish that user, and
 * every load in progress that publishes operators (it may have read the old
 * profile; it is answered, not stored).
 */
function invalidateUser(userId: string): void {
  const id = userId.toLowerCase();
  for (const [key, entry] of entries) if (entry.userIds.includes(id)) entries.delete(key);
  for (const key of [...inflight.keys()]) if (key.endsWith(':ops')) inflight.delete(key);
}

onInvalidate('callpresence', (workspaceId) => invalidatePublicCallPresence(workspaceId));
onInvalidate('widget', (workspaceId, { resync }) => { if (!resync) invalidatePublicCallPresence(workspaceId); });
onInvalidate('platform', (_key, { resync }) => { if (!resync) invalidatePublicCallPresence(); });
onInvalidate('user', (userId, { resync }) => {
  if (resync) return;
  if (userId) invalidateUser(userId);
  else invalidatePublicCallPresence();
});

/**
 * An operator's name as a visitor may see it: their profile's own name,
 * trimmed, or null, never anything from their e-mail. A name with nothing
 * that shows (only marks, spaces or control characters) is no name, as the
 * chat's team stack reads it (shared/widgetTeam.ts): the widget then says
 * "operator". Also the call status endpoint's `operator_name`.
 */
export function operatorOwnName(fullName: unknown): string | null {
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  return name && launcherInitial([name]) ? name : null;
}

type MemberRow = { user_id: string | null; role: string | null; created_at?: string | null };
type PresenceRow = { user_id: string | null; status: string | null };
type ProfileRow = { id: string; full_name: string | null; avatar_storage_key?: string | null };

async function loadPresence(
  config: ServerConfig,
  workspaceId: string,
  withOperators: boolean,
): Promise<{ value: PublicCallPresence; userIds: string[] }> {
  const sb = getServiceClient(config);
  const { data: members, error: membersError } = await sb
    .from('workspace_members')
    .select('user_id, role, created_at')
    .eq('workspace_id', workspaceId);
  if (membersError) throw membersError;
  const operators = ((members || []) as MemberRow[])
    .filter((m) => !!m.user_id && OPERATOR_ROLES.has(String(m.role ?? '')));
  if (!operators.length) return { value: { any_available: false, operators: [] }, userIds: [] };
  const { data: presence, error: presenceError } = await sb
    .from('call_center_agent_presence')
    .select('user_id, status')
    .eq('workspace_id', workspaceId)
    .in('user_id', operators.map((m) => m.user_id as string));
  if (presenceError) throw presenceError;
  const available = new Set(
    ((presence || []) as PresenceRow[])
      .filter((p) => String(p.status ?? '') === 'available')
      .map((p) => String(p.user_id)),
  );
  const availableMembers = operators.filter((m) => available.has(String(m.user_id)));
  if (!withOperators || !availableMembers.length) {
    return { value: { any_available: availableMembers.length > 0, operators: [] }, userIds: [] };
  }
  // The chat team's order (the order they joined); the first three.
  const shown = widgetTeamMembers(availableMembers).slice(0, PUBLIC_CALL_OPERATORS_MAX).map((m) => String(m.user_id));
  const { data: profiles, error: profilesError } = await sb
    .from('profiles')
    .select('id, full_name, avatar_storage_key')
    .in('id', shown);
  if (profilesError) throw profilesError;
  const hydrated = await hydrateUserAvatars(createStorageUrlResolver(config), (profiles || []) as ProfileRow[]);
  const byId = new Map(hydrated.map((p) => [String(p.id), p]));
  return {
    value: {
      any_available: true,
      operators: shown.map((id) => {
        const p = byId.get(id);
        const name = operatorOwnName(p?.full_name);
        return { name, avatar_url: p?.avatar_url ?? null };
      }),
    },
    userIds: shown.map((id) => id.toLowerCase()),
  };
}

/**
 * The workspace's public presence, from the memo when fresh. Never throws: a
 * failed read answers "available" without operators (the widget then reads as
 * it did before presence existed) and is not kept.
 */
export async function loadPublicCallPresence(
  config: ServerConfig,
  workspaceId: string,
  opts: { withOperators?: boolean } = {},
): Promise<PublicCallPresence> {
  const withOperators = opts.withOperators === true;
  const ws = workspaceKey(workspaceId);
  const key = `${ws}:${withOperators ? 'ops' : 'any'}`;
  const now = Date.now();
  const hit = entries.get(key);
  let value: Promise<PublicCallPresence>;
  if (hit && now - hit.at < TTL_MS) {
    value = hit.value;
  } else {
    if (hit) entries.delete(key);
    const pending = inflight.get(key);
    if (pending) {
      value = pending.value;
    } else {
      const entry: Entry = { at: now, workspace: ws, userIds: [], value: undefined as unknown as Promise<PublicCallPresence> };
      entry.value = loadPresence(config, workspaceId, withOperators).then(
        (loaded) => {
          entry.userIds = loaded.userIds;
          // Not stored when an invalidation came in meanwhile.
          if (inflight.get(key) === entry) {
            inflight.delete(key);
            entries.set(key, entry);
            if (entries.size > MAX_ENTRIES) {
              const oldest = entries.keys().next().value;
              if (oldest !== undefined) entries.delete(oldest);
            }
          }
          return loaded.value;
        },
        (err) => {
          if (inflight.get(key) === entry) inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, entry);
      value = entry.value;
    }
  }
  try {
    return await value;
  } catch (e) {
    console.warn('[call-widget] presence read failed:', e instanceof Error ? e.message : e);
    return { any_available: true, operators: [] };
  }
}
