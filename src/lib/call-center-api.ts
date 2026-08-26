/**
 * Call Center — workspace + admin client API.
 * All endpoints require a Supabase auth bearer token.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

/** CC-2H Phase 7 — Friendly messages for known transient/infra errors. */
const FRIENDLY_API_ERRORS: Record<string, string> = {
  auth_provider_unreachable:
    'Authentication provider is temporarily unreachable. Please retry in a moment.',
};

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {credentials: 'include', 
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const code = body?.error || body?.message || `HTTP ${res.status}`;
    const friendly = FRIENDLY_API_ERRORS[String(body?.error || '')];
    const err: any = new Error(friendly || code);
    err.code = body?.error || null;
    err.status = res.status;
    throw err;
  }
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
  voice_enabled: boolean;
  video_enabled: boolean;
  callback_enabled: boolean;
  pre_call_form_enabled: boolean;
  pre_call_form_schema: unknown[];
  business_hours: Record<string, unknown>;
  offline_behavior: string;
  recording_enabled: boolean;
  recording_consent_required: boolean;
  operator_video_visible_to_visitor?: boolean;
  routing_mode: string;
  default_department_id: string | null;
  created_at: string;
  updated_at: string;
  widget_default_locale?: 'en' | 'fa' | 'tr' | null;
  widget_enabled_locales?: string[] | null;
  widget_custom_texts?: Record<string, Record<string, string>> | null;
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
  callback_show_when_online: boolean;
  callback_min_seconds_between_requests: number;
  callback_max_per_ip_per_hour: number;
  callback_require_contact: boolean;
  callback_min_message_length: number;
  callback_honeypot_enabled: boolean;
  callback_min_form_seconds: number;
  ringback_enabled: boolean;
  ringback_mode: 'tone' | 'music' | 'off';
  ringback_music_path?: string | null;
  ringback_music_url: string | null;
  ringback_announcement_audio_path?: string | null;
  ringback_queue_audio_paths?: Record<string, string> | null;
  queue_show_position: boolean;
  queue_show_eta: boolean;
  queue_eta_seconds_per_position: number;
  queue_offer_callback_after_seconds: number;
  operator_new_call_sound_enabled: boolean;
  widget_default_locale: 'en' | 'fa' | 'tr';
  widget_available_locales: string[];
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
  enabled_by_plan: boolean;
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
  /** Canonical visitor session behind this callback (Geo/IP unification). */
  visitor_session_id?: string | null;
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
  platform_callback_enabled: boolean;
  settings_exists: boolean;
  effective: CallCenterEffectiveCaps;
  recording?: RecordingCapability;
}

// ── Departments / presence / routing types ───────────────────────
export type CallCenterRoutingMode = 'broadcast' | 'round_robin' | 'least_busy';
export type CallCenterPresenceStatus = 'available' | 'busy' | 'away' | 'offline';

export interface CallCenterDepartment {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  enabled: boolean;
  sort_order: number;
  routing_mode: CallCenterRoutingMode;
  fallback_department_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  agent_count?: number;
}

