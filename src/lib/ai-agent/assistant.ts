/**
 * AI Agent API client — assistant domain.
 *
 * Mechanically extracted from src/lib/ai-agent-api.ts (Phase 4 split).
 * Workspace-level AI assistant settings/runtime-related API calls. Same
 * URLs, methods, bodies, and response types as before.
 */
import { jsonFetch } from './client.js';
import type { KnowledgeIndexStatus } from './knowledge.js';

export type AgentMode = 'off' | 'suggest_only' | 'auto_reply_when_offline' | 'auto_reply_until_human_joins' | 'auto_reply_always';

export type AnswerGuidance = 'conservative' | 'balanced' | 'creative';

export type EscalationStyle = 'conservative' | 'balanced' | 'helpful_first';


// E12 — Redacted capability snapshot exposed to workspace customers.
export interface AiAgentCapabilities {
  /** TRUE platform kill switch — never affected by the workspace plan. */
  ai_agent_enabled: boolean;
  /** TRUE platform customer-visibility switch — never affected by the plan. */
  customer_ai_agent_visible: boolean;

  /** Plan state (independent of platform state). */
  plan_ai_assistant_enabled?: boolean;
  plan_knowledge_base_enabled?: boolean;
  plan_ai_kb_builder_enabled?: boolean;
  plan_name?: string | null;
  plan_slug?: string | null;
  upgrade_required?: boolean;
  entitlement_error?: boolean;

  /** Derived state (platform AND plan). */
  effective_ai_agent_available?: boolean;
  effective_ai_kb_builder_available?: boolean;

  operator_assist_enabled: boolean;
  auto_answer_enabled: boolean;
  learning_enabled: boolean;
  files_enabled: boolean;
  websites_enabled: boolean;
  qna_enabled: boolean;
  kb_enabled: boolean;
  customer_nav: {
    overview: boolean;
    knowledge: boolean;
    behavior: boolean;
    operatorAssist: boolean;
    activity: boolean;
    settings: boolean;
  };
  advanced: {
    debug_visible: boolean;
    regression_visible: boolean;
    source_health_visible: boolean;
    test_harness_visible: boolean;
  };
  disabled_message: string | null;
  max_customer_visible_nav_items?: number;
  platform?: { enabled: boolean; customerVisible: boolean; disabledMessage: string | null };
  plan?: {
    aiAssistantEnabled: boolean;
    knowledgeBaseEnabled: boolean;
    aiKbBuilderEnabled: boolean;
    planName: string | null;
    planSlug: string | null;
  };
  effective?: { aiAgentAvailable: boolean; aiKbBuilderAvailable: boolean };
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
  instructions: {
    tone?: string;
    custom_instructions?: string;
    forbidden_topics?: string[];
    escalation_instructions?: string;
    max_answer_length?: 'short' | 'medium' | 'long';
    // Pass A
    brand_voice?: string;
    business_description?: string;
    do_list?: string[];
    dont_list?: string[];
    handoff_instructions?: string;
    pricing_instructions?: string;
    support_instructions?: string;
    custom_system_instruction?: string;
  };
  ai_intro_enabled?: boolean;
  intro_message?: string | null;
  intro_message_localized?: Record<string, string>;
  handoff_message_localized?: Record<string, string>;
  handoff_prechat_message_localized?: Record<string, string>;
  fallback_behavior?: 'handoff' | 'silent';
  stop_on_handoff?: boolean;
  pause_auto_reply_after_human_reply?: boolean;
  allow_suggestions_after_takeover?: boolean;
  keep_in_automated_until_handoff?: boolean;
  // Phase 4 — answer strategy & learning
  escalation_style?: EscalationStyle;
  allow_clarifying_questions?: boolean;
  max_clarification_attempts?: number;
  allow_answer_with_caveat?: boolean;
  learning_enabled?: boolean;
  auto_create_learning_candidates?: boolean;
  require_approval_for_learning?: boolean;
}


export interface KnowledgeStatus {
  published: number;
  drafts: number;
  by_locale: Record<string, number>;
  qna_count: number;
  has_any: boolean;
}


