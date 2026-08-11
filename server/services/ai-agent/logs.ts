/**
 * AI Agent — run logs.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface LogRunInput {
  workspaceId: string;
  conversationId?: string | null;
  visitorMessageId?: string | null;
  runType: 'playground' | 'auto_reply' | 'suggestion' | 'handoff' | 'skip';
  mode?: string | null;
  status: 'skipped' | 'replied' | 'suggested' | 'handoff' | 'failed' | 'no_answer';
  inputText?: string | null;
  outputText?: string | null;
  skipReason?: string | null;
  errorMessage?: string | null;
  provider?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  creditsUsed?: number;
  kbArticleIds?: string[];
  confidence?: number | null;
  metadata?: Record<string, unknown>;
}

export async function logRun(config: ServerConfig, input: LogRunInput): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_runs')
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId ?? null,
      visitor_message_id: input.visitorMessageId ?? null,
      run_type: input.runType,
      mode: input.mode ?? null,
      status: input.status,
      input_text: input.inputText ?? null,
      output_text: input.outputText ?? null,
      skip_reason: input.skipReason ?? null,
      error_message: redactErrorMessage(input.errorMessage),
      provider: input.provider ?? null,
      model: input.model ?? null,
      prompt_tokens: input.promptTokens ?? null,
      completion_tokens: input.completionTokens ?? null,
      credits_used: input.creditsUsed ?? 0,
      kb_article_ids: input.kbArticleIds ?? [],
      confidence: input.confidence ?? null,
      metadata: input.metadata ?? {},
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[ai-agent] logRun failed:', error.message);
    return null;
  }
  return data?.id || null;
}

/**
 * Strips credential-looking material out of provider error strings before they
 * are persisted (run logs are visible to workspace operators).
 */
export function redactErrorMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw)
    .replace(/(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(api[_-]?key|authorization|bearer|token|x-api-key)\b\s*[:=]?\s*[^\s,;]+/gi, '$1 [redacted]')
    .replace(/([?&](?:key|access_token|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 1000);
}

/**
 * Promotes a provisional run row to its final state. Used by the delivery
 * stage so a run is only ever marked `replied`/`suggested` (and billed) AFTER
 * the visitor-facing message actually persisted.
 */
export async function finalizeRun(
  config: ServerConfig,
  runId: string | null,
  patch: {
    status: LogRunInput['status'];
    creditsUsed?: number;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!runId) return;
  const sb = getServiceClient(config);
  const update: Record<string, unknown> = { status: patch.status };
  if (typeof patch.creditsUsed === 'number') update.credits_used = patch.creditsUsed;
  if (patch.errorMessage !== undefined) update.error_message = redactErrorMessage(patch.errorMessage);
  if (patch.metadata) update.metadata = patch.metadata;
  const { error } = await sb.from('ai_agent_runs').update(update).eq('id', runId);
  if (error) console.warn('[ai-agent] finalizeRun failed:', error.message);
}

export async function listRuns(
  config: ServerConfig,
  workspaceId: string,
  opts: { limit?: number } = {},
) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_runs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 50, 200));
  if (error) throw new Error(error.message);
  return data || [];
}

const RUN_LIST_COLUMNS = 'id,run_type,mode,status,input_text,skip_reason,error_message,confidence,created_at,conversation_id';

const RUN_FILTER_STATUSES: Record<string, string[]> = {
  answered: ['replied'],
  suggested: ['suggested'],
  handoff: ['handoff'],
  no_answer: ['no_answer', 'skipped'],
  needs_review: ['failed'],
};

/**
 * Paginated + searchable run listing for the Activity page.
 * Filtering/searching happens in Postgres so the client never loads the
 * full history into memory.
 */
export async function listRunsPaged(
  config: ServerConfig,
  workspaceId: string,
  opts: { page?: number; pageSize?: number; search?: string; filter?: string } = {},
) {
  const sb = getServiceClient(config);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const from = (page - 1) * pageSize;

  let q = sb
    .from('ai_agent_runs')
    .select(RUN_LIST_COLUMNS, { count: 'exact' })
    .eq('workspace_id', workspaceId);

  const statuses = opts.filter && opts.filter !== 'all' ? RUN_FILTER_STATUSES[opts.filter] : undefined;
  if (statuses) q = q.in('status', statuses);

  const search = (opts.search || '').trim();
  if (search) {
    const safe = search.replace(/[%,()]/g, ' ').slice(0, 120);
    q = q.ilike('input_text', `%${safe}%`);
  }

  const { data, error, count } = await q
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw new Error(error.message);
  const total = count ?? 0;
  return {
    runs: data || [],
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function summarize(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  // Last 30 days
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data } = await sb
    .from('ai_agent_runs')
    .select('run_type,status,credits_used,confidence')
    .eq('workspace_id', workspaceId)
    .gte('created_at', since)
    .limit(5000);
  const rows = data || [];
  const total = rows.length;
  let replies = 0, suggestions = 0, handoffs = 0, noAnswer = 0, failed = 0;
  let credits = 0, confSum = 0, confN = 0;
  for (const r of rows) {
    if (r.status === 'replied') replies++;
    else if (r.status === 'suggested') suggestions++;
    else if (r.status === 'handoff') handoffs++;
    else if (r.status === 'no_answer') noAnswer++;
    else if (r.status === 'failed') failed++;
    credits += r.credits_used || 0;
    if (typeof r.confidence === 'number') { confSum += r.confidence; confN++; }
  }
  return {
    range: '30d',
    total,
    replies,
    suggestions,
    handoffs,
    no_answer: noAnswer,
    failed,
    credits_used: credits,
    avg_confidence: confN ? confSum / confN : null,
  };
}