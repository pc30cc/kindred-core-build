/**
 * AI Agent engine — answer-strategy stage (decideStrategy, page-aware
 * overrides, page-intent terminal reply, and the no-LLM branches:
 * no_answer_silent, handoff(strategy)).
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
import { decideStrategy, countClarificationAttempts, isStrictKbNoGrounding } from '../answerStrategy.js';
import { logRun } from '../logs.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { markAiManaged, commitNeedsHuman, routeAfterHandoff, type HandoffCommit } from '../handoffState.js';
import { updateRuntimeFlags } from '../runtime/conversationState.js';
import { pickTemplate } from '../runtime/templates.js';
import {
  evaluateRoutingRulesForTriggerTypes, applyStrictKbApplicability, rewriteKeepAiToSkip,
  buildRoutingMetadata, mergeRoutingMetadata, POST_STRATEGY_ROUTING_TRIGGER_TYPES,
  type RoutingEvaluationResult,
} from '../runtime/routingRuntime.js';
import {
  evaluateNoAnswerHooks,
  resolveHandoffAckMessage,
  applySafeRoutingSideEffects,
  pickPageNoUrl,
  pickPageNotIndexed,
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
  /** Merged pre-strategy + post-strategy routing metadata (Follow-up 9E.2). */
  routingMeta: ReturnType<typeof buildRoutingMetadata>;
}

