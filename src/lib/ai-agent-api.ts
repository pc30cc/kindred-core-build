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
};

export interface AgentSuggestionSource {
  id: string;
  title: string;
  slug: string | null;
  locale: string | null;
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