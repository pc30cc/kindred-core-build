/**
 * AI Agent engine — generation stage (provider resolution, suggestion
 * dedupe, prompt construction, LLM execution, limit-error handling,
 * post-validation).
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit G). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, local baseRuntimeMeta()
 * redefinition, and terminal-result wrapping of existing early `return`
 * statements) is new. No behavior change. Provider orchestration
 * (resolveAIConfig/executeAICompletion), prompt text, temperatures, and
 * retry semantics are all untouched.
 */
import type { ServerConfig } from '../../../config.js';
import { executeAICompletion, executeAICompletionWithConfig, resolveAIConfig } from '../../ai/index.js';
// `executeAICompletion` is still referenced by the GenerationStageResult type.
import { buildSystemPrompt, buildUserPrompt } from '../prompt.js';
import { toModelMessages } from '../conversationContext.js';
import { postValidateAnswer } from '../policy.js';
import { logRun } from '../logs.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { commitNeedsHuman, routeAfterHandoff, type HandoffCommit } from '../handoffState.js';
import { markHandoffRequested } from '../conversationState.js';
import { runLimitHandoff, detectLimitErrorReason } from '../limitHandoff.js';
import { loadWorkspaceContext } from '../workspaceContext.js';
import { redactSecrets } from '../../../lib/redactSecrets.js';
import {
  ACTION_CATALOG, getActionDefinition, parseActionPlan, runActionPipeline,
  createRealActionRunner, createConversationIdempotencyStore, readExecutedActionKeys,
  wantsBusinessHours, renderToolResults, type GateContext,
} from '../actions/index.js';
import { resolveHandoffAckMessage, pickHandoffAck } from './helpers.js';
import { checkGenerationFreshness, freshnessMeta } from '../freshness.js';
import { parseAiControl, buildAiControlContract, type AiControl } from '../aiControl.js';
import { createGuidanceRequest, hasPendingGuidanceRequest } from '../guidance.js';
import { assistFirstMessage } from '../handoffPolicy.js';
import type { MemoryPatch } from '../workingMemory.js';
import type { MaybeRunInput, MaybeRunResult } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';
import type { AutomationStageResult } from './automationStage.js';
import type { RuntimeDecisionStageResult } from './runtimeDecisionStage.js';
import type { RetrievalStageResult } from './retrievalStage.js';
import type { AnswerStageResult } from './answerStage.js';

export interface GenerationStageResult {
  aiResult: Awaited<ReturnType<typeof executeAICompletion>>;
  /** Phase 3 — action pipeline observability metadata (3.13). */
  actionsMeta?: Record<string, unknown> | null;
  /** Phase 3 — true when handoff executed through the action pipeline. */
  actionHandoffExecuted?: boolean;
  /** vNext — parsed private status block (never visitor-visible). */
  aiControl?: AiControl | null;
  /** vNext — memory patch to persist at delivery time. */
  memoryPatch?: MemoryPatch | null;
  /** vNext — freshness/guidance observability for the run log. */
  vnextMeta?: Record<string, unknown> | null;
}

