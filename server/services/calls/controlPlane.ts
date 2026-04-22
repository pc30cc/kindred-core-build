/**
 * Phase 8A — Voice/Video Call Control Plane
 *
 * Stores global call settings in `app_runtime_config.call_control_plane`
 * and exposes typed read/write helpers. Workspace overrides (allow_voice,
 * allow_video, allow_recording, provider_override, verification_policy)
 * live in `workspace_provider_settings` under provider_type='call' so we
 * reuse the existing per-workspace provider config table — no new schema.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const RUNTIME_KEY = 'call_control_plane';
const CACHE_TTL_MS = 30_000;

export type CallProviderId = 'livekit' | 'jitsi' | 'janus' | 'disabled';

export interface CallControlPlaneConfig {
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

export const DEFAULT_CALL_CONTROL_PLANE: CallControlPlaneConfig = {
  enabled: false,
  primary_provider: 'livekit',
  secondary_provider: 'jitsi',
  fallback_policy: 'lenient',
  max_participants: 8,
  default_audio_bitrate_kbps: 32,
  default_video_bitrate_kbps: 1200,
  default_video_profile: 'h264_baseline_720p',
  recording_default_enabled: false,
  recording_default_type: 'composite',
  retention_default_days: 30,
  verification_required_for_visitor_calls: true,
};

let cache: { value: CallControlPlaneConfig; loadedAt: number } | null = null;

export function invalidateCallControlPlaneCache(): void {
  cache = null;
}

export async function loadCallControlPlane(
  config: ServerConfig,
  forceRefresh = false,
): Promise<CallControlPlaneConfig> {
  if (!forceRefresh && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.value;

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', RUNTIME_KEY)
    .maybeSingle();

  const merged: CallControlPlaneConfig = {
    ...DEFAULT_CALL_CONTROL_PLANE,
    ...((data?.value as Partial<CallControlPlaneConfig>) || {}),
  };

  cache = { value: merged, loadedAt: Date.now() };
  return merged;
}

export async function saveCallControlPlane(
  config: ServerConfig,
  next: Partial<CallControlPlaneConfig>,
): Promise<CallControlPlaneConfig> {
  const sb = getServiceClient(config);
  const current = await loadCallControlPlane(config, true);
  const merged: CallControlPlaneConfig = { ...current, ...next };
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: RUNTIME_KEY, value: merged as any, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);
  invalidateCallControlPlaneCache();
  return merged;
}

/** Workspace-level overrides for call features. */
export interface WorkspaceCallOverrides {
  allow_voice: boolean;
  allow_video: boolean;
  allow_recording: boolean;
  provider_override: CallProviderId | null;
  verification_policy: 'inherit' | 'always' | 'never';
}

const DEFAULT_WORKSPACE_OVERRIDES: WorkspaceCallOverrides = {
  allow_voice: true,
  allow_video: true,
  allow_recording: false,
  provider_override: null,
  verification_policy: 'inherit',
};

export async function loadWorkspaceCallOverrides(
  config: ServerConfig,
  workspaceId: string,
): Promise<WorkspaceCallOverrides> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_provider_settings')
    .select('config, enabled')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'call')
    .maybeSingle();

  if (!data) return { ...DEFAULT_WORKSPACE_OVERRIDES };
  const cfg = (data.config as Partial<WorkspaceCallOverrides>) || {};
  return { ...DEFAULT_WORKSPACE_OVERRIDES, ...cfg };
}