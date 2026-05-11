/**
 * Call Center departments + agent presence service.
 * Pure DB layer — workspace-scoped reads/writes via service role.
 * No provider tokens, no secrets, no storage paths exposed.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type RoutingMode = 'broadcast' | 'round_robin' | 'least_busy';
export type AgentRole = 'agent' | 'supervisor';
export type PresenceStatus = 'available' | 'busy' | 'away' | 'offline';

export interface DepartmentInput {
  name: string;
  slug?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  enabled?: boolean;
  sort_order?: number;
  routing_mode?: RoutingMode;
  fallback_department_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DepartmentAgentInput {
  role?: AgentRole;
  priority?: number;
  enabled?: boolean;
  max_concurrent_calls?: number | null;
  metadata?: Record<string, unknown>;
}

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'dept';
}

export async function listDepartments(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_center_departments')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getDepartment(config: ServerConfig, workspaceId: string, id: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_center_departments')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createDepartment(config: ServerConfig, workspaceId: string, input: DepartmentInput) {
  const sb = getServiceClient(config);
  const slug = (input.slug && slugify(input.slug)) || slugify(input.name);
  const { data, error } = await sb
    .from('call_center_departments')
    .insert({
      workspace_id: workspaceId,
      name: input.name,
      slug,
      description: input.description ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      enabled: input.enabled ?? true,
      sort_order: input.sort_order ?? 0,
      routing_mode: input.routing_mode ?? 'broadcast',
      fallback_department_id: input.fallback_department_id ?? null,
      metadata: input.metadata ?? {},
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateDepartment(
  config: ServerConfig,
  workspaceId: string,
  id: string,
  patch: Partial<DepartmentInput>,
) {
  const sb = getServiceClient(config);
  const update: Record<string, unknown> = {};
  for (const k of [
    'name', 'description', 'color', 'icon', 'enabled',
    'sort_order', 'routing_mode', 'fallback_department_id', 'metadata',
  ] as const) {
    if (patch[k] !== undefined) update[k] = patch[k];
  }
  if (patch.slug !== undefined) update.slug = slugify(patch.slug);
  const { data, error } = await sb
    .from('call_center_departments')
    .update(update)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function deleteDepartment(config: ServerConfig, workspaceId: string, id: string) {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('call_center_departments')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('id', id);
  if (error) throw error;
}

export async function listDepartmentAgents(config: ServerConfig, workspaceId: string, departmentId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_center_department_agents')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('department_id', departmentId)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addDepartmentAgent(
  config: ServerConfig,
  workspaceId: string,
  departmentId: string,
  userId: string,
  options: DepartmentAgentInput = {},
) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('call_center_department_agents')
    .insert({
      workspace_id: workspaceId,
      department_id: departmentId,
      user_id: userId,
      role: options.role ?? 'agent',
      priority: options.priority ?? 100,
      enabled: options.enabled ?? true,
      max_concurrent_calls: options.max_concurrent_calls ?? null,
      metadata: options.metadata ?? {},
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateDepartmentAgent(
  config: ServerConfig,
  workspaceId: string,
  departmentId: string,
  userId: string,
  patch: DepartmentAgentInput,
) {
  const sb = getServiceClient(config);
  const update: Record<string, unknown> = {};
  for (const k of ['role', 'priority', 'enabled', 'max_concurrent_calls', 'metadata'] as const) {
    if (patch[k] !== undefined) update[k] = patch[k];
  }
  const { data, error } = await sb
    .from('call_center_department_agents')
    .update(update)
    .eq('workspace_id', workspaceId)
    .eq('department_id', departmentId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function removeDepartmentAgent(
  config: ServerConfig,
  workspaceId: string,
  departmentId: string,
  userId: string,
) {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('call_center_department_agents')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('department_id', departmentId)
    .eq('user_id', userId);
  if (error) throw error;
}

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
