/**
 * AI Agent engine — automation stage (routing, message triggers, workflow
 * match/execute, pre-retrieval trigger action execution).
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit C). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, and final return statement) is
 * new. No behavior change; this stage has no early/terminal returns in the
 * original code. Only orchestration code moved -- evaluateRoutingRules,
 * evaluateMessageTriggers, evaluateWorkflows, executeMatchedWorkflows, and
 * executeRuntimeActions themselves are untouched.
 *
 * `buildEvalCtx` calls Date.now() fresh on every invocation (both here and
 * later in the answer stage's no-answer hooks) -- preserved exactly by
 * keeping it as a function, never precomputed.
 */
import type { ServerConfig } from '../../../config.js';
import {
  evaluateRoutingRules, evaluateRoutingRulesForTriggerTypes, buildRoutingMetadata,
  PRE_STRATEGY_ROUTING_TRIGGER_TYPES,
} from '../runtime/routingRuntime.js';
import { evaluateMessageTriggers, type TriggerEvaluationResult } from '../runtime/triggerRuntime.js';
import { evaluateWorkflows, buildWorkflowMetadata, type WorkflowEvaluationResult } from '../runtime/workflowRuntime.js';
import { executeRuntimeActions } from '../runtime/actionExecutor.js';
import { executeMatchedWorkflows, buildExecutedWorkflowMetadata } from '../runtime/workflowExecutor.js';
import { applySafeRoutingSideEffects } from './helpers.js';
import type { MaybeRunInput } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';

export interface AutomationStageResult {
  routingResult: ReturnType<typeof evaluateRoutingRules> | null;
  routingMeta: ContextStageResult['routingMeta'];
  triggerMeta: ContextStageResult['triggerMeta'];
  workflowMeta: ContextStageResult['workflowMeta'];
  buildEvalCtx: (extra?: { answerStrategy?: any }) => any;
  workflowStopAi: boolean;
  workflowHandoffExecuted: boolean;
  workflowMessageId: string | null;
  stoppedByTrigger: boolean;
  triggerMessageId: string | null;
  triggerForcesHandoff: boolean;
}

export async function runAutomationStage(
  config: ServerConfig,
  input: MaybeRunInput,
  pre: PreflightResult,
  ctxStage: ContextStageResult,
): Promise<AutomationStageResult> {
  const { workspaceId, conversationId, visitorMessageId } = input;
  const question = (input.question || '').trim();
  const { settings, runtimeCfg, decisionTimeline } = pre;
  const { locale, inputLanguage, detectedTopicsMeta, humanRequestFromTopics, state, availability } = ctxStage;
  let { routingMeta, triggerMeta, workflowMeta } = ctxStage;

  // ─── C2A — evaluate routing rules ────────────────────────────────────
  // Pure evaluation. Side-effects (handoff, mark_priority) executed below.
  let routingResult: ReturnType<typeof evaluateRoutingRules> | null = null;
  if (runtimeCfg?.routingRules?.length) {
    try {
      const topTopic = (detectedTopicsMeta as any)?.topTopic
        ? { slug: (detectedTopicsMeta as any).topTopic.slug, name: (detectedTopicsMeta as any).topTopic.name } as any
        : null;
      routingResult = evaluateRoutingRulesForTriggerTypes({
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
        // Already computed in contextStage — zero new DB IO (Follow-up 9C).
        availabilityReason: availability?.reason ?? null,
        now: Date.now(),
      }, PRE_STRATEGY_ROUTING_TRIGGER_TYPES);
      routingMeta = buildRoutingMetadata(routingResult, 'pre_strategy');
      decisionTimeline.push('routing_evaluated');
      // Follow-up 9E.2 — mark_priority must execute whenever PRE routing
      // evaluation matches it, independent of whether the message later
      // answers, retrieves, or hands off. Previously this only ran inside
      // runtimeDecisionStage's HANDOFF branch, so a matched-but-classified-
      // executed mark_priority action silently never wrote to the DB on the
      // normal (non-handoff) path — see runtimeDecisionStage.ts for the
      // corresponding removal.
      await applySafeRoutingSideEffects(config, workspaceId, conversationId, routingResult).catch(() => {});
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

  return {
    routingResult, routingMeta, triggerMeta, workflowMeta, buildEvalCtx,
    workflowStopAi, workflowHandoffExecuted, workflowMessageId,
    stoppedByTrigger, triggerMessageId, triggerForcesHandoff,
  };
}
