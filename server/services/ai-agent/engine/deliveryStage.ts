/**
 * AI Agent engine — delivery stage (auto-reply visitor message insertion,
 * or operator-facing suggestion insertion + realtime publish).
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit H). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, and local baseRuntimeMeta()
 * redefinition) is new; this is also the final stage, so its return value
 * IS the function's terminal MaybeRunResult directly (no wrapping needed).
 * No behavior change. Suggestion dedupe and the realtime event payload are
 * untouched.
 */
import type { ServerConfig } from '../../../config.js';
import { logRun, finalizeRun } from '../logs.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { markAiManaged } from '../handoffState.js';
import { publishOperatorEvent } from '../../realtime/publish.js';
import type { MaybeRunInput, MaybeRunResult } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';
import type { AutomationStageResult } from './automationStage.js';
import type { RuntimeDecisionStageResult } from './runtimeDecisionStage.js';
import type { RetrievalStageResult } from './retrievalStage.js';
import type { AnswerStageResult } from './answerStage.js';
import type { GenerationStageResult } from './generationStage.js';

export async function runDeliveryStage(
  config: ServerConfig,
  input: MaybeRunInput,
  pre: PreflightResult,
  ctxStage: ContextStageResult,
  auto: AutomationStageResult,
  decisionStage: RuntimeDecisionStageResult,
  retrieval: RetrievalStageResult,
  answer: AnswerStageResult,
  generation: GenerationStageResult,
): Promise<MaybeRunResult> {
  const { workspaceId, conversationId, visitorMessageId } = input;
  const question = (input.question || '').trim();
  const { settings, runtimeCfg, decisionTimeline } = pre;
  const { sb, locale, languageMeta, detectedTopicsMeta, guidanceMeta } = ctxStage;
  const { decision } = decisionStage;
  const { sources, queryMeta } = retrieval;
  const {
    strategy, strategyMeta, triggerMeta, workflowMeta, toolMeta, pageContextMetaRef,
    // Merged pre+post routing metadata (Follow-up 9E.2).
    routingMeta,
  } = answer;
  const { aiResult } = generation;

  const baseRuntimeMeta = () => ({
    topics: detectedTopicsMeta,
    guidance: guidanceMeta,
    routing: routingMeta,
    message_triggers: triggerMeta,
    workflows: workflowMeta,
    tools: toolMeta,
    decision_timeline: decisionTimeline,
    runtime_warnings: runtimeCfg?.warnings || [],
    page_context: pageContextMetaRef,
  } as Record<string, unknown>);

  const kbIds = sources.filter((s) => s.kind === 'kb_article').map((s) => s.id);
  const qnaIds = sources.filter((s) => s.kind === 'qna').map((s) => s.id);

  // ─── AUTO REPLY → insert visitor-facing message ────────────────────────
  if (decision.canAutoReply) {
    decisionTimeline.push('answer_strategy_selected');
    // The run row is created in a provisional `failed` state with zero credits.
    // It is promoted to `replied` (and billed) ONLY after the visitor-facing
    // message is confirmed persisted, so a failed insert can never leave a
    // "replied" run behind with no message.
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'auto_reply',
      mode: settings.mode,
      status: 'failed',
      inputText: question,
      outputText: aiResult.text,
      provider: aiResult.provider,
      model: aiResult.model,
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
      creditsUsed: 0,
      kbArticleIds: kbIds,
      confidence: strategy.confidence,
      metadata: {
        ...baseRuntimeMeta(),
        latencyMs: aiResult.latencyMs,
        locale,
        qnaIds,
        answer_strategy: strategyMeta,
        language: languageMeta,
        retrieval: queryMeta,
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
      decisionType: strategy.decisionType,
    });
    if (!inserted.id) {
      await finalizeRun(config, runId, {
        status: 'failed',
        creditsUsed: 0,
        errorMessage: inserted.error || 'ai_message_insert_failed',
      });
      console.warn('[ai-agent] auto reply persistence failed', { conversationId, runId });
      return { ran: true, action: 'failed', reason: 'ai_message_insert_failed', runId };
    }
    decisionTimeline.push('reply_sent');
    await finalizeRun(config, runId, { status: 'replied', creditsUsed: 1 });
    console.log('[ai-agent] auto reply sent', { conversationId, runId, messageId: inserted.id });
    // Keep conversation in the Automated inbox while AI is handling it.
    await markAiManaged(config, { workspaceId, conversationId }).catch(() => {});
    return { ran: true, action: 'replied', runId, messageId: inserted.id };
  }

  // ─── SUGGEST → operator-facing card (Phase 2 behaviour) ────────────────
  decisionTimeline.push('answer_strategy_selected');
  const runId = await logRun(config, {
    workspaceId,
    conversationId,
    visitorMessageId,
    runType: 'suggestion',
    mode: settings.mode,
    status: 'failed',
    inputText: question,
    outputText: aiResult.text,
    provider: aiResult.provider,
    model: aiResult.model,
    promptTokens: aiResult.promptTokens,
    completionTokens: aiResult.completionTokens,
    creditsUsed: 0,
    kbArticleIds: kbIds,
    confidence: strategy.confidence,
    metadata: {
      ...baseRuntimeMeta(),
      latencyMs: aiResult.latencyMs,
      locale,
      qnaIds,
      answer_strategy: strategyMeta,
      language: languageMeta,
      retrieval: queryMeta,
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
    await finalizeRun(config, runId, {
      status: 'failed',
      creditsUsed: 0,
      errorMessage: sErr.message,
    });
    return { ran: true, action: 'failed', reason: 'suggestion_insert_failed', runId };
  }
  decisionTimeline.push('suggestion_sent');
  await finalizeRun(config, runId, { status: 'suggested', creditsUsed: 1 });

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
