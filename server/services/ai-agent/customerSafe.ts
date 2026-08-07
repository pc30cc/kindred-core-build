/**
 * AI Agent — customer-safe shared helpers.
 *
 * - toCustomerSafeAiAgentSettings: strips metadata, storage keys, and any
 *   internal/secret-shaped fields before returning settings to the client.
 * - canAccessAiAgentAdvancedToolsServer: backend gate for advanced/QA/debug
 *   endpoints. Mirrors the frontend AdvancedAiAgentGuard.
 * - isAiAgentPlatformEnabled: central platform kill-switch helper. Defaults
 *   to enabled when no platform table is present (TODO: wire to Super Admin).
 * - validateAvatarBytes: extension + MIME + magic-byte validation for avatar
 *   uploads. Rejects mismatches and SVG entirely.
 */
import type { ServerConfig } from '../../config.js';
import { isGlobalAdmin } from '../../middleware/adminBypass.js';
import { getServiceClient } from '../../supabase.js';
import type { AgentSettings } from './settings.js';
import { getPlatformAiAgentSettings } from './platformSettings.js';

export interface CustomerSafeAgentSettings {
  id: string;
  workspace_id: string;
  enabled: boolean;
  mode: AgentSettings['mode'];
  agent_name: string;
  agent_logo_url: string | null;
  avatar_display_url: string | null;
  business_description: string | null;
  answer_guidance: AgentSettings['answer_guidance'];
  answer_only_from_kb: boolean;
  welcome_message: string | null;
  fallback_message: string;
  allowed_locales: string[];
  show_sources_to_operator: boolean;
  show_sources_to_visitor: boolean;
  handoff_on_low_confidence: boolean;
  handoff_on_human_request: boolean;
  handoff_when_no_kb_match: boolean;
  ai_intro_enabled: boolean;
  intro_message: string | null;
  intro_message_localized: Record<string, string>;
  handoff_message_localized: Record<string, string>;
  fallback_behavior: 'handoff' | 'silent';
  stop_on_handoff: boolean;
  pause_auto_reply_after_human_reply?: boolean;
  allow_suggestions_after_takeover?: boolean;
  keep_in_automated_until_handoff?: boolean;
  // Customer-safe subset of instructions. Never returns custom_system_instruction
  // or anything resembling internal secrets.
  instructions: {
    tone?: string;
    custom_instructions?: string;
    forbidden_topics?: string[];
    escalation_instructions?: string;
    max_answer_length?: 'short' | 'medium' | 'long';
    brand_voice?: string;
    business_description?: string;
    do_list?: string[];
    dont_list?: string[];
    handoff_instructions?: string;
    pricing_instructions?: string;
    support_instructions?: string;
  };
  handoff_keywords: string[];
  max_replies_per_conversation: number;
  max_replies_per_hour: number;
  confidence_threshold: number;
  created_at: string;
  updated_at: string;
}

export function toCustomerSafeAiAgentSettings(s: AgentSettings): CustomerSafeAgentSettings {
  const instr = (s.instructions || {}) as any;
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    enabled: !!s.enabled,
    mode: s.mode,
    agent_name: s.agent_name,
    agent_logo_url: s.agent_logo_url,
    avatar_display_url: s.agent_logo_url,
    business_description: s.business_description,
    answer_guidance: s.answer_guidance,
    answer_only_from_kb: !!s.answer_only_from_kb,
    welcome_message: s.welcome_message,
    fallback_message: s.fallback_message,
    allowed_locales: s.allowed_locales || [],
    show_sources_to_operator: !!s.show_sources_to_operator,
    show_sources_to_visitor: !!s.show_sources_to_visitor,
    handoff_on_low_confidence: !!s.handoff_on_low_confidence,
    handoff_on_human_request: !!s.handoff_on_human_request,
    handoff_when_no_kb_match: !!s.handoff_when_no_kb_match,
    ai_intro_enabled: s.ai_intro_enabled !== false,
    intro_message: s.intro_message ?? null,
    intro_message_localized: (s.intro_message_localized && typeof s.intro_message_localized === 'object')
      ? s.intro_message_localized
      : {},
    handoff_message_localized: (s.handoff_message_localized && typeof s.handoff_message_localized === 'object')
      ? s.handoff_message_localized
      : {},
    fallback_behavior: s.fallback_behavior || 'handoff',
    stop_on_handoff: s.stop_on_handoff !== false,
    pause_auto_reply_after_human_reply: s.pause_auto_reply_after_human_reply,
    allow_suggestions_after_takeover: s.allow_suggestions_after_takeover,
    keep_in_automated_until_handoff: s.keep_in_automated_until_handoff,
    instructions: {
      tone: instr.tone,
      custom_instructions: instr.custom_instructions,
      forbidden_topics: instr.forbidden_topics,
      escalation_instructions: instr.escalation_instructions,
      max_answer_length: instr.max_answer_length,
      brand_voice: instr.brand_voice,
      business_description: instr.business_description,
      do_list: instr.do_list,
      dont_list: instr.dont_list,
      handoff_instructions: instr.handoff_instructions,
      pricing_instructions: instr.pricing_instructions,
      support_instructions: instr.support_instructions,
    },
    handoff_keywords: s.handoff_keywords || [],
    max_replies_per_conversation: s.max_replies_per_conversation,
    max_replies_per_hour: s.max_replies_per_hour,
    confidence_threshold: s.confidence_threshold,
    created_at: s.created_at,
    updated_at: s.updated_at,
    // metadata is intentionally omitted — it may contain ai_avatar_storage_key
    // and other internal bookkeeping that must never reach the client.
  };
}

