/**
 * Phase 8H — Optional Departments (foundation).
 *
 * Pure read-side resolvers used by the routing engine to optionally
 * narrow eligible operators by department. The system MUST behave
 * identically when a workspace has no departments configured.
 *
 * Concepts:
 *   - Department          → workspace_departments row (enabled).
 *   - Department member   → workspace_department_members row.
 *   - General Pool        → workspace_members NOT in any department.
 *
 * All resolvers are cached per workspace for 30s. Cache is invalidated
 * by mutation paths (admin endpoints) — not by this module.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type DepartmentChannel = 'chat' | 'audio' | 'video';

export interface DepartmentRow {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  chat_enabled: boolean;
  audio_enabled: boolean;
  video_enabled: boolean;
  sort_order: number;
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> { value: T; ts: number }
const deptCache = new Map<string, CacheEntry<DepartmentRow[]>>();
const memberCache = new Map<string, CacheEntry<string[]>>(); // key = department_id
const generalCache = new Map<string, CacheEntry<string[]>>(); // key = workspace_id

function fresh<T>(e: CacheEntry<T> | undefined): e is CacheEntry<T> {
  return !!e && Date.now() - e.ts < CACHE_TTL_MS;
}

/** Drop all cached lookups for a workspace. Call from mutation routes. */
export function invalidateDepartmentCache(workspaceId: string): void {
  deptCache.delete(workspaceId);
  generalCache.delete(workspaceId);
  // Department-member cache keyed by department_id — clear pessimistically.
  for (const k of Array.from(memberCache.keys())) memberCache.delete(k);
}

/**
 * List all enabled departments for a workspace, in display order.
 * Returns [] when none configured (the "no departments" mode).
 */
export async function resolveDepartments(
  config: ServerConfig,
  workspaceId: string,
): Promise<DepartmentRow[]> {
  const hit = deptCache.get(workspaceId);
  if (fresh(hit)) return hit.value;

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_departments')
    .select('id, workspace_id, name, enabled, chat_enabled, audio_enabled, video_enabled, sort_order')
    .eq('workspace_id', workspaceId)
    .eq('enabled', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  const value = (data ?? []) as DepartmentRow[];
  deptCache.set(workspaceId, { value, ts: Date.now() });
  return value;
}

/** Return user_ids belonging to a specific department. */
export async function resolveDepartmentMembers(
  config: ServerConfig,
  departmentId: string,
): Promise<string[]> {
  const hit = memberCache.get(departmentId);
  if (fresh(hit)) return hit.value;

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_department_members')
    .select('user_id')
    .eq('department_id', departmentId);

  const value = (data ?? []).map((r: any) => r.user_id as string).filter(Boolean);
  memberCache.set(departmentId, { value, ts: Date.now() });
  return value;
}

/**
 * The General Pool: workspace members NOT assigned to any department.
 * Always non-empty when the workspace itself has members.
 */
export async function resolveGeneralPool(
  config: ServerConfig,
  workspaceId: string,
): Promise<string[]> {
  const hit = generalCache.get(workspaceId);
  if (fresh(hit)) return hit.value;

  const sb = getServiceClient(config);
  const [{ data: members }, { data: assignments }] = await Promise.all([
    sb.from('workspace_members').select('user_id').eq('workspace_id', workspaceId),
    sb.from('workspace_department_members').select('user_id').eq('workspace_id', workspaceId),
  ]);

  const inDept = new Set((assignments ?? []).map((r: any) => r.user_id as string));
  const value = (members ?? [])
    .map((m: any) => m.user_id as string)
    .filter((id) => id && !inDept.has(id));

  generalCache.set(workspaceId, { value, ts: Date.now() });
  return value;
}

/** True if a department has the given channel enabled. */
export function departmentSupportsChannel(
  dept: DepartmentRow,
  channel: DepartmentChannel,
): boolean {
  if (channel === 'chat') return dept.chat_enabled;
  if (channel === 'audio') return dept.audio_enabled;
  if (channel === 'video') return dept.video_enabled;
  return false;
}

/**
 * Resolve the candidate user_id pool for a routing decision:
 *
 *   1. If departmentId is provided AND the department exists AND supports
 *      the channel AND has members → return those members.
 *   2. Otherwise → return the General Pool.
 *   3. If General Pool is empty (everyone is in a department but no
 *      department was selected) → return the union of ALL workspace
 *      members so the routing engine can still resolve. Owner fallback
 *      is handled by the caller.
 *
 * Returning [] means the workspace truly has no members.
 */
export async function resolveRoutingCandidates(
  config: ServerConfig,
  workspaceId: string,
  channel: DepartmentChannel,
  departmentId?: string | null,
): Promise<{ user_ids: string[]; source: 'department' | 'general' | 'all' }>
{
  if (departmentId) {
    const all = await resolveDepartments(config, workspaceId);
    const dept = all.find((d) => d.id === departmentId && departmentSupportsChannel(d, channel));
    if (dept) {
      const members = await resolveDepartmentMembers(config, dept.id);
      if (members.length > 0) return { user_ids: members, source: 'department' };
    }
  }

  const general = await resolveGeneralPool(config, workspaceId);
  if (general.length > 0) return { user_ids: general, source: 'general' };

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId);
  const all = (data ?? []).map((r: any) => r.user_id as string).filter(Boolean);
  return { user_ids: all, source: 'all' };
}