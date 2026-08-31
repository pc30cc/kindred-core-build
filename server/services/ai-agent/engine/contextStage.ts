/**
 * AI Agent engine — context stage (locale/language, topics, guidance,
 * runtime-metadata bundle init, conversation state + operator availability).
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit B). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, and final return statement) is
 * new. No behavior change. This stage has no early/terminal returns in the
 * original code.
 *
 * Preserves the Promise.all parallel fetch of conversation state and
 * operator availability, and the Phase 2 Persian-language detection fix
 * (delegated to decideResponseLanguage/detectInputLanguage, untouched).
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getConversationState } from '../conversationState.js';
import { getOperatorAvailability } from '../availability.js';
import { decideResponseLanguage, detectInputLanguage } from '../language.js';
import { detectTopics } from '../topics/detector.js';
import { buildRoutingMetadata } from '../runtime/routingRuntime.js';
import { buildTriggerMetadata } from '../runtime/triggerRuntime.js';
import { buildToolMetadata } from '../runtime/toolRuntime.js';
import { getPlatformAllowedLocales } from '../../platformRegion.js';
import { loadActiveGuidance, type ActiveGuidanceBundle } from '../guidance.js';
import {
  loadWorkingMemory, deriveTurnPatch, applyMemoryPatch, renderMemoryBlock,
  memoryMeta, type WorkingMemory, type MemoryPatch,
} from '../workingMemory.js';
import type { MaybeRunInput } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import { resolveHumanRequestSignal, NO_HUMAN_REQUEST, type HumanRequestSignal } from '../humanRequest.js';

export interface ContextStageResult {
  sb: ReturnType<typeof getServiceClient>;
  locale: string;
  /** workspaces.name — business display name for the system prompt. */
  workspaceName: string | null;
  inputLanguage: string;
  languageMeta: Record<string, unknown>;
  detectedTopicsMeta: Record<string, unknown>;
  topTopicSlug: string | null;
  /** Supporting-only topic evidence. NOT authority to hand off. */
  humanRequestFromTopics: boolean;
  /** Canonical, authoritative explicit-human-request signal (P0-5). */
  humanRequest: HumanRequestSignal;
  guidanceMeta: Record<string, unknown>;
  routingMeta: ReturnType<typeof buildRoutingMetadata>;
  triggerMeta: ReturnType<typeof buildTriggerMetadata>;
  workflowMeta: {
    matchedWorkflowIds: string[];
    matchedWorkflowNames: string[];
    executedActions: any[];
    blockedActions: any[];
    plannedActions: any[];
    skippedActions: any[];
    runtimeExecutionEnabled: boolean;
    safeExecutionOnly: boolean;
  };
  toolMeta: ReturnType<typeof buildToolMetadata>;
  pageContextMetaRef: any;
  state: Awaited<ReturnType<typeof getConversationState>>;
  availability: Awaited<ReturnType<typeof getOperatorAvailability>>;
  /** vNext — private operator guidance active for this generation. */
  operatorGuidance: ActiveGuidanceBundle;
  /** vNext — bounded working memory AFTER folding in this turn's signals. */
  memory: WorkingMemory;
  /** Deterministic patch derived from this turn (persisted by delivery). */
  memoryTurnPatch: MemoryPatch;
  memoryBlock: string | null;
  memoryMetaBundle: Record<string, unknown>;
  /** Text of the most recent assistant message, for reference resolution. */
  previousAssistantText: string | null;
}

