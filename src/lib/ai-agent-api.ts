/**
 * AI Agent — operator-side API client.
 * All work routes through the project's own Express backend.
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request_failed_${res.status}`);
  return data;
}

export type AgentMode = 'off' | 'suggest_only' | 'auto_reply_when_offline' | 'auto_reply_until_human_joins' | 'auto_reply_always';
export type AnswerGuidance = 'conservative' | 'balanced' | 'creative';
export type EscalationStyle = 'conservative' | 'balanced' | 'helpful_first';

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
  };
  ai_intro_enabled?: boolean;
  intro_message?: string | null;
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

export interface PlaygroundResult {
  action: 'answer' | 'handoff' | 'no_answer' | 'blocked';
  answer: string | null;
  retrievedArticles: Array<{ id: string; kind: 'qna' | 'kb_article'; title: string; slug: string | null; locale: string | null; score: number }>;
  confidence: number;
  provider: string | null;
  model: string | null;
  creditsUsed: number;
  runId: string | null;
  fallbackMessage: string;
  debug: Record<string, unknown>;
}

export const aiAgentApi = {
  getSettings: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/settings?workspaceId=${workspaceId}`) as Promise<{ settings: AgentSettings }>,
  updateSettings: (workspaceId: string, patch: Partial<AgentSettings>) =>
    jsonFetch(`/api/ai-agent/settings`, { method: 'PUT', body: JSON.stringify({ workspaceId, ...patch }) }) as Promise<{ settings: AgentSettings }>,
  getKnowledgeStatus: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/knowledge-status?workspaceId=${workspaceId}`) as Promise<KnowledgeStatus>,
  getDiagnostics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/diagnostics?workspaceId=${workspaceId}`) as Promise<DiagnosticsResponse>,
  playground: (input: { workspaceId: string; question: string; locale?: string; guidanceOverride?: AnswerGuidance; modelOverride?: string }) =>
    jsonFetch(`/api/ai-agent/playground/test`, { method: 'POST', body: JSON.stringify(input) }) as Promise<PlaygroundResult>,
  getRuns: (workspaceId: string, limit = 50) =>
    jsonFetch(`/api/ai-agent/runs?workspaceId=${workspaceId}&limit=${limit}`) as Promise<{ runs: any[] }>,
  getAnalytics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/analytics?workspaceId=${workspaceId}`) as Promise<any>,
  generateBusinessDescription: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/generate-business-description`, { method: 'POST', body: JSON.stringify({ workspaceId }) }) as Promise<{ description: string; source: 'ai' | 'stub' }>,
  // Q&A
  listQna: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/qna?workspaceId=${workspaceId}`) as Promise<{ items: any[] }>,
  createQna: (workspaceId: string, q: { question: string; answer: string; locale?: string; enabled?: boolean }) =>
    jsonFetch(`/api/ai-agent/qna`, { method: 'POST', body: JSON.stringify({ workspaceId, ...q }) }),
  updateQna: (id: string, patch: any) =>
    jsonFetch(`/api/ai-agent/qna/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteQna: (id: string) =>
    jsonFetch(`/api/ai-agent/qna/${id}`, { method: 'DELETE' }),
  // Conversation suggestions (Phase 2 operator-facing UI)
  listConversationSuggestions: (conversationId: string, status: 'pending' | 'all' = 'pending') =>
    jsonFetch(`/api/ai-agent/conversations/${conversationId}/suggestions?status=${status}`) as Promise<{ items: AgentSuggestion[] }>,
  useSuggestion: (id: string) =>
    jsonFetch(`/api/ai-agent/suggestions/${id}/use`, { method: 'POST' }) as Promise<{ ok: boolean; suggestion: AgentSuggestion }>,
  dismissSuggestion: (id: string) =>
    jsonFetch(`/api/ai-agent/suggestions/${id}/dismiss`, { method: 'POST' }) as Promise<{ ok: boolean; suggestion: AgentSuggestion }>,
  takeOverConversation: (workspaceId: string, conversationId: string, assignToMe = true) =>
    jsonFetch(`/api/ai-agent/conversations/${conversationId}/take-over`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId, assign_to_me: assignToMe }),
    }) as Promise<{ ok: boolean }>,
  // Pass 2 — knowledge index
  getKnowledgeIndexStatus: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/knowledge-index/status?workspaceId=${workspaceId}`) as Promise<KnowledgeIndexStatus>,
  rebuildKnowledgeIndex: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/knowledge-index/rebuild`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }) as Promise<KnowledgeIndexRebuildResult>,
  syncKnowledgeSource: (workspaceId: string, sourceType: 'kb_article' | 'qna' | 'business_profile', sourceId: string) =>
    jsonFetch(`/api/ai-agent/knowledge-index/sync-source`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId, sourceType, sourceId }),
    }) as Promise<{ ok: boolean }>,
  // Pass 3 — learning candidates
  listLearningCandidates: (workspaceId: string, status: 'pending' | 'all' | 'rejected' | 'converted_to_qna' | 'converted_to_kb' = 'pending') =>
    jsonFetch(`/api/ai-agent/learning-candidates?workspaceId=${workspaceId}&status=${status}`) as Promise<{ items: LearningCandidate[] }>,
  approveLearningCandidateAsQna: (id: string, patch: { question?: string; answer?: string; locale?: string } = {}) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}/approve-qna`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }) as Promise<{ ok: boolean; qna_id: string }>,
  convertLearningCandidateToKb: (id: string, patch: { title?: string; answer?: string; locale?: string } = {}) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}/convert-kb`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }) as Promise<{ ok: boolean; article_id: string }>,
  rejectLearningCandidate: (id: string) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}/reject`, { method: 'POST' }) as Promise<{ ok: boolean }>,
  getLearningCandidateStats: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/learning-candidates/stats?workspaceId=${workspaceId}`) as Promise<{
      pending: number; approved: number; converted_to_qna: number; converted_to_kb: number; rejected: number;
    }>,
  // Pass A — Guidance
  listGuidance: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/guidance?workspaceId=${workspaceId}`) as Promise<{ items: GuidanceRule[] }>,
  createGuidance: (input: Partial<GuidanceRule> & { workspaceId: string; title: string; rule_type: GuidanceRule['rule_type'] }) =>
    jsonFetch(`/api/ai-agent/guidance`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: GuidanceRule }>,
  updateGuidance: (id: string, patch: Partial<GuidanceRule>) =>
    jsonFetch(`/api/ai-agent/guidance/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: GuidanceRule }>,
  deleteGuidance: (id: string) =>
    jsonFetch(`/api/ai-agent/guidance/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  // Pass A — Routing
  listRouting: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/routing?workspaceId=${workspaceId}`) as Promise<{ items: RoutingRule[] }>,
  createRouting: (input: Partial<RoutingRule> & { workspaceId: string; name: string; trigger_type: RoutingRule['trigger_type']; action_type: RoutingRule['action_type'] }) =>
    jsonFetch(`/api/ai-agent/routing`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: RoutingRule }>,
  updateRouting: (id: string, patch: Partial<RoutingRule>) =>
    jsonFetch(`/api/ai-agent/routing/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: RoutingRule }>,
  deleteRouting: (id: string) =>
    jsonFetch(`/api/ai-agent/routing/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  // Pass A — Data sources
  listDataSources: (workspaceId: string, sourceType?: string) =>
    jsonFetch(`/api/ai-agent/data-sources?workspaceId=${workspaceId}${sourceType ? `&sourceType=${sourceType}` : ''}`) as Promise<{ items: DataSource[] }>,
  createWebsiteSource: (input: { workspaceId: string; base_url?: string; name?: string; crawl_depth?: number; max_pages?: number; refresh_interval?: 'manual'|'daily'|'weekly'|'monthly'; include_rules?: string[]; exclude_rules?: string[] }) =>
    jsonFetch(`/api/ai-agent/data-sources/website`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: DataSource; registeredDomain: string | null }>,
  updateDataSource: (id: string, patch: Partial<DataSource>) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: DataSource }>,
  deleteDataSource: (id: string) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  syncDataSource: (id: string) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}/sync`, { method: 'POST' }) as Promise<{ ok: boolean }>,
  getDataSourceLogs: (id: string) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}/logs`) as Promise<{ items: SourceSyncLog[] }>,
  getWorkspaceDomains: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/workspace-domain?workspaceId=${workspaceId}`) as Promise<{ domains: Array<{ domain: string; is_primary: boolean; verified: boolean }> }>,
};

export type GuidanceRuleType =
  | 'tone' | 'answer_policy' | 'escalation_policy' | 'restricted_topic'
  | 'fallback_behavior' | 'sales_guidance' | 'support_guidance' | 'pricing_guidance';

export interface GuidanceRule {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  rule_type: GuidanceRuleType;
  condition_json: Record<string, unknown>;
  instruction: string;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type RoutingTrigger =
  | 'human_request' | 'no_answer' | 'low_confidence' | 'topic_detected'
  | 'business_hours' | 'language' | 'vip_customer' | 'plan_limit';
export type RoutingAction =
  | 'handoff' | 'assign_team' | 'assign_operator' | 'keep_ai' | 'create_ticket' | 'mark_priority';

export interface RoutingRule {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  trigger_type: RoutingTrigger;
  conditions_json: Record<string, unknown>;
  action_type: RoutingAction;
  action_json: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface DataSource {
  id: string;
  workspace_id: string;
  source_type: 'website' | 'kb' | 'qna' | 'file' | 'business_profile' | 'snippet';
  name: string;
  base_url: string | null;
  status: 'active' | 'paused' | 'syncing' | 'failed' | 'deleted';
  include_rules: string[];
  exclude_rules: string[];
  crawl_depth: number;
  max_pages: number;
  refresh_interval: 'manual' | 'daily' | 'weekly' | 'monthly';
  last_synced_at: string | null;
  next_sync_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SourceSyncLog {
  id: string;
  workspace_id: string;
  source_id: string;
  status: string;
  message: string | null;
  pages_found: number;
  chunks_created: number;
  embedded_chunks: number;
  errors: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface LearningCandidate {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  visitor_message_id: string | null;
  operator_message_id: string | null;
  question_text: string;
  answer_text: string;
  normalized_question: string;
  source_type: string;
  locale: string | null;
  confidence_score: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'converted_to_qna' | 'converted_to_kb';
  suggested_title: string | null;
  suggested_answer: string | null;
  suggested_tags: string[];
  reviewed_by: string | null;
  reviewed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AgentSuggestionSource {
  id: string;
  title: string;
  slug: string | null;
  locale: string | null;
}

export interface KnowledgeIndexStatus {
  activeChunks: number;
  embeddedChunks: number;
  staleChunks: number;
  deletedChunks: number;
  bySourceType: Record<string, number>;
  byLocale: Record<string, number>;
  lastUpdated: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingProviderAvailable: boolean;
}

export interface KnowledgeIndexRebuildResult {
  ok: boolean;
  chunksCreated: number;
  chunksUpdated: number;
  chunksSkipped: number;
  chunksDeleted: number;
  embeddingsGenerated: number;
  embeddingFailures: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBudget: number;
  embeddingBudgetUsed: number;
  sourcesProcessed: number;
}

export interface AgentSuggestion {
  id: string;
  conversation_id: string;
  visitor_message_id: string | null;
  suggested_reply: string;
  source_article_ids: string[];
  confidence: number | null;
  status: 'pending' | 'used' | 'dismissed' | 'expired';
  created_at: string;
  updated_at: string;
  sources?: AgentSuggestionSource[];
}