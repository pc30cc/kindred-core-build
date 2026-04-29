/**
 * AI Agent — conversation engine entry point.
 *
 * Phase 2: invoked by widget /message handler after a visitor message is
 * persisted. Default mode is `suggest_only`, which means:
 *   - NO message is inserted into the conversation
 *   - An ai_agent_suggestions row is created (status='pending')
 *   - An ai_agent_runs row is recorded with run_type='suggestion',
 *     status='suggested'
 *   - The visitor sees nothing
 *
 * Other modes (auto_reply_*) are intentionally NOT wired in this phase.
 * They fall through to a 'skipped' run with reason='mode_not_wired_phase2'.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { executeAICompletion, resolveAIConfig } from '../ai/index.js';
import { getOrCreateSettings } from './settings.js';
import { retrieveSources } from './retrieval.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { decide, postValidateAnswer } from './policy.js';
import { logRun } from './logs.js';
import { publishOperatorEvent } from '../realtime/publish.js';

export interface MaybeRunInput {
  workspaceId: string;
  conversationId: string;
  visitorMessageId: string;
  question: string;
  locale?: string;
}

export interface MaybeRunResult {
  ran: boolean;
  action: 'suggested' | 'handoff' | 'no_answer' | 'skipped' | 'failed';
  reason?: string;
  suggestionId?: string | null;
  runId?: string | null;
}

/**
 * Safe entry: never throws. All failures are logged and swallowed so the
 * widget request path is never broken by AI Agent issues.
 */
export async function maybeRunAiAssistantAfterVisitorMessage(
  config: ServerConfig,
  input: MaybeRunInput,
): Promise<MaybeRunResult> {
  try {
    return await runInternal(config, input);
  } catch (err: any) {
    console.warn('[ai-agent] engine failed:', err?.message || err);
    return { ran: false, action: 'failed', reason: err?.message || 'engine_error' };
  }
}