const EMPTY_ROUTING_RESULT: RoutingEvaluationResult = {
  actions: [], matchedRuleIds: [], matchedRuleNames: [], hardHandoff: false, keepAi: false,
};

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
  // routingKeepAi (raw, pre-strict-KB-normalization) is superseded below by
  // effectiveRoutingKeepAi, computed once retrievalStrength is known.
  const { decision } = decisionStage;
  const { built, sources, hybridUsed, pageContextDebug, queryMeta } = retrieval;

  // Reassigned once POST routing evaluation runs (after E2C finalization) so
  // that metadata built BEFORE that point (the E2C page-intent terminal
  // reply) truthfully reflects pre-strategy-only routing, and metadata built
  // AFTER it reflects the full merged pre+post picture (Follow-up 9E.2).
  let currentRoutingMeta = auto.routingMeta;
  const baseRuntimeMeta = () => ({
    topics: detectedTopicsMeta,
    guidance: guidanceMeta,
    routing: currentRoutingMeta,
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
    // Phase 2.2 — the visitor is answering the clarification we just asked.
    justAnsweredClarification: built.previousAiAskedClarification,
    // Semantic evidence only — a retrieval ATTEMPT never makes a turn
    // business-specific (page context alone must not force strict-KB).
    businessSignalDetected: retrieval.businessSignalDetected,
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
    grounding_mode: strategy.groundingMode,
    requires_business_knowledge: strategy.requiresBusinessKnowledge,
    // ── Phase 2 observability ──────────────────────────────────────────
    confidence: strategy.confidence,
    confidence_band: strategy.confidenceBand,
    confidence_inputs: strategy.confidenceInputs,
    conflict_detected: strategy.conflictDetected,
    conflicts: strategy.conflicts,
    just_answered_clarification: !!built.previousAiAskedClarification,
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

  // ─── Follow-up 9E.2 — POST-strategy Routing (low_confidence / no_answer) ──
  // Proven safe insertion point: strictly AFTER decideStrategy() AND the
  // entire E2C page-context finalization/terminal-reply block above — a raw
  // low_confidence/no_kb_match decision can still be superseded by an
  // exact/path page-context match (forced to 'answer'/'page_context_match')
  // or short-circuited by the no_url/no_indexed_page terminal reply just
  // above. Evaluating any earlier would risk matching a stale reason that
  // no longer reflects the final outcome (Follow-up 9E.2 Blocker 1).
  // Strict knowledge-only mode still blocks keep_ai routing overrides, but
  // only on BUSINESS turns: a conversational turn (greeting, identity,
  // thanks) is answered from the assistant persona and was never gated by
  // the knowledge base.
  // vNext blocker 4 — operator guidance IS grounding. Strict knowledge-only
  // mode may not silence an answer the business itself just supplied
  // privately for this conversation; otherwise the prompt tells the model
  // guidance outranks the KB while the gate blocks it from ever being used.
  const hasOperatorGuidance = !!ctxStage.operatorGuidance?.items?.length;
  const strictBlocked =
    strategy.requiresBusinessKnowledge
    && !hasOperatorGuidance
    && isStrictKbNoGrounding(settings, strategy.retrievalStrength);


  // Normalize the PRE-strategy result now that retrievalStrength is finally
  // known, so a PRE keep_ai action that strict-KB blocks is never reported
  // as "executed" in metadata (Follow-up 9E.1/9E.2 Blocker 5). Reassigned
  // below once postHardHandoff is known (Follow-up 9E.3.1 cross-phase
  // observability normalization).
  let normalizedPreRouting = applyStrictKbApplicability(auto.routingResult || EMPTY_ROUTING_RESULT, strictBlocked);

  let postRoutingResult: RoutingEvaluationResult = EMPTY_ROUTING_RESULT;
  if (runtimeCfg?.routingRules?.length) {
    try {
      const postCtx = buildEvalCtx({ answerStrategy: { reason: strategy.reason, confidence: strategy.confidence } });
      postRoutingResult = applyStrictKbApplicability(
        evaluateRoutingRulesForTriggerTypes(postCtx, POST_STRATEGY_ROUTING_TRIGGER_TYPES),
        strictBlocked,
      );
      decisionTimeline.push('post_routing_evaluated');
      // POST mark_priority is an orthogonal side effect — it executes here,
      // unconditionally, independent of whether the final outcome becomes
      // answer, keep_ai-overridden-answer, or handoff.
      await applySafeRoutingSideEffects(config, workspaceId, conversationId, postRoutingResult).catch(() => {});
    } catch (err) {
      console.warn('[ai-agent.runtime.routing] post-strategy evaluation failed:', err?.message || err);
    }
  }
  const postKeepAi = postRoutingResult.keepAi;
  const postHardHandoff = postRoutingResult.hardHandoff;

  // Cross-phase precedence (Follow-up 9E.2, product-decision-closed):
  // 1. PRE hard handoff (already terminal upstream, before this stage runs)
  // 2. POST hard handoff  — wins over ANY PRE/POST keep_ai preference
  // 3. applicable keep_ai — PRE and POST combine via OR
  // 4. normal strategy outcome
  // A POST no_answer/low_confidence -> handoff rule is an explicit,
  // outcome-specific escalation evaluated after the strategy is finalized;
  // it must not become unreachable merely because an earlier, coarser PRE
  // keep_ai preference happened to also be true.
  if (postHardHandoff) {
    strategy.decisionType = 'handoff';
    decisionTimeline.push('post_routing_handoff_forced');
    // Follow-up 9E.3.1 — cross-phase observability: a POST hard handoff
    // also outranks an already-applicable PRE keep_ai. The PRE rule's
    // condition still matched (stays in matchedRuleIds), but its keep_ai
    // effect never actually applies — metadata must not report it as
    // executed/effective. (POST's own same-phase keep_ai-vs-hard-handoff
    // conflict, if any, is already normalized inside evaluateRoutingRules
    // itself, so postRoutingResult.keepAi is already false here.)
    if (normalizedPreRouting.keepAi) {
      normalizedPreRouting = rewriteKeepAiToSkip(normalizedPreRouting, 'overridden_by_post_hard_handoff');
    }
  }
  const effectiveRoutingKeepAi = normalizedPreRouting.keepAi;

  // Merge PRE + POST routing metadata, phase-tagged, for every log/metadata
  // call from this point on (never overwrite either phase's observability).
  currentRoutingMeta = mergeRoutingMetadata(
    buildRoutingMetadata(normalizedPreRouting, 'pre_strategy'),
    buildRoutingMetadata(postRoutingResult, 'post_strategy'),
  );

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
    // Follow-up 9D.1/9D.2 — never let it override a strict-KB/no-grounding
    // handoff (already guaranteed here since effectiveRoutingKeepAi/postKeepAi
    // are normalized to false when strictBlocked). Follow-up 9E.2 — a POST
    // hard handoff outranks ANY keep_ai preference, PRE or POST.
    if (!postHardHandoff && (effectiveRoutingKeepAi || postKeepAi)) {
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

    const fallbackBehavior = (settings as any).fallback_behavior || 'handoff';
    // Follow-up 9E.2 — an explicit POST no_answer/low_confidence -> handoff
    // Routing rule is allowed to override the coarse fallback_behavior=
    // 'silent' default, matching the already-live explicit ai_no_answer
    // Message Trigger handoff automation semantics (which already sends a
    // full visible ack regardless of fallback_behavior — see
    // evaluateNoAnswerHooks/actionExecutor.ts, unaffected by this setting).
    //
    // Follow-up 9E.3.1 — an explicit POST hard handoff is a Routing DECISION
    // (transition the conversation to needs_human), independent from
    // decision.canAutoReply (which only governs whether an AI-generated
    // reply/ack may be sent). Gating the entire handoff execution behind
    // canAutoReply meant a postHardHandoff could be classified executed in
    // metadata while the conversation never actually transitioned to
    // needs_human whenever canAutoReply was false (suggest_only,
    // auto_reply_when_offline with operators online, etc). The ordinary
    // strategy-driven fallback handoff (postHardHandoff=false) keeps its
    // pre-existing canAutoReply gate untouched.
    const shouldExecuteHandoff = postHardHandoff || (decision.canAutoReply && fallbackBehavior === 'handoff');
    if (shouldExecuteHandoff) {
      // C2 — if no_answer hooks already executed a handoff (trigger/tool),
      // skip a second markNeedsHuman + duplicate fallback message. Checked
      // regardless of canAutoReply so a suggest_only conversation whose
      // Trigger/Workflow already handed off is reported truthfully too.
      if (noAnsResult?.handoffExecuted) {
        decisionTimeline.push('handoff_message_already_sent');
        return { terminal: { ran: true, action: 'handoff', reason: strategy.reason, runId, messageId: noAnsResult.lastMessageId || null } };
      }
      // vNext blocker 1 — commit the durable needs_human state BEFORE the
      // visitor-facing acknowledgement, and run routing AFTER it.
      const commit = await commitNeedsHuman(config, {
        workspaceId,
        conversationId,
        reason: strategy.reason as any,
      }).catch(() => ({ ok: false, routingDeferred: false } as HandoffCommit));
      decisionTimeline.push(commit.ok ? 'handoff_state_committed' : 'handoff_state_commit_failed');
      // Visitor-facing ack mirrors the EXISTING PRE hard-handoff mode
      // semantics (runtimeDecisionStage.ts's HANDOFF branch): suppressed in
      // suggest_only mode unless canAutoReply is true; sent in every other
      // mode regardless of canAutoReply (e.g. auto_reply_when_offline with
      // operators currently online). It is ALSO suppressed when the state
      // commit failed — never promise an escalation that did not persist.
      let messageId: string | null = null;
      if (commit.ok && (decision.canAutoReply || settings.mode !== 'suggest_only')) {
        const display = deriveAgentDisplay(settings);
        // Handoff wording stays deterministic and owner-controlled: an
        // escalation must never depend on a second model call that can fail
        // or spend credits on a turn the model was not allowed to answer.
        const body = settings.fallback_message
          || await resolveHandoffAckMessage(
            config, workspaceId, locale,
            availability.state === 'offline',
            pickTemplate('no_answer_handoff', locale),
            conversationId,
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
        messageId = inserted.id;
      } else if (!commit.ok) {
        decisionTimeline.push('handoff_ack_suppressed_commit_failed');
      }
      await routeAfterHandoff(config, { workspaceId, conversationId, commit });
      // vNext final blocker 3 — only a durable handoff may be recorded as sent.
      if (commit.ok) {
        await updateRuntimeFlags(config, conversationId, { handoffSent: true }).catch(() => {});
      }
      return { terminal: { ran: true, action: 'handoff', reason: strategy.reason, runId, messageId } };

    }
    return { terminal: { ran: true, action: 'no_answer', reason: strategy.reason, runId } };
    }
  }

  return {
    strategy, strategyMeta, pageExact, pagePath, triggerMeta, workflowMeta, toolMeta,
    pageContextMetaRef, sources, routingMeta: currentRoutingMeta,
  };
}
