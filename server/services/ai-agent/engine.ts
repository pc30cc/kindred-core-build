/**
 * AI Agent — conversation engine entry point.
 *
 * Phase 3 — Runtime Pro:
 *   - off / disabled    → no-op
 *   - suggest_only      → operator-facing suggestion (Phase 2 behaviour)
 *   - auto_reply_when_offline       → AI replies only when operators offline
 *   - auto_reply_until_human_joins  → AI replies until a human agent posts
 *   - auto_reply_always             → AI replies subject to safety caps
 *
 * Hard rules (do not relax):
 *   - never throws; widget /message must never break
 *   - answer_only_from_kb → no LLM call without a Q&A/KB match
 *   - human_request keyword → handoff, no LLM call
 *   - per-conversation cap, per-hour cap, pending handoff all enforced
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { executeAICompletion, resolveAIConfig } from '../ai/index.js';
import { getOrCreateSettings } from './settings.js';
import { retrieveSources, type RetrievedSource } from './retrieval.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { postValidateAnswer } from './policy.js';
import { decideStrategy, countClarificationAttempts } from './answerStrategy.js';
import { logRun } from './logs.js';
import { publishOperatorEvent } from '../realtime/publish.js';
import { getConversationState, markHandoffRequested } from './conversationState.js';
import { getOperatorAvailability } from './availability.js';
import { decideRuntime } from './runtimePolicy.js';
import { insertAiMessage, deriveAgentDisplay } from './responder.js';
import { markAiManaged, markNeedsHuman } from './handoffState.js';
import { isConversationSpam } from './spamGuard.js';

export interface MaybeRunInput {
  workspaceId: string;
  conversationId: string;
  visitorMessageId: string;
  question: string;
  locale?: string;
}

export interface MaybeRunResult {
  ran: boolean;
  action: 'replied' | 'suggested' | 'handoff' | 'no_answer' | 'skipped' | 'failed';
  reason?: string;
  suggestionId?: string | null;
  runId?: string | null;
  messageId?: string | null;
}

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
  if (!question) {
    return { ran: false, action: 'skipped', reason: 'empty_question' };
  }

  const settings = await getOrCreateSettings(config, workspaceId);
  if (!settings.enabled || settings.mode === 'off') {
    return { ran: false, action: 'skipped', reason: 'disabled_or_off' };
  }

  // Spam guard — never auto-reply or suggest on flagged conversations.
  // This runs before retrieval/LLM so we don't burn tokens on spam.
  if (await isConversationSpam(config, conversationId)) {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'skip',
      mode: settings.mode,
      status: 'skipped',
      inputText: input.question,
      skipReason: 'spam',
    });
    return { ran: false, action: 'skipped', reason: 'spam', runId };
  }

  // Resolve locale (explicit > workspace > 'en')
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
    locale = settings.allowed_locales[0];
  }

  // Gather state in parallel — runtime policy needs all three.
  const [state, availability] = await Promise.all([
    getConversationState(config, workspaceId, conversationId),
    getOperatorAvailability(config, workspaceId, locale),
  ]);

  const decision = decideRuntime({ settings, state, availability, visitorText: question });
  console.log('[ai-agent] policy decision', {
    conversationId,
    mode: settings.mode,
    action: decision.action,
    reason: decision.reason,
    availability: availability.state,
  });

  // ─── Branch: SKIP ──────────────────────────────────────────────────────
  if (decision.action === 'skip') {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'skip',
      mode: settings.mode,
      status: 'skipped',
      inputText: question,
      skipReason: decision.reason,
    });
    return { ran: false, action: 'skipped', reason: decision.reason, runId };
  }

  // ─── Branch: HANDOFF (human request) ───────────────────────────────────
  if (decision.action === 'handoff') {
    await markHandoffRequested(config, conversationId).catch(() => {});
    await markNeedsHuman(config, {
      workspaceId,
      conversationId,
      reason: 'human_request',
    }).catch(() => {});
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'handoff',
      mode: settings.mode,
      status: 'handoff',
      inputText: question,
      skipReason: decision.reason,
    });
    // In auto-reply modes we acknowledge the handoff to the visitor.
    let messageId: string | null = null;
    if (decision.canAutoReply || settings.mode !== 'suggest_only') {
      const display = deriveAgentDisplay(settings);
      const ack = pickHandoffAck(locale, display.agentName);
      const inserted = await insertAiMessage(config, {
        workspaceId,
        conversationId,
        body: ack,
        source: 'ai_agent_handoff',
        runId,
        mode: settings.mode,
        handoff: true,
        agentName: display.agentName,
        agentLogoUrl: display.agentLogoUrl,
      });
      messageId = inserted.id;
    }
    return { ran: true, action: 'handoff', reason: decision.reason, runId, messageId };
  }

  // From here we either suggest or auto-reply. Both need retrieval.
  const sources = await retrieveSources(config, workspaceId, question, locale, 5);
  const clarificationAttemptCount = await countClarificationAttempts(sb, conversationId);
  const strategy = decideStrategy({
    settings,
    question,
    sources,
    clarificationAttemptCount,
  });
  console.log('[ai-agent] strategy decision', {
    conversationId,
    decisionType: strategy.decisionType,
    reason: strategy.reason,
    retrievalStrength: strategy.retrievalStrength,
    topScore: strategy.topScore,
    clarificationAttempts: clarificationAttemptCount,
  });
  const strategyMeta = {
    decision_type: strategy.decisionType,
    reason: strategy.reason,
    retrieval_strength: strategy.retrievalStrength,
    top_score: strategy.topScore,
    clarification_attempt_count: clarificationAttemptCount,
    source_types_used: strategy.sourceTypesUsed,
    handoff_required: strategy.handoffRequired,
    escalation_style: settings.escalation_style || 'balanced',
  };

  // ─── Decisions that don't require an LLM call ─────────────────────────
  if (strategy.decisionType === 'no_answer_silent') {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'skip',
      mode: settings.mode,
      status: 'no_answer',
      inputText: question,
      skipReason: strategy.reason,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: strategy.confidence,
      metadata: { answer_strategy: strategyMeta, locale },
    });
    return { ran: true, action: 'no_answer', reason: strategy.reason, runId };
  }

  if (strategy.decisionType === 'handoff') {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'handoff',
      mode: settings.mode,
      status: 'handoff',
      inputText: question,
      skipReason: strategy.reason,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: strategy.confidence,
      metadata: { answer_strategy: strategyMeta, locale },
    });

    if (decision.canAutoReply) {
      const fallbackBehavior = (settings as any).fallback_behavior || 'handoff';
      if (fallbackBehavior === 'handoff') {
        await markHandoffRequested(config, conversationId).catch(() => {});
        await markNeedsHuman(config, {
          workspaceId,
          conversationId,
          reason: strategy.reason,
        }).catch(() => {});
        const display = deriveAgentDisplay(settings);
        const body = (settings.fallback_message || pickHandoffAck(locale, display.agentName));
        const inserted = await insertAiMessage(config, {
          workspaceId,
          conversationId,
          body,
          source: 'ai_agent_fallback',
          runId,
          mode: settings.mode,
          handoff: true,
          agentName: display.agentName,
          agentLogoUrl: display.agentLogoUrl,
        });
        return { ran: true, action: 'handoff', reason: strategy.reason, runId, messageId: inserted.id };
      }
    }
    return { ran: true, action: 'no_answer', reason: strategy.reason, runId };
  }

  // ─── LLM call ─────────────────────────────────────────────────────────
  const aiConfig = await resolveAIConfig(config, workspaceId);
  if (!aiConfig) {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: decision.canAutoReply ? 'auto_reply' : 'suggestion',
      mode: settings.mode,
      status: 'failed',
      inputText: question,
      errorMessage: 'no_ai_provider_configured',
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: strategy.confidence,
      metadata: { answer_strategy: strategyMeta, locale },
    });
    return { ran: true, action: 'failed', reason: 'no_ai_provider_configured', runId };
  }

  // Suggestion dedupe (Phase 2 contract).
  if (decision.canSuggest) {
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
  }

  const systemPrompt = buildSystemPrompt(settings, locale);
  const userPrompt = buildUserPrompt(question, sources, strategy);

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
      runType: decision.canAutoReply ? 'auto_reply' : 'suggestion',
      mode: settings.mode,
      status: 'failed',
      inputText: question,
      errorMessage: err?.message || 'ai_call_failed',
      provider: aiConfig.provider,
      model: aiConfig.model,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: strategy.confidence,
      metadata: { answer_strategy: strategyMeta, locale },
    });
    return { ran: true, action: 'failed', reason: err?.message || 'ai_call_failed', runId };
  }

  // Clarifying questions can legitimately be short / "I'm not sure".
  // Only post-validate when we expected a confident answer.
  const valid =
    strategy.decisionType === 'ask_clarifying_question'
      ? { ok: true as const }
      : postValidateAnswer(aiResult.text || '');
  if (!valid.ok) {
    // Treat as handoff when AI itself bailed out.
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
      confidence: strategy.confidence,
      metadata: { answer_strategy: strategyMeta, locale },
    });
    if (decision.canAutoReply) {
      await markHandoffRequested(config, conversationId).catch(() => {});
      await markNeedsHuman(config, {
        workspaceId,
        conversationId,
        reason: 'low_confidence',
      }).catch(() => {});
      const display = deriveAgentDisplay(settings);
      const inserted = await insertAiMessage(config, {
        workspaceId,
        conversationId,
        body: settings.fallback_message || pickHandoffAck(locale, display.agentName),
        source: 'ai_agent_fallback',
        runId,
        mode: settings.mode,
        handoff: true,
        agentName: display.agentName,
        agentLogoUrl: display.agentLogoUrl,
      });
      return { ran: true, action: 'handoff', reason: valid.reason, runId, messageId: inserted.id };
    }
    return { ran: true, action: 'handoff', reason: valid.reason, runId };
  }

  const kbIds = sources.filter((s) => s.kind === 'kb_article').map((s) => s.id);
  const qnaIds = sources.filter((s) => s.kind === 'qna').map((s) => s.id);

  // ─── AUTO REPLY → insert visitor-facing message ────────────────────────
  if (decision.canAutoReply) {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'auto_reply',
      mode: settings.mode,
      status: 'replied',
      inputText: question,
      outputText: aiResult.text,
      provider: aiResult.provider,
      model: aiResult.model,
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
      creditsUsed: 1,
      kbArticleIds: kbIds,
      confidence: strategy.confidence,
      metadata: {
        latencyMs: aiResult.latencyMs,
        locale,
        qnaIds,
        answer_strategy: strategyMeta,
      },
    });
    const display = deriveAgentDisplay(settings);
    const inserted = await insertAiMessage(config, {
      workspaceId,
      conversationId,
      body: aiResult.text,
      source: 'ai_agent',
      runId,
      mode: settings.mode,
      kbArticleIds: kbIds,
      qnaIds,
      confidence: strategy.confidence,
      provider: aiResult.provider,
      model: aiResult.model,
      handoff: false,
      agentName: display.agentName,
      agentLogoUrl: display.agentLogoUrl,
    });
    console.log('[ai-agent] auto reply sent', { conversationId, runId, messageId: inserted.id });
    // Keep conversation in the Automated inbox while AI is handling it.
    await markAiManaged(config, { workspaceId, conversationId }).catch(() => {});
    return { ran: true, action: 'replied', runId, messageId: inserted.id };
  }

  // ─── SUGGEST → operator-facing card (Phase 2 behaviour) ────────────────
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
    creditsUsed: 1,
    kbArticleIds: kbIds,
    confidence: strategy.confidence,
    metadata: {
      latencyMs: aiResult.latencyMs,
      locale,
      qnaIds,
      answer_strategy: strategyMeta,
    },
  });

  const { data: suggestion, error: sErr } = await sb
    .from('ai_agent_suggestions')
    .insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      visitor_message_id: visitorMessageId,
      suggested_reply: aiResult.text,
      source_article_ids: kbIds,
      confidence: strategy.confidence,
      status: 'pending',
      created_by_run_id: runId,
    })
    .select('id')
    .single();
  if (sErr) {
    console.warn('[ai-agent] suggestion insert failed:', sErr.message);
    return { ran: true, action: 'failed', reason: 'suggestion_insert_failed', runId };
  }

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

function pickHandoffAck(locale: string | undefined, agentName: string): string {
  const l = (locale || 'en').toLowerCase();
  if (l.startsWith('fa')) return `باشه — همین الان شما را به یک کارشناس انسانی وصل می‌کنم.`;
  if (l.startsWith('tr')) return `Tamam — sizi bir temsilciye bağlıyorum.`;
  return `Sure — I'll connect you with a human agent.`;
}

// Suppress unused-var warning for _RetrievedSource if added later
export type { RetrievedSource };
