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
      error_message: input.errorMessage ?? null,
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