export async function runContextStage(
  config: ServerConfig,
  input: MaybeRunInput,
  pre: PreflightResult,
): Promise<ContextStageResult> {
  const { workspaceId, conversationId } = input;
  const question = (input.question || '').trim();
  const { settings, runtimeCfg, decisionTimeline, pageContext, isPageIntent } = pre;

  // Resolve locale (explicit > workspace > 'en')
  const sb = getServiceClient(config);
  // Read workspace locale info once — needed by language service.
  // Column names must match the real schema — `locale` / `widget_language`
  // do not exist and made this query error out, silently dropping the
  // workspace's language configuration from the decision.
  const { data: wsRow } = await sb
    .from('workspaces')
    .select('name, default_locale, widget_locale')
    .eq('id', workspaceId)
    .maybeSingle();
  const widgetLocale = (wsRow as any)?.widget_locale || '';
  // Business display name — feeds the dynamic assistant identity prompt.
  const workspaceName = ((wsRow as any)?.name || '').toString().trim() || null;
  const workspaceLocale = (wsRow as any)?.default_locale || '';

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
    const widgetNorm = (widgetLocale || '').toLowerCase().split('-')[0];
    const wsNorm = (workspaceLocale || '').toLowerCase().split('-')[0];
    locale = allowList.includes(widgetNorm)
      ? widgetNorm
      : allowList.includes(wsNorm)
        ? wsNorm
        : allowList[0];
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

  // Gather state in parallel — runtime policy needs all of it.
  // vNext additions (operator guidance, working memory, last assistant turn)
  // are best-effort reads: each degrades to an empty value on failure and can
  // never break the existing auto-reply flow.
  const [state, availability, operatorGuidance, storedMemory, previousAssistantText] = await Promise.all([
    getConversationState(config, workspaceId, conversationId),
    getOperatorAvailability(config, workspaceId, locale),
    loadActiveGuidance(config, workspaceId, conversationId),
    loadWorkingMemory(config, workspaceId, conversationId),
    loadPreviousAssistantText(sb, conversationId),
  ]);

  // Deterministic resolution awareness: fold "that link is broken" /
  // "I tried that, it didn't work" into memory with ZERO provider calls.
  const memoryTurnPatch = deriveTurnPatch({
    visitorText: question,
    previousAssistantText,
    memory: storedMemory,
  });
  const memory = Object.keys(memoryTurnPatch).length
    ? applyMemoryPatch(storedMemory, memoryTurnPatch)
    : storedMemory;
  const memoryBlock = renderMemoryBlock(memory);
  const memoryMetaBundle = memoryMeta(memory);
  if (operatorGuidance.items.length) decisionTimeline.push('operator_guidance_loaded');
  if (memoryBlock) decisionTimeline.push('conversation_memory_loaded');

  // Canonical explicit human-request resolution. Topic evidence is passed in
  // as SUPPORTING context only — it can never flip `explicit` on its own.
  const humanRequest: HumanRequestSignal = settings.handoff_on_human_request === false
    ? { ...NO_HUMAN_REQUEST, supporting: { topicHumanRequest: humanRequestFromTopics, genericKeywordMention: null } }
    : resolveHumanRequestSignal({
        text: question,
        configuredKeywords: settings.handoff_keywords || [],
        topicHumanRequest: humanRequestFromTopics,
      });
  if (humanRequest.explicit) decisionTimeline.push(`human_request_explicit:${humanRequest.reason}`);
  else if (humanRequest.supporting.topicHumanRequest) decisionTimeline.push('human_request_topic_support_only');

  return {
    sb, locale, workspaceName, inputLanguage, languageMeta, detectedTopicsMeta, topTopicSlug,
    humanRequestFromTopics, humanRequest, guidanceMeta, routingMeta, triggerMeta, workflowMeta,
    toolMeta, pageContextMetaRef, state, availability,
    operatorGuidance, memory, memoryTurnPatch, memoryBlock, memoryMetaBundle,
    previousAssistantText,
  };
}

/**
 * Last assistant-authored message body. Used to resolve "this link doesn't
 * open" to the exact URL the assistant offered.
 */
async function loadPreviousAssistantText(
  sb: ReturnType<typeof getServiceClient>,
  conversationId: string,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const { data } = await sb
      .from('conversation_messages')
      .select('body,sender_type,metadata,created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(12);
    for (const m of data || []) {
      const st = String((m as any).sender_type || '').toLowerCase();
      const src = String(((m as any).metadata || {}).source || '');
      if (st === 'ai' || st === 'bot' || src.startsWith('ai_agent')) {
        return String((m as any).body || '') || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
