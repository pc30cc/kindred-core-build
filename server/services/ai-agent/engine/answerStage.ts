/**
 * AI Agent engine — answer-strategy stage (decideStrategy, page-aware
 * overrides, page-intent terminal reply, and the no-LLM branches:
 * no_answer_silent, handoff(strategy), greeting).
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit F). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, local baseRuntimeMeta()/
 * buildEvalCtx redefinition, and terminal-result wrapping of existing early
 * `return` statements) is new. No behavior change. decideStrategy() itself
 * is untouched -- the Phase 2 strict-KB fix stays intact.
 *
 * C13 page-aware override constants (0.95 exact / 0.8 path score floors,
 * source reordering, no_url/no_indexed_page branches) preserved exactly,
 * unretuned. `evaluateNoAnswerHooks` mutates triggerMeta/workflowMeta/
 * toolMeta via the same get/set ref pattern as the original.
 */
import type { ServerConfig } from '../../../config.js';
import { decideStrategy, countClarificationAttempts } from '../answerStrategy.js';
import { logRun } from '../logs.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { markAiManaged, markNeedsHuman } from '../handoffState.js';
import { markHandoffRequested } from '../conversationState.js';
import { updateRuntimeFlags } from '../runtime/conversationState.js';
import { pickTemplate } from '../runtime/templates.js';
import {
  evaluateNoAnswerHooks,
  resolveHandoffAckMessage,
  pickPageNoUrl,
  pickPageNotIndexed,
  pickGreeting,
} from './helpers.js';
import type { MaybeRunInput, MaybeRunResult } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';
import type { AutomationStageResult } from './automationStage.js';
import type { RuntimeDecisionStageResult } from './runtimeDecisionStage.js';
import type { RetrievalStageResult } from './retrievalStage.js';

export interface AnswerStageResult {
  strategy: ReturnType<typeof decideStrategy>;
  strategyMeta: Record<string, unknown>;
  pageExact: boolean;
  pagePath: boolean;
  triggerMeta: ContextStageResult['triggerMeta'];
  workflowMeta: ContextStageResult['workflowMeta'];
  toolMeta: ContextStageResult['toolMeta'];
  pageContextMetaRef: any;
  sources: RetrievalStageResult['sources'];
}

