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

export interface OperatorSuggestReplyResponse {
  ok: boolean;
  assist_run_id: string | null;
  suggestion: string | null;
  confidence: number;
  tone: string | null;
  provider: string | null;
  model: string | null;
  selected_sources: Array<{
    id: string;
    source_id: string;
    source_type: string;
    kind: string;
    title: string;
    source_url: string | null;
    locale: string | null;
    final_score: number;
  }>;
  retrieval_debug: any;
  answer_strategy: {
    action: 'answer' | 'handoff' | 'clarification' | 'no_answer';
    decision_type: string;
    reason: string;
    retrieval_strength: string;
    top_score: number;
    handoff_required: boolean;
    source_types_used: string[];
  };
  safety_notes: string[];
  excluded_summary?: Record<string, number>;
  prompt_preview?: { system: string; user: string };
}

export type OperatorAssistFeedbackRating = 'positive' | 'negative' | 'neutral';
export type OperatorAssistFeedbackReason =
  | 'helpful' | 'wrong_answer' | 'missing_context' | 'bad_tone'
  | 'too_long' | 'too_short' | 'unsafe' | 'not_grounded' | 'other';
export type OperatorAssistFeedbackAction =
  | 'inserted' | 'replaced' | 'appended' | 'copied' | 'dismissed'
  | 'regenerated' | 'sent_after_edit' | 'sent_as_is';

