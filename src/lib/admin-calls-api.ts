/**
 * Phase 8A — Admin client for the Voice/Video control plane.
 * All endpoints require global admin (server-enforced).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type CallProviderId =
  | 'livekit'
  | 'jitsi'
  | 'janus'
  | 'agora_cloud'
  | 'disabled';

export interface CallProviderClassification {
  self_hosted: boolean;
  external_provider: boolean;
  eligible_for_default_order: boolean;
}

export interface CallControlPlane {
  enabled: boolean;
  primary_provider: CallProviderId;
  secondary_provider: CallProviderId;
  fallback_policy: 'lenient' | 'strict';
  max_participants: number;
  default_audio_bitrate_kbps: number;
  default_video_bitrate_kbps: number;
  default_video_profile: string;
  recording_default_enabled: boolean;
  recording_default_type: 'composite' | 'individual' | 'audio_only';
  retention_default_days: number;
  verification_required_for_visitor_calls: boolean;
  // Phase 8C — global channel gates (hard upper bounds).
  voice_calls_enabled_global: boolean;
  video_calls_enabled_global: boolean;
  call_recording_enabled_global: boolean;
  call_queue_enabled_global: boolean;
  visitor_initiated_audio_enabled_global: boolean;
  visitor_initiated_video_enabled_global: boolean;
}

export interface CallTurnConfig {
  urls: string[];
  username: string | null;
  credential: string | null;
  credential_type: 'password' | 'oauth';
  static_secret_present: boolean;
}

export interface CallNetworkBundle {
  rtc_url: string | null;
  ws_url: string | null;
  recording_url: string | null;
  turn: CallTurnConfig;
  ice_policy: 'all' | 'relay';
  region: string | null;
  provider: string | null;
}

export interface CallControlPlaneResponse {
  control_plane: CallControlPlane;
  network: CallNetworkBundle;
  readiness: Record<string, boolean>;
  classification?: Record<string, CallProviderClassification>;
}

export async function fetchCallControlPlane(): Promise<CallControlPlaneResponse> {
  const res = await fetch(`${API_BASE}/api/admin/calls/control-plane`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export interface PlatformCallbackSummary {
  counts: {
    requested: number;
    scheduled: number;
    in_progress: number;
    completed: number;
    cancelled: number;
  };
  open: number;
  total: number;
  completion_rate: number;
}

export async function fetchPlatformCallbackSummary(): Promise<PlatformCallbackSummary> {
  const res = await fetch(`${API_BASE}/api/admin/calls/callbacks/summary`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

/** Phase 8E — Upcoming visitor-scheduled callbacks (platform-wide). */
export interface UpcomingCallbackItem {
  id: string;
  workspace_id: string;
  channel: 'audio' | 'video';
  status: 'requested' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  scheduled_for: string;
  requested_at: string;
}

export interface UpcomingCallbacksResponse {
  items: UpcomingCallbackItem[];
  scheduled_count: number;
}