export interface DiagnosticsResponse {
  ready: boolean;
  checks: {
    ai_provider_configured: boolean;
    has_knowledge: boolean;
    module_enabled: boolean;
    settings_enabled: boolean;
    mode: AgentMode;
  };
  provider: { name: string; model: string } | null;
  knowledge: KnowledgeStatus;
  is_global_admin: boolean;
  role: string | null;
  auto_modes_supported?: boolean;
  intro_enabled?: boolean;
  operator_availability?: {
    status?: 'online' | 'offline' | 'unavailable' | string;
    online_count?: number;
    total_count?: number;
  } | null;
  reply_limits?: {
    per_conversation: number;
    per_hour: number;
    fallback_behavior: 'handoff' | 'silent';
    stop_on_handoff: boolean;
  };
  recent_runs?: Array<{
    id: string;
    run_type?: string;
    status?: string;
    mode?: string;
    created_at?: string;
  }>;
  automated_inbox?: {
    ai_managed: number;
    needs_human: number;
    human_active: number;
    last_handoff_reason: string | null;
    last_human_takeover_at: string | null;
  };
  safety_settings?: {
    pause_auto_reply_after_human_reply: boolean;
    allow_suggestions_after_takeover: boolean;
    keep_in_automated_until_handoff: boolean;
  };
}


export interface OverviewResponse {
  settings: AgentSettings;
  counts: {
    guidanceRules: number;
    routingRules: number;
    topics: number;
    workflows: number;
    messageTriggers: number;
    tools: number;
    qna: number;
    pendingLearningCandidates: number;
    dataSources: number;
    activeChunks: number;
    embeddedChunks: number;
    aiRuns24h: number;
    replies24h: number;
    handoffs24h: number;
    noAnswer24h: number;
    failed24h: number;
    outputLanguageRepairs24h: number;
    triggerExecutions24h?: number;
    workflowPlanned24h?: number;
    routingHandoffs24h?: number;
    routingKeepAi24h?: number;
    toolExecutions24h?: number;
    hardHandoffs24h?: number;
    duplicateTriggersSkipped24h?: number;
    workflowExecuted24h?: number;
    workflowBlocked24h?: number;
    workflowSkipped24h?: number;
    workflowStopAi24h?: number;
    workflowHandoffs24h?: number;
    workflowMessagesSent24h?: number;
    workflowDuplicateSkips24h?: number;
  };
  knowledgeIndex: KnowledgeIndexStatus | null;
  recentRuns: Array<{ id: string; run_type: string | null; status: string | null; mode: string | null; created_at: string; input_text: string | null; output_text: string | null; confidence: number | null }>;
  recentSyncLogs: Array<{ id: string; source_id: string; status: string; message: string | null; pages_found: number; chunks_created: number; embedded_chunks: number; errors: number; created_at: string }>;
  recentRuntimeActions?: Array<Record<string, unknown>>;
  warnings: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string }>;
  runtime: {
    workflowExecutionEnabled: boolean;
    mcpExecutionEnabled: boolean;
    triggerExecutionEnabled?: boolean;
    internalToolExecutionEnabled?: boolean;
    workflowSafeExecutionOnly?: boolean;
  };
}


export const assistantApi = {
  getSettings: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/settings?workspaceId=${workspaceId}`) as Promise<{ settings: AgentSettings }>,
  // E12 — workspace-safe capability snapshot (kill switch + per-feature toggles)
  getCapabilities: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/capabilities?workspaceId=${workspaceId}`) as Promise<{
      capabilities: AiAgentCapabilities;
    }>,
  updateSettings: (workspaceId: string, patch: Partial<AgentSettings>) =>
    jsonFetch(`/api/ai-agent/settings`, { method: 'PUT', body: JSON.stringify({ workspaceId, ...patch }) }) as Promise<{ settings: AgentSettings }>,
  uploadAvatar: async (workspaceId: string, file: File) => {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('read_failed'));
      r.onload = () => {
        const s = String(r.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.readAsDataURL(file);
    });
    return jsonFetch(`/api/ai-agent/settings/avatar`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        filename: file.name,
        mimeType: file.type,
        dataBase64,
      }),
    }) as Promise<{ avatar_url: string }>;
  },
  removeAvatar: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/settings/avatar?workspaceId=${workspaceId}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  getKnowledgeStatus: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/knowledge-status?workspaceId=${workspaceId}`) as Promise<KnowledgeStatus>,
  getDiagnostics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/diagnostics?workspaceId=${workspaceId}`) as Promise<DiagnosticsResponse>,
  generateBusinessDescription: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/generate-business-description`, { method: 'POST', body: JSON.stringify({ workspaceId }) }) as Promise<{ description: string; source: 'ai' | 'stub' }>,
  // ─── Pass B2 — Overview, Test-run, Tools & MCP ───
  getOverview: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/overview?workspaceId=${workspaceId}`) as Promise<OverviewResponse>,
};
