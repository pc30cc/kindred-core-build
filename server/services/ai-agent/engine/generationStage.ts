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
import { toModelMessages, type ContextTurn } from '../conversationContext.js';
import { postValidateAnswer, type PostValidateContext } from '../policy.js';
import type { InternalToolRecord } from '../runtimeConfig.js';
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
import { runCommerceToolStage } from '../commerce-tools/runner.js';
import { runWhmcsToolStage, hasWhmcsData, intentForAccountData, type WhmcsStageResult } from '../commerce-tools/whmcsRunner.js';
import { listWorkspaceConnections, selectConnection } from '../../commerce/connectionSelection.js';
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
import { repairCommerceLinks, urlsFromToolResults, verifyStoreLinks } from '../commerce-tools/answerLinks.js';

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
  const { settings, runtimeCfg, decisionTimeline, pageContext, nudgeContext } = pre;
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
    .filter((t: InternalToolRecord | null) => t && t.enabled !== false && t.tool_type === 'internal')
    .map((t: InternalToolRecord) => String(t.name))
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
  // Commerce Integration Platform (docs/commerce/ARCHITECTURE.md) — a
  // bounded, deterministic pre-generation stage, never a model-driven tool
  // loop. Never throws; a workspace with no commerce connection pays only
  // the cost of a regex intent check. Merged into the SAME sanitized
  // "factual data only" tool-results block get_business_hours already uses.
  //
  // The workspace's live connections are read ONCE here and shared by the
  // store stage, the WHMCS stage and the link verifier (each used to do its
  // own "newest connection" lookup). The page the visitor is on decides which
  // connection a turn is about — see commerce/connectionSelection.ts.
  const commerceConnections = await listWorkspaceConnections(config, workspaceId).catch(() => null);
  const commerceSite = {
    pageOrigin: pageContext?.currentPageOrigin ?? null,
    pagePath: pageContext?.currentPagePath ?? null,
  };
  const commerceStage = await runCommerceToolStage(config, {
    workspaceId, conversationId: conversationId || null, question,
    locale, connections: commerceConnections ?? undefined, ...commerceSite,
  }).catch(() => ({ toolResults: [], toolsUsed: [] } as Awaited<ReturnType<typeof runCommerceToolStage>>));
  const commerceUrls = [...urlsFromToolResults(commerceStage.toolResults), ...(commerceStage.allowedUrls ?? [])];
  // The signed-in store customer changed (or signed out) in this browser:
  // turns from before that must not carry the previous customer's private
  // answers into this prompt (combined with the WHMCS cutoff below).
  const storeCutoffMs = commerceStage.historyCutoffAt ? Date.parse(commerceStage.historyCutoffAt) : NaN;
  if (commerceStage.toolResults.length) {
    const commerceBlock = renderToolResults(commerceStage.toolResults);
    toolResultsBlock = [toolResultsBlock, commerceBlock].filter(Boolean).join('\n');
    for (const t of commerceStage.toolsUsed) readOnlyToolResults.push({ name: t, ok: true });
  }
  // WHMCS (billing/hosting accounts). Runs only when the message is about
  // plans or the visitor's own account; otherwise it returns before any I/O.
  const previousVisitorTurns = (built?.contextTurns || [])
    .filter((t) => t.role === 'visitor' && typeof t.text === 'string' && t.text.trim() && t.text.trim() !== question)
    .map((t) => t.text)
    .slice(-4);
  const whmcsStage: WhmcsStageResult | null = commerceConnections && commerceConnections.some((c) => c.provider_type === 'whmcs')
    ? await runWhmcsToolStage(config, {
        workspaceId, conversationId: conversationId || null, question,
        connections: commerceConnections, ...commerceSite, previousVisitorTurns,
      }).catch(() => null)
    : null;
  if (whmcsStage?.toolResults.length) {
    const whmcsBlock = renderToolResults(whmcsStage.toolResults);
    toolResultsBlock = [toolResultsBlock, whmcsBlock].filter(Boolean).join('\n');
    for (const t of whmcsStage.toolsUsed) readOnlyToolResults.push({ name: t, ok: true });
  }
  const whmcsAccountTurn = whmcsStage?.intent === 'account' && whmcsStage.toolResults.length > 0;
  // A different WHMCS subject (other client account, other user, or after a
  // logout) must not see the previous subject's answers in the prompt.
  const whmcsCutoffMs = whmcsAccountTurn && whmcsStage?.historyCutoff ? Date.parse(whmcsStage.historyCutoff) : NaN;
  // The later of the two cutoffs applies (a store customer switch, a WHMCS
  // subject change); NaN when neither does.
  const cutoffs = [storeCutoffMs, whmcsCutoffMs].filter(Number.isFinite);
  const historyCutoffMs = cutoffs.length ? Math.max(...cutoffs) : NaN;
  const historyCut = Number.isFinite(historyCutoffMs);
  // Fast-path misses: when a billing connection is in context for this turn
  // and the deterministic router fetched nothing, the SAME generation may
  // name the account section it needed in its private control block. One
  // bounded follow-up (below) then fetches it and regenerates once — no
  // separate router model, no loop, and still no authority from the model.
  const whmcsConnectionInContext = commerceConnections
    ? selectConnection(commerceConnections, { family: 'billing', ...commerceSite }).connection
    : null;
  const offerAccountData = !!whmcsConnectionInContext && !!conversationId && !hasWhmcsData(whmcsStage);
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
    // After a WHMCS subject change the stored memory describes the previous
    // subject's conversation; it is left out of this account turn's prompt.
    conversationMemoryBlock: historyCut ? null : memoryBlock,
    aiControlContract: buildAiControlContract({ allowGuidanceRequest: allowGuidanceRequest, allowAccountDataRequest: offerAccountData }),
  });
  // Phase 11 — real role-tagged history. Providers that accept a message
  // array get system + user/assistant turns + the current message; the
  // rendered text block is only used as a fallback for that same context.
  // The current visitor message is delivered separately as `prompt`, so it
  // must never be duplicated as the last history turn.
  const turnsSince = (cutoffMs: number): ContextTurn[] => (Number.isFinite(cutoffMs)
    ? (built?.contextTurns || []).filter((t) => !!t.createdAt && Date.parse(t.createdAt) >= cutoffMs)
    : (built?.contextTurns || []));
  const messagesFor = (turns: ContextTurn[]) => toModelMessages(turns)
    .filter((m, i, arr) => !(i === arr.length - 1 && m.role === 'user' && m.content.trim() === question));
  const composeUserPrompt = (toolBlock: string | null, directive: string | null, cut: boolean, messages: ReturnType<typeof messagesFor>) =>
    buildUserPrompt(question, sources, strategy, {
      pageContext: pageContext ? { currentPageUrl: pageContext.currentPageUrl, currentPageTitle: pageContext.currentPageTitle } : null,
      pageMatched: pageExact || pagePath,
      // Phase 2.1 — bounded multi-turn context, already tenant-scoped.
      // The rendered text fallback carries the SAME history; after a WHMCS
      // subject change it would reintroduce exactly what was cut above.
      conversationContext: messages.length || cut ? null : (built?.conversationContext || null),
      // Phase 2.7 — warn the model when sources materially disagree.
      conflictDetected: strategy.conflictDetected,
      toolResults: toolBlock,
      nudgeContext: nudgeContext || null,
    }) + (directive ? `\n\n${directive}` : '') + (decisionStage.assistFirstActive
      ? `\n\nTURN DIRECTIVE — the visitor asked for a human. A transfer has NOT happened. Acknowledge the request in one short sentence, then make exactly ONE genuinely useful attempt at their actual problem, and close by offering the transfer. Never imply the transfer is already in progress. Suggested tone: "${assistFirstMessage(locale)}"`
      : '');
  const historyMessages = messagesFor(turnsSince(historyCutoffMs));
  const userPrompt = composeUserPrompt(toolResultsBlock, whmcsStage?.directive ?? null, historyCut, historyMessages);

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
    const lengthCapped = String((aiResult as { finishReason?: unknown } | null)?.finishReason || '') === 'length';
    if (emptyOutput) {
      generationMeta.empty_first_attempt = true;
      generationMeta.first_attempt_finish_reason = (aiResult as { finishReason?: unknown } | null)?.finishReason || null;
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
  } catch (caught: unknown) {
    const err = caught as { message?: string } | null;
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
  let aiControl = parsedControl.control;

  // ─── WHMCS fast-path miss → one bounded fetch + one regeneration ───────
  let whmcsFallback: WhmcsStageResult | null = null;
  if (offerAccountData && aiControl.accountData) {
    decisionTimeline.push(`whmcs_model_requested_${aiControl.accountData}`);
    generationMeta.whmcs_fallback = 'requested';
    whmcsFallback = await runWhmcsToolStage(config, {
      workspaceId, conversationId: conversationId || null, question,
      connections: commerceConnections, ...commerceSite, previousVisitorTurns,
      forcedIntent: intentForAccountData(aiControl.accountData, question),
    }).catch(() => null);
    // Regenerate only when real rows came back. A refusal (not signed in,
    // no permission, unavailable) adds nothing the first answer lacked.
    if (hasWhmcsData(whmcsFallback)) {
      const fallbackCutMs = whmcsFallback.historyCutoff ? Date.parse(whmcsFallback.historyCutoff) : NaN;
      const fallbackMessages = messagesFor(turnsSince(fallbackCutMs));
      const fallbackPrompt = composeUserPrompt(
        [toolResultsBlock, renderToolResults(whmcsFallback.toolResults)].filter(Boolean).join('\n'),
        whmcsFallback.directive,
        Number.isFinite(fallbackCutMs),
        fallbackMessages,
      );
      const regenerated = await executeAICompletionWithConfig(config, aiConfig, {
        workspaceId,
        prompt: fallbackPrompt,
        systemPrompt,
        messages: fallbackMessages,
        maxTokens: 600,
        temperature:
          settings.answer_guidance === 'creative' ? 0.6 :
          settings.answer_guidance === 'balanced' ? 0.4 : 0.2,
      }, input.runCtx ?? undefined).catch(() => null);
      if (regenerated && String(regenerated.text || '').trim()) {
        const reparsed = parseAiControl(regenerated.text || '');
        aiResult = { ...regenerated, text: reparsed.text };
        // Bounded to ONE extra round: a second request is ignored.
        aiControl = { ...reparsed.control, accountData: null };
        generationMeta.whmcs_fallback = 'regenerated';
        for (const t of whmcsFallback.toolsUsed) readOnlyToolResults.push({ name: t, ok: true });
      } else {
        generationMeta.whmcs_fallback = 'regeneration_failed';
      }
    } else {
      generationMeta.whmcs_fallback = 'no_data';
    }
  }
  const whmcsUrls = [...(whmcsStage?.urls ?? []), ...(hasWhmcsData(whmcsFallback) ? whmcsFallback!.urls : [])];

  // A store link the model RETYPED instead of copying is a 404 presented as
  // fact. Done here, before the action pipeline and before anything is
  // logged, so every downstream consumer sees the same repaired text.
  //
  // Two passes, because the turn's own tool results are not enough: asked
  // «لینکشو بده» — which carries no commerce intent, so no tool runs — the
  // model invented a link to a product it had described a turn earlier. The
  // second pass answers to the catalogue rather than to the turn, and costs
  // nothing when the answer has no link in it.
  if (commerceUrls.length) {
    aiResult = { ...aiResult, text: repairCommerceLinks(aiResult.text || '', commerceUrls) };
  }
  // WHMCS links: only the ones this turn's results carried survive on the
  // billing host; a retyped one is repaired or dropped the same way.
  if (whmcsUrls.length) {
    aiResult = { ...aiResult, text: repairCommerceLinks(aiResult.text || '', whmcsUrls) };
  }
  aiResult = {
    ...aiResult,
    text: await verifyStoreLinks(config, workspaceId, aiResult.text || '', {
      connections: commerceConnections ?? undefined, ...commerceSite,
      conversationId: conversationId || null,
      allowedUrls: commerceUrls,
    }).catch(() => aiResult.text || ''),
  };

  // Fold model-reported state into the deterministic memory patch. Model
  // input is advisory: bounded fields only, never counters or authorization.
  // On a WHMCS account turn the model's free-text memory fields could hold
  // invoice amounts or service details; persisting them would be a second,
  // unmanaged copy of account data. Only the deterministic patch is kept.
  const accountDataShown = whmcsAccountTurn || (whmcsFallback?.intent === 'account' && hasWhmcsData(whmcsFallback));
  const modelMemory = accountDataShown ? { ...aiControl, currentIssue: null, awaitingUserAction: null, entities: [], proposedSolution: null } : aiControl;
  const memoryPatch: MemoryPatch = {
    ...memoryTurnPatch,
    ...(modelMemory.currentIssue ? { currentIssue: modelMemory.currentIssue } : {}),
    ...(modelMemory.awaitingUserAction ? { awaitingUserAction: modelMemory.awaitingUserAction } : {}),
    ...(modelMemory.entities.length ? { addEntities: modelMemory.entities } : {}),
    ...(aiControl.resolutionStatus !== 'unknown'
      ? { issueStatus: aiControl.resolutionStatus === 'resolved' ? 'resolved' as const
          : aiControl.resolutionStatus === 'awaiting_user' ? 'awaiting_user' as const
          : 'open' as const }
      : {}),
    ...(modelMemory.proposedSolution
      ? { addAttempt: { summary: modelMemory.proposedSolution, status: 'proposed' as const } }
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
      const { data: convData } = await sb
        .from('conversations')
        .select('workspace_id,priority,tags,metadata')
        .eq('id', conversationId)
        .maybeSingle();
      const convRow = convData as { workspace_id?: string | null; priority?: string | null; tags?: unknown; metadata?: unknown } | null;
      const gate: GateContext = {
        workspaceId,
        conversationId,
        conversationWorkspaceId: convRow?.workspace_id ?? null,
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
        handoffKeywords: (settings as { handoff_keywords?: string[] }).handoff_keywords || [],
        // The model may propose a handoff; deterministic authorization is
        // an explicit human request (checked inside the gate), a strategy
        // handoff, or a genuine verified-information gap on this turn.
        strategyHandoffRequired:
          strategy.decisionType === 'handoff'
          || (strategy.groundingMode === 'unverified' && settings.handoff_when_no_kb_match !== false),
        currentPriority: convRow?.priority ?? null,
        currentTags: Array.isArray(convRow?.tags) ? (convRow.tags as string[]) : [],
        executedKeys: readExecutedActionKeys(convRow?.metadata as Parameters<typeof readExecutedActionKeys>[0]),
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
    } catch (caught: unknown) {
      const err = caught as { message?: string } | null;
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
          groundingMode: strategy.groundingMode as PostValidateContext['groundingMode'],
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
