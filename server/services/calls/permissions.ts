/**
 * Phase 8C — Call-channel role permissions.
 *
 * Two-tier resolution:
 *   1. Platform default rows (workspace_id IS NULL).
 *   2. Workspace overrides (workspace_id = the workspace).
 *
 * The workspace row, when present, fully replaces the platform value
 * for that single (role_slug, permission_key) pair. Missing rows fall
 * back to a hard-coded conservative default (false). Cached for 30s
 * per workspace+role to keep the call hot path off the DB.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type CallPermissionKey =
  | 'can_start_audio_call'
  | 'can_start_video_call'
  | 'can_receive_audio_call'
  | 'can_receive_video_call'
  | 'can_record_calls'
  | 'can_transfer_calls'
  | 'can_join_queue_calls'
  | 'can_manage_call_queue';

export const ALL_CALL_PERMISSIONS: CallPermissionKey[] = [
  'can_start_audio_call',
  'can_start_video_call',
  'can_receive_audio_call',
  'can_receive_video_call',
  'can_record_calls',
  'can_transfer_calls',
  'can_join_queue_calls',
  'can_manage_call_queue',
];

export type RoleSlug = 'owner' | 'admin' | 'agent' | 'viewer';

export type PermissionMap = Record<CallPermissionKey, boolean>;

const HARD_DEFAULT: PermissionMap = {
  can_start_audio_call: false,
  can_start_video_call: false,
  can_receive_audio_call: false,
  can_receive_video_call: false,
  can_record_calls: false,
  can_transfer_calls: false,
  can_join_queue_calls: false,
  can_manage_call_queue: false,
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: PermissionMap; ts: number }>();

function cacheKey(workspaceId: string, roleSlug: string): string {
  return `${workspaceId}::${roleSlug}`;
}

export function invalidatePermissionCache(workspaceId?: string): void {
  if (!workspaceId) { cache.clear(); return; }
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${workspaceId}::`)) cache.delete(k);
  }
}

/**
 * Resolve effective permissions for a single (workspace, role) pair.
 * Workspace rows override platform defaults; missing keys remain false.
 */
export async function resolveRolePermissions(
  config: ServerConfig,
  workspaceId: string,
  roleSlug: RoleSlug,
): Promise<PermissionMap> {
  const key = cacheKey(workspaceId, roleSlug);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('role_permissions')
    .select('permission_key, granted, workspace_id')
    .eq('role_slug', roleSlug)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);

  const map: PermissionMap = { ...HARD_DEFAULT };
  if (!error && Array.isArray(data)) {
    // Apply platform defaults first.
    for (const r of data) {
      if (r.workspace_id === null && (ALL_CALL_PERMISSIONS as string[]).includes(r.permission_key)) {
        (map as any)[r.permission_key] = !!r.granted;
      }
    }
    // Workspace rows override.
    for (const r of data) {
      if (r.workspace_id === workspaceId && (ALL_CALL_PERMISSIONS as string[]).includes(r.permission_key)) {
        (map as any)[r.permission_key] = !!r.granted;
      }
    }
  }

  cache.set(key, { value: map, ts: Date.now() });
  return map;
}

/** Resolve permissions for the user's role inside a workspace. */
export async function resolveUserCallPermissions(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<PermissionMap & { role: RoleSlug | null }> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  const role = (data?.role ?? null) as RoleSlug | null;
  if (!role) return { ...HARD_DEFAULT, role: null };
  const perms = await resolveRolePermissions(config, workspaceId, role);
  return { ...perms, role };
}