export async function runAnswerStage(
  config: ServerConfig,
  input: MaybeRunInput,
  pre: PreflightResult,
  ctxStage: ContextStageResult,
  auto: AutomationStageResult,
  decisionStage: RuntimeDecisionStageResult,
  retrieval: RetrievalStageResult,
): Promise<{ terminal: MaybeRunResult } | AnswerStageResult> {
  const { workspaceId, conversationId, visitorMessageId } = input;
  const question = (input.question || '').trim();
  const { settings, runtimeCfg, decisionTimeline, isPageIntent, pageContext } = pre;
  const {
    sb, locale, inputLanguage, languageMeta, detectedTopicsMeta, guidanceMeta,
    state, availability,
  } = ctxStage;
  // triggerMeta/workflowMeta reflect the automation stage's final values.
  // toolMeta/pageContextMetaRef are untouched by the automation stage, so
  // they still come from the context stage (toolMeta is only ever mutated
  // inside evaluateNoAnswerHooks, called for the first time in this stage).
  let { triggerMeta, workflowMeta } = auto;
  let { toolMeta, pageContextMetaRef } = ctxStage;
  const { buildEvalCtx } = auto;
  const { decision, routingKeepAi } = decisionStage;
  const { built, sources, hybridUsed, pageContextDebug, queryMeta } = retrieval;

  const baseRuntimeMeta = () => ({
    topics: detectedTopicsMeta,
    guidance: guidanceMeta,
    routing: auto.routingMeta,
    message_triggers: triggerMeta,
    workflows: workflowMeta,
    tools: toolMeta,
    decision_timeline: decisionTimeline,
    runtime_warnings: runtimeCfg?.warnings || [],
    page_context: pageContextMetaRef,
  } as Record<string, unknown>);

  const clarificationAttemptCount = await countClarificationAttempts(sb, conversationId);
  const strategy = decideStrategy({
    settings,
    question,
    sources,
    clarificationAttemptCount,
    topics: built.topics,
    hybridUsed,
  });
  console.log('[ai-agent] strategy decision', {
    conversationId,
    decisionType: strategy.decisionType,
    reason: strategy.reason,
    retrievalStrength: strategy.retrievalStrength,
    topScore: strategy.topScore,
    clarificationAttempts: clarificationAttemptCount,
    inputLanguage,
    responseLanguage: locale,
    topics: built.topics,
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
    safe_guidance_topic: strategy.safeGuidanceTopic || null,
  };

  // ─── E2C — page-aware overrides ────────────────────────────────────────
  // When the visitor asks "what is this page" AND we have an indexed match,
  // force ANSWER (no handoff, no clarifying question). When intent is set
  // but no page is matched, force a short honest no-answer message.
  const pageExact = !!pageContextDebug?.exact_page_match;
  const pagePath = !!pageContextDebug?.same_path_match;
  let pageIntentOverride: 'answer' | 'no_indexed_page' | 'no_url' | null = null;
  if (isPageIntent) {
    if (pageExact || pagePath) {
      // Reorder sources so the matched page chunk is FIRST, and force answer.
      const matchedIds: string[] = pageContextDebug?.page_matched_source_ids || [];
      const idx = sources.findIndex((s: any) => matchedIds.includes(s.id));
      if (idx > 0) {
        const [hit] = sources.splice(idx, 1);
        sources.unshift(hit);
      }
      (strategy as any).decisionType = 'answer';
      (strategy as any).reason = 'page_context_match';
      (strategy as any).retrievalStrength = pageExact ? 'page_exact_match' : 'page_path_match';
      (strategy as any).handoffRequired = false;
      (strategy as any).topScore = Math.max(strategy.topScore, pageExact ? 0.95 : 0.8);
      (strategy as any).confidence = Math.max(strategy.confidence, pageExact ? 0.95 : 0.8);
      if (!strategy.sourceTypesUsed.includes('web_page')) {
        (strategy as any).sourceTypesUsed = ['web_page', ...strategy.sourceTypesUsed];
      }
      strategyMeta.decision_type = strategy.decisionType;
      strategyMeta.reason = strategy.reason;
      strategyMeta.retrieval_strength = strategy.retrievalStrength;
      strategyMeta.top_score = strategy.topScore;
      strategyMeta.handoff_required = false;
      strategyMeta.source_types_used = strategy.sourceTypesUsed;
      pageIntentOverride = 'answer';
      decisionTimeline.push('page_context_answer_override');
    } else if (!pageContext?.currentPageUrl) {
      pageIntentOverride = 'no_url';
    } else {
      pageIntentOverride = 'no_indexed_page';
    }
  }
  // Reflect page-intent override into the closure-captured metadata bundle.
  if (pageContextMetaRef) {
    pageContextMetaRef.intent_override = pageIntentOverride;
  } else if (pageIntentOverride) {
    pageContextMetaRef = { page_intent_detected: isPageIntent, intent_override: pageIntentOverride };
  }

  // ─── E2C — page intent without a usable match → short honest reply ───
  // Avoid hallucinating from unrelated KB. We do this BEFORE the LLM call.
  if (isPageIntent && pageIntentOverride && pageIntentOverride !== 'answer' && decision.canAutoReply) {
    const body = pageIntentOverride === 'no_url'
      ? pickPageNoUrl(locale)
      : pickPageNotIndexed(locale);
    const runId = await logRun(config, {
      workspaceId, conversationId, visitorMessageId,
      runType: 'auto_reply', mode: settings.mode, status: 'replied',
      inputText: question, outputText: body,
      kbArticleIds: [], confidence: 0.6,
      metadata: { ...baseRuntimeMeta(), answer_strategy: { ...strategyMeta, decision_type: 'no_answer', reason: pageIntentOverride }, locale, language: languageMeta, retrieval: queryMeta },
    });
    const display = deriveAgentDisplay(settings);
    const inserted = await insertAiMessage(config, {
      workspaceId, conversationId, body, source: 'ai_agent', runId,
      mode: settings.mode, kbArticleIds: [], qnaIds: [],
      confidence: 0.6, provider: null, model: null, handoff: false,
      agentName: display.agentName, agentLogoUrl: display.agentLogoUrl,
    });
    await markAiManaged(config, { workspaceId, conversationId }).catch(() => {});
    return { terminal: { ran: true, action: 'replied', runId, messageId: inserted.id } };
  }

  // ─── Decisions that don't require an LLM call ─────────────────────────
  if (strategy.decisionType === 'no_answer_silent') {
    // C2B — evaluate ai_no_answer triggers/workflows/tools.
    await evaluateNoAnswerHooks({
      config, workspaceId, conversationId, locale, settings,
      buildEvalCtx, runtimeCfg, decisionTimeline,
      strategyMeta: { action: 'no_answer', confidence: strategy.confidence, reason: strategy.reason },
      triggerMetaRef: { get: () => triggerMeta, set: (v) => { triggerMeta = v; } },
      workflowMetaRef: { get: () => workflowMeta, set: (v) => { workflowMeta = v; } },
      toolMetaRef: { get: () => toolMeta, set: (v) => { toolMeta = v; } },
      messageRegistry: auto.messageRegistry,
    });
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
      metadata: { ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta, retrieval: queryMeta },
    });
    return { terminal: { ran: true, action: 'no_answer', reason: strategy.reason, runId } };
  }

  if (strategy.decisionType === 'handoff') {
    // C2A — keep_ai routing rule prevents weak-confidence handoff escalation.
    if (routingKeepAi) {
      decisionTimeline.push('routing_keep_ai_overrides_handoff');
      console.log('[ai-agent.runtime.routing] keep_ai overrides handoff', { conversationId });
      // Fall through to LLM by treating strategy as substantive answer.
      (strategy as any).decisionType = 'answer';
      (strategy as any).reason = `${strategy.reason || 'low_confidence'}_keep_ai`;
    } else {
    const noAnsResult = await evaluateNoAnswerHooks({
      config, workspaceId, conversationId, locale, settings,
      buildEvalCtx, runtimeCfg, decisionTimeline,
      strategyMeta: { action: 'handoff', confidence: strategy.confidence, reason: strategy.reason },
      triggerMetaRef: { get: () => triggerMeta, set: (v) => { triggerMeta = v; } },
      workflowMetaRef: { get: () => workflowMeta, set: (v) => { workflowMeta = v; } },
      toolMetaRef: { get: () => toolMeta, set: (v) => { toolMeta = v; } },
      messageRegistry: auto.messageRegistry,
    });
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
      metadata: { ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta, retrieval: queryMeta },
    });

    if (decision.canAutoReply) {
      const fallbackBehavior = (settings as any).fallback_behavior || 'handoff';
      if (fallbackBehavior === 'handoff') {
        // C2 — if no_answer hooks already executed a handoff (trigger/tool),
        // skip a second markNeedsHuman + duplicate fallback message.
        if (noAnsResult?.handoffExecuted) {
          decisionTimeline.push('handoff_message_already_sent');
          return { terminal: { ran: true, action: 'handoff', reason: strategy.reason, runId, messageId: noAnsResult.lastMessageId || null } };
        }
        await markHandoffRequested(config, conversationId).catch(() => {});
        // Insert the fallback/ack message BEFORE markNeedsHuman() — see the
        // ordering note on the human-request handoff branch above.
        const display = deriveAgentDisplay(settings);
        const body = settings.fallback_message
          || await resolveHandoffAckMessage(
            config, workspaceId, locale,
            availability.state === 'offline',
            pickTemplate('no_answer_handoff', locale),
          );
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
        await markNeedsHuman(config, {
          workspaceId,
          conversationId,
          reason: strategy.reason as any,
        }).catch(() => {});
        await updateRuntimeFlags(config, conversationId, { handoffSent: true }).catch(() => {});
        return { terminal: { ran: true, action: 'handoff', reason: strategy.reason, runId, messageId: inserted.id } };
      }
    }
    return { terminal: { ran: true, action: 'no_answer', reason: strategy.reason, runId } };
    }
  }

  // ─── Branch: GREETING (no LLM, no retrieval needed) ────────────────────
  if (strategy.decisionType === 'greeting') {
    // C2 dedup — if we already greeted this visitor, fall through to LLM.
    const flagsForGreet = (state._metadata as any) || {};
    if (flagsForGreet.ai_greeting_sent === true) {
      decisionTimeline.push('greeting_skipped_duplicate');
      console.log('[ai-agent.runtime] greeting skipped — already greeted', { conversationId });
      // Fall through to LLM by treating as substantive answer.
      (strategy as any).decisionType = 'answer';
      (strategy as any).reason = `${strategy.reason || 'greeting'}_dedup`;
    } else {
    const display = deriveAgentDisplay(settings);
    const body = pickGreeting(locale, display.agentName);
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: decision.canAutoReply ? 'auto_reply' : 'suggestion',
      mode: settings.mode,
      status: decision.canAutoReply ? 'replied' : 'suggested',
      inputText: question,
      outputText: body,
      kbArticleIds: [],
      confidence: 1,
      metadata: { ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta, retrieval: queryMeta, greeting: true },
    });
    if (decision.canAutoReply) {
      const inserted = await insertAiMessage(config, {
        workspaceId,
        conversationId,
        body,
        source: 'ai_agent',
        runId,
        mode: settings.mode,
        kbArticleIds: [],
        qnaIds: [],
        confidence: 1,
        provider: null,
        model: null,
        handoff: false,
        agentName: display.agentName,
        agentLogoUrl: display.agentLogoUrl,
      });
      await markAiManaged(config, { workspaceId, conversationId }).catch(() => {});
      await updateRuntimeFlags(config, conversationId, { greetingSent: true }).catch(() => {});
      return { terminal: { ran: true, action: 'replied', runId, messageId: inserted.id } };
    }
    return { terminal: { ran: true, action: 'no_answer', reason: 'greeting_suggest_skipped', runId } };
    }
  }

  return { strategy, strategyMeta, pageExact, pagePath, triggerMeta, workflowMeta, toolMeta, pageContextMetaRef, sources };
}
