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
import { resolveRolePermissions, type RoleSlug } from './permissions.js';
import { listWorkspaceAvailability, isEligible } from './availability.js';

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
const fallbackCache = new Map<string, CacheEntry<FallbackPolicy>>(); // key = workspace_id

function fresh<T>(e: CacheEntry<T> | undefined): e is CacheEntry<T> {
  return !!e && Date.now() - e.ts < CACHE_TTL_MS;
}

/** Drop all cached lookups for a workspace. Call from mutation routes. */
export function invalidateDepartmentCache(workspaceId: string): void {
  deptCache.delete(workspaceId);
  generalCache.delete(workspaceId);
  fallbackCache.delete(workspaceId);
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

// ---------------------------------------------------------------------------
// Phase 8H Completion — Fallback policy, widget visibility, diagnostics.
// ---------------------------------------------------------------------------

export interface FallbackPolicy {
  owner_fallback_enabled: boolean;
  owner_fallback_for_chat: boolean;
  owner_fallback_for_audio: boolean;
  owner_fallback_for_video: boolean;
  general_pool_enabled: boolean;
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  owner_fallback_enabled: true,
  owner_fallback_for_chat: true,
  owner_fallback_for_audio: true,
  owner_fallback_for_video: true,
  general_pool_enabled: true,
};

/** Persisted on workspace_provider_settings keyed by ('department_routing'). */
export async function loadFallbackPolicy(
  config: ServerConfig,
  workspaceId: string,
): Promise<FallbackPolicy> {
  const hit = fallbackCache.get(workspaceId);
  if (fresh(hit)) return hit.value;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_provider_settings')
    .select('config')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'department_routing')
    .maybeSingle();
  const cfg = (data?.config as Partial<FallbackPolicy>) || {};
  const value: FallbackPolicy = { ...DEFAULT_FALLBACK_POLICY, ...cfg };
  fallbackCache.set(workspaceId, { value, ts: Date.now() });
  return value;
}

export async function saveFallbackPolicy(
  config: ServerConfig,
  workspaceId: string,
  patch: Partial<FallbackPolicy>,
): Promise<FallbackPolicy> {
  const sb = getServiceClient(config);
  const current = await loadFallbackPolicy(config, workspaceId);
  const merged: FallbackPolicy = { ...current, ...patch };
  const { error } = await sb
    .from('workspace_provider_settings')
    .upsert(
      {
        workspace_id: workspaceId,
        provider_type: 'department_routing',
        provider_name: 'department_routing',
        enabled: true,
        config: merged as any,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,provider_type' },
    );
  if (error) throw new Error(error.message);
  fallbackCache.set(workspaceId, { value: merged, ts: Date.now() });
  return merged;
}

export function ownerFallbackAllowed(
  policy: FallbackPolicy,
  channel: DepartmentChannel,
): boolean {
  if (!policy.owner_fallback_enabled) return false;
  if (channel === 'chat') return policy.owner_fallback_for_chat;
  if (channel === 'audio') return policy.owner_fallback_for_audio;
  if (channel === 'video') return policy.owner_fallback_for_video;
  return false;
}

/**
 * Owner of the workspace (single user). Used as a last-resort fallback before
 * the queue/callback/offline branches kick in.
 */
export async function resolveWorkspaceOwnerId(
  config: ServerConfig,
  workspaceId: string,
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspaces')
    .select('owner_id')
    .eq('id', workspaceId)
    .maybeSingle();
  return (data?.owner_id as string | null) ?? null;
}

export interface VisibleDepartment {
  id: string;
  name: string;
  sort_order: number;
  chat: boolean;
  audio: boolean;
  video: boolean;
  member_count: number;
  available_count: number;
}

/**
 * Build the widget-safe view of departments for a given channel. A department
 * is visible only if it's enabled for the channel AND has at least one
 * eligible member (with the right permissions and, for audio/video, an
 * available presence). For chat we relax presence — any eligible member is
 * enough.
 */
export async function resolveWidgetVisibleDepartments(
  config: ServerConfig,
  workspaceId: string,
  channel: DepartmentChannel,
): Promise<VisibleDepartment[]> {
  const departments = await resolveDepartments(config, workspaceId);
  if (departments.length === 0) return [];

  const sb = getServiceClient(config);
  const { data: members } = await sb
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);
  const roleByUser = new Map<string, RoleSlug>();
  for (const m of (members ?? []) as any[]) {
    roleByUser.set(m.user_id, (m.role || 'viewer') as RoleSlug);
  }

  // Availability is only required for audio/video. Compute once.
  const needAvailability = channel === 'audio' || channel === 'video';
  const availability = needAvailability
    ? await listWorkspaceAvailability(config, workspaceId)
    : [];
  const availMap = new Map(availability.map((a) => [a.user_id, a]));

  // Resolve per-role permissions once.
  const perRole = new Map<RoleSlug, Awaited<ReturnType<typeof resolveRolePermissions>>>();
  for (const role of new Set(roleByUser.values())) {
    perRole.set(role, await resolveRolePermissions(config, workspaceId, role));
  }

  function userEligible(userId: string): { eligible: boolean; available: boolean } {
    const role = roleByUser.get(userId);
    if (!role) return { eligible: false, available: false };
    const perms = perRole.get(role)!;
    if (channel === 'chat') {
      // Chat eligibility — any active workspace member qualifies. We do NOT
      // require call-specific permissions for chat-only departments.
      return { eligible: true, available: true };
    }
    if (!perms.can_join_queue_calls) return { eligible: false, available: false };
    if (channel === 'audio' && !perms.can_receive_audio_call)
      return { eligible: false, available: false };
    if (channel === 'video' && !perms.can_receive_video_call)
      return { eligible: false, available: false };
    const av = availMap.get(userId);
    if (!av) return { eligible: true, available: false };
    return { eligible: true, available: isEligible(av, channel) };
  }

  const out: VisibleDepartment[] = [];
  for (const d of departments) {
    if (!departmentSupportsChannel(d, channel)) continue;
    const memberIds = await resolveDepartmentMembers(config, d.id);
    let eligibleCount = 0;
    let availableCount = 0;
    for (const uid of memberIds) {
      const r = userEligible(uid);
      if (r.eligible) eligibleCount++;
      if (r.available) availableCount++;
    }
    // Visibility rules per channel:
    //   chat  → any eligible member is enough
    //   audio → at least one available eligible member
    //   video → at least one available eligible member
    const visible = channel === 'chat'
      ? eligibleCount > 0
      : availableCount > 0;
    if (!visible) continue;
    out.push({
      id: d.id,
      name: d.name,
      sort_order: d.sort_order,
      chat: d.chat_enabled,
      audio: d.audio_enabled,
      video: d.video_enabled,
      member_count: eligibleCount,
      available_count: availableCount,
    });
  }
  return out;
}