export interface CallCenterDepartmentAgent {
  id: string;
  workspace_id: string;
  department_id: string;
  user_id: string;
  role: 'agent' | 'supervisor';
  priority: number;
  enabled: boolean;
  max_concurrent_calls: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CallCenterAgentPresence {
  user_id: string;
  workspace_id: string;
  status: CallCenterPresenceStatus;
  status_message: string | null;
  active_call_count: number;
  last_seen_at: string | null;
  updated_at: string;
}

export interface CreateDepartmentPayload {
  name: string;
  slug?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  enabled?: boolean;
  sort_order?: number;
  routing_mode?: CallCenterRoutingMode;
  fallback_department_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AddDepartmentAgentPayload {
  user_id: string;
  role?: 'agent' | 'supervisor';
  priority?: number;
  enabled?: boolean;
  max_concurrent_calls?: number | null;
  metadata?: Record<string, unknown>;
}

export interface TransferCallPayload {
  to_agent_id?: string | null;
  to_department_id?: string | null;
  reason?: string | null;
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
    jsonFetch<{
      call: CallSession;
      events: CallEvent[];
      rating: { rating: number; comment: string | null; created_at: string } | null;
    }>(
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
  completeCallback: (workspaceId: string, id: string, note?: string) =>
    jsonFetch<{ ok: boolean }>(`/api/call-center/callbacks/${id}/complete?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', body: JSON.stringify({ workspaceId, note: note || undefined }),
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
  /**
   * Operator-side recording visibility (read-only, workspace-scoped).
   * Returns playable artifact metadata only — no storage paths, provider
   * URLs, retention, or legal-hold fields. Super-admin-only retention
   * controls remain on the /api/admin/calls/* surface.
   */
  listCallRecordings: (workspaceId: string, callId: string) =>
    jsonFetch<{
      recordings: Array<{
        id: string;
        recording_type: string | null;
        duration_seconds: number | null;
        size_bytes: number | null;
        created_at: string;
        has_storage: boolean;
      }>;
    }>(
      `/api/call-center/calls/${encodeURIComponent(callId)}/recordings?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  /**
   * Workspace-wide recordings listing (read-only).
   * Returns every recording artifact for the workspace with a minimal call
   * snapshot for display. Storage paths / provider metadata are stripped
   * server-side. Retention and deletion remain super-admin only.
   */
  listWorkspaceRecordings: (
    workspaceId: string,
    opts?: { limit?: number; offset?: number },
  ) =>
    jsonFetch<{
      recordings: Array<{
        id: string;
        call_id: string;
        recording_type: string | null;
        duration_seconds: number | null;
        size_bytes: number | null;
        created_at: string;
        has_storage: boolean;
        call: {
          visitor_name: string | null;
          visitor_email: string | null;
          call_type: string | null;
          started_at: string | null;
          ended_at: string | null;
          duration_seconds: number | null;
        } | null;
      }>;
      limit: number;
      offset: number;
    }>(
      `/api/call-center/recordings?workspaceId=${encodeURIComponent(workspaceId)}` +
        (opts?.limit ? `&limit=${opts.limit}` : '') +
        (opts?.offset ? `&offset=${opts.offset}` : ''),
    ),
  mintCallRecordingPlaybackToken: (workspaceId: string, callId: string, recordingId: string) =>
    jsonFetch<{
      recording_id: string;
      url: string;
      token: string;
      disposition: 'inline';
      expires_at: string;
      ttl_seconds: number;
    }>(
      `/api/call-center/calls/${encodeURIComponent(callId)}/recordings/${encodeURIComponent(recordingId)}/playback-token?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  /**
   * Operator-side download (read-only, workspace-scoped).
   * Mints a short-lived attachment-scoped playback token for a recording the
   * operator can already view. Reuses the same canonical streaming route as
   * inline playback; the token's embedded disposition claim is enforced
   * server-side, so this cannot be widened or downgraded client-side.
   */
  mintCallRecordingDownloadToken: (workspaceId: string, callId: string, recordingId: string) =>
    jsonFetch<{
      recording_id: string;
      url: string;
      token: string;
      disposition: 'attachment';
      expires_at: string;
      ttl_seconds: number;
    }>(
      `/api/call-center/calls/${encodeURIComponent(callId)}/recordings/${encodeURIComponent(recordingId)}/download-token?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  /**
   * Operator-side bulk download orchestration (read-only, workspace-scoped).
   * Mints attachment-scoped tokens for up to ~25 recordings on a single
   * call in one request. Reuses the canonical streaming route — no archive
   * is generated server-side. Per-id results carry either a tokenized URL
   * or an `error` string so a single bad id never poisons the batch.
   */
  mintCallRecordingBulkDownloadTokens: (
    workspaceId: string,
    callId: string,
    recordingIds: string[],
  ) =>
    jsonFetch<{
      limit: number;
      count: number;
      results: Array<
        | {
            recording_id: string;
            url: string;
            token: string;
            disposition: 'attachment';
            expires_at: string;
            ttl_seconds: number;
          }
        | { recording_id: string; error: string }
      >;
    }>(
      `/api/call-center/calls/${encodeURIComponent(callId)}/recordings/bulk-download-tokens?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ workspaceId, recording_ids: recordingIds }) },
    ),
  /**
   * Operator-side server-side ZIP archive export (read-only, workspace-scoped).
   *
   * Posts the selected recording ids and receives a single `application/zip`
   * response containing every recording the operator is allowed to access on
   * the given call, plus a `manifest.txt` summarising any per-id exclusions
   * (cross-workspace, cross-call, missing storage, download failures, or
   * the per-request size cap). Returns the raw ZIP `Blob`.
   *
   * Reuses the canonical operator gate and the canonical storage abstraction
   * — no raw provider URLs/credentials are ever exposed.
   */
  exportCallRecordingsArchive: async (
    workspaceId: string,
    callId: string,
    recordingIds: string[],
  ): Promise<{ blob: Blob; included: number; excluded: number; filename: string }> => {
    const res = await fetch(
      `${API_BASE}/api/call-center/calls/${encodeURIComponent(callId)}/recordings/archive?workspaceId=${encodeURIComponent(workspaceId)}`,
      {credentials: 'include', 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspaceId, recording_ids: recordingIds }),
      },
    );
    if (!res.ok) {
      let body: any = null;
      try { body = await res.json(); } catch { /* non-JSON */ }
      const err: any = new Error(body?.error || `HTTP ${res.status}`);
      err.code = body?.error || null;
      err.status = res.status;
      throw err;
    }
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename="([^"]+)"/i.exec(cd);
    const filename = m?.[1] || `call-${callId.slice(0, 8)}-recordings.zip`;
    const included = Number(res.headers.get('x-archive-included') || '0');
    const excluded = Number(res.headers.get('x-archive-excluded') || '0');
    const blob = await res.blob();
    return { blob, included, excluded, filename };
  },
  /**
   * Operator-side workspace-scoped multi-call ZIP archive export (read-only).
   *
   * Sibling of `exportCallRecordingsArchive`. Accepts an explicit
   * `[{ call_id, recording_id }]` selection collected across multiple
   * calls the operator can already access in the same workspace. The
   * server independently re-validates each pair, silently excludes any
   * cross-workspace / cross-call rows via the manifest, and returns a
   * single ZIP grouped by call directory. Same canonical caps, same
   * canonical storage abstraction, same uniform not_found semantics.
   */
  exportWorkspaceRecordingsArchive: async (
    workspaceId: string,
    items: Array<{ call_id: string; recording_id: string }>,
  ): Promise<{ blob: Blob; included: number; excluded: number; calls: number; filename: string }> => {
    const res = await fetch(
      `${API_BASE}/api/call-center/workspaces/recordings/archive?workspaceId=${encodeURIComponent(workspaceId)}`,
      {credentials: 'include', 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspaceId, items }),
      },
    );
    if (!res.ok) {
      let body: any = null;
      try { body = await res.json(); } catch { /* non-JSON */ }
      const err: any = new Error(body?.error || `HTTP ${res.status}`);
      err.code = body?.error || null;
      err.status = res.status;
      throw err;
    }
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename="([^"]+)"/i.exec(cd);
    const filename = m?.[1] || `workspace-${workspaceId.slice(0, 8)}-recordings.zip`;
    const included = Number(res.headers.get('x-archive-included') || '0');
    const excluded = Number(res.headers.get('x-archive-excluded') || '0');
    const calls = Number(res.headers.get('x-archive-calls') || '0');
    const blob = await res.blob();
    return { blob, included, excluded, calls, filename };
  },
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
  // ── Departments ───────────────────────────────────────────────
  listDepartments: (workspaceId: string) =>
    jsonFetch<{ departments: CallCenterDepartment[] }>(
      `/api/call-center/departments?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  getDepartment: (workspaceId: string, departmentId: string) =>
    jsonFetch<{ department: CallCenterDepartment }>(
      `/api/call-center/departments/${departmentId}?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  createDepartment: (workspaceId: string, payload: CreateDepartmentPayload) =>
    jsonFetch<{ department: CallCenterDepartment }>(
      `/api/call-center/departments?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  updateDepartment: (workspaceId: string, departmentId: string, patch: Partial<CreateDepartmentPayload>) =>
    jsonFetch<{ department: CallCenterDepartment }>(
      `/api/call-center/departments/${departmentId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  deleteDepartment: (workspaceId: string, departmentId: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/call-center/departments/${departmentId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    ),
  listDepartmentAgents: (workspaceId: string, departmentId: string) =>
    jsonFetch<{ agents: CallCenterDepartmentAgent[] }>(
      `/api/call-center/departments/${departmentId}/agents?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  addDepartmentAgent: (workspaceId: string, departmentId: string, payload: AddDepartmentAgentPayload) =>
    jsonFetch<{ agent: CallCenterDepartmentAgent }>(
      `/api/call-center/departments/${departmentId}/agents?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  updateDepartmentAgent: (
    workspaceId: string, departmentId: string, userId: string,
    patch: Partial<Omit<AddDepartmentAgentPayload, 'user_id'>>,
  ) =>
    jsonFetch<{ agent: CallCenterDepartmentAgent }>(
      `/api/call-center/departments/${departmentId}/agents/${userId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  removeDepartmentAgent: (workspaceId: string, departmentId: string, userId: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/call-center/departments/${departmentId}/agents/${userId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    ),
  // ── Presence ──────────────────────────────────────────────────
  getAgentPresence: (workspaceId: string) =>
    jsonFetch<{ presence: CallCenterAgentPresence[] }>(
      `/api/call-center/agents/presence?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  updateMyPresence: (
    workspaceId: string,
    status: CallCenterPresenceStatus,
    statusMessage?: string | null,
  ) =>
    jsonFetch<{ presence: CallCenterAgentPresence }>(
      `/api/call-center/agents/me/presence?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'PUT', body: JSON.stringify({ status, status_message: statusMessage ?? null }) },
    ),
  // ── Assignment + transfer ─────────────────────────────────────
  assignCall: (workspaceId: string, callId: string, agentId: string | null, reason?: string) =>
    jsonFetch<{ ok: boolean; assigned_agent_id: string | null }>(
      `/api/call-center/calls/${callId}/assign?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ agent_id: agentId, reason }) },
    ),
  transferCall: (workspaceId: string, callId: string, payload: TransferCallPayload) =>
    jsonFetch<{ ok: boolean; assigned_agent_id: string | null; department_id: string | null }>(
      `/api/call-center/calls/${callId}/transfer?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
};

// ── CC-2H — LiveKit diagnostics ────────────────────────────────────
export interface LiveKitDiagnostics {
  provider: 'livekit';
  configured: boolean;
  server_url_public: string | null;
  server_url_public_normalized: string | null;
  rtc_url_present: boolean;
  ws_url_present: boolean;
  api_key_present: boolean;
  api_secret_present: boolean;
  connect_info_supported: boolean;
  connect_info_reason: string | null;
  health: {
    twirp_create_room_ready: boolean | null;
    server_reachable: boolean | null;
    rtc_validate_status: number | null;
    rtc_v1_validate_status: number | null;
    websocket_origin_hint: string | null;
  };
  warnings: string[];
}

export const callCenterDiagnosticsApi = {
  getLiveKit: (workspaceId: string) =>
    jsonFetch<LiveKitDiagnostics>(
      `/api/call-center/diagnostics/livekit?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
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
  uploadRingbackAudio: async (input: { kind: 'music' | 'announcement' | 'queue'; file: File; queue_position?: number }) => {
    const buf = await input.file.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return jsonFetch<{ settings: CallCenterPlatformSettings; url: string; file_key: string }>(
      `/api/call-center/admin/platform/ringback-audio`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind: input.kind,
          queue_position: input.queue_position,
          fileName: input.file.name,
          contentType: input.file.type || 'audio/mpeg',
          data: btoa(bin),
        }),
      },
    );
  },
  listWorkspaces: () =>
    jsonFetch<{ workspaces: Array<{ workspace_id: string; enabled: boolean; voice_enabled: boolean; video_enabled: boolean; callback_enabled: boolean; recording_enabled: boolean; public_key: string | null; updated_at: string; workspaces: { name: string; slug: string } | null }> }>(
      `/api/call-center/admin/workspaces`,
    ),
  invalidateCache: () =>
    jsonFetch<{ ok: boolean }>(`/api/call-center/admin/cache/invalidate`, { method: 'POST' }),
};