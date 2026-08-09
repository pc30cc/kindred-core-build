/**
 * AI Agent API client — knowledge domain.
 *
 * Mechanically extracted from src/lib/ai-agent-api.ts (Phase 4 split).
 * Q&A, knowledge index, data sources, websites, files, training, learning
 * candidates, customer knowledge summary, and workspace domains. This is
 * AI Agent's own AI-knowledge surface -- separate from the independent
 * Core Knowledge Base client and from AI KB Builder. Same URLs, methods,
 * bodies, and response types as before.
 */
import { jsonFetch } from './client.js';


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


export const knowledgeApi = {
  knowledgeCustomerSummary: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/knowledge/customer-summary?workspaceId=${workspaceId}`) as Promise<{
      items: Array<{ source_type: string; title: string; eligible: boolean; reason: string; updated_at: string | null }>;
    }>,
  // Q&A
  listQna: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/qna?workspaceId=${workspaceId}`) as Promise<{ items: any[] }>,
  createQna: (workspaceId: string, q: { question: string; answer: string; locale?: string; enabled?: boolean }) =>
    jsonFetch(`/api/ai-agent/qna`, { method: 'POST', body: JSON.stringify({ workspaceId, ...q }) }),
  updateQna: (id: string, patch: any) =>
    jsonFetch(`/api/ai-agent/qna/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteQna: (id: string) =>
    jsonFetch(`/api/ai-agent/qna/${id}`, { method: 'DELETE' }),
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
};
