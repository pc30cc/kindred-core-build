/**
 * AI Agent — settings service.
 *
 * Phase 1 foundation. Reads / writes ai_agent_settings with safe defaults.
 * No engine / auto-reply logic here — that comes in Phase 2.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { publishCacheInvalidation } from '../../lib/cacheBus.js';
import { createStorageUrlResolver, type StorageUrlResolver } from '../storage/urlResolver.js';
import { DEFAULT_AI_AGENT_NAME, DEFAULT_AI_FALLBACK_MESSAGE } from '../../../shared/systemMessages.js';

export type AgentMode =
  | 'off'
  | 'suggest_only'
  | 'auto_reply_when_offline'
  | 'auto_reply_until_human_joins'
  | 'auto_reply_always';

export type AnswerGuidance = 'conservative' | 'balanced' | 'creative';
/**
 * The column's values (CHECK in migration 016a), shared with the answer
 * strategy (answerStrategy.ts thresholdsForStyle), which also reads the
 * legacy 'proactive' as 'helpful_first'.
 */
export type EscalationStyle = 'conservative' | 'balanced' | 'helpful_first';

/**
 * The language the AI writes to the visitor in (instructions.reply_language):
 * 'visitor' (also when unset) keeps each path's visitor-language rule;
 * 'workspace_default' answers in the workspace's default language when it is
 * an allowed one (replyLanguage.ts). allowed_locales stays the allow-list only.
 */
export type ReplyLanguage = 'visitor' | 'workspace_default';

/**
 * `ai_agent_settings.instructions`, one JSON column. A write merges into it
 * key by key (mergeInstructions below); only the customer-safe subset ever
 * reaches a browser (customerSafe.ts).
 */
export interface AgentInstructions {
  tone?: string;
  custom_instructions?: string;
  forbidden_topics?: string[];
  escalation_instructions?: string;
  max_answer_length?: 'short' | 'medium' | 'long';
  brand_voice?: string;
  /** @deprecated legacy key; the canonical field is AgentSettings.business_description. */
  business_description?: string;
  do_list?: string[];
  dont_list?: string[];
  handoff_instructions?: string;
  pricing_instructions?: string;
  support_instructions?: string;
  /** Never returned to a browser (customerSafe.ts sends has_custom_system_instruction). */
  custom_system_instruction?: string;
  reply_language?: ReplyLanguage;
}

