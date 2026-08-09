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
import { decideResponseLanguage, detectInputLanguage } from './language.js';
import { buildRetrievalQuery } from './queryBuilder.js';
import { runLimitHandoff, detectLimitErrorReason, type LimitReason } from './limitHandoff.js';
import { retrieveHybridSources } from './retrievalHybrid.js';
import { loadWorkspaceContext } from './workspaceContext.js';
import { maybeCreateLearningCandidateFromAiSkip } from './learning/candidates.js';
import { loadAiAgentRuntimeConfig } from './runtimeConfig.js';
import { detectTopics } from './topics/detector.js';
import { evaluateRoutingRules, buildRoutingMetadata } from './runtime/routingRuntime.js';
import { updateRuntimeFlags } from './runtime/conversationState.js';
import { pickTemplate, pickHandoffAckMessage, pickHandoffOfflineMessage, hasOfflineContactCapability } from './runtime/templates.js';
import { evaluateMessageTriggers, buildTriggerMetadata, type TriggerEvaluationResult } from './runtime/triggerRuntime.js';
import { evaluateWorkflows, buildWorkflowMetadata, type WorkflowEvaluationResult } from './runtime/workflowRuntime.js';
import { evaluateInternalTools, buildToolMetadata, type ToolEvaluationResult } from './runtime/toolRuntime.js';
import { executeRuntimeActions } from './runtime/actionExecutor.js';
import { executeMatchedWorkflows, buildExecutedWorkflowMetadata, type WorkflowExecutionResult } from './runtime/workflowExecutor.js';
import { isAutoAnswerAllowedForWorkspace } from './platformGuards.js';
import { getPlatformAllowedLocales } from '../platformRegion.js';
import type { MaybeRunInput, MaybeRunResult } from './engine/types.js';
import {
  resolveHandoffAckMessage,
  pickHandoffAck,
  pickGreeting,
  pickPageNotIndexed,
  pickPageNoUrl,
  detectPageIntent,
  applySafeRoutingSideEffects,
  evaluateNoAnswerHooks,
} from './engine/helpers.js';

