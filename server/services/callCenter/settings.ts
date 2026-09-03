/**
 * Call Center — workspace + platform settings helpers.
 * Self-hosted, provider-driven, additive on top of existing call infra.
 */
import crypto from 'crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { CallWidgetFormField, CallWidgetOfflineBehavior, CallWidgetTheme } from './presentation.js';

export interface PlatformCallCenterSettings {
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
  /** Callback (anti-spam) controls. */
  callback_show_when_online: boolean;
  callback_min_seconds_between_requests: number;
  callback_max_per_ip_per_hour: number;
  callback_require_contact: boolean;
  callback_min_message_length: number;
  callback_honeypot_enabled: boolean;
  callback_min_form_seconds: number;
  /** Ringback (on-hold) audio played to the visitor while waiting. */
  ringback_enabled: boolean;
  ringback_mode: 'tone' | 'music' | 'off';
  ringback_music_path: string | null;
  ringback_music_url: string | null;
  ringback_announcement_audio_path: string | null;
  ringback_queue_audio_paths: Record<string, string> | null;
  /** Queue experience for the visitor. */
  queue_show_position: boolean;
  queue_show_eta: boolean;
  queue_eta_seconds_per_position: number;
  queue_offer_callback_after_seconds: number;
  /** Audible notification on the operator side when a new call hits the queue. */
  operator_new_call_sound_enabled: boolean;
  /** Widget language defaults / catalog (super-admin scope). */
  widget_default_locale: 'en' | 'fa' | 'tr';
  widget_available_locales: string[];
  updated_at: string;
}

export interface WorkspaceCallCenterSettings {
  id: string;
  workspace_id: string;
  enabled: boolean;
  public_key: string | null;
  allowed_domains: string[];
  widget_position: string;
  widget_template_id: string;
  widget_theme: CallWidgetTheme;
  display_name: string | null;
  avatar_url: string | null;
  avatar_storage_path: string | null;
  voice_enabled: boolean;
  video_enabled: boolean;
  callback_enabled: boolean;
  pre_call_form_enabled: boolean;
  pre_call_form_schema: CallWidgetFormField[];
  business_hours: Record<string, unknown>;
  offline_behavior: CallWidgetOfflineBehavior;
  recording_enabled: boolean;
  recording_consent_required: boolean;
  /** When false, the visitor's widget does not render the operator's camera (audio still flows). */
  operator_video_visible_to_visitor: boolean;
  routing_mode: string;
  default_department_id: string | null;
  departments_enabled: boolean;
  allow_visitor_department_choice: boolean;
  /** Widget language overrides (workspace scope). Null = inherit platform. */
  widget_default_locale: 'en' | 'fa' | 'tr' | null;
  widget_enabled_locales: string[] | null;
  /** Per-locale overrides for widget labels (header, buttons, launcher). */
  widget_custom_texts: Record<string, Record<string, string>> | null;
  created_at: string;
  updated_at: string;
}

let _platformCache: { value: PlatformCallCenterSettings; at: number } | null = null;
const PLATFORM_CACHE_MS = 30_000;

export function invalidatePlatformCallCenterCache() {
  _platformCache = null;
}

export async function getPlatformCallCenterSettings(
  config: ServerConfig,
): Promise<PlatformCallCenterSettings> {
  if (_platformCache && Date.now() - _platformCache.at < PLATFORM_CACHE_MS) {
    return _platformCache.value;
  }
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('platform_call_center_settings')
    .select('*')
    .eq('singleton', true)
    .maybeSingle();
  if (error) throw error;
  let row = data;
  if (!row) {
    // Fail-closed: ensure singleton exists
    const ins = await sb
      .from('platform_call_center_settings')
      .insert({ singleton: true, call_center_enabled: false })
      .select('*')
      .maybeSingle();
    row = ins.data;
  }
  const value = row as PlatformCallCenterSettings;
  _platformCache = { value, at: Date.now() };
  return value;
}

export async function updatePlatformCallCenterSettings(
  config: ServerConfig,
  patch: Partial<PlatformCallCenterSettings>,
): Promise<PlatformCallCenterSettings> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('platform_call_center_settings')
    .update(patch)
    .eq('singleton', true)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  invalidatePlatformCallCenterCache();
  return data as PlatformCallCenterSettings;
}

function generatePublicKey(): string {
  return 'cck_' + crypto.randomBytes(18).toString('base64url');
}

export async function getOrCreateWorkspaceSettings(
  config: ServerConfig,
  workspaceId: string,
): Promise<WorkspaceCallCenterSettings> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_center_settings')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (data) return data as WorkspaceCallCenterSettings;
  const { data: created, error } = await sb
    .from('call_center_settings')
    .insert({ workspace_id: workspaceId, public_key: generatePublicKey() })
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return created as WorkspaceCallCenterSettings;
}

