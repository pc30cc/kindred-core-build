/**
 * AI Agent API client — internal QA domain.
 *
 * Mechanically extracted from src/lib/ai-agent-api.ts (Phase 4 split).
 * Playground, customer-safe test-ai, retrieval debug, source health, test
 * cases, test runs, suggested tests, and regression schedules/batches.
 * Backend enforcement (AdvancedAiAgentGuard-equivalent) is unchanged by
 * this split. Same URLs, methods, bodies, and response types as before.
 */
import { jsonFetch, API_BASE } from './client.js';
import type { AnswerGuidance } from './assistant.js';


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


// ─── E9 — Suggested regression test cases ───
export type SuggestedTestCaseStatus = 'pending' | 'accepted' | 'rejected' | 'converted';

export type SuggestedTestCaseSource = 'operator_assist_feedback' | 'test_run' | 'manual';

export interface SuggestedTestCase {
  id: string;
  workspace_id: string;
  source_type: SuggestedTestCaseSource;
  source_id: string | null;
  status: SuggestedTestCaseStatus;
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
  reason: string | null;
  metadata: any;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}


// ─── E10 types ───
export type RegressionFrequency = 'hourly' | 'daily' | 'weekly' | 'manual';

export interface RegressionSchedule {
  id: string;
  workspace_id: string;
  enabled: boolean;
  name: string;
  frequency: RegressionFrequency;
  time_of_day: string | null;
  timezone: string;
  include_enabled_cases_only: boolean;
  max_cases_per_run: number;
  call_llm: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RegressionBatch {
  id: string;
  workspace_id: string;
  schedule_id: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger_type: 'manual' | 'scheduled';
  total_cases: number;
  passed: number;
  failed: number;
  errored: number;
  pass_rate: number | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegressionBatchDetail {
  batch: RegressionBatch;
  runs: TestRun[];
  retryChildren?: Array<{
    id: string; status: RegressionBatch['status']; passed: number; failed: number; errored: number;
    pass_rate: number | null; created_at: string; trigger_type: RegressionBatch['trigger_type'];
  }>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    pass_rate: number | null;
  };
}


export interface RegressionOverview {
  total_schedules: number;
  enabled_schedules: number;
  last_batch: RegressionBatch | null;
  last_24h_batches: number;
  last_24h_pass_rate: number | null;
  last_7d_pass_rate: number | null;
  failed_batches_count: number;
  errored_runs_count: number;
  top_failure_reasons: { reason: string; count: number }[];
  coverage_by_source_type: { source_type: string; runs: number }[];
  next_due_schedule: { id: string; name: string; next_run_at: string | null; timezone: string } | null;
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


export const internalQaApi = {
  playground: (input: { workspaceId: string; question: string; locale?: string; guidanceOverride?: AnswerGuidance; modelOverride?: string }) =>
    jsonFetch(`/api/ai-agent/playground/test`, { method: 'POST', body: JSON.stringify(input) }) as Promise<PlaygroundResult>,
  testAi: (input: { workspaceId: string; message: string; locale?: string; pageContext?: { currentPageUrl?: string | null; currentPagePath?: string | null; currentPageOrigin?: string | null; currentPageTitle?: string | null } | null }) =>
    jsonFetch(`/api/ai-agent/test-ai`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{
      action: 'answer' | 'handoff' | 'clarification' | 'no_answer';
      answer: string | null;
      confidence_bucket: 'low' | 'medium' | 'high';
      reason: string;
      sources: Array<{ title: string; source_type: string }>;
      sources_hidden: boolean;
    }>,
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
  testRun: (input: { workspaceId: string; message: string; pageUrl?: string; visitorLocale?: string }) =>
    jsonFetch(`/api/ai-agent/test-run`, { method: 'POST', body: JSON.stringify({ ...input, dryRun: true }) }) as Promise<TestRunResult>,
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
  // ─── E9 — Suggested regression test cases ───
  listSuggestedTestCases: (workspaceId: string, status: SuggestedTestCaseStatus | 'all' = 'pending') =>
    jsonFetch(`/api/ai-agent/suggested-test-cases?workspaceId=${workspaceId}&status=${status}`) as Promise<{ items: SuggestedTestCase[] }>,
  suggestTestCaseFromFeedback: (feedbackId: string) =>
    jsonFetch(`/api/ai-agent/suggested-test-cases/from-feedback/${feedbackId}`, { method: 'POST' }) as Promise<{ ok: boolean; suggestion: SuggestedTestCase }>,
  suggestTestCaseFromTestRun: (runId: string) =>
    jsonFetch(`/api/ai-agent/suggested-test-cases/from-test-run/${runId}`, { method: 'POST' }) as Promise<{ ok: boolean; suggestion: SuggestedTestCase }>,
  acceptSuggestedTestCase: (id: string, overrides: Partial<SuggestedTestCase> = {}) =>
    jsonFetch(`/api/ai-agent/suggested-test-cases/${id}/accept`, { method: 'POST', body: JSON.stringify(overrides) }) as Promise<{ ok: boolean; test_case_id: string }>,
  rejectSuggestedTestCase: (id: string, reason?: string) =>
    jsonFetch(`/api/ai-agent/suggested-test-cases/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason || null }) }) as Promise<{ ok: boolean }>,
  deleteSuggestedTestCase: (id: string) =>
    jsonFetch(`/api/ai-agent/suggested-test-cases/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  // ─── E10 — Scheduled regression runs ───
  listRegressionSchedules: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/regression/schedules?workspaceId=${workspaceId}`) as Promise<{ items: RegressionSchedule[] }>,
  getOrCreateRegressionSchedule: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/regression/schedules/default`, {
      method: 'POST', body: JSON.stringify({ workspaceId }),
    }) as Promise<{ item: RegressionSchedule }>,
  updateRegressionSchedule: (id: string, patch: Partial<RegressionSchedule>) =>
    jsonFetch(`/api/ai-agent/regression/schedules/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }) as Promise<{ item: RegressionSchedule }>,
  listRegressionBatches: (workspaceId: string, opts: {
    limit?: number;
    offset?: number;
    status?: RegressionBatch['status'] | null;
    triggerType?: RegressionBatch['trigger_type'] | null;
    scheduleId?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    onlyFailed?: boolean;
  } = {}) => {
    const p = new URLSearchParams();
    p.set('workspaceId', workspaceId);
    p.set('limit', String(opts.limit ?? 50));
    if (opts.offset) p.set('offset', String(opts.offset));
    if (opts.status) p.set('status', opts.status);
    if (opts.triggerType) p.set('trigger_type', opts.triggerType);
    if (opts.scheduleId) p.set('schedule_id', opts.scheduleId);
    if (opts.dateFrom) p.set('date_from', opts.dateFrom);
    if (opts.dateTo) p.set('date_to', opts.dateTo);
    if (opts.onlyFailed) p.set('only_failed', 'true');
    return jsonFetch(`/api/ai-agent/regression/batches?${p.toString()}`) as Promise<{
      items: RegressionBatch[]; total: number; limit: number; offset: number;
    }>;
  },
  getRegressionOverview: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/regression/overview?workspaceId=${workspaceId}`) as Promise<RegressionOverview>,
  regressionBatchCsvUrl: (id: string) =>
    `${API_BASE}/api/ai-agent/regression/batches/${id}/export.csv`,
  runRegressionNow: (workspaceId: string, scheduleId?: string | null) =>
    jsonFetch(`/api/ai-agent/regression/run-now`, {
      method: 'POST', body: JSON.stringify({ workspaceId, scheduleId: scheduleId || null }),
    }) as Promise<{ batch: RegressionBatch }>,
  getRegressionBatch: (id: string) =>
    jsonFetch(`/api/ai-agent/regression/batches/${id}`) as Promise<RegressionBatchDetail>,
  runRegressionBatch: (id: string) =>
    jsonFetch(`/api/ai-agent/regression/batches/${id}/run`, { method: 'POST' }) as Promise<{ ok: boolean; result: { total: number; passed: number; failed: number; errored: number } }>,
  cancelRegressionBatch: (id: string) =>
    jsonFetch(`/api/ai-agent/regression/batches/${id}/cancel`, { method: 'POST' }) as Promise<{ ok: boolean; status: RegressionBatch['status']; idempotent: boolean }>,
  retryFailedRegressionBatch: (id: string) =>
    jsonFetch(`/api/ai-agent/regression/batches/${id}/retry-failed`, { method: 'POST' }) as Promise<{ batch: RegressionBatch }>,
  // E10.2 short aliases (kept stable for tests/imports).
  e10_cancelBatch: (id: string) =>
    jsonFetch(`/api/ai-agent/regression/batches/${id}/cancel`, { method: 'POST' }) as Promise<{ ok: boolean; status: RegressionBatch['status']; idempotent: boolean }>,
  e10_retryFailed: (id: string) =>
    jsonFetch(`/api/ai-agent/regression/batches/${id}/retry-failed`, { method: 'POST' }) as Promise<{ batch: RegressionBatch }>,
};
