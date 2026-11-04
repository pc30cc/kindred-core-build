/**
 * AI Agent — customer-safe shared helpers.
 *
 * - toCustomerSafeAiAgentSettings: strips metadata, storage keys, and any
 *   internal/secret-shaped fields before returning settings to the client.
 * - canAccessAiAgentAdvancedToolsServer: backend gate for advanced/QA/debug
 *   endpoints, by the rule the frontend AdvancedAiAgentGuard applies
 *   (shared/aiAdvancedTools.ts): the Super Admin, or the workspace's plan
 *   key `ai_advanced_tools` and its owner or an admin.
 * - canAccessAiAgentPlatformPagesServer: the AI section's platform pages
 *   (/platform/*), Super Admin only, never a plan's.
 * - isAiAgentPlatformEnabled: central platform kill-switch helper. Defaults
 *   to enabled when no platform table is present (TODO: wire to Super Admin).
 * - validateAvatarBytes: extension + MIME + magic-byte validation for avatar
 *   uploads. Rejects mismatches and SVG entirely.
 */
import type { ServerConfig } from '../../config.js';
import { isGlobalAdmin } from '../../middleware/adminBypass.js';
import { getServiceClient } from '../../supabase.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { isUnreadableEntitlementReason } from '../billing/entitlementParse.js';
import { AI_ADVANCED_TOOLS_KEY, aiAdvancedToolsAllowed } from '../../../shared/aiAdvancedTools.js';
import type { AgentSettings, ReplyLanguage } from './settings.js';
import { getPlatformAiAgentSettings } from './platformSettings.js';
import { resolveReplyLanguage } from './replyLanguage.js';
import { resolveMaxAssistAttempts } from './handoffPolicy.js';

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
  strict_topic_scope: boolean;
  welcome_message: string | null;
  fallback_message: string;
  allowed_locales: string[];
  show_sources_to_operator: boolean;
  show_sources_to_visitor: boolean;
  handoff_on_low_confidence: boolean;
  /** false: a request for a person is not acted on, whatever handoff_policy says. */
  handoff_on_human_request: boolean;
  handoff_when_no_kb_match: boolean;
  /** The handoff control as stored; null is the legacy rule (hand over at once). */
  handoff_policy: 'immediate' | 'assist_first' | 'adaptive' | null;
  /** 0..3, as the runtime reads it (handoffPolicy.ts resolveMaxAssistAttempts). */
  max_assist_attempts: number;
  ai_intro_enabled: boolean;
  intro_message: string | null;
  intro_message_localized: Record<string, string>;
  handoff_message_localized: Record<string, string>;
  handoff_prechat_message_localized: Record<string, string>;
  fallback_behavior: 'handoff' | 'silent';
  stop_on_handoff: boolean;
  pause_auto_reply_after_human_reply?: boolean;
  allow_suggestions_after_takeover?: boolean;
  keep_in_automated_until_handoff?: boolean;
  // Answer strategy (Activation's "Answer behavior", Behavior's "When AI is unsure").
  escalation_style: NonNullable<AgentSettings['escalation_style']>;
  allow_clarifying_questions: boolean;
  max_clarification_attempts: number;
  allow_answer_with_caveat: boolean;
  // Learning from operator replies (learning/candidates.ts).
  learning_enabled: boolean;
  auto_create_learning_candidates: boolean;
  /**
   * Whether instructions.custom_system_instruction is set. The text itself
   * is never returned; a settings write that leaves it out keeps it
   * (settings.ts updateSettings).
   */
  has_custom_system_instruction: boolean;
  // Customer-safe subset of instructions. Never returns custom_system_instruction
  // or anything resembling internal secrets.
  instructions: {
    tone?: string;
    custom_instructions?: string;
    forbidden_topics?: string[];
    escalation_instructions?: string;
    max_answer_length?: 'short' | 'medium' | 'long';
    brand_voice?: string;
    /** @deprecated legacy persisted key; canonical field is AgentSettings.business_description. */
    business_description?: string;
    do_list?: string[];
    dont_list?: string[];
    handoff_instructions?: string;
    pricing_instructions?: string;
    support_instructions?: string;
    /** Always set: 'visitor' when the row has none (replyLanguage.ts). */
    reply_language: ReplyLanguage;
  };
  handoff_keywords: string[];
  max_replies_per_conversation: number;
  max_replies_per_hour: number;
  confidence_threshold: number;
  created_at: string;
  updated_at: string;
}

