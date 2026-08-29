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
import { checkGenerationFreshness, freshnessMeta } from '../freshness.js';
import { persistWorkingMemory } from '../workingMemory.js';
import { markGuidanceConsumed } from '../guidance.js';
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
  const aiActionsMeta = (generation as any).actionsMeta || null;
  const vnextMeta = (generation as any).vnextMeta || null;
  const memoryPatch = (generation as any).memoryPatch || null;
  /**
   * vNext bug fix — a handoff executed by the action pipeline must NOT be
   * silently reverted to `ai_managed` after delivery. Previously this stage
   * always called markAiManaged(), which pulled a conversation that the AI
   * had just escalated back out of the human queue.
   */
  const handoffExecuted = !!(generation as any).actionHandoffExecuted;
  const keepAiOwnership = async () => {
    if (handoffExecuted) {
      decisionTimeline.push('ai_ownership_released_after_handoff');
      return;
    }
    await markAiManaged(config, { workspaceId, conversationId }).catch(() => {});
  };

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
    ...(aiActionsMeta ? { ai_actions: aiActionsMeta } : {}),
    ...(vnextMeta || {}),
  } as Record<string, unknown>);

  const kbIds = sources.filter((s) => s.kind === 'kb_article').map((s) => s.id);
  const qnaIds = sources.filter((s) => s.kind === 'qna').map((s) => s.id);

  // ─── AUTO REPLY → insert visitor-facing message ────────────────────────
  if (decision.canAutoReply) {
    decisionTimeline.push('answer_strategy_selected');
    // vNext §20-24 — last freshness checkpoint. A human who took over (or a
    // newer visitor message) between generation and delivery must not be
    // talked over by an answer written for an older state.
    const freshDelivery = await checkGenerationFreshness(config, {
      workspaceId, conversationId, visitorMessageId, checkpoint: 'pre_delivery',
    });
    if (!freshDelivery.fresh) {
      decisionTimeline.push(`stale_${freshDelivery.reason}`);
      const staleRunId = await logRun(config, {
        workspaceId, conversationId, visitorMessageId,
        runType: 'auto_reply', mode: settings.mode, status: 'skipped',
        inputText: question, outputText: aiResult.text,
        skipReason: `stale_${freshDelivery.reason || 'superseded'}`,
        provider: aiResult.provider, model: aiResult.model,
        kbArticleIds: kbIds, confidence: strategy.confidence,
        metadata: { ...baseRuntimeMeta(), ...freshnessMeta(freshDelivery), locale, language: languageMeta },
      });
      return {
        ran: false, action: 'skipped',
        reason: `stale_${freshDelivery.reason || 'superseded'}`,
        runId: staleRunId || undefined,
      };
    }
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
    // The provisional run row is part of the delivery/accounting contract:
    // without it a delivered message would exist with no durable run record
    // and no way to bill or reconcile it. Fail closed BEFORE delivering.
    if (!runId) {
      console.error('[ai-agent] provisional run creation failed, auto reply suppressed', { conversationId });
      return { ran: true, action: 'failed', reason: 'run_log_create_failed' };
    }
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
      const failFinal = await finalizeRun(config, runId, {
        status: 'failed',
        creditsUsed: 0,
        errorMessage: inserted.error || 'ai_message_insert_failed',
      });
      console.warn('[ai-agent] auto reply persistence failed', {
        conversationId, runId, finalized: failFinal.ok, finalizeError: failFinal.error,
      });
      return { ran: true, action: 'failed', reason: 'ai_message_insert_failed', runId };
    }
    decisionTimeline.push('reply_sent');
    const finalized = await finalizeRun(config, runId, { status: 'replied', creditsUsed: 1 });
    if (!finalized.ok) {
      // The visitor DID receive the message, but the accounting transition
      // (status=replied, credits=1) did not persist after retries. Surface it
      // loudly and mark the result so callers/reconciliation can pick it up —
      // never claim the transition succeeded.
      console.error('[ai-agent] run finalization failed after delivery', {
        conversationId, runId, messageId: inserted.id, error: finalized.error, attempts: finalized.attempts,
      });
      await keepAiOwnership();
      return {
        ran: true,
        action: 'replied',
        reason: 'run_finalization_failed',
        runId,
        messageId: inserted.id,
        finalizationPending: true,
      };
    }
    console.log('[ai-agent] auto reply sent', { conversationId, runId, messageId: inserted.id });
    // Keep conversation in the Automated inbox while AI is handling it —
    // unless this very turn escalated to a human.
    await keepAiOwnership();
    // Persist conversation working memory only after a successful delivery,
    // so a failed turn never leaves phantom resolution attempts behind.
    if (memoryPatch && Object.keys(memoryPatch).length) {
      await persistWorkingMemory(config, { workspaceId, conversationId, patch: memoryPatch }).catch(() => {});
    }
    // Guidance is only "used" once a reply actually reached the visitor.
    if (ctxStage.operatorGuidance?.items?.length) {
      await markGuidanceConsumed(config, {
        workspaceId, conversationId,
        items: ctxStage.operatorGuidance.items,
        runId,
      }).catch(() => {});
    }
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
  // Same invariant as the auto-reply path: never create a suggestion that has
  // no durable provisional run behind it (created_by_run_id must be real).
  if (!runId) {
    console.error('[ai-agent] provisional run creation failed, suggestion suppressed', { conversationId });
    return { ran: true, action: 'failed', reason: 'run_log_create_failed' };
  }

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
    const failFinal = await finalizeRun(config, runId, {
      status: 'failed',
      creditsUsed: 0,
      errorMessage: sErr.message,
    });
    if (!failFinal.ok) {
      console.error('[ai-agent] suggestion failure finalization failed', { runId, error: failFinal.error });
    }
    return { ran: true, action: 'failed', reason: 'suggestion_insert_failed', runId };
  }
  if (!suggestion?.id) {
    const failFinal = await finalizeRun(config, runId, {
      status: 'failed',
      creditsUsed: 0,
      errorMessage: 'suggestion_insert_returned_no_id',
    });
    console.warn('[ai-agent] suggestion insert returned no id', { runId, finalized: failFinal.ok });
    return { ran: true, action: 'failed', reason: 'suggestion_insert_failed', runId };
  }
  decisionTimeline.push('suggestion_sent');
  const finalizedSuggestion = await finalizeRun(config, runId, { status: 'suggested', creditsUsed: 1 });
  if (!finalizedSuggestion.ok) {
    console.error('[ai-agent] suggestion run finalization failed', {
      conversationId, runId, suggestionId: suggestion.id,
      error: finalizedSuggestion.error, attempts: finalizedSuggestion.attempts,
    });
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
    suggestionId: suggestion.id,
    runId,
    ...(finalizedSuggestion.ok ? {} : { reason: 'run_finalization_failed', finalizationPending: true }),
  };
}