/**
 * Server-side gate for advanced AI tools (regression, debug, retrieval debug,
 * source health, test cases, run inspector, etc.).
 * Allowed when the user is a global platform admin OR the
 * ENABLE_AI_ADVANCED_TOOLS env override is set (development only).
 * TODO: extend with per-workspace platform config when Super Admin pass lands.
 */
export async function canAccessAiAgentAdvancedToolsServer(
  config: ServerConfig,
  userId: string,
  _workspaceId: string,
): Promise<boolean> {
  // Dev-only override. MUST NOT take effect in production builds — in
  // production only verified global admins (or future platform config) may
  // access advanced QA/debug/regression tools.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.ENABLE_AI_ADVANCED_TOOLS === 'true'
  ) {
    return true;
  }
  try {
    return await isGlobalAdmin(config, userId);
  } catch {
    return false;
  }
}

/**
 * Central platform kill-switch helper. Defaults to enabled when no platform
 * config row is present. TODO(SuperAdmin): read from a dedicated platform
 * config table once it exists.
 */
export async function isAiAgentPlatformEnabled(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  try {
    // Read platform-wide kill switch from the canonical Super Admin table.
    // Defaults to enabled when the row/table is missing (fresh self-host).
    const platform = await getPlatformAiAgentSettings(config);
    if (!platform.ai_agent_enabled) return false;
    // Optional per-workspace override via ai_agent_settings.metadata.platform_disabled
    const sb = getServiceClient(config);
    const { data: row } = await sb
      .from('ai_agent_settings')
      .select('metadata')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const meta = ((row as any)?.metadata || {}) as Record<string, unknown>;
    if (meta.platform_disabled === true) return false;
  } catch {
    /* ignore — default to enabled */
  }
  return true;
}

// ─── Avatar validation ───
const AVATAR_ALLOWED_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export interface AvatarValidationResult {
  ok: boolean;
  error?: string;
  mime?: string;
  ext?: string;
}

export function validateAvatarBytes(opts: {
  filename: string;
  declaredMime: string | undefined | null;
  buf: Buffer;
  maxBytes: number;
}): AvatarValidationResult {
  const { filename, declaredMime, buf, maxBytes } = opts;
  if (!buf || buf.length === 0) return { ok: false, error: 'empty_file' };
  if (buf.length > maxBytes) return { ok: false, error: 'file_too_large' };

  const lcName = String(filename || '').toLowerCase();
  if (lcName.endsWith('.svg') || (declaredMime || '').toLowerCase().includes('svg')) {
    return { ok: false, error: 'svg_not_allowed' };
  }
  const dot = lcName.lastIndexOf('.');
  const ext = dot >= 0 ? lcName.slice(dot + 1) : '';
  const extMime = AVATAR_ALLOWED_EXT_TO_MIME[ext];
  if (!extMime) return { ok: false, error: 'unsupported_extension' };

  // Allow empty browser file.type (some browsers); otherwise require match.
  const declared = (declaredMime || '').toLowerCase().trim();
  if (declared && declared !== extMime) {
    // jpg/jpeg interchange handled by extMime resolution
    return { ok: false, error: 'mime_extension_mismatch' };
  }

  // Magic bytes
  let detected: string | null = null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    detected = 'image/png';
  } else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    detected = 'image/jpeg';
  } else if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    detected = 'image/webp';
  } else if (
    buf.length >= 6 &&
    (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    detected = 'image/gif';
  }
  if (!detected) return { ok: false, error: 'unrecognized_image_bytes' };
  if (detected !== extMime) return { ok: false, error: 'magic_bytes_mismatch' };

  return { ok: true, mime: extMime, ext: ext === 'jpeg' ? 'jpg' : ext };
}