/**
 * `derivedLogoUrl` is the agent logo resolved from its storage key by
 * resolveAgentLogoUrl(). It is passed in rather than read from the row
 * because no provider URL is persisted: the row holds the key, the caller
 * holds the request-scoped resolver, and this mapper stays pure.
 */
export function toCustomerSafeAiAgentSettings(
  s: AgentSettings,
  derivedLogoUrl: string | null = null,
): CustomerSafeAgentSettings {
  const instr = (s.instructions || {}) as Record<string, never>;
  const customSystemInstruction = (s.instructions as { custom_system_instruction?: unknown } | null)
    ?.custom_system_instruction;
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    enabled: !!s.enabled,
    mode: s.mode,
    agent_name: s.agent_name,
    agent_logo_url: derivedLogoUrl,
    avatar_display_url: derivedLogoUrl,
    business_description: s.business_description,
    answer_guidance: s.answer_guidance,
    answer_only_from_kb: !!s.answer_only_from_kb,
    strict_topic_scope: !!s.strict_topic_scope,
    welcome_message: s.welcome_message,
    fallback_message: s.fallback_message,
    allowed_locales: s.allowed_locales || [],
    show_sources_to_operator: !!s.show_sources_to_operator,
    show_sources_to_visitor: !!s.show_sources_to_visitor,
    handoff_on_low_confidence: !!s.handoff_on_low_confidence,
    handoff_on_human_request: !!s.handoff_on_human_request,
    handoff_when_no_kb_match: !!s.handoff_when_no_kb_match,
    handoff_policy:
      s.handoff_policy === 'immediate' || s.handoff_policy === 'assist_first' || s.handoff_policy === 'adaptive'
        ? s.handoff_policy
        : null,
    max_assist_attempts: resolveMaxAssistAttempts(s),
    ai_intro_enabled: s.ai_intro_enabled !== false,
    intro_message: s.intro_message ?? null,
    intro_message_localized: (s.intro_message_localized && typeof s.intro_message_localized === 'object')
      ? s.intro_message_localized
      : {},
    handoff_message_localized: (s.handoff_message_localized && typeof s.handoff_message_localized === 'object')
      ? s.handoff_message_localized
      : {},
    handoff_prechat_message_localized: (s.handoff_prechat_message_localized && typeof s.handoff_prechat_message_localized === 'object')
      ? s.handoff_prechat_message_localized
      : {},
    fallback_behavior: s.fallback_behavior || 'handoff',
    stop_on_handoff: s.stop_on_handoff !== false,
    // As the runtime reads them (runtimePolicy.ts: on unless false).
    pause_auto_reply_after_human_reply: s.pause_auto_reply_after_human_reply !== false,
    allow_suggestions_after_takeover: s.allow_suggestions_after_takeover !== false,
    keep_in_automated_until_handoff: s.keep_in_automated_until_handoff,
    // The columns' defaults (migration 016a) when a row has none.
    escalation_style: s.escalation_style || 'balanced',
    allow_clarifying_questions: s.allow_clarifying_questions !== false,
    max_clarification_attempts: typeof s.max_clarification_attempts === 'number' ? s.max_clarification_attempts : 1,
    allow_answer_with_caveat: s.allow_answer_with_caveat !== false,
    // The columns' defaults (migration 016a), as learning/candidates.ts reads them.
    learning_enabled: s.learning_enabled !== false,
    auto_create_learning_candidates: s.auto_create_learning_candidates !== false,
    has_custom_system_instruction:
      typeof customSystemInstruction === 'string' && customSystemInstruction.trim().length > 0,
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
      reply_language: resolveReplyLanguage(s),
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
 * The non-production override ENABLE_AI_ADVANCED_TOOLS. MUST NOT take
 * effect in production builds: there only the Super Admin, or the plan rule
 * below, opens the advanced tools.
 */
export function aiAdvancedToolsDevOverrideServer(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ENABLE_AI_ADVANCED_TOOLS === 'true';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The AI section's platform pages (GET/PATCH /platform/settings, GET
 * /platform/ai-proactive-stats): platform-wide settings and counters, the
 * Super Admin's only, never a plan's. The dev override keeps working outside
 * production, as before.
 */
export async function canAccessAiAgentPlatformPagesServer(
  config: ServerConfig,
  userId: string,
): Promise<boolean> {
  if (aiAdvancedToolsDevOverrideServer()) return true;
  try {
    return await isGlobalAdmin(config, userId);
  } catch {
    return false;
  }
}

/**
 * Server-side gate for advanced AI tools (regression, test cases and runs,
 * suggested tests, source health, retrieval debug, run inspector), by the
 * rule of shared/aiAdvancedTools.ts:
 *   - a global platform admin (Super Admin), always;
 *   - the ENABLE_AI_ADVANCED_TOOLS override outside production;
 *   - otherwise `workspaceId`'s effective plan has `ai_advanced_tools`
 *     exactly true (check_workspace_entitlement, as every plan feature is
 *     read; a plan without the key takes the registry default, off) AND the
 *     caller is that workspace's owner or an admin (an active, unsuspended
 *     member). An unreadable plan or membership is a no (fail closed).
 * `workspaceId` must be the workspace whose data the request reads or
 * writes: the guard in server/routes/ai-agent/index.ts resolves it from the
 * request's resource (resolveAiAgentRequestWorkspace, platformGuards.ts),
 * so a member of one workspace with the key never reaches another
 * workspace's QA data.
 */
export async function canAccessAiAgentAdvancedToolsServer(
  config: ServerConfig,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  if (aiAdvancedToolsDevOverrideServer()) return true;
  let platformAdmin = false;
  try {
    platformAdmin = await isGlobalAdmin(config, userId);
  } catch {
    platformAdmin = false;
  }
  if (platformAdmin) return true;
  if (!workspaceId || !UUID_RE.test(workspaceId)) return false;
  try {
    const { data: member, error } = await getServiceClient(config)
      .from('workspace_members')
      .select('role, suspended_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !member) return false;
    const row = member as { role?: string | null; suspended_at?: string | null };
    if (row.suspended_at) return false;
    const role = row.role ?? null;
    // The role first: an agent never costs a plan read.
    if (!aiAdvancedToolsAllowed({ isPlatformAdmin: false, planValue: true, role })) return false;
    const plan = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      AI_ADVANCED_TOOLS_KEY,
      { selfHostBillingUnlimited: config.selfHostBillingUnlimited === true },
    );
    if (isUnreadableEntitlementReason(plan.reason) || plan.plan === 'error') return false;
    return aiAdvancedToolsAllowed({ isPlatformAdmin: false, planValue: plan.allowed === true, role });
  } catch {
    return false;
  }
}

/**
 * Whether a due regression schedule may run (worker/regression-runner). The
 * Advanced tools are a plan feature, so a plan that loses `ai_advanced_tools`
 * (turned off by the Super Admin, or a downgrade) stops its workspaces'
 * scheduled runs too, instead of leaving them calling the AI unseen. A
 * schedule the Super Admin set up or last changed keeps running, as every
 * schedule did before. An unreadable plan skips this run (fail closed; the
 * schedule has already moved on to its next time).
 */
export async function regressionScheduleMayRunServer(
  config: ServerConfig,
  schedule: { workspace_id: string; created_by?: string | null; updated_by?: string | null },
): Promise<boolean> {
  if (aiAdvancedToolsDevOverrideServer()) return true;
  for (const actor of new Set([schedule.updated_by, schedule.created_by])) {
    if (actor && (await isGlobalAdmin(config, actor).catch(() => false))) return true;
  }
  if (!schedule.workspace_id || !UUID_RE.test(schedule.workspace_id)) return false;
  try {
    const plan = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      schedule.workspace_id,
      AI_ADVANCED_TOOLS_KEY,
      { selfHostBillingUnlimited: config.selfHostBillingUnlimited === true },
    );
    if (isUnreadableEntitlementReason(plan.reason) || plan.plan === 'error') return false;
    return plan.allowed === true;
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
    const meta = (row?.metadata || {}) as Record<string, unknown>;
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