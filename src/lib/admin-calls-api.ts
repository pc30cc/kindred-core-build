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