/**
 * Call Center — workspace + admin client API.
 * All endpoints require a Supabase auth bearer token.
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body?.error || body?.message || `HTTP ${res.status}`);
  return body as T;
}

export interface CallCenterWorkspaceSettings {
  id: string;
  workspace_id: string;
  enabled: boolean;
  public_key: string | null;
  allowed_domains: string[];
  widget_position: string;
  widget_theme: Record<string, unknown>;
  display_name: string | null;
  avatar_url: string | null;
  avatar_storage_path: string | null;
  voice_enabled: boolean;
  video_enabled: boolean;
  callback_enabled: boolean;
  pre_call_form_enabled: boolean;
  pre_call_form_schema: unknown[];
  business_hours: Record<string, unknown>;
  offline_behavior: string;
  recording_enabled: boolean;
  recording_consent_required: boolean;
  routing_mode: string;
  default_department_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallCenterPlatformSettings {
  call_center_enabled: boolean;
  voice_calls_enabled: boolean;
  video_calls_enabled: boolean;
  callback_requests_enabled: boolean;
  call_recording_enabled: boolean;
  screen_share_enabled: boolean;
  call_transfer_enabled: boolean;
  departments_enabled: boolean;
  advanced_routing_enabled: boolean;
  max_concurrent_calls_per_workspace: number;
  max_queue_size_per_workspace: number;
  max_monthly_call_minutes_per_workspace: number;
  max_callback_requests_per_month: number;
  max_recording_storage_mb: number;
  disabled_message: Record<string, unknown>;
}

export interface CallCenterEffectiveCaps {
  call_center_enabled: boolean;
  workspace_call_center_visible: boolean;
  voice_enabled: boolean;
  video_enabled: boolean;
  callback_enabled: boolean;
  recording_enabled: boolean;
  max_concurrent_calls: number;
  max_monthly_call_minutes: number;
  max_queue_size: number;
}

export interface RecordingCapability {
  enabled_by_platform: boolean;
  enabled_by_workspace: boolean;
  consent_required: boolean;
  provider_supported: boolean;
  provider_configured: boolean;
  effective_enabled: boolean;
  reason?: string;
}

export interface CallCenterRecordingStatus {
  recording_enabled: boolean;
  recording_state: string;
  consent_given: boolean;
  consent_at: string | null;
  provider: string | null;
  recording_id_masked: string | null;
  has_artifact: boolean;
  playback_available: false;
  download_available: false;
  started_at: string | null;
  stopped_at: string | null;
  reason?: string;
  capability: {
    effective_enabled: boolean;
    consent_required: boolean;
    provider_supported: boolean;
    provider_configured: boolean;
    reason?: string;
  };
  last_error?: string | null;
}

export interface CallCenterRecordingStartResponse {
  ok: true;
  recording_state: 'recording' | 'pending';
  recording_id_masked: string;
  has_artifact: true;
  provider: string;
  started_at: string;
  idempotent?: boolean;
}

export interface CallCenterRecordingStopResponse {
  ok: true;
  recording_state: 'finalizing' | 'available' | 'failed';
  recording_id_masked: string;
  has_artifact: true;
  stopped_at: string;
}

export interface CallCenterOverview {
  today_calls: number;
  waiting_calls: number;
  active_calls: number;
  missed_today: number;
  callbacks_pending: number;
  provider: { provider: string; ready: boolean; error?: string };
  recording?: RecordingCapability;
}

export interface CallSession {
  id: string;
  workspace_id: string;
  state: string;
  call_type: string;
  visitor_name: string | null;
  visitor_email: string | null;
  visitor_phone: string | null;
  subject: string | null;
  page_url: string | null;
  page_title: string | null;
  created_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  end_reason: string | null;
  provider: string | null;
  provider_room_id: string | null;
  entry_source: string | null;
}

export interface CallEvent {
  id: string;
  call_session_id: string;
  event_type: string;
  actor_type: string | null;
  actor_id: string | null;
  payload: any;
  created_at: string;
}

export interface QueueEntry {
  id: string;
  call_session_id: string;
  state: string;
  channel: string;
  priority: number;
  created_at: string;
  call_session?: CallSession;
}

export interface CallbackRequest {
  id: string;
  workspace_id: string;
  status: string;
  channel: string;
  contact_phone?: string | null;
  contact_email?: string | null;
  notes?: string | null;
  metadata?: Record<string, any> | null;
  scheduled_for?: string | null;
  requested_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  handled_by?: string | null;
  created_at: string;
}

export interface CallCenterCapabilities {
  platform_enabled: boolean;
  workspace_enabled: boolean;
  workspace_call_center_visible: boolean;
  settings_exists: boolean;
  effective: CallCenterEffectiveCaps;
  recording?: RecordingCapability;
}

// ── Workspace API ────────────────────────────────────────────────
export const callCenterApi = {
  getCapabilities: (workspaceId: string) =>
    jsonFetch<CallCenterCapabilities>(
      `/api/call-center/capabilities?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  getSettings: (workspaceId: string) =>
    jsonFetch<{ settings: CallCenterWorkspaceSettings; platform: CallCenterPlatformSettings; effective: CallCenterEffectiveCaps; recording?: RecordingCapability }>(
      `/api/call-center/settings?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  updateSettings: (workspaceId: string, patch: Partial<CallCenterWorkspaceSettings>) =>
    jsonFetch<{ settings: CallCenterWorkspaceSettings }>(
      `/api/call-center/settings?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'PUT', body: JSON.stringify(patch) },
    ),
  getOverview: (workspaceId: string) =>
    jsonFetch<CallCenterOverview>(`/api/call-center/overview?workspaceId=${encodeURIComponent(workspaceId)}`),
  listQueue: (workspaceId: string) =>
    jsonFetch<{ queue: QueueEntry[] }>(`/api/call-center/queue?workspaceId=${encodeURIComponent(workspaceId)}`),
  listCalls: (workspaceId: string, filters?: { status?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams({ workspaceId });
    if (filters?.status) p.set('status', filters.status);
    if (filters?.limit) p.set('limit', String(filters.limit));
    if (filters?.offset) p.set('offset', String(filters.offset));
    return jsonFetch<{ calls: CallSession[] }>(`/api/call-center/calls?${p}`);
  },
  getCall: (workspaceId: string, callId: string) =>
    jsonFetch<{ call: CallSession; events: CallEvent[] }>(
      `/api/call-center/calls/${callId}?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  acceptCall: (workspaceId: string, callId: string) =>
    jsonFetch<{
      ok: boolean;
      provider: string;
      provider_room_id: string;
      token: string;
      expires_at: string;
      connect?: {
        supported: boolean;
        provider: string;
        server_url: string | null;
        room_id: string | null;
        identity: string | null;
        reason?: string;
      };
    }>(
      `/api/call-center/calls/${callId}/accept?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  rejectCall: (workspaceId: string, callId: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/call-center/calls/${callId}/reject?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  endCall: (workspaceId: string, callId: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/call-center/calls/${callId}/end?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  getCallbacks: (workspaceId: string, status?: string) => {
    const p = new URLSearchParams({ workspaceId });
    if (status) p.set('status', status);
    return jsonFetch<{ callbacks: CallbackRequest[] }>(`/api/call-center/callbacks?${p}`);
  },
  assignCallback: (workspaceId: string, id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/call-center/callbacks/${id}/assign?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', body: JSON.stringify({ workspaceId }),
    }),
  completeCallback: (workspaceId: string, id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/call-center/callbacks/${id}/complete?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', body: JSON.stringify({ workspaceId }),
    }),
  cancelCallback: (workspaceId: string, id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/call-center/callbacks/${id}/cancel?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', body: JSON.stringify({ workspaceId }),
    }),
  getAgentStatus: (workspaceId: string) =>
    jsonFetch<{ agents: any[] }>(`/api/call-center/agent-status?workspaceId=${encodeURIComponent(workspaceId)}`),
  updateAgentStatus: (workspaceId: string, status: string) =>
    jsonFetch<{ ok: boolean }>(`/api/call-center/agent-status?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', body: JSON.stringify({ workspaceId, status }),
    }),
  startRecording: (workspaceId: string, callId: string, recordingType?: 'composite' | 'individual' | 'audio_only') =>
    jsonFetch<CallCenterRecordingStartResponse>(
      `/api/call-center/calls/${callId}/recording/start?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId, recording_type: recordingType }) },
    ),
  stopRecording: (workspaceId: string, callId: string) =>
    jsonFetch<CallCenterRecordingStopResponse>(
      `/api/call-center/calls/${callId}/recording/stop?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  getRecordingStatus: (workspaceId: string, callId: string) =>
    jsonFetch<CallCenterRecordingStatus>(
      `/api/call-center/calls/${callId}/recording/status?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  uploadAvatar: async (workspaceId: string, file: File) => {
    const buf = await file.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const data = btoa(bin);
    return jsonFetch<{ avatar_url: string }>(
      `/api/call-center/settings/avatar?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId, fileName: file.name, contentType: file.type, data }) },
    );
  },
};

// ── Super Admin API ──────────────────────────────────────────────
export const callCenterAdminApi = {
  getPlatform: () =>
    jsonFetch<{ settings: CallCenterPlatformSettings & { id?: string }; stats: { enabled_workspaces: number; active_calls: number; waiting_calls: number } }>(
      `/api/call-center/admin/platform`,
    ),
  updatePlatform: (patch: Partial<CallCenterPlatformSettings>) =>
    jsonFetch<{ settings: CallCenterPlatformSettings }>(`/api/call-center/admin/platform`, {
      method: 'PUT', body: JSON.stringify(patch),
    }),
  listWorkspaces: () =>
    jsonFetch<{ workspaces: Array<{ workspace_id: string; enabled: boolean; voice_enabled: boolean; video_enabled: boolean; callback_enabled: boolean; public_key: string | null; updated_at: string; workspaces: { name: string; slug: string } | null }> }>(
      `/api/call-center/admin/workspaces`,
    ),
  invalidateCache: () =>
    jsonFetch<{ ok: boolean }>(`/api/call-center/admin/cache/invalidate`, { method: 'POST' }),
};