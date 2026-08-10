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
import { executeAICompletion, resolveAIConfig } from '../../ai/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompt.js';
import { isStrictKbNoGrounding } from '../answerStrategy.js';
import { postValidateAnswer } from '../policy.js';
import { logRun } from '../logs.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { markNeedsHuman } from '../handoffState.js';
import { markHandoffRequested } from '../conversationState.js';
import { runLimitHandoff, detectLimitErrorReason } from '../limitHandoff.js';
import { loadWorkspaceContext } from '../workspaceContext.js';
import { resolveHandoffAckMessage, pickHandoffAck } from './helpers.js';
import type { MaybeRunInput, MaybeRunResult } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';
import type { AutomationStageResult } from './automationStage.js';
import type { RuntimeDecisionStageResult } from './runtimeDecisionStage.js';
import type { RetrievalStageResult } from './retrievalStage.js';
import type { AnswerStageResult } from './answerStage.js';

export interface GenerationStageResult {
  aiResult: Awaited<ReturnType<typeof executeAICompletion>>;
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
    guidanceMeta, availability,
  } = ctxStage;
  const { decision } = decisionStage;
  const { sources, queryMeta } = retrieval;
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

  // ─── Follow-up 9D.1/9D.2 — load-bearing strict-KB provider guard ──────
  // The single, unconditional choke point every path must cross before a
  // provider call happens. AnswerStage's routingKeepAi check is the
  // "normal path" fix (preserves full handoff/no-answer messaging); this is
  // the last-resort backstop for any other upstream decisionType mutation
  // (present or future — e.g. the greeting-dedup fallthrough) that reaches
  // here despite strict-KB having no qualifying grounding. Never fabricate
  // an answer here — fail closed with a plain, observable skip.
  if (isStrictKbNoGrounding(settings, strategy.retrievalStrength)) {
    decisionTimeline.push('strict_kb_safety_block');
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: decision.canAutoReply ? 'auto_reply' : 'suggestion',
      mode: settings.mode,
      status: 'skipped',
      inputText: question,
      skipReason: 'strict_kb_safety_block',
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: strategy.confidence,
      metadata: { ...baseRuntimeMeta(), answer_strategy: strategyMeta, locale, language: languageMeta, retrieval: queryMeta },
    });
    return { terminal: { ran: false, action: 'skipped', reason: 'strict_kb_safety_block', runId } };
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
      return { terminal: { ran: true, action: 'handoff', reason: valid.reason, runId, messageId: inserted.id } };
    }
    return { terminal: { ran: true, action: 'handoff', reason: valid.reason, runId } };
  }

  return { aiResult };
}