export async function updateWorkspaceSettings(
  config: ServerConfig,
  workspaceId: string,
  patch: Partial<WorkspaceCallCenterSettings>,
): Promise<WorkspaceCallCenterSettings> {
  const sb = getServiceClient(config);
  // Ensure row exists
  await getOrCreateWorkspaceSettings(config, workspaceId);
  // Strip immutable
  const safe: Record<string, unknown> = { ...patch };
  delete safe.id;
  delete safe.workspace_id;
  delete safe.public_key;
  delete safe.created_at;
  delete safe.updated_at;
  const { data, error } = await sb
    .from('call_center_settings')
    .update(safe)
    .eq('workspace_id', workspaceId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data as WorkspaceCallCenterSettings;
}

/**
 * Look up a workspace by its call-widget `public_key`.
 *
 * SECURITY: `public_key` is a PUBLIC IDENTIFIER, not a secret credential — it
 * is embedded in the widget snippet and visible to anyone who views the
 * customer's page source. It may be used for routing/authorization lookups,
 * but it must NEVER authenticate a caller and must never select an
 * authenticated per-workspace rate-limit bucket. Only a signed, server-issued
 * call-widget session (`x-cc-session`) proves workspace identity.
 */
export async function findWorkspaceByPublicKey(
  config: ServerConfig,
  publicKey: string,
): Promise<WorkspaceCallCenterSettings | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_center_settings')
    .select('*')
    .eq('public_key', publicKey)
    .maybeSingle();
  return (data as WorkspaceCallCenterSettings | null) ?? null;
}

/**
 * Effective capabilities = platform AND workspace AND plan.
 * (Plan layer is hookable later; we use platform AND workspace for now.)
 */
export function computeEffectiveCallCenterCaps(
  platform: PlatformCallCenterSettings,
  workspace: WorkspaceCallCenterSettings,
) {
  const enabled = platform.call_center_enabled && workspace.enabled;
  return {
    call_center_enabled: enabled,
    // Visibility depends only on the platform kill switch so workspace
    // owners can still open Settings to enable/disable their workspace.
    workspace_call_center_visible: platform.call_center_enabled,
    voice_enabled: enabled && platform.voice_calls_enabled && workspace.voice_enabled,
    video_enabled: enabled && platform.video_calls_enabled && workspace.video_enabled,
    callback_enabled:
      platform.call_center_enabled &&
      platform.callback_requests_enabled &&
      workspace.enabled &&
      workspace.callback_enabled,
    recording_enabled:
      enabled && platform.call_recording_enabled && workspace.recording_enabled,
    max_concurrent_calls: platform.max_concurrent_calls_per_workspace,
    max_monthly_call_minutes: platform.max_monthly_call_minutes_per_workspace,
    max_queue_size: platform.max_queue_size_per_workspace,
  };
}

export function originAllowed(
  workspace: WorkspaceCallCenterSettings,
  origin: string | null,
): boolean {
  if (!origin) return false;
  const list = workspace.allowed_domains || [];
  if (list.length === 0) return false;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return list.some((d) => {
    const dn = d.trim().toLowerCase();
    if (!dn) return false;
    if (dn === host) return true;
    if (dn.startsWith('*.')) return host.endsWith(dn.slice(1));
    return false;
  });
}

/**
 * Resolve effective widget i18n config for a workspace.
 *  - `available` = intersection(platform.widget_available_locales, workspace.widget_enabled_locales ?? all-available)
 *    (always falls back to ['en'] if everything resolves to empty).
 *  - `default_locale` = workspace.widget_default_locale if it is in `available`,
 *    else platform.widget_default_locale if it is in `available`,
 *    else first locale in `available`.
 */
export function computeEffectiveCallCenterLocales(
  platform: PlatformCallCenterSettings,
  workspace: WorkspaceCallCenterSettings,
): { default_locale: string; available: string[]; platform_available: string[] } {
  const platformAvailable = (platform.widget_available_locales || []).filter(Boolean);
  const wsEnabled = workspace.widget_enabled_locales;
  const filtered = (wsEnabled && wsEnabled.length > 0)
    ? wsEnabled.filter((l) => platformAvailable.includes(l))
    : platformAvailable.slice();
  const available = filtered.length > 0 ? filtered : ['en'];
  const wsDefault = workspace.widget_default_locale || null;
  const platDefault = platform.widget_default_locale || 'en';
  const def = (wsDefault && available.includes(wsDefault))
    ? wsDefault
    : (available.includes(platDefault) ? platDefault : available[0]);
  return { default_locale: def, available, platform_available: platformAvailable };
}
