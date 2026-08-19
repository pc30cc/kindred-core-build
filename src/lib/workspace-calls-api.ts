/**
 * Phase 8C — Workspace-scoped call settings + role permission overrides.
 * All endpoints require workspace owner/admin (server-enforced).
 */
import type { CallPermissionKey, RoleSlug } from '@/lib/admin-calls-api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface WorkspaceCallOverrides {
  allow_voice: boolean;
  allow_video: boolean;
  allow_recording: boolean;
  voice_calls_enabled: boolean;
  video_calls_enabled: boolean;
  call_recording_enabled: boolean;
  call_queue_enabled: boolean;
  visitor_initiated_audio_enabled: boolean;
  visitor_initiated_video_enabled: boolean;
  default_video_quality: 'auto' | 'low' | 'medium' | 'high' | 'hd';
}

export interface EffectiveCallChannels {
  voice_enabled: boolean;
  video_enabled: boolean;
  recording_enabled: boolean;
  queue_enabled: boolean;
  visitor_initiated_audio: boolean;
  visitor_initiated_video: boolean;
}

export interface WorkspaceCallSettingsResponse {
  overrides: WorkspaceCallOverrides;
  global_gates: {
    enabled: boolean;
    voice_calls_enabled_global: boolean;
    video_calls_enabled_global: boolean;
    call_recording_enabled_global: boolean;
    call_queue_enabled_global: boolean;
    visitor_initiated_audio_enabled_global: boolean;
    visitor_initiated_video_enabled_global: boolean;
  };
  effective: EffectiveCallChannels;
}

export async function fetchWorkspaceCallSettings(workspaceId: string): Promise<WorkspaceCallSettingsResponse> {
  const res = await fetch(`${API_BASE}/api/workspace-calls/${workspaceId}/settings`, {credentials: 'include', 
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateWorkspaceCallSettings(
  workspaceId: string,
  patch: Partial<WorkspaceCallOverrides>,
): Promise<WorkspaceCallSettingsResponse> {
  const res = await fetch(`${API_BASE}/api/workspace-calls/${workspaceId}/settings`, {credentials: 'include', 
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export interface WorkspaceRolePermissionsResponse {
  /** Platform default matrix — read-only baseline. */
  platform: Record<RoleSlug, Record<CallPermissionKey, boolean>>;
  /** Workspace overrides; null entry means "inherit platform default". */
  workspace: Record<RoleSlug, Record<CallPermissionKey, boolean | null>>;
  roles: RoleSlug[];
  permissions: CallPermissionKey[];
}

export async function fetchWorkspaceRolePermissions(
  workspaceId: string,
): Promise<WorkspaceRolePermissionsResponse> {
  const res = await fetch(`${API_BASE}/api/workspace-calls/${workspaceId}/role-permissions`, {credentials: 'include', 
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function setWorkspaceRolePermission(
  workspaceId: string,
  input: {
    role_slug: RoleSlug;
    permission_key: CallPermissionKey;
    /** null clears the override (inherit platform default). */
    granted: boolean | null;
  },
): Promise<{ ok: true }> {
  const res = await fetch(`${API_BASE}/api/workspace-calls/${workspaceId}/role-permissions`, {credentials: 'include', 
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}