export type { MaybeRunInput, MaybeRunResult } from './engine/types.js';

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

  // E12 Platform kill switch + auto_answer toggle. Visitor messages still
  // flow normally to the operator inbox; we only short-circuit AI side
  // effects (LLM, AI reply, suggestion, handoff).
  const platformGate = await isAutoAnswerAllowedForWorkspace(config, workspaceId);
  if (platformGate.allowed !== true) {
    const reason = (platformGate as { allowed: false; reason: string }).reason;
    try {
      await logRun(config, {
        workspaceId,
        conversationId,
        visitorMessageId,
        runType: 'skip',
        mode: 'off',
        status: 'skipped',
        inputText: input.question,
        skipReason: reason,
      });
    } catch { /* never break visitor flow */ }
    return { ran: false, action: 'skipped', reason };
  }

  const pageContext = input.pageContext || null;
  // E2C — lightweight intent detector for "what is this page" questions.
  const isPageIntent = detectPageIntent(question);

  const settings = await getOrCreateSettings(config, workspaceId);
  if (!settings.enabled || settings.mode === 'off') {
    return { ran: false, action: 'skipped', reason: 'disabled_or_off' };
  }

  // Pass C1 — load runtime configuration (cached 30s per workspace).
  // Best-effort: any failure must not break the existing auto-reply flow.
  const runtimeCfg = await loadAiAgentRuntimeConfig(config, workspaceId).catch((err) => {
    console.warn('[ai-agent.runtime] runtimeConfig load failed:', err?.message || err);
    return null;
  });
  const decisionTimeline: string[] = ['runtime_config_loaded'];
  if (runtimeCfg) {
    console.log('[ai-agent.runtime] config loaded', {
      workspaceId,
      topics: runtimeCfg.topics.length,
      guidance: runtimeCfg.guidanceRules.length,
      routing: runtimeCfg.routingRules.length,
      triggers: runtimeCfg.messageTriggers.length,
      tools: runtimeCfg.internalTools.length,
      warnings: runtimeCfg.warnings,
    });
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
  // Read workspace locale info once — needed by language service.
  const { data: wsRow } = await sb
    .from('workspaces')
    .select('locale, widget_language')
    .eq('id', workspaceId)
    .maybeSingle();
  const widgetLocale = (wsRow as any)?.widget_language || '';
  const workspaceLocale = (wsRow as any)?.locale || '';

  // Phase A — language policy. Decide what language to RESPOND in regardless
  // of what language the visitor wrote in.
  // Platform region lock — on a single-language deployment the visitor's
  // detected/browser language must never override the active language.
  const platformAllowed = await getPlatformAllowedLocales(config);
  const settingsAllowed = (settings.allowed_locales || []).map((l) => l.toLowerCase().split('-')[0]);
  const effectiveAllowed = settingsAllowed.length
    ? settingsAllowed.filter((l) => platformAllowed.includes(l))
    : platformAllowed;
  const allowList = effectiveAllowed.length ? effectiveAllowed : platformAllowed;

  const langDecision = decideResponseLanguage({
    visitorText: question,
    widgetLocale,
    workspaceLocale,
    allowedLocales: allowList,
  });
  // `locale` from here on means the response locale.
  let locale = (input.locale || '').toLowerCase() || langDecision.responseLanguage || 'en';
  locale = locale.split('-')[0];
  if (allowList.length && !allowList.includes(locale)) {
    locale = allowList[0];
  }
  const inputLanguage = langDecision.inputLanguage !== 'unknown'
    ? langDecision.inputLanguage
    : detectInputLanguage(question);
  const languageMeta = {
    input_language: inputLanguage,
    response_language: locale,
    widget_locale: widgetLocale || null,
    language_decision_source: langDecision.source,
    detection_confidence: langDecision.detectionConfidence,
    mixed_language_detected: langDecision.mixedLanguageDetected,
  };

  // Pass C1 — deterministic topic detection from configured ai_agent_topics.
  let detectedTopicsMeta: Record<string, unknown> = { detectedTopics: [] };
  let topTopicSlug: string | null = null;
  let humanRequestFromTopics = false;
  if (runtimeCfg && runtimeCfg.topics.length) {
    try {
      const det = detectTopics(question, runtimeCfg.topics);
      const top = det.detectedTopics[0] || null;
      topTopicSlug = top?.slug || null;
      humanRequestFromTopics = top?.slug === 'human-request';
      detectedTopicsMeta = {
        detectedTopics: det.detectedTopics.map((t) => ({
          slug: t.slug,
          name: t.name,
          confidence: t.confidence,
          matchedKeywords: t.matchedKeywords,
          matchedExamples: t.matchedExamples,
          action: t.action,
        })),
        topTopic: top ? { slug: top.slug, name: top.name, confidence: top.confidence } : null,
        language: det.language,
      };
      decisionTimeline.push('topics_detected');
      if (det.detectedTopics.length) {
        console.log('[ai-agent.runtime] topics detected', {
          conversationId,
          top: top?.slug,
          confidence: top?.confidence,
          count: det.detectedTopics.length,
        });
      }
    } catch (err: any) {
      console.warn('[ai-agent.runtime] topic detection failed:', err?.message || err);
    }
  }

  const guidanceMeta = runtimeCfg
    ? {
        appliedRuleIds: runtimeCfg.guidanceRules.map((g) => g.id),
        appliedRuleTitles: runtimeCfg.guidanceRules.map((g) => g.title),
        appliedRuleTypes: Array.from(new Set(runtimeCfg.guidanceRules.map((g) => g.type))),
      }
    : { appliedRuleIds: [], appliedRuleTitles: [], appliedRuleTypes: [] };
  if (runtimeCfg?.guidanceRules.length) decisionTimeline.push('guidance_loaded');

  // Helper to enrich every logRun call below with the new metadata bundles.
  // `routing` is filled in once routing rules are evaluated (after we have
  // conversation state). Until then, defaults to an empty bundle.
  let routingMeta: ReturnType<typeof buildRoutingMetadata> = {
    matchedRuleIds: [],
    matchedRuleNames: [],
    executedActions: [],
    plannedActions: [],
    skippedActions: [],
  };
  // C2B aggregators — populated as runtime evaluators run.
  let triggerMeta: ReturnType<typeof buildTriggerMetadata> = {
    matched: [], executed: [], planned: [], skipped: [],
  };
  let workflowMeta: {
    matchedWorkflowIds: string[];
    matchedWorkflowNames: string[];
    executedActions: any[];
    blockedActions: any[];
    plannedActions: any[];
    skippedActions: any[];
    runtimeExecutionEnabled: boolean;
    safeExecutionOnly: boolean;
  } = {
    matchedWorkflowIds: [], matchedWorkflowNames: [],
    executedActions: [], blockedActions: [],
    plannedActions: [], skippedActions: [], runtimeExecutionEnabled: true, safeExecutionOnly: true,
  };
  let toolMeta: ReturnType<typeof buildToolMetadata> = {
    allowedTools: [], usedTools: [], plannedTools: [], skippedTools: [],
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
  } as Record<string, unknown>);
  // E2C — populated after retrieval. Captured by closure above.
  let pageContextMetaRef: any = pageContext ? {
    source: 'widget',
    current_page_url: pageContext.currentPageUrl || null,
    current_page_origin: pageContext.currentPageOrigin || null,
    current_page_path: pageContext.currentPagePath || null,
    current_page_title: pageContext.currentPageTitle || null,
    page_intent_detected: isPageIntent,
    intent_override: null,
  } : (isPageIntent ? { page_intent_detected: true, intent_override: null } : null);

  // Gather state in parallel — runtime policy needs all three.
  const [state, availability] = await Promise.all([
    getConversationState(config, workspaceId, conversationId),
    getOperatorAvailability(config, workspaceId, locale),
  ]);

  // ─── C2A — evaluate routing rules ────────────────────────────────────
  // Pure evaluation. Side-effects (handoff, mark_priority) executed below.
  let routingResult: ReturnType<typeof evaluateRoutingRules> | null = null;
  if (runtimeCfg?.routingRules?.length) {
    try {
      const topTopic = (detectedTopicsMeta as any)?.topTopic
        ? { slug: (detectedTopicsMeta as any).topTopic.slug, name: (detectedTopicsMeta as any).topTopic.name } as any
        : null;
      routingResult = evaluateRoutingRules({
        workspaceId,
        conversationId,
        visitorMessageId,
        visitorText: question,
        inputLanguage,
        responseLanguage: locale,
        topTopic,
        detectedTopics: ((detectedTopicsMeta as any)?.detectedTopics || []) as any,
        settings,
        runtimeConfig: runtimeCfg,
        conversationState: state,
        now: Date.now(),
      });
      routingMeta = buildRoutingMetadata(routingResult);
      decisionTimeline.push('routing_evaluated');
    } catch (err: any) {
      console.warn('[ai-agent.runtime.routing] evaluation failed:', err?.message || err);
    }
  }

  // ─── C2B — message triggers + workflow planned (pre-retrieval) ──────
  // Build a shared evaluation context once.
  const buildEvalCtx = (extra?: { answerStrategy?: any }) => ({
    workspaceId,
    conversationId,
    visitorMessageId,
    visitorText: question,
    inputLanguage,
    responseLanguage: locale,
    topTopic: (detectedTopicsMeta as any)?.topTopic
      ? { slug: (detectedTopicsMeta as any).topTopic.slug, name: (detectedTopicsMeta as any).topTopic.name } as any
      : null,
    detectedTopics: ((detectedTopicsMeta as any)?.detectedTopics || []) as any,
    settings,
    runtimeConfig: runtimeCfg,
    conversationState: state,
    answerStrategy: extra?.answerStrategy ?? null,
    now: Date.now(),
  });

  let triggerResult: TriggerEvaluationResult | null = null;
  let workflowResult: WorkflowEvaluationResult | null = null;
  // Pass D — aggregated execution state across all workflow events fired pre-retrieval.
  let workflowStopAi = false;
  let workflowHandoffExecuted = false;
  let workflowMessageId: string | null = null;
  if (runtimeCfg) {
    try {
      const isFirstVisitorMessage = (state.aiRepliesCountInConversation === 0);
      const triggerEvents: Array<'visitor_first_message' | 'topic_detected' | 'human_requested'> = [];
      if (isFirstVisitorMessage) triggerEvents.push('visitor_first_message');
      if ((detectedTopicsMeta as any)?.topTopic) triggerEvents.push('topic_detected');
      if (humanRequestFromTopics) triggerEvents.push('human_requested');

      const aggExec: any[] = [];
      const aggPlan: any[] = [];
      const aggSkip: any[] = [];
      const matchedAll: Array<{ id: string; name: string }> = [];
      for (const ev of triggerEvents) {
        const r = evaluateMessageTriggers(buildEvalCtx(), ev);
        if (!r.matchedTriggerIds.length) continue;
        matchedAll.push(...r.matchedTriggerIds.map((id, i) => ({ id, name: r.matchedTriggerNames[i] || id })));
        aggExec.push(...r.executed);
        aggPlan.push(...r.planned);
        aggSkip.push(...r.skipped);
      }

      // Pass D — workflow MATCH + EXECUTE for the firing events.
      // Always considered (not gated by trigger matches).
      const wfEvents: Array<'visitor_first_message' | 'topic_detected' | 'human_requested'> = [];
      if (isFirstVisitorMessage) wfEvents.push('visitor_first_message');
      if ((detectedTopicsMeta as any)?.topTopic) wfEvents.push('topic_detected');
      if (humanRequestFromTopics) wfEvents.push('human_requested');
      for (const ev of wfEvents) {
        const w = evaluateWorkflows(buildEvalCtx(), ev as any);
        if (!w.matchedWorkflowIds.length) continue;
        decisionTimeline.push('workflow_matched');
        const planMeta = buildWorkflowMetadata(w);
        // Execute safe steps.
        const exec = await executeMatchedWorkflows(
          {
            config, workspaceId, conversationId,
            responseLanguage: locale, inputLanguage,
            settings, runId: null,
          },
          w,
          buildEvalCtx(),
        );
        const execMeta = buildExecutedWorkflowMetadata(exec);
        workflowMeta = {
          matchedWorkflowIds: [...workflowMeta.matchedWorkflowIds, ...planMeta.matchedWorkflowIds],
          matchedWorkflowNames: [...workflowMeta.matchedWorkflowNames, ...planMeta.matchedWorkflowNames],
          executedActions: [...(workflowMeta.executedActions || []), ...execMeta.executedActions],
          blockedActions: [...(workflowMeta.blockedActions || []), ...execMeta.blockedActions],
          plannedActions: [
            ...workflowMeta.plannedActions,
            ...execMeta.plannedActions,
            // Surface the classifier's planned/blocked steps from match step too,
            // de-duplicated naturally because the executor already returned them.
          ],
          skippedActions: [...workflowMeta.skippedActions, ...execMeta.skippedActions, ...planMeta.skippedActions],
          runtimeExecutionEnabled: true,
          safeExecutionOnly: true,
        };
        if (execMeta.executedActions.length) decisionTimeline.push('workflow_step_executed');
        if (execMeta.plannedActions.length) decisionTimeline.push('workflow_step_planned');
        if (execMeta.blockedActions.length) decisionTimeline.push('workflow_step_blocked');
        if (exec.handoffExecuted) {
          workflowHandoffExecuted = true;
          decisionTimeline.push('workflow_handoff_executed');
        }
        if (exec.stopAi) {
          workflowStopAi = true;
          decisionTimeline.push('workflow_stopped_ai');
        }
        if (exec.insertedMessageIds.length && !workflowMessageId) {
          workflowMessageId = exec.insertedMessageIds[0];
        }
      }
      if (matchedAll.length) {
        triggerMeta = {
          matched: matchedAll,
          executed: aggExec.map((a) => ({ id: a.sourceId, name: a.sourceName, action_type: a.type === 'reply_template' ? 'send_message' : a.type, messageId: (a.payload as any)?.messageId || null })),
          planned: aggPlan.map((a) => ({ id: a.sourceId, name: a.sourceName, action_type: a.type, reason: a.skippedReason || a.reason || null })),
          skipped: aggSkip.map((a) => ({ id: a.sourceId, name: a.sourceName, reason: a.skippedReason || a.reason || null })),
        };
        decisionTimeline.push('trigger_evaluated');
        // Build a synthetic combined result for downstream execution.
        triggerResult = {
          actions: [...aggExec, ...aggPlan, ...aggSkip],
          matchedTriggerIds: matchedAll.map((m) => m.id),
          matchedTriggerNames: matchedAll.map((m) => m.name),
          executed: aggExec, planned: aggPlan, skipped: aggSkip,
        };
      }
    } catch (err: any) {
      console.warn('[ai-agent.runtime.trigger] evaluation failed:', err?.message || err);
    }
  }

  // Execute safe trigger actions BEFORE retrieval. send_message with
  // continue_ai=false short-circuits the entire AI flow for this message.
  let stoppedByTrigger = false;
  let triggerMessageId: string | null = null;
  let triggerForcesHandoff = false;
  if (triggerResult && triggerResult.executed.length) {
    const exec = await executeRuntimeActions({
      config, workspaceId, conversationId,
      responseLanguage: locale, settings, runId: null,
    }, triggerResult.executed);
    if (exec.insertedMessageIds.length) {
      triggerMessageId = exec.insertedMessageIds[0];
      decisionTimeline.push('trigger_message_sent');
      // Refresh trigger executed messageIds in metadata.
      triggerMeta = {
        ...triggerMeta,
        executed: triggerMeta.executed.map((e, i) => ({ ...e, messageId: exec.insertedMessageIds[i] || e.messageId })),
      };
    }
    if (exec.handoffExecuted) {
      triggerForcesHandoff = true;
      decisionTimeline.push('trigger_handoff_executed');
    }
    // continue_ai=false on any send_message stops further AI work.
    const blockingSend = triggerResult.executed.find(
      (a) => a.type === 'reply_template' && (a.payload as any)?.continue_ai !== true,
    );
    if (blockingSend) {
      stoppedByTrigger = true;
      decisionTimeline.push('stopped_after_trigger_message');
    }
  }

  const decision = decideRuntime({ settings, state, availability, visitorText: question });
  // If the visitor's intent matched the configured "human-request" topic but
  // the legacy keyword check did not fire, upgrade the decision to handoff so
  // we never miss an explicit "وصل کن" / "operatör".
  if (
    settings.handoff_on_human_request &&
    humanRequestFromTopics &&
    decision.action !== 'handoff' &&
    decision.action !== 'skip'
  ) {
    (decision as any).action = 'handoff';
    (decision as any).reason = 'human_request';
    decisionTimeline.push('immediate_intent_human_request');
  }

  // Routing rule with action=handoff overrides the legacy decision.
  if (routingResult?.hardHandoff && decision.action !== 'skip') {
    (decision as any).action = 'handoff';
    (decision as any).reason = (decision as any).reason || 'routing_handoff';
    decisionTimeline.push('routing_handoff_executed');
  }
  // Trigger forced handoff also overrides legacy decision.
  if (triggerForcesHandoff && decision.action !== 'skip') {
    (decision as any).action = 'handoff';
    (decision as any).reason = (decision as any).reason || 'trigger_handoff';
  }
  // Pass D — workflow handoff / stopAi can also override legacy decision.
  if (workflowHandoffExecuted && decision.action !== 'skip') {
    (decision as any).action = 'handoff';
    (decision as any).reason = (decision as any).reason || 'workflow_handoff';
  }
  // Pass D — workflow stopAi without handoff: short-circuit before retrieval.
  if (workflowStopAi && !workflowHandoffExecuted && decision.action !== 'skip' && decision.action !== 'handoff') {
    const runId = await logRun(config, {
      workspaceId, conversationId, visitorMessageId,
      runType: 'auto_reply', mode: settings.mode, status: 'replied',
      inputText: question,
      outputText: '[workflow]',
      kbArticleIds: [], confidence: 1,
      metadata: { ...baseRuntimeMeta(), language: languageMeta, locale, workflow_only: true },
    });
    return { ran: true, action: 'replied', runId, messageId: workflowMessageId };
  }
  // If a trigger sent a static message with continue_ai=false, stop.
  if (stoppedByTrigger && decision.action !== 'skip' && decision.action !== 'handoff') {
    const runId = await logRun(config, {
      workspaceId, conversationId, visitorMessageId,
      runType: 'auto_reply', mode: settings.mode, status: 'replied',
      inputText: question,
      outputText: '[trigger]',
      kbArticleIds: [], confidence: 1,
      metadata: { ...baseRuntimeMeta(), language: languageMeta, locale, trigger_only: true },
    });
    return { ran: true, action: 'replied', runId, messageId: triggerMessageId };
  }
  // Routing rule with action=keep_ai prevents weak-confidence handoff.
  const routingKeepAi = !!routingResult?.keepAi;

  console.log('[ai-agent] policy decision', {
    conversationId,
    mode: settings.mode,
    action: decision.action,
    reason: decision.reason,
    availability: availability.state,
    topTopic: topTopicSlug,
    routingMatched: routingResult?.matchedRuleIds.length || 0,
    routingHardHandoff: !!routingResult?.hardHandoff,
    routingKeepAi,
  });

  // ─── Branch: SKIP ──────────────────────────────────────────────────────
  if (decision.action === 'skip') {
    // Limit-related skips deserve a human-friendly handoff template instead
    // of dead silence. Suggest-only mode skips the visitor message but still
    // routes to needs_human + logs the run.
    const limitReason: LimitReason | null =
      decision.reason === 'max_replies_reached' ? 'max_replies_reached' :
      decision.reason === 'rate_limited' ? 'rate_limited' : null;
    if (limitReason) {
      const result = await runLimitHandoff(config, {
        workspaceId,
        conversationId,
        visitorMessageId,
        question,
        locale,
        reason: limitReason,
        settings,
        suppressVisitorMessage: settings.mode === 'suggest_only',
        extraMetadata: { language: languageMeta, mode: settings.mode },
      });
      return {
        ran: true,
        action: 'handoff',
        reason: limitReason,
        runId: result.runId,
        messageId: result.messageId,
      };
    }
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
    // C2 hardening — if a trigger/tool already executed the handoff above,
    // do not call markNeedsHuman or insert a second handoff message.
    const handoffAlreadyDone = triggerForcesHandoff || workflowHandoffExecuted;
    if (!handoffAlreadyDone) {
      await markHandoffRequested(config, conversationId).catch(() => {});
    }
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'handoff',
      mode: settings.mode,
      status: 'handoff',
      inputText: question,
      skipReason: decision.reason,
      metadata: { ...baseRuntimeMeta(), language: languageMeta, locale },
    });
    // In auto-reply modes we acknowledge the handoff to the visitor. This
    // insert MUST happen before markNeedsHuman() below — markNeedsHuman
    // synchronously runs routing (chatRouting.ts) and inserts its own
    // "X joined" / "no one's available" system message, so the ack has to
    // land first or the visitor sees the routing outcome appear before the
    // AI ever says it's connecting them.
    let messageId: string | null = null;
    if (!handoffAlreadyDone && (decision.canAutoReply || settings.mode !== 'suggest_only')) {
      const display = deriveAgentDisplay(settings);
      const teamOffline = availability.state === 'offline';
      const ack = await resolveHandoffAckMessage(config, workspaceId, locale, teamOffline, pickHandoffAckMessage(settings, locale));
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
    } else if (handoffAlreadyDone) {
      messageId = triggerMessageId || workflowMessageId;
      decisionTimeline.push('handoff_message_already_sent');
    }
    if (!handoffAlreadyDone) {
      await markNeedsHuman(config, {
        workspaceId,
        conversationId,
        reason: 'human_request',
      }).catch(() => {});
    }
    // C2A — execute safe non-handoff routing actions (mark_priority).
    await applySafeRoutingSideEffects(config, workspaceId, conversationId, routingResult).catch(() => {});
    await updateRuntimeFlags(config, conversationId, { handoffSent: true }).catch(() => {});
    // Persist routing rule executed ids for dedup.
    if (routingResult) {
      for (const id of routingResult.matchedRuleIds) {
        await updateRuntimeFlags(config, conversationId, { appendRoutingRuleId: id }).catch(() => {});
      }
    }
    return { ran: true, action: 'handoff', reason: decision.reason, runId, messageId };
  }

  // From here we either suggest or auto-reply. Both need retrieval.
  // Phase B — conversation-aware query builder + Phase C synonym expansion.
  const built = await buildRetrievalQuery({
    config,
    workspaceId,
    conversationId,
    currentMessage: question,
    inputLanguage,
    widgetLocale: locale,
  });

  // Pass 2 — hybrid retrieval with safe fallback to keyword-only retriever.
  let sources: RetrievedSource[] = [];
  let hybridUsed = false;
  let vectorUsed = false;
  let keywordUsed = false;
  let embeddingProviderName: string | null = null;
  let embeddingModelName: string | null = null;
  let fallbackReason: string | null = null;
  let selectedSourcesMeta: Array<Record<string, unknown>> = [];
  let pageContextDebug: any = null;
  let retrievalDebug: any = null;
  let excludedSummary: any = null;
  try {
    const hybrid = await retrieveHybridSources(config, {
      workspaceId,
      originalMessage: built.originalMessage,
      retrievalQuery: built.retrievalQuery,
      expandedQuery: built.expandedQuery,
      responseLanguage: locale,
      inputLanguage,
      limit: 5,
      pageContext: pageContext ? {
        currentPageUrl: pageContext.currentPageUrl,
        currentPageOrigin: pageContext.currentPageOrigin,
        currentPagePath: pageContext.currentPagePath,
        currentPageTitle: pageContext.currentPageTitle,
      } : null,
    });
    hybridUsed = hybrid.hybridUsed;
    vectorUsed = hybrid.vectorUsed;
    keywordUsed = hybrid.keywordUsed;
    embeddingProviderName = hybrid.embeddingProvider;
    embeddingModelName = hybrid.embeddingModel;
    fallbackReason = hybrid.fallbackReason || null;
    pageContextDebug = hybrid.pageContextDebug || null;
    retrievalDebug = hybrid.retrievalDebug || null;
    excludedSummary = hybrid.excludedSummary || null;
    selectedSourcesMeta = hybrid.sources.map((s) => ({
      id: s.source_id,
      source_type: s.source_type,
      kind: (s.kind === 'qna' ? 'qna' : 'kb_article'),
      title: s.title,
      slug: s.slug ?? null,
      source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
      score: s.final_score,
      locale: s.locale ?? null,
      keyword_score: s.keyword_score,
      vector_score: s.vector_score,
      topic_boost: s.topic_boost,
      url_boost: s.url_boost,
      locale_bonus: s.locale_bonus,
      source_priority: s.source_priority,
      final_score: s.final_score,
    }));
    sources = hybrid.sources.map((s) => ({
      kind: (s.kind === 'qna' ? 'qna' : 'kb_article') as 'qna' | 'kb_article',
      id: s.source_id,
      title: s.title,
      excerpt: s.excerpt ?? null,
      content: s.content ?? null,
      slug: s.slug ?? null,
      locale: s.locale ?? null,
      score: s.final_score,
      // E2C — preserve original source_type + URL so prompt can label "Current page".
      source_type: s.source_type,
      source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
      url_boost: s.url_boost,
    } as any));
    if (!sources.length && (vectorUsed || keywordUsed)) {
      // Fall through to legacy retriever only if hybrid produced nothing AND
      // the simple keyword-only path might still find loose matches.
      const legacy = await retrieveSources(config, workspaceId, built.retrievalQuery, locale, 5);
      if (legacy.length) {
        sources = legacy;
        hybridUsed = false;
        selectedSourcesMeta = legacy.map((s) => ({
          id: s.id, source_type: s.kind, kind: s.kind,
          title: s.title, slug: s.slug ?? null, source_url: null,
          score: s.score, locale: s.locale ?? null,
          keyword_score: s.score, vector_score: 0,
          topic_boost: 0, url_boost: 0, locale_bonus: 0, source_priority: 0,
          final_score: s.score,
        }));
      }
    }
  } catch (err: any) {
    console.warn('[ai-agent.engine] hybrid retrieval failed, falling back to keyword:', err?.message);
    fallbackReason = `hybrid_throw:${err?.message || 'unknown'}`;
    sources = await retrieveSources(config, workspaceId, built.retrievalQuery, locale, 5);
    // PHASE 2 FIX: the legacy retriever IS a keyword search, and it just
    // executed -- keywordUsed must reflect that so top-level queryMeta and
    // the nested retrieval_debug.execution block (hardcoded below) agree on
    // what actually ran for this request, instead of the top-level flag
    // staying at its unrelated `false` initial value.
    keywordUsed = true;
    selectedSourcesMeta = sources.map((s) => ({
      id: s.id, source_type: s.kind, kind: s.kind,
      title: s.title, slug: s.slug ?? null, source_url: null,
      score: s.score, locale: s.locale ?? null,
      keyword_score: s.score, vector_score: 0,
      topic_boost: 0, url_boost: 0, locale_bonus: 0, source_priority: 0,
      final_score: s.score,
    }));
    retrievalDebug = {
      execution: { fallback_reason: 'legacy_retriever_used', hybrid_used: false, vector_used: false, keyword_used: true },
      selected_sources: [],
      excluded_sources_summary: null,
    };
    excludedSummary = null;
  }

  const queryMeta = {
    original_message: built.originalMessage,
    retrieval_query: built.retrievalQuery,
    expanded_query: built.expandedQuery,
    context_messages_used: built.contextMessagesUsed,
    topics: built.topics,
    added_terms_count: built.addedTerms.length,
    follow_up_detected: built.followUpDetected,
    previous_ai_asked_clarification: built.previousAiAskedClarification,
    retrieval_results_count: sources.length,
    hybrid_used: hybridUsed,
    vector_used: vectorUsed,
    keyword_used: keywordUsed,
    embedding_provider: embeddingProviderName,
    embedding_model: embeddingModelName,
    fallback_reason: fallbackReason,
    selected_sources: selectedSourcesMeta,
    page_context: pageContextDebug || null,
    // E5 — standardized observable retrieval debug (Inspector reads this).
    retrieval_debug: retrievalDebug,
    excluded_sources_summary: excludedSummary,
  };
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
    return { ran: true, action: 'replied', runId, messageId: inserted.id };
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
    return { ran: true, action: 'no_answer', reason: strategy.reason, runId };
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
          return { ran: true, action: 'handoff', reason: strategy.reason, runId, messageId: noAnsResult.lastMessageId || null };
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
        return { ran: true, action: 'handoff', reason: strategy.reason, runId, messageId: inserted.id };
      }
    }
    return { ran: true, action: 'no_answer', reason: strategy.reason, runId };
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
      return { ran: true, action: 'replied', runId, messageId: inserted.id };
    }
    return { ran: true, action: 'no_answer', reason: 'greeting_suggest_skipped', runId };
    }
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
      metadata: { ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta, retrieval: queryMeta },
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

  // Workspace navigation context — best-effort.
  const wsContext = await loadWorkspaceContext(config, workspaceId).catch(() => null);
  const systemPrompt = buildSystemPrompt(settings, locale, {
    responseLanguage: locale,
    inputLanguage,
    workspaceLinks: wsContext ? {
      pricing: wsContext.pricingUrl,
      contact: wsContext.contactUrl,
      help: wsContext.helpUrl,
      domain: wsContext.domain,
    } : undefined,
    extendedInstructions: runtimeCfg?.instructions,
    guidanceRules: runtimeCfg?.guidanceRules,
    topicSlug: topTopicSlug,
  });
  const userPrompt = buildUserPrompt(question, sources, strategy, {
    pageContext: pageContext ? { currentPageUrl: pageContext.currentPageUrl, currentPageTitle: pageContext.currentPageTitle } : null,
    pageMatched: pageExact || pagePath,
  });

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
    // Credit / plan-limit errors → human-friendly limit handoff (no LLM,
    // 0 credits, route to Needs human).
    const limitReason = detectLimitErrorReason(err?.message);
    if (limitReason) {
      const result = await runLimitHandoff(config, {
        workspaceId,
        conversationId,
        visitorMessageId,
        question,
        locale,
        reason: limitReason,
        settings,
        suppressVisitorMessage: settings.mode === 'suggest_only',
        extraMetadata: {
          language: languageMeta,
          retrieval: queryMeta,
          provider: aiConfig.provider,
          model: aiConfig.model,
          original_error: String(err?.message || ''),
        },
      });
      return {
        ran: true,
        action: 'handoff',
        reason: limitReason,
        runId: result.runId,
        messageId: result.messageId,
      };
    }
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
      metadata: { ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta, retrieval: queryMeta },
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
      metadata: { ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta, retrieval: queryMeta },
    });
    if (decision.canAutoReply) {
      await markHandoffRequested(config, conversationId).catch(() => {});
      // Insert the fallback/ack message BEFORE markNeedsHuman() — see the
      // ordering note on the human-request handoff branch above.
      const display = deriveAgentDisplay(settings);
      const handoffAckBody = settings.fallback_message
        || await resolveHandoffAckMessage(
          config, workspaceId, locale,
          availability.state === 'offline',
          pickHandoffAck(locale, display.agentName),
        );
      const inserted = await insertAiMessage(config, {
        workspaceId,
        conversationId,
        body: handoffAckBody,
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
        reason: 'low_confidence',
      }).catch(() => {});
      return { ran: true, action: 'handoff', reason: valid.reason, runId, messageId: inserted.id };
    }
    return { ran: true, action: 'handoff', reason: valid.reason, runId };
  }

  const kbIds = sources.filter((s) => s.kind === 'kb_article').map((s) => s.id);
  const qnaIds = sources.filter((s) => s.kind === 'qna').map((s) => s.id);

  // ─── AUTO REPLY → insert visitor-facing message ────────────────────────
  if (decision.canAutoReply) {
    decisionTimeline.push('answer_strategy_selected');
    decisionTimeline.push('reply_sent');
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
    });
    console.log('[ai-agent] auto reply sent', { conversationId, runId, messageId: inserted.id });
    // Keep conversation in the Automated inbox while AI is handling it.
    await markAiManaged(config, { workspaceId, conversationId }).catch(() => {});
    return { ran: true, action: 'replied', runId, messageId: inserted.id };
  }

  // ─── SUGGEST → operator-facing card (Phase 2 behaviour) ────────────────
  decisionTimeline.push('answer_strategy_selected');
  decisionTimeline.push('suggestion_sent');
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

// Suppress unused-var warning for _RetrievedSource if added later
export type { RetrievedSource };
