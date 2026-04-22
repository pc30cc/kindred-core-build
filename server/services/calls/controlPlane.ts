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

export type CallProviderId =
  | 'livekit'
  | 'jitsi'
  | 'janus'
  | 'agora_cloud'
  | 'disabled';

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
  // ── Phase 8C — global channel gates (hard upper bounds) ──
  // When false at the platform level, a workspace cannot enable the
  // corresponding feature regardless of its own override.
  voice_calls_enabled_global: boolean;
  video_calls_enabled_global: boolean;
  call_recording_enabled_global: boolean;
  call_queue_enabled_global: boolean;
  visitor_initiated_audio_enabled_global: boolean;
  visitor_initiated_video_enabled_global: boolean;
  // ── Phase 8D — SLA + callback defaults (platform level) ──
  // Keep all defaults bounded and self-explanatory; workspace overrides
  // are intentionally NOT exposed here yet (kept for a later phase).
  queue_offer_timeout_seconds: number;       // single offer ring duration
  queue_max_wait_seconds: number;            // overall queue patience
  auto_expire_queue_after_seconds: number;   // hard ceiling for any entry
  callback_offer_after_timeout: boolean;     // surface callback once SLA breaches
  audio_queue_enabled: boolean;              // channel toggle for the queue itself
  video_queue_enabled: boolean;
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
  voice_calls_enabled_global: true,
  video_calls_enabled_global: true,
  call_recording_enabled_global: false,
  call_queue_enabled_global: true,
  visitor_initiated_audio_enabled_global: true,
  visitor_initiated_video_enabled_global: true,
  queue_offer_timeout_seconds: 25,
  queue_max_wait_seconds: 180,
  auto_expire_queue_after_seconds: 600,
  callback_offer_after_timeout: true,
  audio_queue_enabled: true,
  video_queue_enabled: true,
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
  // Phase 8C — workspace-level channel toggles. Each is bounded by the
  // corresponding global gate above (effective = global AND workspace).
  voice_calls_enabled: boolean;
  video_calls_enabled: boolean;
  call_recording_enabled: boolean;
  call_queue_enabled: boolean;
  visitor_initiated_audio_enabled: boolean;
  visitor_initiated_video_enabled: boolean;
}

const DEFAULT_WORKSPACE_OVERRIDES: WorkspaceCallOverrides = {
  allow_voice: true,
  allow_video: true,
  allow_recording: false,
  provider_override: null,
  verification_policy: 'inherit',
  voice_calls_enabled: true,
  video_calls_enabled: true,
  call_recording_enabled: false,
  call_queue_enabled: true,
  visitor_initiated_audio_enabled: true,
  visitor_initiated_video_enabled: true,
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

/**
 * Phase 8C — write workspace call overrides. Stored as the `config` JSON
 * column on `workspace_provider_settings` row keyed by (workspace, 'call').
 * Creates the row if it does not yet exist. Returns the merged value.
 */
export async function saveWorkspaceCallOverrides(
  config: ServerConfig,
  workspaceId: string,
  patch: Partial<WorkspaceCallOverrides>,
): Promise<WorkspaceCallOverrides> {
  const sb = getServiceClient(config);
  const current = await loadWorkspaceCallOverrides(config, workspaceId);
  const merged: WorkspaceCallOverrides = { ...current, ...patch };
  const { error } = await sb
    .from('workspace_provider_settings')
    .upsert(
      {
        workspace_id: workspaceId,
        provider_type: 'call',
        provider_name: 'call_channel',
        enabled: true,
        config: merged as any,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,provider_type' },
    );
  if (error) throw new Error(error.message);
  return merged;
}

/**
 * Effective channel state = (platform global AND workspace setting).
 * This is the single source clients should consult for "is this channel
 * actually usable right now". UI gates and queue admission both read
 * from here so there is no chance of drift.
 */
export interface EffectiveCallChannels {
  voice_enabled: boolean;
  video_enabled: boolean;
  recording_enabled: boolean;
  queue_enabled: boolean;
  visitor_initiated_audio: boolean;
  visitor_initiated_video: boolean;
}

export async function loadEffectiveCallChannels(
  config: ServerConfig,
  workspaceId: string,
): Promise<EffectiveCallChannels> {
  const [cp, ws] = await Promise.all([
    loadCallControlPlane(config),
    loadWorkspaceCallOverrides(config, workspaceId),
  ]);
  if (!cp.enabled) {
    return {
      voice_enabled: false,
      video_enabled: false,
      recording_enabled: false,
      queue_enabled: false,
      visitor_initiated_audio: false,
      visitor_initiated_video: false,
    };
  }
  return {
    voice_enabled: cp.voice_calls_enabled_global && ws.voice_calls_enabled,
    video_enabled: cp.video_calls_enabled_global && ws.video_calls_enabled,
    recording_enabled:
      cp.call_recording_enabled_global && ws.call_recording_enabled,
    queue_enabled: cp.call_queue_enabled_global && ws.call_queue_enabled,
    visitor_initiated_audio:
      cp.voice_calls_enabled_global &&
      ws.voice_calls_enabled &&
      cp.visitor_initiated_audio_enabled_global &&
      ws.visitor_initiated_audio_enabled,
    visitor_initiated_video:
      cp.video_calls_enabled_global &&
      ws.video_calls_enabled &&
      cp.visitor_initiated_video_enabled_global &&
      ws.visitor_initiated_video_enabled,
  };
}