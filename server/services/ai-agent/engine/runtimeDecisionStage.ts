/**
 * AI Agent engine — runtime decision stage (decideRuntime + human-request/
 * routing/trigger/workflow overrides, workflow/trigger short-circuits, SKIP
 * branch, HANDOFF branch).
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit D). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, local baseRuntimeMeta() redefinition,
 * and terminal-result wrapping of existing early `return` statements) is
 * new. No behavior change. decideRuntime() itself is untouched.
 *
 * Handoff side-effect ordering (vNext blocker 1): the durable needs_human
 * commit happens FIRST, the visitor acknowledgement second, and operator
 * routing (which inserts its own system message) LAST. A failed commit
 * suppresses the acknowledgement entirely.
 */
import type { ServerConfig } from '../../../config.js';
import { decideRuntime } from '../runtimePolicy.js';
import { logRun } from '../logs.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { commitNeedsHuman, routeAfterHandoff, type HandoffCommit } from '../handoffState.js';

import { runLimitHandoff, type LimitReason } from '../limitHandoff.js';
import { updateRuntimeFlags } from '../runtime/conversationState.js';
import { pickHandoffAckMessage } from '../runtime/templates.js';
import { resolveHandoffAckMessage } from './helpers.js';
import {
  resolveHandoffPolicy, resolveMaxAssistAttempts, decideHandoff, handoffPolicyMeta,
  type HandoffPolicyDecision,
} from '../handoffPolicy.js';
import { persistWorkingMemory } from '../workingMemory.js';
import type { MaybeRunInput, MaybeRunResult } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';
import type { AutomationStageResult } from './automationStage.js';

export interface RuntimeDecisionStageResult {
  decision: ReturnType<typeof decideRuntime>;
  routingKeepAi: boolean;
  /**
   * vNext §16-19 — outcome of the adaptive handoff policy for this turn.
   * `null` when the turn was not a human request at all.
   */
  handoffPolicyDecision: HandoffPolicyDecision | null;
  /**
   * True when the policy converted an explicit human request into ONE brief
   * assist attempt. Generation must then acknowledge the request honestly
   * and must never claim a transfer already happened.
   */
  assistFirstActive: boolean;
}

