/**
 * Pass E9 — Suggested regression test cases.
 *
 * Turns negative AI Operator Assist feedback and failed/errored test runs into
 * draft test cases that owners/admins can review and convert into real entries
 * in `ai_agent_test_cases`.
 *
 * Hard rules (mirror E6/E7/E8):
 *  - Workspace-scoped reads & writes only (every query filters workspace_id).
 *  - No conversation_messages / handoff / workflow / learning candidate writes.
 *  - No calls / LiveKit / widget-call code touched.
 *  - No MCP / webhooks / external HTTP / Edge Functions.
 *  - No storage paths, signed URLs, tokens, or credentials are copied into the
 *    suggestion. File `expected_source_url` is forced to null. All inferred
 *    text is run through `redactString`.
 *  - Duplicates are prevented by `(workspace_id, source_type, source_id)` and
 *    by normalized `(input_message, expected_behavior)`.
 */
import { redactString, redactDeep } from './testHarness.js';

export type SuggestedSourceType = 'operator_assist_feedback' | 'test_run' | 'manual';
export type SuggestedStatus = 'pending' | 'accepted' | 'rejected' | 'converted';
export type ExpectedBehavior = 'answer' | 'no_answer' | 'handoff' | 'clarification';

const VALID_EXPECTED_SOURCE_TYPES = new Set([
  'qna', 'learned_qna', 'kb_article', 'web_page', 'file', 'business_profile',
]);

const UNSAFE_REASONS = new Set(['unsafe', 'wrong_answer', 'hallucination']);

function normalizeMessage(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
}

function shortName(prefix: string, msg: string): string {
  const m = String(msg || '').trim().replace(/\s+/g, ' ');
  return `${prefix}: ${m.slice(0, 80)}${m.length > 80 ? '…' : ''}`;
}

function safeExpectedSourceType(t: any): string | null {
  if (typeof t !== 'string') return null;
  return VALID_EXPECTED_SOURCE_TYPES.has(t) ? t : null;
}

/**
 * From a selected_sources array, infer the primary source_type and (when safe)
 * a non-file source_url. File sources NEVER expose a URL.
 */