export interface AgentSettings {
  id: string;
  workspace_id: string;
  enabled: boolean;
  agent_name: string;
  agent_logo_url: string | null;
  business_description: string | null;
  answer_guidance: AnswerGuidance;
  mode: AgentMode;
  answer_only_from_kb: boolean;
  /**
   * Allow-list scope mode. false (default) preserves the existing
   * conversational persona: the assistant may engage with greetings, small
   * talk, and general questions unrelated to the business. true switches the
   * CONVERSATION section of the system prompt (see prompt.ts) to a strict
   * allow-list: only greetings/identity questions and questions about this
   * business are answered; everything else gets a short "I can only help
   * with X" redirect. Independent of, and complementary to, the topics
   * `decline` gate (topics/*) — that gate is a deterministic hard guarantee
   * for specific sensitive categories regardless of this setting; this
   * setting is a prompt-level default posture for everything else.
   */
  strict_topic_scope: boolean;
  welcome_message: string | null;
  fallback_message: string;
  handoff_keywords: string[];
  max_replies_per_conversation: number;
  max_replies_per_hour: number;
  allowed_locales: string[];
  show_sources_to_operator: boolean;
  show_sources_to_visitor: boolean;
  handoff_on_low_confidence: boolean;
  /**
   * Whether an explicit request for a person is acted on at all (every
   * consumer reads this switch: runtimePolicy, contextStage,
   * runtimeDecisionStage, answerStrategy, policy). false: the AI keeps
   * answering, whatever handoff_policy says. A write that sets a
   * handoff_policy turns it on (updateSettings), so the page's handoff
   * control always takes effect.
   */
  handoff_on_human_request: boolean;
  handoff_when_no_kb_match: boolean;
  /**
   * How an explicit request for a person is handled while
   * handoff_on_human_request is on: 'immediate', 'assist_first' or
   * 'adaptive' (handoffPolicy.ts). NULL (every row until an owner picks one)
   * is the legacy rule: hand over at once.
   */
  handoff_policy?: 'immediate' | 'assist_first' | 'adaptive' | null;
  /**
   * Assist attempts before an explicit request hands over ('assist_first',
   * 'adaptive'), 0..3 (handoffPolicy.ts resolveMaxAssistAttempts). The
   * second explicit request always hands over (§19), so 0 means at once and
   * any value from 1 means one attempt.
   */
  max_assist_attempts?: number;
  confidence_threshold: number;
  instructions: AgentInstructions;
  metadata: Record<string, unknown>;
  // Phase 3 — runtime
  ai_intro_enabled: boolean;
  intro_message: string | null;
  intro_message_localized: Record<string, string>;
  handoff_message_localized: Record<string, string>;
  handoff_prechat_message_localized: Record<string, string>;
  fallback_behavior: 'handoff' | 'silent';
  stop_on_handoff: boolean;
  max_auto_replies_per_conversation?: number;
  // Phase 3.1 — automated inbox & takeover safety
  pause_auto_reply_after_human_reply?: boolean;
  allow_suggestions_after_takeover?: boolean;
  keep_in_automated_until_handoff?: boolean;
  // Phase 4 — answer strategy & learning toggles
  escalation_style?: EscalationStyle;
  allow_clarifying_questions?: boolean;
  max_clarification_attempts?: number;
  allow_answer_with_caveat?: boolean;
  learning_enabled?: boolean;
  auto_create_learning_candidates?: boolean;
  require_approval_for_learning?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * The agent's name and hand-over line until the owner sets them. English in
 * every language, so what the visitor reads treats them as unset
 * (shared/systemMessages.ts, where they live so that pure code reads them
 * too; ai-agent/intro.ts, engine/helpers.ts ownerFallbackMessage).
 */
export { DEFAULT_AI_AGENT_NAME, DEFAULT_AI_FALLBACK_MESSAGE };

const DEFAULT_HANDOFF_KEYWORDS = [
  'human','agent','operator','representative','speak to someone',
  'انسان','اپراتور','پشتیبان',
  'insan','operatör','temsilci','yetkili',
];

function defaults(workspaceId: string): Omit<AgentSettings, 'id' | 'created_at' | 'updated_at'> {
  return {
    workspace_id: workspaceId,
    enabled: false,
    agent_name: DEFAULT_AI_AGENT_NAME,
    agent_logo_url: null,
    business_description: null,
    answer_guidance: 'conservative',
    mode: 'off',
    answer_only_from_kb: true,
    strict_topic_scope: false,
    welcome_message: null,
    fallback_message: DEFAULT_AI_FALLBACK_MESSAGE,
    handoff_keywords: DEFAULT_HANDOFF_KEYWORDS,
    max_replies_per_conversation: 3,
    max_replies_per_hour: 20,
    allowed_locales: ['en','tr','fa'],
    show_sources_to_operator: true,
    show_sources_to_visitor: false,
    // Missing/weak verified knowledge is NOT an escalation by default: the
    // assistant says it has no confirmed information instead of dragging in
    // a human. Owners can opt back in explicitly.
    handoff_on_low_confidence: false,
    handoff_on_human_request: true,
    handoff_when_no_kb_match: false,
    // NULL on purpose: existing workspaces keep byte-identical behaviour
    // until an owner explicitly picks a policy (§53 backward compatibility).
    handoff_policy: null,
    max_assist_attempts: 1,
    confidence_threshold: 0.55,
    instructions: {},
    metadata: {},
    ai_intro_enabled: true,
    intro_message: null,
    intro_message_localized: {},
    handoff_message_localized: {},
    handoff_prechat_message_localized: {},
    fallback_behavior: 'handoff',
    stop_on_handoff: true,
    pause_auto_reply_after_human_reply: true,
    allow_suggestions_after_takeover: true,
    keep_in_automated_until_handoff: true,
    escalation_style: 'balanced',
    allow_clarifying_questions: true,
    max_clarification_attempts: 1,
    allow_answer_with_caveat: true,
    learning_enabled: true,
    auto_create_learning_candidates: true,
    require_approval_for_learning: true,
  };
}

export async function getOrCreateSettings(
  config: ServerConfig,
  workspaceId: string,
): Promise<AgentSettings> {
  const sb = getServiceClient(config);
  const { data: existing } = await sb
    .from('ai_agent_settings')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (existing) return existing as AgentSettings;

  const { data: created, error } = await sb
    .from('ai_agent_settings')
    .insert(defaults(workspaceId))
    .select('*')
    .single();
  if (error) throw new Error(`ai_agent_settings init failed: ${error.message}`);
  publishCacheInvalidation([`widget:${workspaceId}`]);
  return created as AgentSettings;
}

const ALLOWED_UPDATE_FIELDS = new Set([
  'enabled','agent_name','agent_logo_url','business_description','answer_guidance',
  'mode','answer_only_from_kb','strict_topic_scope','welcome_message','fallback_message','handoff_keywords',
  'max_replies_per_conversation','max_replies_per_hour','allowed_locales',
  'show_sources_to_operator','show_sources_to_visitor',
  'handoff_on_low_confidence','handoff_on_human_request','handoff_when_no_kb_match',
  'handoff_policy','max_assist_attempts',
  'confidence_threshold','instructions','metadata',
  'ai_intro_enabled','intro_message','intro_message_localized','handoff_message_localized','handoff_prechat_message_localized','fallback_behavior','stop_on_handoff',
  'pause_auto_reply_after_human_reply','allow_suggestions_after_takeover',
  'keep_in_automated_until_handoff',
  'escalation_style','allow_clarifying_questions','max_clarification_attempts',
  'allow_answer_with_caveat','learning_enabled','auto_create_learning_candidates',
  'require_approval_for_learning',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * `instructions` is one JSON column, and a write MERGES into it key by key:
 *
 *   - a key the write carries replaces the stored one; '' clears a text and
 *     [] clears a list (the prompt reads both as unset);
 *   - a key the write leaves out keeps its stored value, including the keys
 *     a page never sees (`custom_system_instruction`, which only reaches a
 *     browser as `has_custom_system_instruction`) or does not know (legacy
 *     keys such as `custom_instructions`, `forbidden_topics`, `personality`).
 *
 * So a page sends only the keys the owner edited, and a client that sends
 * the whole object (every key it shows) gets what it sent. The custom system
 * instruction keeps its rule: left out, the stored one stays; sent, it
 * replaces it ('' removes it). An `undefined` value counts as left out.
 * Anything but an object (no current caller) is written as given.
 *
 * Two newer keys retire the legacy key they replaced (LEGACY_KEY_OF): the
 * prompt reads the old one only while the new one is empty (prompt.ts), and
 * the pages show the two as one field, so writing the new key, '' included,
 * drops the old one, unless the same write sets it: a cleared field then
 * clears what the assistant follows instead of bringing the old text back.
 */
const LEGACY_KEY_OF: Record<string, string> = {
  handoff_instructions: 'escalation_instructions',
  custom_system_instruction: 'custom_instructions',
};

export function mergeInstructions(next: unknown, stored: unknown): unknown {
  if (!isPlainObject(next)) return next;
  const merged: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    merged[key] = value;
    const legacy = LEGACY_KEY_OF[key];
    if (legacy && next[legacy] === undefined) delete merged[legacy];
  }
  return merged;
}

/**
 * The handoff control and its switch stay one rule. handoff_on_human_request
 * says whether a request for a person is acted on at all, and every consumer
 * reads it (runtimePolicy.decideRuntime, engine/contextStage.ts,
 * engine/runtimeDecisionStage.ts, answerStrategy.decideStrategy,
 * policy.decide); handoff_policy says how (handoffPolicy.ts). Each of the
 * three policies acts on the request (at once, or after one assist attempt),
 * so a write that picks a policy and says nothing about the switch turns the
 * switch on: otherwise a workspace whose switch was off would keep ignoring
 * the visitor whatever the page shows. A write that sets the switch itself
 * (false: "never hand over on request") is kept as written, and so is the
 * stored policy, for when the switch is turned on again.
 */
function syncHumanRequestSwitch(update: Record<string, unknown>): void {
  const policy = update.handoff_policy;
  const picksPolicy = policy === 'immediate' || policy === 'assist_first' || policy === 'adaptive';
  if (picksPolicy && !('handoff_on_human_request' in update)) {
    update.handoff_on_human_request = true;
  }
}

export async function updateSettings(
  config: ServerConfig,
  workspaceId: string,
  patch: Partial<AgentSettings>,
): Promise<AgentSettings> {
  const current = await getOrCreateSettings(config, workspaceId);
  const sb = getServiceClient(config);

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED_UPDATE_FIELDS.has(k)) update[k] = v;
  }
  if ('instructions' in update) {
    update.instructions = mergeInstructions(update.instructions, current.instructions);
  }
  syncHumanRequestSwitch(update);
  if (Object.keys(update).length === 0) {
    return getOrCreateSettings(config, workspaceId);
  }