export type WidgetDepartmentMode = 'general' | 'single' | 'multi';

export interface WidgetDepartmentResolution {
  mode: WidgetDepartmentMode;
  visible_departments: VisibleDepartment[];
  default_department_id: string | null;
}

export async function resolveWidgetDepartmentMode(
  config: ServerConfig,
  workspaceId: string,
  channel: DepartmentChannel,
): Promise<WidgetDepartmentResolution> {
  const visible = await resolveWidgetVisibleDepartments(config, workspaceId, channel);
  if (visible.length === 0) {
    return { mode: 'general', visible_departments: [], default_department_id: null };
  }
  if (visible.length === 1) {
    return {
      mode: 'single',
      visible_departments: visible,
      default_department_id: visible[0].id,
    };
  }
  return { mode: 'multi', visible_departments: visible, default_department_id: null };
}

/**
 * Diagnostic snapshot for owner/admin debug surfaces. Explains WHY routing
 * resolves the way it does for a given channel. Safe to expose only to
 * privileged workspace roles.
 */
export interface DepartmentDiagnostics {
  channel: DepartmentChannel;
  total_departments: number;
  visible_departments: VisibleDepartment[];
  hidden_departments: Array<{ id: string; name: string; reason: string }>;
  general_pool_size: number;
  fallback_policy: FallbackPolicy;
  owner_id: string | null;
}

export async function buildDepartmentDiagnostics(
  config: ServerConfig,
  workspaceId: string,
  channel: DepartmentChannel,
): Promise<DepartmentDiagnostics> {
  const [departments, visible, generalPool, fallback, ownerId] = await Promise.all([
    resolveDepartments(config, workspaceId),
    resolveWidgetVisibleDepartments(config, workspaceId, channel),
    resolveGeneralPool(config, workspaceId),
    loadFallbackPolicy(config, workspaceId),
    resolveWorkspaceOwnerId(config, workspaceId),
  ]);
  const visibleIds = new Set(visible.map((v) => v.id));
  const hidden: Array<{ id: string; name: string; reason: string }> = [];
  for (const d of departments) {
    if (visibleIds.has(d.id)) continue;
    let reason = 'unavailable';
    if (!departmentSupportsChannel(d, channel)) reason = `channel_disabled:${channel}`;
    else {
      const members = await resolveDepartmentMembers(config, d.id);
      if (members.length === 0) reason = 'no_members';
      else reason = channel === 'chat' ? 'no_eligible_members' : 'no_available_members';
    }
    hidden.push({ id: d.id, name: d.name, reason });
  }
  return {
    channel,
    total_departments: departments.length,
    visible_departments: visible,
    hidden_departments: hidden,
    general_pool_size: generalPool.length,
    fallback_policy: fallback,
    owner_id: ownerId,
  };
}