async function runInternal(
  config: ServerConfig,
  input: MaybeRunInput,
): Promise<MaybeRunResult> {
  const { workspaceId, conversationId, visitorMessageId } = input;
  const question = (input.question || '').trim();

  // Empty question (e.g. attachment-only message) → silently skip
  if (!question) {
    return { ran: false, action: 'skipped', reason: 'empty_question' };
  }

  const settings = await getOrCreateSettings(config, workspaceId);

  // Disabled or off → no-op (no run logged to keep tables clean)
  if (!settings.enabled || settings.mode === 'off') {
    return { ran: false, action: 'skipped', reason: 'disabled_or_off' };
  }

  // Phase 2: only suggest_only is wired into real conversations.
  // Auto-reply modes are intentionally NOT executed yet.
  if (settings.mode !== 'suggest_only') {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'skip',
      mode: settings.mode,
      status: 'skipped',
      inputText: question,
      skipReason: 'mode_not_wired_phase2',
    });
    return { ran: false, action: 'skipped', reason: 'mode_not_wired_phase2', runId };
  }

  // Resolve locale: explicit > workspace default > 'en'
  const sb = getServiceClient(config);
  let locale = (input.locale || '').toLowerCase();
  if (!locale) {
    const { data: ws } = await sb
      .from('workspaces')
      .select('locale, widget_language')
      .eq('id', workspaceId)
      .maybeSingle();
    locale = ((ws as any)?.widget_language && (ws as any).widget_language !== 'auto'
      ? (ws as any).widget_language
      : (ws as any)?.locale) || 'en';
  }
  if (settings.allowed_locales?.length && !settings.allowed_locales.includes(locale)) {
    // Fall back to first allowed locale rather than hard-blocking
    locale = settings.allowed_locales[0];
  }

  // Retrieve KB / Q&A
  const sources = await retrieveSources(config, workspaceId, question, locale, 5);

  // Decide
  const decision = decide({ settings, question, sources });

  // Handoff (human request) → log + no suggestion
  if (decision.action === 'handoff') {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'handoff',
      mode: settings.mode,
      status: 'handoff',
      inputText: question,
      skipReason: decision.reason ?? null,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
    });
    return { ran: true, action: 'handoff', reason: decision.reason, runId };
  }

  // No KB match / no answer → log, do not call AI, no suggestion
  if (decision.action !== 'answer') {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'skip',
      mode: settings.mode,
      status: 'no_answer',
      inputText: question,
      skipReason: decision.reason ?? 'no_kb_match',
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
    });
    return { ran: true, action: 'no_answer', reason: decision.reason, runId };
  }

  // Need to call the LLM — make sure a provider is configured
  const aiConfig = await resolveAIConfig(config, workspaceId);
  if (!aiConfig) {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'suggestion',
      mode: settings.mode,
      status: 'failed',
      inputText: question,
      errorMessage: 'no_ai_provider_configured',
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
    });
    return { ran: true, action: 'failed', reason: 'no_ai_provider_configured', runId };
  }

  // Dedupe: if a pending suggestion already exists for this exact visitor
  // message, do not create another. Defends against retries / races.
  const { data: existing } = await sb
    .from('ai_agent_suggestions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('conversation_id', conversationId)
    .eq('visitor_message_id', visitorMessageId)
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    return { ran: false, action: 'skipped', reason: 'duplicate_suggestion', suggestionId: existing.id };
  }

  const systemPrompt = buildSystemPrompt(settings, locale);
  const userPrompt = buildUserPrompt(question, sources);

  let aiResult;
  try {
    aiResult = await executeAICompletion(config, {
      workspaceId,
      prompt: userPrompt,
      systemPrompt,
      maxTokens: 600,
      temperature:
        settings.answer_guidance === 'creative' ? 0.6 :
        settings.answer_guidance === 'balanced' ? 0.4 : 0.2,
    });
  } catch (err: any) {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'suggestion',
      mode: settings.mode,
      status: 'failed',
      inputText: question,
      errorMessage: err?.message || 'ai_call_failed',
      provider: aiConfig.provider,
      model: aiConfig.model,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
    });
    return { ran: true, action: 'failed', reason: err?.message || 'ai_call_failed', runId };
  }

  const valid = postValidateAnswer(aiResult.text || '');
  if (!valid.ok) {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'handoff',
      mode: settings.mode,
      status: 'handoff',
      inputText: question,
      outputText: aiResult.text,
      skipReason: valid.reason,
      provider: aiResult.provider,
      model: aiResult.model,
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
    });
    return { ran: true, action: 'handoff', reason: valid.reason, runId };
  }

  // Persist run first, then suggestion (link via created_by_run_id)
  const runId = await logRun(config, {
    workspaceId,
    conversationId,
    visitorMessageId,
    runType: 'suggestion',
    mode: settings.mode,
    status: 'suggested',
    inputText: question,
    outputText: aiResult.text,
    provider: aiResult.provider,
    model: aiResult.model,
    promptTokens: aiResult.promptTokens,
    completionTokens: aiResult.completionTokens,
    kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
    confidence: decision.confidence,
    metadata: { latencyMs: aiResult.latencyMs, locale },
  });

  const { data: suggestion, error: sErr } = await sb
    .from('ai_agent_suggestions')
    .insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      visitor_message_id: visitorMessageId,
      suggested_reply: aiResult.text,
      source_article_ids: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
      status: 'pending',
      created_by_run_id: runId,
    })
    .select('id')
    .single();
  if (sErr) {
    console.warn('[ai-agent] suggestion insert failed:', sErr.message);
    return { ran: true, action: 'failed', reason: 'suggestion_insert_failed', runId };
  }

  // Realtime echo so the operator's open conversation gets the card without
  // waiting on polling. Best-effort — UI also polls every 15s as fallback.
  try {
    await publishOperatorEvent(config, {
      kind: 'ai_suggestion_created' as any,
      conversation_id: conversationId,
      workspace_id: workspaceId,
      actor_id: null,
      suggestion_id: suggestion?.id || null,
    }, { skipInboxChannel: true });
  } catch { /* best-effort */ }

  return {
    ran: true,
    action: 'suggested',
    suggestionId: suggestion?.id || null,
    runId,
  };
}