  const { data, error } = await sb
    .from('ai_agent_settings')
    .update(update)
    .eq('workspace_id', workspaceId)
    .select('*')
    .single();
  if (error) throw new Error(`ai_agent_settings update failed: ${error.message}`);
  // The widget's AI snapshot (greeting, intro, agent name and logo).
  publishCacheInvalidation([`widget:${workspaceId}`]);
  return data as AgentSettings;
}
/**
 * The AI agent's logo URL, derived from its storage key.
 *
 * The object's only persisted record is `metadata.ai_avatar_storage_key`;
 * the avatar upload route no longer writes `agent_logo_url`, so a value
 * still in that column can only be an operator-supplied external link
 * (the settings PATCH schema accepts one). A key of ours therefore wins,
 * and the link it produces names whichever provider is primary right now.
 */
export async function resolveAgentLogoUrl(
  config: ServerConfig,
  workspaceId: string | null | undefined,
  settings: { agent_logo_url?: string | null; metadata?: unknown } | null | undefined,
  /** A resolver the caller already holds (one provider lookup for several URLs). */
  resolver?: StorageUrlResolver,
): Promise<string | null> {
  if (!settings) return null;
  const meta = (settings.metadata && typeof settings.metadata === 'object')
    ? settings.metadata as Record<string, unknown>
    : {};
  const key = typeof meta.ai_avatar_storage_key === 'string' ? meta.ai_avatar_storage_key : null;
  if (key) {
    const derived = await (resolver ?? createStorageUrlResolver(config)).workspace(workspaceId, key);
    if (derived) return derived;
  }
  return settings.agent_logo_url ?? null;
}

/**
 * The agent logo for a workspace, fetched and derived in one call.
 *
 * For callers that have a workspace id but not the settings row — notably the
 * realtime fan-out in responder.ts, which must put the link on the envelope
 * itself because the widget's only other source for it was a snapshot inside
 * the message metadata that this platform no longer writes.
 */
export async function resolveWorkspaceAgentLogoUrl(
  config: ServerConfig,
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('ai_agent_settings')
      .select('agent_logo_url, metadata')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    return await resolveAgentLogoUrl(config, workspaceId, data);
  } catch {
    // A cosmetic avatar must never break the message it belongs to.
    return null;
  }
}