export interface OperatorAssistFeedbackInput {
  rating: OperatorAssistFeedbackRating;
  reason?: OperatorAssistFeedbackReason | null;
  comment?: string | null;
  operatorAction?: OperatorAssistFeedbackAction | null;
  finalComposerText?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OperatorAssistAnalytics {
  range: string;
  summary: {
    total_suggestions: number;
    total_feedback: number;
    positive: number;
    negative: number;
    neutral: number;
    acceptance_rate: number;
    negative_rate: number;
    avg_confidence: number;
    no_source_count: number;
    usage_increment_failed_count: number;
  };
  by_reason: Array<{ reason: string; count: number }>;
  by_action: Array<{ action: string; count: number }>;
  by_source_type: Array<{ source_type: string; runs: number }>;
  by_day: Array<{ day: string; suggestions: number; positive: number; negative: number; neutral: number }>;
  worst_runs: Array<{
    run_id: string;
    created_at: string;
    confidence: number | null;
    rating: 'negative';
    reason: string | null;
    source_types: string[];
    safety_notes: string[];
    suggestion_preview: string | null;
  }>;
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
  inspectRun: (id: string) =>
    jsonFetch(`/api/ai-agent/runs/${id}/inspect`) as Promise<any>,
  debugRetrieval: (input: { workspaceId: string; message: string; locale?: string; pageContext?: { currentPageUrl?: string | null; currentPagePath?: string | null; currentPageOrigin?: string | null; currentPageTitle?: string | null } | null }) =>
    jsonFetch(`/api/ai-agent/debug/retrieval`, { method: 'POST', body: JSON.stringify(input) }) as Promise<any>,
  getSourceHealth: (workspaceId: string, opts: { sourceType?: string; eligible?: boolean; query?: string; limit?: number } = {}) => {
    const p = new URLSearchParams({ workspaceId });
    if (opts.sourceType) p.set('sourceType', opts.sourceType);
    if (typeof opts.eligible === 'boolean') p.set('eligible', String(opts.eligible));
    if (opts.query) p.set('query', opts.query);
    if (opts.limit) p.set('limit', String(opts.limit));
    return jsonFetch(`/api/ai-agent/source-health?${p.toString()}`) as Promise<any>;
  },
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
  // Pass E7 — Operator AI Suggest-Reply (read-only, manual)
  suggestReply: (input: {
    workspaceId: string;
    conversationId: string;
    locale?: string;
    tone?: 'friendly' | 'professional' | 'short' | 'detailed';
    instruction?: string;
    callLLM?: boolean;
  }) =>
    jsonFetch(`/api/ai-agent/operator/suggest-reply`, {
      method: 'POST',
      body: JSON.stringify(input),
    }) as Promise<OperatorSuggestReplyResponse>,
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
  rejectLearningCandidateWithReason: (id: string, reason?: string) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}/reject`, {
      method: 'POST', body: JSON.stringify({ reason }),
    }) as Promise<{ ok: boolean }>,
  generateLearningCandidates: (workspaceId: string, opts?: { sinceIso?: string; limit?: number }) =>
    jsonFetch(`/api/ai-agent/learning-candidates/generate`, {
      method: 'POST', body: JSON.stringify({ workspaceId, ...(opts || {}) }),
    }) as Promise<{ scanned: number; created: number; skipped: number; reasons: Record<string, number> }>,
  patchLearningCandidate: (id: string, patch: { question_text?: string; suggested_answer?: string; locale?: string; suggested_title?: string }) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }) as Promise<{ item: LearningCandidate }>,
  approveLearningCandidateAsLearned: (id: string, body: { final_answer: string; question?: string; locale?: string }) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}/approve`, {
      method: 'POST', body: JSON.stringify(body),
    }) as Promise<{ ok: boolean; candidate_id: string }>,
  convertLearningCandidateToQna: (id: string, patch: { question?: string; answer?: string; locale?: string } = {}) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}/convert-to-qna`, {
      method: 'POST', body: JSON.stringify(patch),
    }) as Promise<{ ok: boolean; qna_id: string }>,
  convertLearningCandidateToKbV2: (id: string, body: { title?: string; answer?: string; locale?: string; publish?: boolean } = {}) =>
    jsonFetch(`/api/ai-agent/learning-candidates/${id}/convert-to-kb`, {
      method: 'POST', body: JSON.stringify(body),
    }) as Promise<{ ok: boolean; article_id: string; published: boolean }>,
  bulkCreateQna: (workspaceId: string, items: Array<{ question: string; answer: string; locale?: string; enabled?: boolean }>) =>
    jsonFetch(`/api/ai-agent/qna/bulk`, {
      method: 'POST', body: JSON.stringify({ workspaceId, items }),
    }) as Promise<{ created: number; skipped: number; errors: number; details: any }>,
  reindexQna: (id: string) =>
    jsonFetch(`/api/ai-agent/qna/${id}/reindex`, { method: 'POST' }) as Promise<{ ok: boolean }>,
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
    jsonFetch(`/api/ai-agent/data-sources/${id}/sync`, { method: 'POST' }) as Promise<{ ok: boolean; jobId: string; status: string; bypass?: boolean }>,
  retryFailedSourceJob: (id: string) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}/retry-failed-job`, { method: 'POST' }) as Promise<{ ok: boolean; jobId: string; status: string; retried?: boolean; reused?: boolean; bypass?: boolean }>,
  getDataSourceLogs: (id: string) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}/logs`) as Promise<{ items: SourceSyncLog[] }>,
  getDataSourcePages: (id: string) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}/pages`) as Promise<{ items: Array<{ id: string; url: string; status: string; http_status: number | null; title: string | null; locale: string | null; text_length: number; content_hash: string | null; chunks_created: number; embedding_status: string | null; warning: string | null; last_seen_at: string }> }>,
  getDataSourceJobs: (id: string) =>
    jsonFetch(`/api/ai-agent/data-sources/${id}/jobs`) as Promise<{ items: Array<{ id: string; status: string; attempts: number; locked_by: string | null; started_at: string | null; finished_at: string | null; last_error: string | null; metadata: Record<string, unknown>; created_at: string }>; worker: { workerId: string; inProcess: boolean; pollIntervalMs: number; lockTtlSeconds: number; started: boolean } }>,
  cancelSourceJob: (jobId: string) =>
    jsonFetch(`/api/ai-agent/data-sources/jobs/${jobId}/cancel`, { method: 'POST' }) as Promise<{ ok: boolean }>,
  getDataSourceLimits: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/data-sources/limits?workspaceId=${workspaceId}`) as Promise<{ planSlug: string | null; planName: string | null; limits: { ai_kb_max_pages: number; ai_kb_max_depth: number; ai_kb_jobs_per_month: number; ai_kb_file_count: number; ai_kb_file_size_mb: number }; jobs_used_this_month: number; bypass?: boolean; bypassReason?: string | null; worker: { workerId: string; inProcess: boolean; started: boolean } }>,
  // Pass E4-A — AI Agent Files
  listAiFiles: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/files?workspaceId=${workspaceId}`) as Promise<{ items: DataSource[] }>,
  getAiFileLimits: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/files/limits?workspaceId=${workspaceId}`) as Promise<{
      maxFiles: number;
      maxFileSizeMB: number;
      effectiveMaxFileSizeMB: number;
      storageProvider: string | null;
      storageReady: boolean;
      storageError: string | null;
      transport: 'json_base64';
      transportMaxFileSizeMB: number;
      used: number;
      bypass: boolean;
      supported_mimes: string[];
      hard_cap_mb: number;
    }>,
  uploadAiFile: async (workspaceId: string, file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    // Chunked base64 to avoid call-stack overflow on large files.
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)) as any);
    }
    const dataBase64 = btoa(bin);
    return jsonFetch(`/api/ai-agent/files/upload`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        dataBase64,
      }),
    }) as Promise<{ ok: boolean; source: DataSource; jobId: string; status: 'queued' }>;
  },
  reindexAiFile: (id: string) =>
    jsonFetch(`/api/ai-agent/files/${id}/reindex`, { method: 'POST' }) as Promise<{ ok: boolean; source: DataSource; jobId: string; status: 'queued' }>,
  deleteAiFile: (id: string) =>
    jsonFetch(`/api/ai-agent/files/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean; chunks_deleted: number; storage_deleted: boolean; storage_error?: string }>,
  pauseAiFile: (id: string) =>
    jsonFetch(`/api/ai-agent/files/${id}/pause`, { method: 'POST' }) as Promise<{ ok: boolean }>,
  resumeAiFile: (id: string) =>
    jsonFetch(`/api/ai-agent/files/${id}/resume`, { method: 'POST' }) as Promise<{ ok: boolean; source: DataSource; jobId: string; status: 'queued' }>,
  getAiFilePreview: (id: string) =>
    jsonFetch(`/api/ai-agent/files/${id}/preview`) as Promise<{
      source_id: string; file_name: string; status: string; job_status: string | null;
      parser: string | null; page_count: number | null; text_length: number | null;
      text_preview: string;
      chunks_preview: Array<{ index: number; content: string; status: string }>;
      warnings: string[]; last_error: string | null; last_warning: string | null;
    }>,
  getAiFileLogs: (id: string) =>
    jsonFetch(`/api/ai-agent/files/${id}/logs`) as Promise<{
      items: Array<{ id: string; status: string; message: string | null; pages_found: number; chunks_created: number; embedded_chunks: number; errors: number; metadata: Record<string, unknown>; created_at: string }>;
      jobs: Array<{ id: string; status: string; attempts: number; started_at: string | null; finished_at: string | null; last_error: string | null; created_at: string; job_type: string }>;
    }>,
  getWorkspaceDomains: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/workspace-domain?workspaceId=${workspaceId}`) as Promise<{ domains: Array<{ domain: string; is_primary: boolean; verified: boolean }> }>,
  // Pass B1 — Topics
  listTopics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/topics?workspaceId=${workspaceId}`) as Promise<{ items: TopicRecord[] }>,
  createTopic: (input: Partial<TopicRecord> & { workspaceId: string; name: string }) =>
    jsonFetch(`/api/ai-agent/topics`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: TopicRecord }>,
  updateTopic: (id: string, patch: Partial<TopicRecord>) =>
    jsonFetch(`/api/ai-agent/topics/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: TopicRecord }>,
  deleteTopic: (id: string) =>
    jsonFetch(`/api/ai-agent/topics/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  seedDefaultTopics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/topics/seed-defaults`, { method: 'POST', body: JSON.stringify({ workspaceId }) }) as Promise<{ ok: boolean; created: number }>,
  testTopics: (input: { workspaceId: string; text: string; language?: string }) =>
    jsonFetch(`/api/ai-agent/topics/test`, { method: 'POST', body: JSON.stringify(input) }) as Promise<TopicDetectionResult>,
  // Pass B1 — Workflows
  listWorkflows: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/workflows?workspaceId=${workspaceId}`) as Promise<{ items: WorkflowRecord[] }>,
  createWorkflow: (input: Partial<WorkflowRecord> & { workspaceId: string; name: string }) =>
    jsonFetch(`/api/ai-agent/workflows`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: WorkflowRecord }>,
  updateWorkflow: (id: string, patch: Partial<WorkflowRecord>) =>
    jsonFetch(`/api/ai-agent/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: WorkflowRecord }>,
  deleteWorkflow: (id: string) =>
    jsonFetch(`/api/ai-agent/workflows/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  duplicateWorkflow: (id: string) =>
    jsonFetch(`/api/ai-agent/workflows/${id}/duplicate`, { method: 'POST' }) as Promise<{ item: WorkflowRecord }>,
  validateWorkflow: (id: string) =>
    jsonFetch(`/api/ai-agent/workflows/${id}/validate`, { method: 'POST' }) as Promise<{ valid: boolean; errors: string[] }>,
  previewWorkflow: (input: { workspaceId: string; workflowDraft: any; sampleMessage?: string; sampleContext?: any }) =>
    jsonFetch(`/api/ai-agent/workflows/preview`, { method: 'POST', body: JSON.stringify(input) }) as Promise<WorkflowPreviewResult>,
  getWorkflowMeta: () =>
    jsonFetch(`/api/ai-agent/workflows/_meta`) as Promise<{ triggers: string[]; conditions: string[]; actions: string[] }>,
  // Pass B1 — Message triggers
  listMessageTriggers: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/message-triggers?workspaceId=${workspaceId}`) as Promise<{ items: MessageTriggerRecord[] }>,
  createMessageTrigger: (input: Partial<MessageTriggerRecord> & { workspaceId: string; name: string; event_type: MessageTriggerRecord['event_type']; action_type: MessageTriggerRecord['action_type'] }) =>
    jsonFetch(`/api/ai-agent/message-triggers`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: MessageTriggerRecord }>,
  updateMessageTrigger: (id: string, patch: Partial<MessageTriggerRecord>) =>
    jsonFetch(`/api/ai-agent/message-triggers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: MessageTriggerRecord }>,
  deleteMessageTrigger: (id: string) =>
    jsonFetch(`/api/ai-agent/message-triggers/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  testMessageTrigger: (id: string) =>
    jsonFetch(`/api/ai-agent/message-triggers/${id}/test`, { method: 'POST' }) as Promise<{ ok: boolean; dryRun: boolean; runtimeExecutionEnabled: boolean; planned: any; note: string }>,
  // ─── Pass B2 — Overview, Test-run, Tools & MCP ───
  getOverview: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/overview?workspaceId=${workspaceId}`) as Promise<OverviewResponse>,
  testRun: (input: { workspaceId: string; message: string; pageUrl?: string; visitorLocale?: string }) =>
    jsonFetch(`/api/ai-agent/test-run`, { method: 'POST', body: JSON.stringify({ ...input, dryRun: true }) }) as Promise<TestRunResult>,
  listTools: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/tools?workspaceId=${workspaceId}`) as Promise<{ items: ToolRecord[]; defaultInternalTools: Array<{ name: string; description: string; risk_level: ToolRiskLevel }>; runtimeExecutionEnabled: boolean }>,
  createTool: (input: Partial<ToolRecord> & { workspaceId: string; name: string; tool_type: ToolRecord['tool_type'] }) =>
    jsonFetch(`/api/ai-agent/tools`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: ToolRecord }>,
  updateTool: (id: string, patch: Partial<ToolRecord> & { confirm_high_risk?: boolean }) =>
    jsonFetch(`/api/ai-agent/tools/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: ToolRecord }>,
  deleteTool: (id: string) =>
    jsonFetch(`/api/ai-agent/tools/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  listToolServers: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/tool-servers?workspaceId=${workspaceId}`) as Promise<{ items: ToolServerRecord[]; runtimeExecutionEnabled: boolean }>,
  createToolServer: (input: Partial<ToolServerRecord> & { workspaceId: string; name: string; server_type: ToolServerRecord['server_type'] }) =>
    jsonFetch(`/api/ai-agent/tool-servers`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: ToolServerRecord }>,
  updateToolServer: (id: string, patch: Partial<ToolServerRecord>) =>
    jsonFetch(`/api/ai-agent/tool-servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: ToolServerRecord }>,
  deleteToolServer: (id: string) =>
    jsonFetch(`/api/ai-agent/tool-servers/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  testToolServer: (id: string) =>
    jsonFetch(`/api/ai-agent/tool-servers/${id}/test`, { method: 'POST' }) as Promise<{ ok: boolean; runtimeExecutionEnabled: boolean; validations: Array<{ key: string; ok: boolean; message?: string }>; message: string }>,
  // ─── Pass E1 — Train / Data Hub ───
  getTrainOverview: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/train/overview?workspaceId=${workspaceId}`) as Promise<TrainOverviewResponse>,
  listKnowledgeChunks: (workspaceId: string, opts: { sourceType?: string; status?: string; query?: string; limit?: number } = {}) => {
    const p = new URLSearchParams({ workspaceId });
    if (opts.sourceType) p.set('sourceType', opts.sourceType);
    if (opts.status) p.set('status', opts.status);
    if (opts.query) p.set('query', opts.query);
    if (opts.limit) p.set('limit', String(opts.limit));
    return jsonFetch(`/api/ai-agent/knowledge-index/chunks?${p.toString()}`) as Promise<{ items: ChunkDebugRow[]; total: number }>;
  },
  rebuildKnowledgeSource: (workspaceId: string, sourceType: 'kb_article' | 'qna' | 'business_profile', sourceId: string) =>
    jsonFetch(`/api/ai-agent/knowledge-index/rebuild-source`, { method: 'POST', body: JSON.stringify({ workspaceId, sourceType, sourceId }) }) as Promise<{ ok: boolean; reason?: string }>,
  // ─── E6 — Test Harness ───
  listTestCases: (workspaceId: string, opts: { enabled?: boolean; expected_behavior?: string; expected_source_type?: string; query?: string } = {}) => {
    const p = new URLSearchParams({ workspaceId });
    if (typeof opts.enabled === 'boolean') p.set('enabled', String(opts.enabled));
    if (opts.expected_behavior) p.set('expected_behavior', opts.expected_behavior);
    if (opts.expected_source_type) p.set('expected_source_type', opts.expected_source_type);
    if (opts.query) p.set('query', opts.query);
    return jsonFetch(`/api/ai-agent/test-cases?${p.toString()}`) as Promise<{ items: TestCase[] }>;
  },
  createTestCase: (workspaceId: string, payload: Partial<TestCase>) =>
    jsonFetch(`/api/ai-agent/test-cases`, { method: 'POST', body: JSON.stringify({ workspaceId, ...payload }) }) as Promise<{ item: TestCase }>,
  updateTestCase: (id: string, patch: Partial<TestCase>) =>
    jsonFetch(`/api/ai-agent/test-cases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: TestCase }>,
  deleteTestCase: (id: string) =>
    jsonFetch(`/api/ai-agent/test-cases/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  runTestCase: (id: string) =>
    jsonFetch(`/api/ai-agent/test-cases/${id}/run`, { method: 'POST' }) as Promise<{ run: TestRun; result: any; evaluation: { passed: boolean; failure_reasons: string[] } }>,
  runBulkTests: (workspaceId: string, ids?: string[]) =>
    jsonFetch(`/api/ai-agent/test-cases/run-bulk`, { method: 'POST', body: JSON.stringify({ workspaceId, ids }) }) as Promise<BulkRunResponse>,
  seedRecommendedTests: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/test-cases/seed-recommended`, { method: 'POST', body: JSON.stringify({ workspaceId }) }) as Promise<{ inserted: number; skipped: number; created: Array<{ name: string; expected_source_type: string | null; expected_source_id: string | null }>; skipped_reasons: string[] }>,
  listTestRuns: (workspaceId: string, opts: { testCaseId?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams({ workspaceId });
    if (opts.testCaseId) p.set('testCaseId', opts.testCaseId);
    if (opts.status) p.set('status', opts.status);
    if (opts.limit) p.set('limit', String(opts.limit));
    return jsonFetch(`/api/ai-agent/test-runs?${p.toString()}`) as Promise<{ items: TestRun[] }>;
  },
  getTestRun: (id: string) =>
    jsonFetch(`/api/ai-agent/test-runs/${id}`) as Promise<{ item: TestRun; test_case: TestCase | null }>,
  getTestSummary: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/test-summary?workspaceId=${workspaceId}`) as Promise<TestSummary>,
  debugRunTest: (input: { workspaceId: string; message: string; locale?: string; pageContext?: any; callLLM?: boolean }) =>
    jsonFetch(`/api/ai-agent/debug/run-test`, { method: 'POST', body: JSON.stringify(input) }) as Promise<any>,
};

export interface TrainSourceTypeBreakdown {
  source_type: string;
  total: number;
  active: number;
  paused: number;
  failed: number;
  syncing: number;
  last_synced_at: string | null;
}
export interface TrainWarning {
  code: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
  source_type?: string;
  source_id?: string;
}
export interface TrainOverviewResponse {
  counts: {
    totalSources: number; activeSources: number; pausedSources: number;
    failedSources: number; syncingSources: number;
    qnaEnabled: number; qnaDisabled: number;
    kbPublished: number; kbDraft: number;
    learningPending: number; learningApproved: number; learningRejected: number;
    learningConvertedQna: number; learningConvertedKb: number;
    activeChunks: number; embeddedChunks: number;
    failedEmbeddings: number; deletedChunks: number;
  };
  sourcesByType: TrainSourceTypeBreakdown[];
  knowledgeIndex: KnowledgeIndexStatus | null;
  recentSyncLogs: Array<Record<string, unknown>>;
  recentJobs: Array<Record<string, unknown>>;
  warnings: TrainWarning[];
  lastSyncAt: string | null;
  lastRebuildAt: string | null;
  retrievalContract: { allowed: string[]; blocked: string[] };
}
export interface ChunkDebugRow {
  id: string; source_type: string; source_id: string;
  title: string | null; source_url: string | null; locale: string | null;
  status: string; has_embedding: boolean;
  content_preview: string; updated_at: string;
}

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

// ─── Pass B1 types ───
export type TopicAction = 'label_only' | 'route' | 'trigger_workflow' | 'suggest_reply';
export interface TopicRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  slug: string;
  keywords: string[];
  examples: string[];
  language: string | null;
  confidence_threshold: number;
  action: TopicAction;
  action_json: Record<string, unknown>;
  enabled: boolean;
  system: boolean;
  created_at: string;
  updated_at: string;
}
export interface DetectedTopic {
  id: string; name: string; slug: string; confidence: number;
  matchedKeywords: string[]; matchedExamples: string[];
  action: TopicAction; actionJson: Record<string, unknown>;
}
export interface TopicDetectionResult {
  detectedTopics: DetectedTopic[];
  language: string;
  explanation: string;
}
export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export interface WorkflowRecord {
  id: string; workspace_id: string; name: string;
  description: string | null;
  trigger_json: Record<string, any>;
  steps_json: Array<Record<string, any>>;
  enabled: boolean; version: number; status: WorkflowStatus;
  created_at: string; updated_at: string;
}
export interface WorkflowPreviewResult {
  valid: boolean;
  errors: string[];
  wouldTrigger: boolean;
  matchedConditions: string[];
  plannedActions: Array<{ type: string; details: Record<string, unknown> }>;
}
export type MessageTriggerEvent =
  | 'visitor_first_message' | 'conversation_started' | 'after_prechat'
  | 'no_operator_online' | 'ai_no_answer' | 'topic_detected'
  | 'human_requested' | 'business_hours_closed';
export type MessageTriggerAction =
  | 'send_message' | 'start_workflow' | 'handoff' | 'assign' | 'tag' | 'internal_note';
export interface MessageTriggerRecord {
  id: string; workspace_id: string; name: string;
  description: string | null;
  event_type: MessageTriggerEvent;
  conditions_json: Record<string, any>;
  action_type: MessageTriggerAction;
  action_json: Record<string, any>;
  delay_seconds: number;
  enabled: boolean;
  created_at: string; updated_at: string;
}

// ─── Pass B2 types ───
export type ToolType = 'internal' | 'mcp' | 'webhook' | 'crm' | 'ticket';
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export interface ToolRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  tool_type: ToolType;
  provider: string | null;
  server_id: string | null;
  config_json: Record<string, any>;
  enabled: boolean;
  permissions_json: Record<string, any>;
  risk_level: ToolRiskLevel;
  created_at: string;
  updated_at: string;
}

export type ToolServerType = 'mcp' | 'internal' | 'webhook';
export type ToolServerStatus = 'disabled' | 'enabled' | 'error';
export type ToolServerAuth = 'none' | 'bearer' | 'basic' | 'api_key' | 'oauth';
export interface ToolServerRecord {
  id: string;
  workspace_id: string;
  name: string;
  server_type: ToolServerType;
  endpoint_url: string | null;
  status: ToolServerStatus;
  auth_type: ToolServerAuth;
  hasConfig?: boolean;
  allowed_tools: string[];
  permissions_json: Record<string, any>;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
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

export interface TestRunResult {
  language: { detected: string; confidence: number; mixed?: boolean };
  topics: {
    detectedTopics: Array<{ id?: string; name: string; slug: string; confidence: number; matchedKeywords?: string[]; matchedExamples?: string[]; action?: string }>;
    language?: string;
    explanation?: string;
  };
  guidanceRulesApplied?: Array<{ id: string; title: string; type: string }>;
  retrieval: { query: string; sourceCount: number };
  selectedSources: Array<{ id: string; kind: string; title: string; slug: string | null; locale: string | null; score: number }>;
  routingRulesMatched: Array<{ id: string; name: string; trigger_type?: string; action_type?: string }>;
  routing?: {
    matchedRuleIds: string[];
    matchedRuleNames: string[];
    executedActions: any[];
    plannedActions: any[];
    skippedActions: any[];
  };
  messageTriggers?: {
    matched: Array<{ id: string; name: string }>;
    executed: any[];
    planned: any[];
    skipped: any[];
  };
  workflows?: {
    matchedWorkflowIds: string[];
    matchedWorkflowNames: string[];
    wouldExecuteActions?: any[];
    executedActions?: any[];
    blockedActions?: any[];
    plannedActions: any[];
    skippedActions: any[];
    stopAiWouldBe?: boolean;
    runtimeExecutionEnabled: boolean;
    safeExecutionOnly?: boolean;
    dryRun?: boolean;
  };
  tools?: {
    allowedTools: string[];
    usedTools: string[];
    plannedTools: string[];
    skippedTools: string[];
  };
  workflowMatches: Array<{ id: string; name: string; status: string }>;
  messageTriggersMatched: Array<{ id: string; name: string; event_type?: string; action_type?: string }>;
  decisionTimeline?: string[];
  plannedActions?: any[];
  executedActionsDryRun?: any[];
  finalAction?: string;
  answerStrategy: { action: string; reason: string | null; confidence: number };
  finalAnswer: string | null;
  runtime: { conversationCreated: boolean; workflowExecutionEnabled: boolean; mcpExecutionEnabled: boolean };
  warnings: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string }>;
}
// ─── E6 — Test Harness ───
export interface TestCase {
  id: string;
  workspace_id: string;
  name: string;
  input_message: string;
  locale: string | null;
  page_context: any;
  expected_behavior: 'answer' | 'no_answer' | 'handoff' | 'clarification';
  expected_source_type: string | null;
  expected_source_url: string | null;
  expected_source_id: string | null;
  expected_contains: string[];
  expected_not_contains: string[];
  min_confidence: number | null;
  enabled: boolean;
  metadata: any;
  created_at: string;
  updated_at: string;
}
export interface TestRun {
  id: string;
  workspace_id: string;
  test_case_id: string | null;
  ai_agent_run_id?: string | null;
  status: 'passed' | 'failed' | 'errored';
  input_message: string;
  actual_output: string | null;
  actual_status: string | null;
  confidence: number | null;
  selected_sources: any[];
  retrieval_debug: any;
  answer_strategy: TestAnswerStrategy | null;
  failure_reasons: string[];
  metadata: TestRunMetadata;
  created_at: string;
}
export interface TestAnswerStrategy {
  action?: string;
  decision_type?: string;
  reason?: string;
  retrieval_strength?: string;
  top_score?: number;
  handoff_required?: boolean;
  source_types_used?: string[];
}
export interface TestRunRuntime {
  conversation_created: boolean;
  handoff_created: boolean;
  workflow_executed: boolean;
  learning_candidate_created: boolean;
  llm_called: boolean;
  ai_usage_logged: boolean | 'unknown';
}
export interface TestRunRuntimeParity {
  retrieval: string;
  query_expansion: string;
  conversation_history: string;
  workflow_execution: string;
  handoff_execution: string;
  learning_generation: string;
}
export interface TestRunMetadata {
  provider?: string | null;
  model?: string | null;
  safety_notes?: string[];
  runtime?: TestRunRuntime;
  runtime_parity?: TestRunRuntimeParity;
  excluded_summary?: Record<string, number> | null;
  page_context?: any;
  [k: string]: any;
}
export interface BulkRunResponse {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  capped: boolean;
  max: number;
  total_enabled: number | null;
  runs: Array<{ test_case_id: string; name: string; status: string; failure_reasons: string[] }>;
}
export interface TestSummary {
  total_cases: number;
  enabled_cases: number;
  last_24h_runs: number;
  last_24h_passed: number;
  last_24h_failed: number;
  last_24h_errored: number;
  pass_rate: number | null;
  failures_by_reason: Record<string, number>;
  coverage_by_source_type: Record<string, number>;
}
