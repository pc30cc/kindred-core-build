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
import type { MaybeRunInput } from './types.js';
import type { PreflightResult } from './preflightStage.js';

export interface ContextStageResult {
  sb: ReturnType<typeof getServiceClient>;
  locale: string;
  /** workspaces.name — business display name for the system prompt. */
  workspaceName: string | null;
  inputLanguage: string;
  languageMeta: Record<string, unknown>;
  detectedTopicsMeta: Record<string, unknown>;
  topTopicSlug: string | null;
  humanRequestFromTopics: boolean;
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

  return {
    sb, locale, workspaceName, inputLanguage, languageMeta, detectedTopicsMeta, topTopicSlug,
    humanRequestFromTopics, guidanceMeta, routingMeta, triggerMeta, workflowMeta,
    toolMeta, pageContextMetaRef, state, availability,
  };
}