function inferSourceFromSelected(selected: any[]): {
  expected_source_type: string | null;
  expected_source_url: string | null;
  expected_source_id: string | null;
} {
  const first = Array.isArray(selected) ? selected[0] : null;
  const t = safeExpectedSourceType(first?.source_type);
  if (!first || !t) return { expected_source_type: null, expected_source_url: null, expected_source_id: null };
  const isFile = t === 'file';
  const rawUrl = typeof first.source_url === 'string' ? first.source_url : null;
  const safeUrl =
    isFile || !rawUrl
      ? null
      : (/^https?:\/\//i.test(rawUrl) && rawUrl.length <= 2000 ? rawUrl : null);
  const safeId = typeof first.source_id === 'string' && first.source_id.length <= 200
    ? first.source_id
    : null;
  return {
    expected_source_type: t,
    expected_source_url: safeUrl,
    expected_source_id: safeId,
  };
}

async function existsDuplicate(
  sb: any,
  workspaceId: string,
  sourceType: SuggestedSourceType,
  sourceId: string | null,
  inputMessage: string,
  expectedBehavior: ExpectedBehavior,
): Promise<string | null> {
  // 1) Same source row already produced a suggestion.
  if (sourceId) {
    const { data } = await sb
      .from('ai_agent_suggested_test_cases')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }
  // 2) Same normalized message + behavior already pending/accepted.
  const norm = normalizeMessage(inputMessage);
  if (!norm) return null;
  const { data: rows } = await sb
    .from('ai_agent_suggested_test_cases')
    .select('id, input_message, expected_behavior, status')
    .eq('workspace_id', workspaceId)
    .eq('expected_behavior', expectedBehavior)
    .in('status', ['pending', 'accepted'])
    .limit(200);
  for (const r of rows || []) {
    if (normalizeMessage(r.input_message) === norm) return r.id as string;
  }
  return null;
}

export interface SuggestedTestCaseRow {
  id: string;
  workspace_id: string;
  source_type: SuggestedSourceType;
  source_id: string | null;
  status: SuggestedStatus;
  name: string;
  input_message: string;
  locale: string | null;
  page_context: any;
  expected_behavior: ExpectedBehavior;
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

export interface SuggestionResult {
  ok: boolean;
  suggestion?: SuggestedTestCaseRow;
  duplicate_of?: string;
  reason?: string;
}

/**
 * Build a suggested regression test from a negative AI Operator Assist
 * feedback row. Only safe, redacted fields are persisted.
 */
export async function suggestFromAssistFeedback(
  sb: any,
  workspaceId: string,
  feedbackId: string,
  createdBy: string | null,
): Promise<SuggestionResult> {
  const { data: fb, error: fbErr } = await sb
    .from('ai_operator_assist_feedback')
    .select('id, workspace_id, assist_run_id, rating, reason, comment, operator_action, final_composer_text')
    .eq('id', feedbackId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (fbErr) return { ok: false, reason: 'feedback_query_failed' };
  if (!fb) return { ok: false, reason: 'feedback_not_found' };
  if (fb.rating !== 'negative') return { ok: false, reason: 'feedback_not_negative' };

  const { data: run, error: runErr } = await sb
    .from('ai_operator_assist_runs')
    .select('id, workspace_id, conversation_id, input_message, selected_sources, answer_strategy, suggestion')
    .eq('id', fb.assist_run_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (runErr) return { ok: false, reason: 'assist_run_query_failed' };
  if (!run) return { ok: false, reason: 'assist_run_not_found' };

  const inputMessage = redactString(String(run.input_message || '').slice(0, 2000)) || '';
  if (!inputMessage) return { ok: false, reason: 'no_input_message' };

  const expected_behavior: ExpectedBehavior = 'answer';
  const inferred = inferSourceFromSelected(Array.isArray(run.selected_sources) ? run.selected_sources : []);

  // expected_not_contains: only when feedback flags an unsafe/wrong answer AND
  // the suggestion text is short enough to be a useful negative phrase.
  const expected_not_contains: string[] = [];
  if (UNSAFE_REASONS.has(String(fb.reason || '').toLowerCase())) {
    const sug = redactString(String(run.suggestion || '').trim());
    if (sug && sug.length > 0 && sug.length <= 240) expected_not_contains.push(sug);
  }

  const reasonParts: string[] = [];
  if (fb.reason) reasonParts.push(String(fb.reason));
  if (fb.comment) reasonParts.push(redactString(String(fb.comment).slice(0, 240)) || '');
  const reason = reasonParts.filter(Boolean).join(' — ').slice(0, 500) || null;

  const dup = await existsDuplicate(sb, workspaceId, 'operator_assist_feedback', fb.id, inputMessage, expected_behavior);
  if (dup) return { ok: false, duplicate_of: dup, reason: 'duplicate' };

  const insert = {
    workspace_id: workspaceId,
    source_type: 'operator_assist_feedback' as const,
    source_id: fb.id,
    status: 'pending' as const,
    name: shortName('Assist negative', inputMessage),
    input_message: inputMessage,
    locale: null,
    page_context: null,
    expected_behavior,
    expected_source_type: inferred.expected_source_type,
    expected_source_url: inferred.expected_source_url,
    expected_source_id: inferred.expected_source_id,
    expected_contains: [],
    expected_not_contains,
    min_confidence: null,
    reason,
    metadata: redactDeep({
      from: 'operator_assist_feedback',
      assist_run_id: run.id,
      conversation_id: run.conversation_id,
      feedback_reason: fb.reason || null,
      feedback_action: fb.operator_action || null,
    }) || {},
    created_by: createdBy,
  };

  const { data, error } = await sb.from('ai_agent_suggested_test_cases').insert(insert).select('*').single();
  if (error) return { ok: false, reason: `insert_failed:${error.message}` };
  return { ok: true, suggestion: data as SuggestedTestCaseRow };
}

/**
 * Build a suggested regression test from a failed/errored test run. If a
 * test_case exists, copy its expectations as the baseline; otherwise infer.
 */
export async function suggestFromFailedTestRun(
  sb: any,
  workspaceId: string,
  testRunId: string,
  createdBy: string | null,
): Promise<SuggestionResult> {
  const { data: run, error } = await sb
    .from('ai_agent_test_runs')
    .select('id, workspace_id, test_case_id, status, input_message, selected_sources, answer_strategy, confidence, failure_reasons')
    .eq('id', testRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) return { ok: false, reason: 'run_query_failed' };
  if (!run) return { ok: false, reason: 'run_not_found' };
  if (run.status === 'passed') return { ok: false, reason: 'run_not_failed' };

  let tc: any = null;
  if (run.test_case_id) {
    const { data } = await sb
      .from('ai_agent_test_cases')
      .select('*')
      .eq('id', run.test_case_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    tc = data;
  }

  const inputMessage = redactString(String(tc?.input_message ?? run.input_message ?? '').slice(0, 2000)) || '';
  if (!inputMessage) return { ok: false, reason: 'no_input_message' };

  const expected_behavior: ExpectedBehavior =
    (tc?.expected_behavior as ExpectedBehavior) || 'answer';

  const inferred = inferSourceFromSelected(Array.isArray(run.selected_sources) ? run.selected_sources : []);

  const expected_source_type = (safeExpectedSourceType(tc?.expected_source_type) ?? inferred.expected_source_type) || null;
  const isFile = expected_source_type === 'file';
  const expected_source_url = isFile
    ? null
    : (typeof tc?.expected_source_url === 'string' ? tc.expected_source_url : inferred.expected_source_url) || null;
  const expected_source_id = (typeof tc?.expected_source_id === 'string' ? tc.expected_source_id : inferred.expected_source_id) || null;

  const expected_contains: string[] = Array.isArray(tc?.expected_contains)
    ? tc.expected_contains.slice(0, 20).map((s: any) => redactString(String(s).slice(0, 500))).filter(Boolean)
    : [];
  const expected_not_contains: string[] = Array.isArray(tc?.expected_not_contains)
    ? tc.expected_not_contains.slice(0, 20).map((s: any) => redactString(String(s).slice(0, 500))).filter(Boolean)
    : [];

  const reason = (Array.isArray(run.failure_reasons) ? run.failure_reasons.slice(0, 5).join('; ') : null) || null;

  const dup = await existsDuplicate(sb, workspaceId, 'test_run', run.id, inputMessage, expected_behavior);
  if (dup) return { ok: false, duplicate_of: dup, reason: 'duplicate' };

  const insert = {
    workspace_id: workspaceId,
    source_type: 'test_run' as const,
    source_id: run.id,
    status: 'pending' as const,
    name: shortName(run.status === 'errored' ? 'Errored run' : 'Failed run', inputMessage),
    input_message: inputMessage,
    locale: tc?.locale || null,
    page_context: tc?.page_context || null,
    expected_behavior,
    expected_source_type,
    expected_source_url,
    expected_source_id,
    expected_contains,
    expected_not_contains,
    min_confidence: typeof tc?.min_confidence === 'number' ? tc.min_confidence : null,
    reason,
    metadata: redactDeep({
      from: 'test_run',
      test_run_id: run.id,
      test_case_id: run.test_case_id || null,
      run_status: run.status,
      run_confidence: run.confidence,
    }) || {},
    created_by: createdBy,
  };

  const { data, error: insErr } = await sb.from('ai_agent_suggested_test_cases').insert(insert).select('*').single();
  if (insErr) return { ok: false, reason: `insert_failed:${insErr.message}` };
  return { ok: true, suggestion: data as SuggestedTestCaseRow };
}

export async function listSuggestedCases(
  sb: any,
  workspaceId: string,
  filters: { status?: SuggestedStatus | 'all'; limit?: number } = {},
): Promise<SuggestedTestCaseRow[]> {
  let q = sb
    .from('ai_agent_suggested_test_cases')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(filters.limit ?? 200, 500));
  if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as SuggestedTestCaseRow[];
}

/**
 * Convert a suggestion into a real `ai_agent_test_cases` row and mark the
 * suggestion as `converted`. Optional `overrides` lets the operator tweak
 * fields in the review modal before saving.
 */
export async function acceptSuggestedCase(
  sb: any,
  suggestionId: string,
  reviewerId: string | null,
  overrides: Partial<SuggestedTestCaseRow> = {},
): Promise<{ ok: true; test_case_id: string } | { ok: false; reason: string }> {
  const { data: s, error } = await sb
    .from('ai_agent_suggested_test_cases')
    .select('*')
    .eq('id', suggestionId)
    .maybeSingle();
  if (error) return { ok: false, reason: 'load_failed' };
  if (!s) return { ok: false, reason: 'not_found' };
  if (s.status === 'converted') return { ok: false, reason: 'already_converted' };

  const merged: any = { ...s, ...overrides };
  // Re-validate / sanitize.
  const expected_source_type = safeExpectedSourceType(merged.expected_source_type);
  const isFile = expected_source_type === 'file';
  const expected_source_url = isFile ? null : (merged.expected_source_url || null);

  const expected_contains_clean = (Array.isArray(merged.expected_contains) ? merged.expected_contains : [])
    .slice(0, 20)
    .map((s: any) => redactString(String(s).slice(0, 500)))
    .filter(Boolean);
  const expected_not_contains_clean = (Array.isArray(merged.expected_not_contains) ? merged.expected_not_contains : [])
    .slice(0, 20)
    .map((s: any) => redactString(String(s).slice(0, 500)))
    .filter(Boolean);

  const tcInsert = {
    workspace_id: s.workspace_id,
    name: String(merged.name || '').slice(0, 200),
    input_message: redactString(String(merged.input_message || '').slice(0, 2000)) || '',
    locale: merged.locale || null,
    page_context: merged.page_context || null,
    expected_behavior: merged.expected_behavior,
    expected_source_type,
    expected_source_url,
    expected_source_id: merged.expected_source_id || null,
    expected_contains: expected_contains_clean,
    expected_not_contains: expected_not_contains_clean,
    min_confidence: typeof merged.min_confidence === 'number' ? merged.min_confidence : null,
    enabled: true,
    metadata: redactDeep({
      from_suggestion_id: s.id,
      suggestion_source_type: s.source_type,
      suggestion_source_id: s.source_id,
    }) || {},
    created_by: reviewerId,
  };
  const { data: tc, error: tcErr } = await sb
    .from('ai_agent_test_cases')
    .insert(tcInsert)
    .select('id')
    .single();
  if (tcErr) return { ok: false, reason: `tc_insert_failed:${tcErr.message}` };

  await sb.from('ai_agent_suggested_test_cases').update({
    status: 'converted',
    reviewed_by: reviewerId,
    reviewed_at: new Date().toISOString(),
    metadata: { ...(s.metadata || {}), converted_test_case_id: tc.id },
  }).eq('id', s.id);

  return { ok: true, test_case_id: tc.id as string };
}

export async function rejectSuggestedCase(
  sb: any,
  suggestionId: string,
  reviewerId: string | null,
  rejectionReason: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const { data: s, error } = await sb
    .from('ai_agent_suggested_test_cases')
    .select('id, metadata, status')
    .eq('id', suggestionId)
    .maybeSingle();
  if (error) return { ok: false, reason: 'load_failed' };
  if (!s) return { ok: false, reason: 'not_found' };
  if (s.status === 'converted') return { ok: false, reason: 'already_converted' };
  const meta = { ...(s.metadata || {}), rejection_reason: redactString(String(rejectionReason || '').slice(0, 500)) || null };
  const { error: updErr } = await sb.from('ai_agent_suggested_test_cases').update({
    status: 'rejected',
    reviewed_by: reviewerId,
    reviewed_at: new Date().toISOString(),
    metadata: meta,
  }).eq('id', suggestionId);
  if (updErr) return { ok: false, reason: updErr.message };
  return { ok: true };
}