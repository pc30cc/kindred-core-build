/**
 * AI Agent — Playground engine.
 *
 * Phase 1: same backend pipeline that real auto-reply will use in Phase 2,
 * but with run_type='playground' and NO message insertion into any
 * conversation. Safe to call from the operator UI.
 */
import type { ServerConfig } from '../../config.js';
import { executeAICompletion, resolveAIConfig } from '../ai/index.js';
import { getOrCreateSettings } from './settings.js';
import { retrieveSources } from './retrieval.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { decide, postValidateAnswer, type DecisionAction } from './policy.js';
import { logRun } from './logs.js';

export interface PlaygroundInput {
  workspaceId: string;
  question: string;
  locale: string;
  guidanceOverride?: 'conservative' | 'balanced' | 'creative';
  modelOverride?: string;
}

export interface PlaygroundResult {
  action: DecisionAction;
  answer: string | null;
  retrievedArticles: Array<{
    id: string;
    kind: 'qna' | 'kb_article';
    title: string;
    slug?: string | null;
    locale?: string | null;
    score: number;
  }>;
  confidence: number;
  provider: string | null;
  model: string | null;
  creditsUsed: number;
  runId: string | null;
  fallbackMessage: string;
  debug: Record<string, unknown>;
}

export async function runPlayground(
  config: ServerConfig,
  input: PlaygroundInput,
): Promise<PlaygroundResult> {
  const settings = await getOrCreateSettings(config, input.workspaceId);
  const effectiveSettings = input.guidanceOverride
    ? { ...settings, answer_guidance: input.guidanceOverride }
    : settings;

  const aiConfig = await resolveAIConfig(config, input.workspaceId);
  const sources = await retrieveSources(
    config,
    input.workspaceId,
    input.question,
    input.locale,
    5,
  );

  const decision = decide({
    settings: effectiveSettings,
    question: input.question,
    sources,
  });

  const retrievedSummary = sources.map((s) => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    slug: s.slug ?? null,
    locale: s.locale ?? null,
    score: Number(s.score.toFixed(3)),
  }));

  // Branches that don't need an LLM call
  if (decision.action !== 'answer') {
    const runId = await logRun(config, {
      workspaceId: input.workspaceId,
      runType: 'playground',
      mode: settings.mode,
      status: decision.action === 'handoff' ? 'handoff' : 'no_answer',
      inputText: input.question,
      outputText: null,
      skipReason: decision.reason ?? null,
      provider: aiConfig?.provider ?? null,
      model: input.modelOverride || aiConfig?.model || null,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
      metadata: { decision },
    });
    return {
      action: decision.action,
      answer: null,
      retrievedArticles: retrievedSummary,
      confidence: decision.confidence,
      provider: aiConfig?.provider ?? null,
      model: input.modelOverride || aiConfig?.model || null,
      creditsUsed: 0,
      runId,
      fallbackMessage: settings.fallback_message,
      debug: { decision, locale: input.locale },
    };
  }

  if (!aiConfig) {
    const runId = await logRun(config, {
      workspaceId: input.workspaceId,
      runType: 'playground',
      mode: settings.mode,
      status: 'failed',
      inputText: input.question,
      errorMessage: 'no_ai_provider_configured',
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
    });
    return {
      action: 'blocked',
      answer: null,
      retrievedArticles: retrievedSummary,
      confidence: decision.confidence,
      provider: null,
      model: null,
      creditsUsed: 0,
      runId,
      fallbackMessage: settings.fallback_message,
      debug: { reason: 'no_ai_provider_configured' },
    };
  }

  const systemPrompt = buildSystemPrompt(effectiveSettings, input.locale);
  const userPrompt = buildUserPrompt(input.question, sources);

  try {
    const result = await executeAICompletion(config, {
      workspaceId: input.workspaceId,
      prompt: userPrompt,
      systemPrompt,
      model: input.modelOverride,
      maxTokens: 600,
      temperature: settings.answer_guidance === 'creative' ? 0.6 : settings.answer_guidance === 'balanced' ? 0.4 : 0.2,
      billing: { entryPoint: 'agent_playground' },
    });

    const valid = postValidateAnswer(result.text);
    if (!valid.ok) {
      const runId = await logRun(config, {
        workspaceId: input.workspaceId,
        runType: 'playground',
        mode: settings.mode,
        status: 'handoff',
        inputText: input.question,
        outputText: result.text,
        skipReason: valid.reason,
        provider: result.provider,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
        confidence: decision.confidence,
      });
      return {
        action: 'handoff',
        answer: null,
        retrievedArticles: retrievedSummary,
        confidence: decision.confidence,
        provider: result.provider,
        model: result.model,
        creditsUsed: 0,
        runId,
        fallbackMessage: settings.fallback_message,
        debug: { decision, postValidate: valid },
      };
    }

    const runId = await logRun(config, {
      workspaceId: input.workspaceId,
      runType: 'playground',
      mode: settings.mode,
      status: 'replied',
      inputText: input.question,
      outputText: result.text,
      provider: result.provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
      metadata: { latencyMs: result.latencyMs },
    });

    return {
      action: 'answer',
      answer: result.text,
      retrievedArticles: retrievedSummary,
      confidence: decision.confidence,
      provider: result.provider,
      model: result.model,
      creditsUsed: 0,
      runId,
      fallbackMessage: settings.fallback_message,
      debug: { decision, latencyMs: result.latencyMs },
    };
  } catch (err: any) {
    const runId = await logRun(config, {
      workspaceId: input.workspaceId,
      runType: 'playground',
      mode: settings.mode,
      status: 'failed',
      inputText: input.question,
      errorMessage: err?.message || 'ai_call_failed',
      provider: aiConfig.provider,
      model: input.modelOverride || aiConfig.model,
      kbArticleIds: sources.filter((s) => s.kind === 'kb_article').map((s) => s.id),
      confidence: decision.confidence,
    });
    return {
      action: 'blocked',
      answer: null,
      retrievedArticles: retrievedSummary,
      confidence: decision.confidence,
      provider: aiConfig.provider,
      model: input.modelOverride || aiConfig.model,
      creditsUsed: 0,
      runId,
      fallbackMessage: settings.fallback_message,
      debug: { error: err?.message || 'ai_call_failed' },
    };
  }
}