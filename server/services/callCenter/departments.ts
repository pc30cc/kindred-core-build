/**
 * Call Center departments + agent presence service.
 *
 * Department management lives in the canonical Team & Departments system
 * (workspace_departments + workspace_department_members). This module is a
 * read-only adapter for the standalone Call Center plus presence/assignment
 * helpers. Mutations on department/agent records return management_moved
 * (HTTP 410) — callers must use /api/workspace-departments instead.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type RoutingMode = 'broadcast' | 'round_robin' | 'least_busy';
export type AgentRole = 'agent' | 'supervisor';
export type PresenceStatus = 'available' | 'busy' | 'away' | 'offline';

export class DepartmentException extends Error {
  constructor(public readonly code: string, public readonly httpStatus = 400) {
    super(code);
    this.name = 'DepartmentException';
  }
}

const MANAGEMENT_MOVED = new DepartmentException('management_moved', 410);

/**
 * A department row as exposed to Call Center callers. Shape is preserved
 * for API compatibility (fields mirror the legacy call_center_departments
 * shape). Source of truth is workspace_departments.
 */
function toCcDepartment(row: any): any {
  if (!row) return row;
  const cc_enabled = !!(row.cc_voice_enabled || row.cc_video_enabled || row.cc_callback_enabled);
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    slug: null, // canonical table has no slug
    description: null,
    color: null,
    icon: null,
    enabled: cc_enabled,
    sort_order: row.sort_order ?? 0,
    routing_mode: (row.cc_routing_mode as RoutingMode) || 'broadcast',
    fallback_department_id: row.cc_fallback_department_id ?? null,
    metadata: {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    cc_voice_enabled: !!row.cc_voice_enabled,
    cc_video_enabled: !!row.cc_video_enabled,
    cc_callback_enabled: !!row.cc_callback_enabled,
  };
}

const DEPT_COLS =
  'id, workspace_id, name, enabled, sort_order, cc_voice_enabled, cc_video_enabled, cc_callback_enabled, cc_routing_mode, cc_fallback_department_id, cc_routing_state, created_at, updated_at';

/** Throws department_not_found if the canonical department does not exist. */
export async function assertDepartmentInWorkspace(
  config: ServerConfig,
  workspaceId: string,
  departmentId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_departments')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('id', departmentId)
    .maybeSingle();
  if (!data) throw new DepartmentException('department_not_found', 404);
}

export async function listDepartments(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_departments')
    .select(DEPT_COLS)
    .eq('workspace_id', workspaceId)
    .or('cc_voice_enabled.eq.true,cc_video_enabled.eq.true,cc_callback_enabled.eq.true')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(toCcDepartment);
}

export async function getDepartment(
  config: ServerConfig, workspaceId: string, id: string,
) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_departments')
    .select(DEPT_COLS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? toCcDepartment(data) : null;
}

// ── Department mutations: management_moved ─────────────────────────────────
export async function createDepartment(): Promise<never> { throw MANAGEMENT_MOVED; }
export async function updateDepartment(): Promise<never> { throw MANAGEMENT_MOVED; }
export async function deleteDepartment(): Promise<never> { throw MANAGEMENT_MOVED; }

// ── Department agents (canonical workspace_department_members) ────────────
export async function listDepartmentAgents(
  config: ServerConfig, workspaceId: string, departmentId: string,
) {
  await assertDepartmentInWorkspace(config, workspaceId, departmentId);
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_department_members')
    .select('user_id, call_center_role, call_center_priority, call_center_enabled, call_center_max_concurrent_calls, call_center_metadata, created_at')
    .eq('workspace_id', workspaceId)
    .eq('department_id', departmentId)
    .order('call_center_priority', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r: any) => ({
    workspace_id: workspaceId,
    department_id: departmentId,
    user_id: r.user_id,
    role: r.call_center_role,
    priority: r.call_center_priority,
    enabled: r.call_center_enabled,
    max_concurrent_calls: r.call_center_max_concurrent_calls,
    metadata: r.call_center_metadata || {},
    created_at: r.created_at,
  }));
}

export async function addDepartmentAgent(): Promise<never> { throw MANAGEMENT_MOVED; }
export async function updateDepartmentAgent(): Promise<never> { throw MANAGEMENT_MOVED; }
export async function removeDepartmentAgent(): Promise<never> { throw MANAGEMENT_MOVED; }

// ── Agent presence (unchanged — Call Center owned) ────────────────────────
export async function getAgentPresence(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_center_agent_presence')
    .select('*')
    .eq('workspace_id', workspaceId);
  if (error) throw error;
  return data || [];
}

export async function updateMyAgentPresence(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  status: PresenceStatus,
  statusMessage?: string | null,
) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_center_agent_presence')
    .upsert(
      {
        workspace_id: workspaceId,
        user_id: userId,
        status,
        status_message: statusMessage ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,user_id' },
    )
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function ensurePresenceRow(
  config: ServerConfig, workspaceId: string, userId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('call_center_agent_presence')
    .upsert(
      {
        workspace_id: workspaceId,
        user_id: userId,
        status: 'available',
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,user_id', ignoreDuplicates: true },
    );
}

export async function incrementAgentActiveCallCount(
  config: ServerConfig, workspaceId: string, userId: string,
): Promise<void> {
  if (!userId) return;
  const sb = getServiceClient(config);
  await ensurePresenceRow(config, workspaceId, userId);
  const { data: row } = await sb
    .from('call_center_agent_presence')
    .select('active_call_count')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  const next = Math.max(0, ((row?.active_call_count as number) || 0) + 1);
  await sb
    .from('call_center_agent_presence')
    .update({ active_call_count: next, last_seen_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
}

export async function decrementAgentActiveCallCount(
  config: ServerConfig, workspaceId: string, userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('call_center_agent_presence')
    .select('active_call_count')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!row) return;
  const next = Math.max(0, ((row.active_call_count as number) || 0) - 1);
  await sb
    .from('call_center_agent_presence')
    .update({ active_call_count: next, last_seen_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
}

const ASSIGNABLE_ROLES = new Set(['owner', 'admin', 'agent', 'support_agent', 'team_lead']);

/**
 * Validate that an agent UUID is assignable to a call. Allowed when the user
 * is a workspace member with operator-capable role, OR when they are an
 * enabled member of the target department in the canonical table.
 */
export async function assertAssignableAgent(
  config: ServerConfig,
  args: { workspaceId: string; agentId: string; departmentId?: string | null },
): Promise<void> {
  const { workspaceId, agentId, departmentId } = args;
  const sb = getServiceClient(config);
  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', agentId)
    .maybeSingle();
  if (!member) throw new DepartmentException('agent_not_found', 404);
  const role = String((member as any).role || '');
  const isOperatorRole = ASSIGNABLE_ROLES.has(role);

  if (departmentId) {
    const { data: dm } = await sb
      .from('workspace_department_members')
      .select('call_center_enabled')
      .eq('workspace_id', workspaceId)
      .eq('department_id', departmentId)
      .eq('user_id', agentId)
      .maybeSingle();
    const enabledInDept = !!dm && (dm as any).call_center_enabled !== false;
    const isElevated = role === 'owner' || role === 'admin';
    if (!enabledInDept && !isElevated) {
      throw new DepartmentException('operator_permission_required', 403);
    }
  } else if (!isOperatorRole) {
    throw new DepartmentException('operator_permission_required', 403);
  }
}
