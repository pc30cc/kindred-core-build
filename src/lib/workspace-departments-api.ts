/**
 * Phase 8H Completion — Workspace department management client.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface Department {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  chat_enabled: boolean;
  audio_enabled: boolean;
  video_enabled: boolean;
  /** Tickets channel — managed in Team & Departments, consumed by future tickets feature. */
  tickets_enabled?: boolean;
  /** Standalone Call Center channels (separate from chat-widget audio/video). */
  cc_voice_enabled?: boolean;
  cc_video_enabled?: boolean;
  cc_callback_enabled?: boolean;
  /** Per-department Call Center routing strategy. NULL = inherit workspace default. */
  cc_routing_mode?: 'broadcast' | 'round_robin' | 'least_busy' | null;
  cc_fallback_department_id?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FallbackPolicy {
  owner_fallback_enabled: boolean;
  owner_fallback_for_chat: boolean;
  owner_fallback_for_audio: boolean;
  owner_fallback_for_video: boolean;
  general_pool_enabled: boolean;
}

export type DepartmentChannel = 'chat' | 'audio' | 'video';

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

export interface DepartmentDiagnostics {
  channel: DepartmentChannel;
  total_departments: number;
  visible_departments: VisibleDepartment[];
  hidden_departments: Array<{ id: string; name: string; reason: string }>;
  general_pool_size: number;
  fallback_policy: FallbackPolicy;
  owner_id: string | null;
}

async function jsonFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {credentials: 'include', 
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function listDepartments(workspaceId: string): Promise<Department[]> {
  const { departments } = await jsonFetch(`/api/workspace-departments/${workspaceId}`);
  return departments;
}

export async function createDepartment(
  workspaceId: string,
  input: Partial<Department> & { name: string },
): Promise<Department> {
  const { department } = await jsonFetch(`/api/workspace-departments/${workspaceId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return department;
}

export async function updateDepartment(
  workspaceId: string,
  id: string,
  patch: Partial<Department>,
): Promise<Department> {
  const { department } = await jsonFetch(
    `/api/workspace-departments/${workspaceId}/${id}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return department;
}

export async function deleteDepartment(workspaceId: string, id: string): Promise<void> {
  await jsonFetch(`/api/workspace-departments/${workspaceId}/${id}`, {
    method: 'DELETE',
  });
}

export async function listDepartmentMembers(
  workspaceId: string,
  id: string,
): Promise<string[]> {
  const { user_ids } = await jsonFetch(
    `/api/workspace-departments/${workspaceId}/${id}/members`,
  );
  return user_ids;
}

export async function setDepartmentMembers(
  workspaceId: string,
  id: string,
  user_ids: string[],
): Promise<void> {
  await jsonFetch(`/api/workspace-departments/${workspaceId}/${id}/members`, {
    method: 'PUT',
    body: JSON.stringify({ user_ids }),
  });
}

export async function getFallbackPolicy(workspaceId: string): Promise<FallbackPolicy> {
  const { policy } = await jsonFetch(
    `/api/workspace-departments/${workspaceId}/fallback`,
  );
  return policy;
}

export async function updateFallbackPolicy(
  workspaceId: string,
  patch: Partial<FallbackPolicy>,
): Promise<FallbackPolicy> {
  const { policy } = await jsonFetch(
    `/api/workspace-departments/${workspaceId}/fallback`,
    { method: 'PUT', body: JSON.stringify(patch) },
  );
  return policy;
}

export async function getDepartmentDiagnostics(
  workspaceId: string,
  channel: DepartmentChannel,
): Promise<DepartmentDiagnostics> {
  const { diagnostics } = await jsonFetch(
    `/api/workspace-departments/${workspaceId}/diagnostics?channel=${channel}`,
  );
  return diagnostics;
}