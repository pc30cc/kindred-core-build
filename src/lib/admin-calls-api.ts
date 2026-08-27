import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Phase 8A — Admin client for the Voice/Video control plane.
 * All endpoints require global admin (server-enforced).
 */

const API_BASE = RESOLVED_API_BASE;

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
  const res = await fetch(`${API_BASE}/api/admin/calls/control-plane`, {credentials: 'include', 
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
  const res = await fetch(`${API_BASE}/api/admin/calls/callbacks/summary`, {credentials: 'include', 
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
  const res = await fetch(`${API_BASE}/api/admin/calls/callbacks/upcoming`, {credentials: 'include', 
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateCallControlPlane(
  patch: Partial<CallControlPlane>,
): Promise<CallControlPlaneResponse> {
  const res = await fetch(`${API_BASE}/api/admin/calls/control-plane`, {credentials: 'include', 
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateRtcEndpoints(
  patch: Partial<CallNetworkBundle>,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/rtc-endpoints`, {credentials: 'include', 
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(`${API_BASE}/api/admin/calls/agora`, {credentials: 'include', 
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updateAgoraConfig(
  patch: AgoraConfigPatch,
): Promise<{ agora: AgoraConfigPublicView }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/agora`, {credentials: 'include', 
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(`${API_BASE}/api/admin/calls/role-permissions`, {credentials: 'include', 
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function updatePlatformRolePermission(input: {
  role_slug: RoleSlug;
  permission_key: CallPermissionKey;
  granted: boolean;
}): Promise<{ ok: true }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/role-permissions`, {credentials: 'include', 
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(`${API_BASE}/api/admin/calls/livekit`, {credentials: 'include', 
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function updateLiveKitConfig(
  patch: LiveKitConfigPatch,
): Promise<{ livekit: LiveKitConfigPublicView }> {
  const res = await fetch(`${API_BASE}/api/admin/calls/livekit`, {credentials: 'include', 
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(`${API_BASE}/api/admin/calls/livekit/test`, {credentials: 'include', 
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(url, {credentials: 'include', headers: {} });
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
    {credentials: 'include', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, ...(reason ? { reason } : {}) }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Legal-hold toggle failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

/**
 * Bulk legal-hold setter (super-admin only). `enabled` is a SET
 * operation — every supplied id ends in that state regardless of its
 * prior value. Server returns succeeded/failures buckets; this client
 * never deletes anything.
 */
export interface BulkLegalHoldResult {
  requested: number;
  succeeded: string[];
  failures: Array<{ id: string; error: string }>;
  enabled: boolean;
}

export async function bulkSetAdminRecordingLegalHold(
  ids: string[],
  enabled: boolean,
  reason?: string,
): Promise<BulkLegalHoldResult> {
  const res = await fetch(`${API_BASE}/api/admin/calls/recordings/legal-hold/bulk`, {credentials: 'include', 
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, enabled, ...(reason ? { reason } : {}) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Bulk legal-hold failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

/**
 * Build the admin recording artifact URL. Used internally by
 * `fetchAdminRecordingBlob`. NOT a signed URL — the route is protected
 * by the super-admin bearer header and must be fetched via
 * `fetchAdminRecordingBlob`, never opened directly in <a href> / <video src>.
 */
function adminRecordingFileUrl(id: string, disposition: 'inline' | 'attachment'): string {
  const qs = disposition === 'attachment' ? '?disposition=attachment' : '';
  return `${API_BASE}/api/admin/calls/recordings/${encodeURIComponent(id)}/file${qs}`;
}

/**
 * Fetches the underlying recording bytes through the super-admin
 * artifact proxy. Returns a blob + content-type the caller can turn
 * into an in-memory object URL for inline playback or download.
 * Provider URLs are never exposed to the browser — all bytes flow
 * through the canonical storage abstraction on the backend.
 */
export async function fetchAdminRecordingBlob(
  id: string,
  disposition: 'inline' | 'attachment' = 'inline',
): Promise<{ blob: Blob; contentType: string; filename: string | null }> {
  const res = await fetch(adminRecordingFileUrl(id, disposition), {credentials: 'include', 
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return {
    blob,
    contentType: res.headers.get('Content-Type') || blob.type || 'application/octet-stream',
    filename: m ? m[1] : null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tokenized native playback.
//
// Mints a short-lived HMAC URL the browser can hand directly to <audio>
// or <video> as `src`, enabling native Range/streaming without buffering
// the full file into a Blob first. The minted URL is bound to one
// recording id + disposition and expires after a short TTL (server caps
// at 15 min, defaults to 5 min). No provider URL or credential is ever
// exposed — the streaming route still proxies bytes through the canonical
// storage abstraction on the backend.
// ────────────────────────────────────────────────────────────────────────
export interface AdminRecordingPlaybackToken {
  recording_id: string;
  /** Path-only URL (no origin). Combine with API_BASE for fetch/src usage. */
  url: string;
  token: string;
  disposition: 'inline' | 'attachment';
  expires_at: string;
  ttl_seconds: number;
}

export async function mintAdminRecordingPlaybackToken(
  id: string,
  disposition: 'inline' | 'attachment' = 'inline',
): Promise<AdminRecordingPlaybackToken> {
  const res = await fetch(
    `${API_BASE}/api/admin/calls/recordings/${encodeURIComponent(id)}/playback-token`,
    {credentials: 'include', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disposition }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const json = (await res.json()) as AdminRecordingPlaybackToken;
  return { ...json, url: `${API_BASE}${json.url}` };
}

// ────────────────────────────────────────────────────────────────────────
// Per-recording retention override (super-admin only).
//
// Backed by:
//   POST /api/admin/calls/recordings/:id/retention-override
//
// Mutates ONLY `retention_expires_at` and `retention_policy` on the row.
// Never touches `legal_hold`. Never deletes. The retention janitor remains
// the sole deletion path. There is no bulk surface and no clear-override
// surface in this pass — operators set a new explicit value instead.
// ────────────────────────────────────────────────────────────────────────
export type RetentionOverrideInput =
  | { mode: 'exact'; expires_at: string; reason?: string }
  | { mode: 'days_from_now'; days: number; reason?: string }
  | { mode: 'unlimited'; reason?: string };

export interface RetentionOverrideResult {
  id: string;
  retention_policy: string;
  retention_expires_at: string | null;
  legal_hold: boolean;
}

export async function setAdminRecordingRetentionOverride(
  id: string,
  input: RetentionOverrideInput,
): Promise<RetentionOverrideResult> {
  const res = await fetch(
    `${API_BASE}/api/admin/calls/recordings/${encodeURIComponent(id)}/retention-override`,
    {credentials: 'include', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────
// Per-recording retention RESTORE-TO-INHERITED (super-admin only).
//
// Backed by:
//   POST /api/admin/calls/recordings/:id/retention-restore
//
// Only valid for rows whose `retention_policy` starts with `override:`.
// Server returns 409 on legacy/unmanaged or already-inherited rows so the
// UI never silently mutates them. Never touches `legal_hold`. Never
// deletes. Janitor remains the sole deletion path.
// ────────────────────────────────────────────────────────────────────────
export interface RetentionRestoreResult {
  id: string;
  retention_policy: string;
  retention_expires_at: string | null;
  legal_hold: boolean;
  inherited_source: string;
  inherited_days: number;
}

export async function restoreAdminRecordingRetention(
  id: string,
  reason?: string,
): Promise<RetentionRestoreResult> {
  const res = await fetch(
    `${API_BASE}/api/admin/calls/recordings/${encodeURIComponent(id)}/retention-restore`,
    {credentials: 'include', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────
// Per-recording LEGACY ADOPTION (super-admin only).
//
// Backed by:
//   POST /api/admin/calls/recordings/:id/retention-adopt
//
// Eligible ONLY for rows that are currently legacy/unmanaged
// (`retention_expires_at IS NULL` AND `retention_policy IS NULL`).
// Server returns 409 for already-managed rows so the UI never silently
// mutates them. Never touches `legal_hold`. Never deletes. Janitor
// remains the sole deletion path. No bulk / implicit backfill.
// ────────────────────────────────────────────────────────────────────────
export interface RetentionAdoptResult {
  id: string;
  retention_policy: string;
  retention_expires_at: string | null;
  legal_hold: boolean;
  inherited_source: string;
  inherited_days: number;
  already_expired: boolean;
}

export async function adoptAdminRecordingRetention(
  id: string,
  reason?: string,
): Promise<RetentionAdoptResult> {
  const res = await fetch(
    `${API_BASE}/api/admin/calls/recordings/${encodeURIComponent(id)}/retention-adopt`,
    {credentials: 'include', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}