export async function fetchUpcomingCallbacks(): Promise<UpcomingCallbacksResponse> {
  const res = await fetch(`${API_BASE}/api/admin/calls/callbacks/upcoming`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateCallControlPlane(
  patch: Partial<CallControlPlane>,
): Promise<CallControlPlaneResponse> {
  const res = await fetch(`${API_BASE}/api/admin/calls/control-plane`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateRtcEndpoints(
  patch: Partial<CallNetworkBundle>,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/rtc-endpoints`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────
// Agora (external / cloud) provider — optional, opt-in adapter.
// Secrets are write-only: GET returns presence flags, never values.
// ────────────────────────────────────────────────────────────────────────
export interface AgoraConfigPublicView {
  enabled: boolean;
  app_id: string | null;
  app_certificate_present: boolean;
  token_secret_present: boolean;
  region: string | null;
  webhook_url: string | null;
  recording_config: {
    enabled: boolean;
    storage_vendor: string | null;
    storage_bucket: string | null;
  };
}

export interface AgoraConfigPatch {
  enabled?: boolean;
  app_id?: string | null;
  /** Omit to preserve, send "" to clear, send value to set. */
  app_certificate?: string | null;
  /** Omit to preserve, send "" to clear, send value to set. */
  token_secret?: string | null;
  region?: string | null;
  webhook_url?: string | null;
  recording_config?: Partial<AgoraConfigPublicView['recording_config']>;
}

export async function fetchAgoraConfig(): Promise<{ agora: AgoraConfigPublicView }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/agora`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateAgoraConfig(
  patch: AgoraConfigPatch,
): Promise<{ agora: AgoraConfigPublicView }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/agora`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────
// Phase 8C — Platform-default role permissions for call channels.
// ────────────────────────────────────────────────────────────────────────
export type CallPermissionKey =
  | 'can_start_audio_call'
  | 'can_start_video_call'
  | 'can_receive_audio_call'
  | 'can_receive_video_call'
  | 'can_record_calls'
  | 'can_transfer_calls'
  | 'can_join_queue_calls'
  | 'can_manage_call_queue';

export type RoleSlug = 'owner' | 'admin' | 'agent' | 'viewer';

export interface RolePermissionMatrixResponse {
  matrix: Record<RoleSlug, Record<CallPermissionKey, boolean>>;
  roles: RoleSlug[];
  permissions: CallPermissionKey[];
}

export async function fetchPlatformRolePermissions(): Promise<RolePermissionMatrixResponse> {
  const res = await fetch(`${API_BASE}/api/admin/calls/role-permissions`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updatePlatformRolePermission(input: {
  role_slug: RoleSlug;
  permission_key: CallPermissionKey;
  granted: boolean;
}): Promise<{ ok: true }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/role-permissions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────
// LiveKit (self-hosted) provider — admin config.
// Secrets are write-only: GET returns presence flags, never values.
// PUT semantics: omit field to preserve, send "" to clear, send value to set.
// ────────────────────────────────────────────────────────────────────────
export interface LiveKitRecordingStoragePublic {
  vendor: 's3' | 's3_compatible' | null;
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  force_path_style: boolean;
  access_key_present: boolean;
  secret_key_present: boolean;
}

export interface LiveKitConfigPublicView {
  enabled: boolean;
  api_key_present: boolean;
  api_secret_present: boolean;
  rtc_url: string | null;
  ws_url: string | null;
  egress_enabled: boolean;
  egress_url: string | null;
  region: string | null;
  webhook_secret_present: boolean;
  recording_storage: LiveKitRecordingStoragePublic;
}

export interface LiveKitRecordingStoragePatch {
  vendor?: 's3' | 's3_compatible' | null;
  bucket?: string | null;
  region?: string | null;
  endpoint?: string | null;
  force_path_style?: boolean;
  /** Omit to preserve, send "" to clear, send value to set. */
  access_key?: string | null;
  /** Omit to preserve, send "" to clear, send value to set. */
  secret_key?: string | null;
}

export interface LiveKitConfigPatch {
  enabled?: boolean;
  /** Omit to preserve, send "" to clear, send value to set. */
  api_key?: string | null;
  /** Omit to preserve, send "" to clear, send value to set. */
  api_secret?: string | null;
  rtc_url?: string | null;
  ws_url?: string | null;
  egress_enabled?: boolean;
  egress_url?: string | null;
  region?: string | null;
  /** Omit to preserve, send "" to clear, send value to set. */
  webhook_secret?: string | null;
  recording_storage?: LiveKitRecordingStoragePatch;
}

/**
 * Shared fetch helper that surfaces server-side error messages instead of the
 * generic "Failed: 400". Without this the UI can't tell the user *why* a save
 * was rejected (e.g. invalid URL, missing field).
 */
async function parseError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    if (j && typeof j.error === 'string') return j.error;
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

export async function fetchLiveKitConfig(): Promise<{ livekit: LiveKitConfigPublicView }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/livekit`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function updateLiveKitConfig(
  patch: LiveKitConfigPatch,
): Promise<{ livekit: LiveKitConfigPublicView }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/livekit`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface LiveKitTestResult {
  ok: boolean;
  error?: string;
  message?: string;
  latency_ms?: number;
  rtc_url?: string;
}

/**
 * Live-probe the saved LiveKit config. Issues a lightweight ListRooms call
 * against the configured RTC URL using the persisted credentials. Resolves
 * with `ok: false` (and a human message) on any failure rather than throwing,
 * so the UI can render either outcome inline.
 */
export async function testLiveKitConnection(): Promise<LiveKitTestResult> {
  const res = await fetch(`${API_BASE}/api/admin/calls/livekit/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
  });
  try {
    return (await res.json()) as LiveKitTestResult;
  } catch {
    return { ok: false, error: `HTTP ${res.status}` };
  }
}

// ─── Recording retention (super-admin operability) ─────────────────
// Consumes the LIVE contract in server/routes/adminCalls.ts:
//   GET  /api/admin/calls/recordings
//   POST /api/admin/calls/recordings/:id/legal-hold
// This client never deletes. The janitor remains the sole deletion path.

export type RecordingRetentionStatus =
  | 'on_hold'
  | 'expired'
  | 'expires_at'
  | 'legacy_unmanaged';

export interface AdminRecordingRow {
  id: string;
  call_session_id: string;
  workspace_id: string | null;
  provider: string | null;
  recording_type: string | null;
  storage_provider: string | null;
  storage_path: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  retention_policy: string | null;
  retention_expires_at: string | null;
  legal_hold: boolean;
  created_at: string;
  status: RecordingRetentionStatus;
}

export interface AdminRecordingsListResponse {
  items: AdminRecordingRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminRecordingsListParams {
  workspace_id?: string;
  status?: RecordingRetentionStatus;
  limit?: number;
  offset?: number;
}

export async function fetchAdminRecordings(
  params: AdminRecordingsListParams = {},
): Promise<AdminRecordingsListResponse> {
  const qs = new URLSearchParams();
  if (params.workspace_id) qs.set('workspace_id', params.workspace_id);
  if (params.status) qs.set('status', params.status);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  const url = `${API_BASE}/api/admin/calls/recordings${qs.toString() ? `?${qs.toString()}` : ''}`;
  const res = await fetch(url, { headers: await authHeader() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Failed to load recordings (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

export async function setAdminRecordingLegalHold(
  id: string,
  enabled: boolean,
  reason?: string,
): Promise<{ id: string; legal_hold: boolean }> {
  const res = await fetch(
    `${API_BASE}/api/admin/calls/recordings/${encodeURIComponent(id)}/legal-hold`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ enabled, ...(reason ? { reason } : {}) }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Legal-hold toggle failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}