export async function runRuntimeDecisionStage(
  config: ServerConfig,
  input: MaybeRunInput,
  pre: PreflightResult,
  ctxStage: ContextStageResult,
  auto: AutomationStageResult,
): Promise<{ terminal: MaybeRunResult } | RuntimeDecisionStageResult> {
  const { workspaceId, conversationId, visitorMessageId } = input;
  const question = (input.question || '').trim();
  const { settings, decisionTimeline } = pre;
  const {
    locale, inputLanguage, languageMeta, detectedTopicsMeta, topTopicSlug,
    humanRequestFromTopics, guidanceMeta, toolMeta, pageContextMetaRef,
    state, availability,
  } = ctxStage;
  const { routingMeta, triggerMeta, workflowMeta } = auto;
  const {
    routingResult, workflowStopAi, workflowHandoffExecuted, workflowMessageId,
    stoppedByTrigger, triggerMessageId, triggerForcesHandoff,
  } = auto;
  const runtimeCfg = pre.runtimeCfg;
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

  const operatorForcedReply = input.operatorReplyNow === true;
  const decision = decideRuntime({ settings, state, availability, visitorText: question, operatorForcedReply });
  if (operatorForcedReply) decisionTimeline.push('operator_reply_now');
  // If the visitor's intent matched the configured "human-request" topic but
  // the legacy keyword check did not fire, upgrade the decision to handoff so
  // we never miss an explicit "وصل کن" / "operatör".
  // Skipped for an operator-forced turn: the human is already in the loop and
  // has explicitly chosen to let the AI answer this message.
  if (
    !operatorForcedReply &&
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
    return { terminal: { ran: true, action: 'replied', runId, messageId: workflowMessageId } };
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
    return { terminal: { ran: true, action: 'replied', runId, messageId: triggerMessageId } };
  }
  // ─── vNext §16-19 — adaptive handoff policy ────────────────────────────
  // Applies ONLY to a visitor-driven human request. Routing rules, message
  // triggers and workflows that demand a human are mandatory and bypass it.
  const mandatoryHuman = !!routingResult?.hardHandoff || !!triggerForcesHandoff || !!workflowHandoffExecuted;
  let handoffPolicyDecision: HandoffPolicyDecision | null = null;
  let assistFirstActive = false;
  if (decision.action === 'handoff' && (decision as any).reason === 'human_request') {
    const policy = resolveHandoffPolicy(settings);
    handoffPolicyDecision = decideHandoff({
      policy,
      explicitHumanRequest: true,
      visitorText: question,
      memory: ctxStage.memory,
      maxAssistAttempts: resolveMaxAssistAttempts(settings),
      mandatoryHuman,
    });
    if (handoffPolicyDecision.kind === 'assist_once') {
      // Downgrade to a normal AI turn. Recomputed through the SAME policy
      // function with the human-request rule disabled, so every other guard
      // (caps, throttles, takeover, mode) still applies unchanged.
      const downgraded = decideRuntime({
        settings: { ...settings, handoff_on_human_request: false } as typeof settings,
        state,
        availability,
        visitorText: question,
      });
      if (downgraded.action !== 'handoff') {
        (decision as any).action = downgraded.action;
        (decision as any).reason = downgraded.reason;
        (decision as any).canAutoReply = downgraded.canAutoReply;
        (decision as any).canSuggest = downgraded.canSuggest;
        assistFirstActive = true;
        decisionTimeline.push('handoff_assist_first');
      } else {
        handoffPolicyDecision = { ...handoffPolicyDecision, kind: 'handoff', reason: 'downgrade_unavailable' };
      }
    }
    // Durable counters: a repeated explicit request can never be deflected
    // again, even across processes (§19).
    await persistWorkingMemory(config, {
      workspaceId,
      conversationId,
      patch: {
        incrementHandoffRequests: true,
        ...(assistFirstActive ? { incrementAssistAttempts: true } : {}),
      },
    }).catch(() => {});
    if (handoffPolicyDecision) {
      decisionTimeline.push(`handoff_policy_${handoffPolicyDecision.kind}`);
    }
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
        terminal: {
          ran: true,
          action: 'handoff',
          reason: limitReason,
          runId: result.runId,
          messageId: result.messageId,
        },
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
    return { terminal: { ran: false, action: 'skipped', reason: decision.reason, runId } };
  }

  // ─── Branch: HANDOFF (human request) ───────────────────────────────────
  if (decision.action === 'handoff') {
    // C2 hardening — if a trigger/tool already executed the handoff above,
    // do not call commitNeedsHuman or insert a second handoff message.
    const handoffAlreadyDone = triggerForcesHandoff || workflowHandoffExecuted;
    // vNext final blocker 1 — NO pre-handoff marker is written here. The old
    // markHandoffRequested() pre-write left `ai_handoff_requested = true`
    // behind whenever the canonical commit below failed, which made
    // checkGenerationFreshness() report `handoff_in_progress` forever and
    // muted all future legitimate AI generations. commitNeedsHuman() already
    // persists that flag (plus ai_state/managed_by_ai/reason/timestamp)
    // atomically, so it is the FIRST and ONLY durable handoff transition.
    //
    // ORDER: commit the durable handoff state FIRST, then acknowledge to the
    // visitor, then run routing.
    //   commit  → the conversation really is in the human queue
    //   ack     → truthful ("queued"), and still lands before the routing
    //             outcome message ("X joined" / "everyone is busy") because
    //             routing is deferred to routeAfterHandoff() below
    // If the commit fails we send NO acknowledgement: the visitor must never
    // be told they were handed to a human when nothing was persisted.
    let commit: HandoffCommit | null = null;
    if (!handoffAlreadyDone) {
      commit = await commitNeedsHuman(config, {
        workspaceId,
        conversationId,
        reason: 'human_request',
      }).catch(() => ({ ok: false, routingDeferred: false } as HandoffCommit));
      decisionTimeline.push(commit.ok ? 'handoff_state_committed' : 'handoff_state_commit_failed');
    }
    const handoffDurable = handoffAlreadyDone || !!commit?.ok;
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'handoff',
      // Truthful logging — a failed canonical commit is NOT a handoff.
      status: handoffDurable ? 'handoff' : 'failed',
      mode: settings.mode,
      inputText: question,
      skipReason: handoffDurable ? decision.reason : 'handoff_state_commit_failed',
      metadata: {
        ...baseRuntimeMeta(), language: languageMeta, locale,
        ...(handoffPolicyDecision ? handoffPolicyMeta(handoffPolicyDecision) : {}),
        ...ctxStage.memoryMetaBundle,
        handoff_committed: handoffDurable,
        ...(handoffDurable ? {} : { handoff_failure: 'handoff_state_commit_failed' }),
      },
    });
    let messageId: string | null = null;
    const mayAck = !handoffAlreadyDone && !!commit?.ok
      && (decision.canAutoReply || settings.mode !== 'suggest_only');
    if (mayAck) {
      const display = deriveAgentDisplay(settings);
      const teamOffline = availability.state === 'offline';
      const ack = await resolveHandoffAckMessage(config, workspaceId, locale, teamOffline, pickHandoffAckMessage(settings, locale), conversationId);
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
    } else if (commit && !commit.ok) {
      decisionTimeline.push('handoff_ack_suppressed_commit_failed');
    }
    if (commit) {
      await routeAfterHandoff(config, { workspaceId, conversationId, commit });
    }

    // mark_priority now executes unconditionally right after PRE routing
    // evaluation in automationStage.ts (Follow-up 9E.2) — calling it again
    // here would execute it twice, so this branch no longer does so.
    //
    // vNext final blocker 3 — `handoffSent` is an "a handoff really was
    // executed" marker. It may only be recorded when the canonical commit
    // succeeded, or when a trigger/workflow already executed one.
    if (handoffDurable) {
      await updateRuntimeFlags(config, conversationId, { handoffSent: true }).catch(() => {});
    }
    // Persist routing rule executed ids for dedup.
    if (routingResult) {
      for (const id of routingResult.matchedRuleIds) {
        await updateRuntimeFlags(config, conversationId, { appendRoutingRuleId: id }).catch(() => {});
      }
    }
    return {
      terminal: {
        ran: handoffDurable,
        action: handoffDurable ? 'handoff' : 'skipped',
        reason: handoffDurable ? decision.reason : 'handoff_state_commit_failed',
        runId,
        messageId,
      },
    };
  }



  return { decision, routingKeepAi, handoffPolicyDecision, assistFirstActive };
}
