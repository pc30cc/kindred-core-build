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
 * Handoff side-effect ordering preserved exactly: the acknowledgement
 * message is inserted BEFORE markNeedsHuman() (which synchronously runs
 * chatRouting.ts and inserts its own system message) -- see the inline
 * comment carried over from the original.
 */
import type { ServerConfig } from '../../../config.js';
import { decideRuntime } from '../runtimePolicy.js';
import { logRun } from '../logs.js';
import { markHandoffRequested } from '../conversationState.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { markNeedsHuman } from '../handoffState.js';
import { runLimitHandoff, type LimitReason } from '../limitHandoff.js';
import { updateRuntimeFlags } from '../runtime/conversationState.js';
import { pickHandoffAckMessage } from '../runtime/templates.js';
import { resolveHandoffAckMessage } from './helpers.js';
import { composeHandoffMessage } from '../handoffMessage.js';
import type { MaybeRunInput, MaybeRunResult } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';
import type { AutomationStageResult } from './automationStage.js';

export interface RuntimeDecisionStageResult {
  decision: ReturnType<typeof decideRuntime>;
  routingKeepAi: boolean;
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
      const configuredAck = await resolveHandoffAckMessage(config, workspaceId, locale, teamOffline, pickHandoffAckMessage(settings, locale));
      // Phase 9 — context-aware wording, owner text as tone guidance and
      // as the fallback whenever generation is unavailable.
      const ack = await composeHandoffMessage(config, {
        workspaceId,
        locale,
        reason: (decision as any).reason || 'handoff',
        visitorText: question,
        conversationContext: null,
        settings,
        fallback: configuredAck,
      });
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
    // mark_priority now executes unconditionally right after PRE routing
    // evaluation in automationStage.ts (Follow-up 9E.2) — calling it again
    // here would execute it twice, so this branch no longer does so.
    await updateRuntimeFlags(config, conversationId, { handoffSent: true }).catch(() => {});
    // Persist routing rule executed ids for dedup.
    if (routingResult) {
      for (const id of routingResult.matchedRuleIds) {
        await updateRuntimeFlags(config, conversationId, { appendRoutingRuleId: id }).catch(() => {});
      }
    }
    return { terminal: { ran: true, action: 'handoff', reason: decision.reason, runId, messageId } };
  }

  return { decision, routingKeepAi };
}
