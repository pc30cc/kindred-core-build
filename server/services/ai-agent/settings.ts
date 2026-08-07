/**
 * AI Agent — settings service.
 *
 * Phase 1 foundation. Reads / writes ai_agent_settings with safe defaults.
 * No engine / auto-reply logic here — that comes in Phase 2.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type AgentMode =
  | 'off'
  | 'suggest_only'
  | 'auto_reply_when_offline'
  | 'auto_reply_until_human_joins'
  | 'auto_reply_always';

export type AnswerGuidance = 'conservative' | 'balanced' | 'creative';
export type EscalationStyle = 'conservative' | 'balanced' | 'helpful_first';

export interface AgentInstructions {
  tone?: string;
  custom_instructions?: string;
  forbidden_topics?: string[];
  escalation_instructions?: string;
  max_answer_length?: 'short' | 'medium' | 'long';
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
  welcome_message: string | null;
  fallback_message: string;
  handoff_keywords: string[];
  max_replies_per_conversation: number;
  max_replies_per_hour: number;
  allowed_locales: string[];
  show_sources_to_operator: boolean;
  show_sources_to_visitor: boolean;
  handoff_on_low_confidence: boolean;
  handoff_on_human_request: boolean;
  handoff_when_no_kb_match: boolean;
  confidence_threshold: number;
  instructions: AgentInstructions;
  metadata: Record<string, unknown>;
  // Phase 3 — runtime
  ai_intro_enabled: boolean;
  intro_message: string | null;
  intro_message_localized: Record<string, string>;
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

const DEFAULT_HANDOFF_KEYWORDS = [
  'human','agent','operator','representative','speak to someone',
  'انسان','اپراتور','پشتیبان',
  'insan','operatör','temsilci','yetkili',
];

function defaults(workspaceId: string): Omit<AgentSettings, 'id' | 'created_at' | 'updated_at'> {
  return {
    workspace_id: workspaceId,
    enabled: false,
    agent_name: 'AI Assistant',
    agent_logo_url: null,
    business_description: null,
    answer_guidance: 'conservative',
    mode: 'off',
    answer_only_from_kb: true,
    welcome_message: null,
    fallback_message: "I'm not sure about that yet. I'll connect you with a human agent.",
    handoff_keywords: DEFAULT_HANDOFF_KEYWORDS,
    max_replies_per_conversation: 3,
    max_replies_per_hour: 20,
    allowed_locales: ['en','tr','fa'],
    show_sources_to_operator: true,
    show_sources_to_visitor: false,
    handoff_on_low_confidence: true,
    handoff_on_human_request: true,
    handoff_when_no_kb_match: true,
    confidence_threshold: 0.55,
    instructions: {},
    metadata: {},
    ai_intro_enabled: true,
    intro_message: null,
    intro_message_localized: {},
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
  return created as AgentSettings;
}

const ALLOWED_UPDATE_FIELDS = new Set([
  'enabled','agent_name','agent_logo_url','business_description','answer_guidance',
  'mode','answer_only_from_kb','welcome_message','fallback_message','handoff_keywords',
  'max_replies_per_conversation','max_replies_per_hour','allowed_locales',
  'show_sources_to_operator','show_sources_to_visitor',
  'handoff_on_low_confidence','handoff_on_human_request','handoff_when_no_kb_match',
  'confidence_threshold','instructions','metadata',
  'ai_intro_enabled','intro_message','intro_message_localized','fallback_behavior','stop_on_handoff',
  'pause_auto_reply_after_human_reply','allow_suggestions_after_takeover',
  'keep_in_automated_until_handoff',
  'escalation_style','allow_clarifying_questions','max_clarification_attempts',
  'allow_answer_with_caveat','learning_enabled','auto_create_learning_candidates',
  'require_approval_for_learning',
]);

export async function updateSettings(
  config: ServerConfig,
  workspaceId: string,
  patch: Partial<AgentSettings>,
): Promise<AgentSettings> {
  await getOrCreateSettings(config, workspaceId);
  const sb = getServiceClient(config);

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED_UPDATE_FIELDS.has(k)) update[k] = v;
  }
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
  return data as AgentSettings;
}