export async function runGenerationStage(
  config: ServerConfig,
  input: MaybeRunInput,
  pre: PreflightResult,
  ctxStage: ContextStageResult,
  auto: AutomationStageResult,
  decisionStage: RuntimeDecisionStageResult,
  retrieval: RetrievalStageResult,
  answer: AnswerStageResult,
): Promise<{ terminal: MaybeRunResult } | GenerationStageResult> {
  const { workspaceId, conversationId, visitorMessageId } = input;
  const question = (input.question || '').trim();
  const { settings, runtimeCfg, decisionTimeline, pageContext } = pre;
  const {
    sb, locale, inputLanguage, languageMeta, detectedTopicsMeta, topTopicSlug,
    guidanceMeta, availability, state,
    operatorGuidance, memoryBlock, memoryTurnPatch,
  } = ctxStage;
  const { decision } = decisionStage;
  const { sources, queryMeta, built } = retrieval;
  const {
    strategy, strategyMeta, pageExact, pagePath, triggerMeta, workflowMeta, toolMeta, pageContextMetaRef,
    // Merged pre+post routing metadata (Follow-up 9E.2) — supersedes
    // auto.routingMeta, which only ever reflected the pre-strategy phase.
    routingMeta,
  } = answer;

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

  // ─── vNext §20-24 — freshness checkpoint #1 (pre-generation) ──────────
  // Never spend a provider call on a turn the visitor has already
  // superseded or a human has already taken over.
  const freshPre = await checkGenerationFreshness(config, {
    workspaceId, conversationId, visitorMessageId, checkpoint: 'pre_generation',
  });
  if (!freshPre.fresh) {
    decisionTimeline.push(`stale_${freshPre.reason}`);
    return { terminal: { ran: false, action: 'skipped', reason: `stale_${freshPre.reason || 'superseded'}` } };
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

    // P0-AI — the provider disappeared after /widget/config said the AI was
    // ready (key deleted, provider disabled, plan change). The engine has
    // DEFINITIVELY established that no provider can answer this turn, so the
    // conversation must not stay silently in ai_state=ai_managed: hand it to
    // humans through the same durable machinery every other terminal
    // "AI cannot continue" reason uses (commit needs_human FIRST, only then
    // acknowledge, then route). Idempotent per conversation+reason, so a
    // second visitor message does not re-send the template.
    // In suggest_only the AI is operator-facing, so no visitor message.
    const fallback = await runLimitHandoff(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      question,
      locale,
      reason: 'no_ai_provider',
      settings,
      suppressVisitorMessage: settings.mode === 'suggest_only',
      extraMetadata: {
        language: languageMeta,
        retrieval: queryMeta,
        provider_unavailable: true,
      },
    }).catch(() => null);

    // Only claim a handoff when the durable transition actually happened.
    if (fallback && fallback.committed === true) {
      return {
        terminal: {
          ran: true,
          action: 'handoff',
          reason: 'no_ai_provider_handoff',
          runId: fallback.runId || runId,
          messageId: fallback.messageId,
        },
      };
    }
    return { terminal: { ran: true, action: 'failed', reason: 'no_ai_provider_configured', runId } };
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
      return { terminal: { ran: false, action: 'skipped', reason: 'duplicate_suggestion', suggestionId: existing.id } };
    }
  }

  // Workspace navigation context — best-effort.
  const wsContext = await loadWorkspaceContext(config, workspaceId).catch(() => null);
  // ─── Phase 3 — enabled internal actions (canonical catalog ∩ workspace) ──
  const enabledActionNames = (runtimeCfg?.internalTools || [])
    .filter((t: any) => t && t.enabled !== false && t.tool_type === 'internal')
    .map((t: any) => String(t.name))
    .filter((n: string) => {
      const def = getActionDefinition(n);
      return !!def && def.executable;
    });
  // ─── Phase 3.7 — read-only tool result fed back into generation ─────────
  let toolResultsBlock: string | null = null;
  const readOnlyToolResults: Record<string, unknown>[] = [];
  if (enabledActionNames.includes('get_business_hours') && wantsBusinessHours(question)) {
    toolResultsBlock = renderToolResults([{
      name: 'get_business_hours',
      data: { operators_online: availability.state === 'online', availability_reason: availability.reason },
    }]);
    readOnlyToolResults.push({ name: 'get_business_hours', ok: true });
  }
  // A guidance request only makes sense when a human could actually answer
  // it soon: operators reachable, AI still owns the conversation, and no
  // request is already pending for this conversation.
  const guidanceRequestPending = conversationId
    ? await hasPendingGuidanceRequest(config, workspaceId, conversationId).catch(() => false)
    : false;
  const allowGuidanceRequest =
    !!conversationId
    && !guidanceRequestPending
    && availability.state !== 'offline'
    && !(state?.humanTakeoverAt || state?.hasHumanAgentReplied);

  const systemPrompt = buildSystemPrompt(settings, locale, {
    responseLanguage: locale,
    inputLanguage,
    businessName: ctxStage.workspaceName,
    handoffGuidance: (settings.handoff_message_localized || {})[locale] || settings.fallback_message || null,
    workspaceLinks: wsContext ? {
      pricing: wsContext.pricingUrl,
      contact: wsContext.contactUrl,
      help: wsContext.helpUrl,
      domain: wsContext.domain,
    } : undefined,
    extendedInstructions: runtimeCfg?.instructions,
    guidanceRules: runtimeCfg?.guidanceRules,
    topicSlug: topTopicSlug,
    enabledActions: enabledActionNames,
    // vNext — private, non-visitor-visible context.
    operatorGuidanceBlock: operatorGuidance?.promptBlock || null,
    conversationMemoryBlock: memoryBlock,
    aiControlContract: buildAiControlContract({ allowGuidanceRequest: allowGuidanceRequest }),
  });
  // Phase 11 — real role-tagged history. Providers that accept a message
  // array get system + user/assistant turns + the current message; the
  // rendered text block is only used as a fallback for that same context.
  // The current visitor message is delivered separately as `prompt`, so it
  // must never be duplicated as the last history turn.
  const historyMessages = toModelMessages(built?.contextTurns || [])
    .filter((m, i, arr) => !(i === arr.length - 1 && m.role === 'user' && m.content.trim() === question));
  const userPrompt = buildUserPrompt(question, sources, strategy, {
    pageContext: pageContext ? { currentPageUrl: pageContext.currentPageUrl, currentPageTitle: pageContext.currentPageTitle } : null,
    pageMatched: pageExact || pagePath,
    // Phase 2.1 — bounded multi-turn context, already tenant-scoped.
    conversationContext: historyMessages.length ? null : (built?.conversationContext || null),
    // Phase 2.7 — warn the model when sources materially disagree.
    conflictDetected: strategy.conflictDetected,
    toolResults: toolResultsBlock,
  }) + (decisionStage.assistFirstActive
    ? `\n\nTURN DIRECTIVE — the visitor asked for a human. A transfer has NOT happened. Acknowledge the request in one short sentence, then make exactly ONE genuinely useful attempt at their actual problem, and close by offering the transfer. Never imply the transfer is already in progress. Suggested tone: "${assistFirstMessage(locale)}"`
    : '');

  let aiResult;
  /** Observability for the empty-output retry (P0-18). */
  const generationMeta: Record<string, unknown> = {};
  try {
    // P2: aiConfig was already resolved above — reuse it instead of paying for
    // a second provider-config lookup inside executeAICompletion().
    aiResult = await executeAICompletionWithConfig(config, aiConfig, {
      workspaceId,
      prompt: userPrompt,
      systemPrompt,
      messages: historyMessages,
      maxTokens: 600,
      temperature:
        settings.answer_guidance === 'creative' ? 0.6 :
        settings.answer_guidance === 'balanced' ? 0.4 : 0.2,
    }, input.runCtx ?? undefined);
    // ROOT CAUSE GUARD — reasoning models (gpt-5*, o-series) can burn the
    // whole completion budget on hidden reasoning and return EMPTY text with
    // finish_reason === 'length'. That is a transient generation failure, NOT
    // the AI declining to answer, and it must never escalate to a human.
    // One bounded retry with a larger visible-output budget.
    const emptyOutput = !String(aiResult?.text || '').trim();
    const lengthCapped = String((aiResult as any)?.finishReason || '') === 'length';
    if (emptyOutput) {
      generationMeta.empty_first_attempt = true;
      generationMeta.first_attempt_finish_reason = (aiResult as any)?.finishReason || null;
      generationMeta.first_attempt_completion_tokens = aiResult?.completionTokens ?? null;
      const retry = await executeAICompletionWithConfig(config, aiConfig, {
        workspaceId,
        prompt: userPrompt,
        systemPrompt,
        messages: historyMessages,
        maxTokens: lengthCapped ? 1600 : 900,
        temperature:
          settings.answer_guidance === 'creative' ? 0.6 :
          settings.answer_guidance === 'balanced' ? 0.4 : 0.2,
      }, input.runCtx ?? undefined).catch(() => null);
      if (retry && String(retry.text || '').trim()) {
        aiResult = retry;
        generationMeta.empty_output_retry = 'recovered';
        decisionTimeline.push('generation_empty_retry_recovered');
      } else {
        generationMeta.empty_output_retry = 'failed';
        decisionTimeline.push('generation_empty_retry_failed');
      }
    }
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
          // Provider/network errors can embed credentials — never persist raw.
          original_error: redactSecrets(err?.message) || 'unknown_error',
        },
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
    return { terminal: { ran: true, action: 'failed', reason: err?.message || 'ai_call_failed', runId } };
  }

  // ─── vNext §25-31 — private status block ──────────────────────────────
  // Parsed and STRIPPED before anything else touches the text, so the
  // control JSON can never reach the visitor even if a later stage fails.
  const parsedControl = parseAiControl(aiResult.text || '');
  aiResult = { ...aiResult, text: parsedControl.text };
  const aiControl = parsedControl.control;

  // Fold model-reported state into the deterministic memory patch. Model
  // input is advisory: bounded fields only, never counters or authorization.
  const memoryPatch: MemoryPatch = {
    ...memoryTurnPatch,
    ...(aiControl.currentIssue ? { currentIssue: aiControl.currentIssue } : {}),
    ...(aiControl.awaitingUserAction ? { awaitingUserAction: aiControl.awaitingUserAction } : {}),
    ...(aiControl.entities.length ? { addEntities: aiControl.entities } : {}),
    ...(aiControl.resolutionStatus !== 'unknown'
      ? { issueStatus: aiControl.resolutionStatus === 'resolved' ? 'resolved' as const
          : aiControl.resolutionStatus === 'awaiting_user' ? 'awaiting_user' as const
          : 'open' as const }
      : {}),
    ...(aiControl.proposedSolution
      ? { addAttempt: { summary: aiControl.proposedSolution, status: 'proposed' as const } }
      : {}),
  };

  // Model-requested human guidance → private operator request. This NEVER
  // messages the visitor and never routes the conversation by itself.
  let guidanceRequestId: string | null = null;
  if (aiControl.requestHumanGuidance && allowGuidanceRequest && aiControl.guidanceQuestion) {
    const created = await createGuidanceRequest(config, {
      workspaceId,
      conversationId,
      question: aiControl.guidanceQuestion,
      visitorQuestion: question,
      visitorMessageId,
      missingInformation: aiControl.missingInformation,
      knownSummary: aiControl.knownSummary,
    }).catch(() => null);
    guidanceRequestId = created?.request?.id || null;
    if (guidanceRequestId) decisionTimeline.push('guidance_requested');
  }

  const vnextMeta: Record<string, unknown> = {
    ...freshnessMeta(freshPre),
    ...(operatorGuidance?.meta || {}),
    ...ctxStage.memoryMetaBundle,
    ai_control: {
      present: parsedControl.blockPresent,
      parse_error: parsedControl.parseError,
      resolution_status: aiControl.resolutionStatus,
      guidance_requested: !!guidanceRequestId,
    },
    ...(decisionStage.handoffPolicyDecision
      ? { handoff_policy: decisionStage.handoffPolicyDecision.policy,
          handoff_policy_kind: decisionStage.handoffPolicyDecision.kind }
      : {}),
  };

  // ─── Phase 3 — plan → gate → execute → record, BEFORE delivery (3.8) ────
  let actionsMeta: Record<string, unknown> | null = null;
  let actionHandoffExecuted = false;
  if (conversationId && (parseActionPlan(aiResult.text || '').blockPresent || enabledActionNames.length)) {
    try {
      const { data: convRow } = await sb
        .from('conversations')
        .select('workspace_id,priority,tags,metadata')
        .eq('id', conversationId)
        .maybeSingle();
      const gate: GateContext = {
        workspaceId,
        conversationId,
        conversationWorkspaceId: (convRow as any)?.workspace_id ?? null,
        visitorMessageId,
        visitorText: question,
        enabledActionNames,
        mode: settings.mode,
        aiEnabled: settings.mode !== 'off',
        canAutoReply: !!decision.canAutoReply,
        canSuggest: !!decision.canSuggest,
        humanTakeover: !!state?.humanTakeoverAt || !!state?.hasHumanAgentReplied,
        aiManaged: state ? state.managedByAi !== false : true,
        strictKb: !!settings.answer_only_from_kb,
        handoffKeywords: (settings as any).handoff_keywords || [],
        // The model may propose a handoff; deterministic authorization is
        // an explicit human request (checked inside the gate), a strategy
        // handoff, or a genuine verified-information gap on this turn.
        strategyHandoffRequired:
          strategy.decisionType === 'handoff'
          || (strategy.groundingMode === 'unverified' && settings.handoff_when_no_kb_match !== false),
        currentPriority: (convRow as any)?.priority ?? null,
        currentTags: Array.isArray((convRow as any)?.tags) ? (convRow as any).tags : [],
        executedKeys: readExecutedActionKeys((convRow as any)?.metadata),
        // Model output is never authorization: deterministic side effects such
        // as add_tag require an explicit runtime/workspace-configured basis.
        // Workspace-configured workflows/routing keep tagging via their own
        // deterministic executor path, untouched by this list.
        deterministicAuthorizedActions: [],
      };
      const pipeline = await runActionPipeline({
        rawText: aiResult.text || '',
        gate,
        runner: createRealActionRunner({
          config,
          workspaceId,
          conversationId,
          responseLanguage: locale,
          settings,
          locale,
        }),
        idempotency: createConversationIdempotencyStore(config, conversationId, gate.executedKeys || [], { workspaceId }),
        fallbackText: aiResult.text || '',
      });
      aiResult = { ...aiResult, text: pipeline.text };
      actionHandoffExecuted = pipeline.handoffExecuted;
      actionsMeta = {
        catalog_size: Object.keys(ACTION_CATALOG).length,
        enabled: enabledActionNames,
        read_only_results: readOnlyToolResults,
        ...pipeline.metadata,
      };
    } catch (err: any) {
      actionsMeta = { error: redactSecrets(err?.message) || 'action_pipeline_failed' };
    }
  } else if (readOnlyToolResults.length) {
    actionsMeta = { enabled: enabledActionNames, read_only_results: readOnlyToolResults };
  }

  // Clarifying questions can legitimately be short / "I'm not sure".
  // Only post-validate when we expected a confident answer.
  const valid =
    strategy.decisionType === 'ask_clarifying_question'
      ? { ok: true as const }
      : postValidateAnswer(aiResult.text || '', {
          groundingMode: strategy.groundingMode as any,
          escalateOnUncertainty: settings.handoff_when_no_kb_match !== false,
        });
  if (!valid.ok) {
    // The AI itself bailed out. This becomes a handoff ONLY if the durable
    // needs_human transition actually persists — same invariant as
    // runtimeDecisionStage: commit → derive durability → truthful log →
    // ack only if committed → routing only if committed.
    let commit: HandoffCommit | null = null;
    if (decision.canAutoReply) {
      commit = await commitNeedsHuman(config, {
        workspaceId,
        conversationId,
        reason: 'low_confidence',
      }).catch(() => ({ ok: false, routingDeferred: false } as HandoffCommit));
      decisionTimeline.push(commit.ok ? 'handoff_state_committed' : 'handoff_state_commit_failed');
    }
    const handoffDurable = !!commit?.ok;
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: handoffDurable ? 'handoff' : 'auto_reply',
      mode: settings.mode,
      status: handoffDurable ? 'handoff' : 'failed',
      inputText: question,
      outputText: aiResult.text,
      skipReason: handoffDurable ? valid.reason : 'handoff_state_commit_failed',
      provider: aiResult.provider,
      model: aiResult.model,
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: strategy.confidence,
      metadata: {
        ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta,
        retrieval: queryMeta, generation: generationMeta,
        handoff_attempt_source: 'post_validation_failed',
        handoff_committed: handoffDurable,
        // Only a committed transition may claim to be the final handoff source.
        ...(handoffDurable
          ? { final_handoff_source: 'post_validation_failed' }
          : { handoff_failure: 'handoff_state_commit_failed' }),
      },
    });
    if (!handoffDurable) {
      if (commit && !commit.ok) decisionTimeline.push('handoff_ack_suppressed_commit_failed');
      return {
        terminal: {
          ran: false,
          action: commit ? 'failed' : 'no_answer',
          reason: commit ? 'handoff_state_commit_failed' : valid.reason,
          runId,
        },
      };
    }
    const display = deriveAgentDisplay(settings);
    const handoffAckBody = settings.fallback_message
      || await resolveHandoffAckMessage(
        config, workspaceId, locale,
        availability.state === 'offline',
        pickHandoffAck(locale, display.agentName),
        conversationId,
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
    if (commit) await routeAfterHandoff(config, { workspaceId, conversationId, commit });
    return { terminal: { ran: true, action: 'handoff', reason: valid.reason, runId, messageId: inserted.id } };
  }


  // ─── vNext — freshness checkpoint #2 (post-generation) ────────────────
  const freshPost = await checkGenerationFreshness(config, {
    workspaceId, conversationId, visitorMessageId, checkpoint: 'post_generation',
  });
  if (!freshPost.fresh) {
    decisionTimeline.push(`stale_${freshPost.reason}`);
    const runId = await logRun(config, {
      workspaceId, conversationId, visitorMessageId,
      runType: 'auto_reply', mode: settings.mode, status: 'skipped',
      inputText: question, outputText: aiResult.text,
      skipReason: `stale_${freshPost.reason || 'superseded'}`,
      provider: aiResult.provider, model: aiResult.model,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: strategy.confidence,
      metadata: { ...baseRuntimeMeta(), ...vnextMeta, ...freshnessMeta(freshPost), locale, language: languageMeta },
    });
    return { terminal: { ran: false, action: 'skipped', reason: `stale_${freshPost.reason || 'superseded'}`, runId } };
  }

  return { aiResult, actionsMeta, actionHandoffExecuted, aiControl, memoryPatch, vnextMeta };
}
