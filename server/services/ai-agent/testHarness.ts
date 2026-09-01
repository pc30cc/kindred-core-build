/**
 * AI Agent — Pass E6 — Test Harness (dry-run runtime + evaluator).
 *
 * Self-host. Pure read-only execution path that mirrors the real runtime
 * pipeline (settings → hybrid retrieval → answer strategy → optional LLM
 * call) but writes ZERO conversation side effects:
 *   - never inserts conversation_messages
 *   - never creates handoffs
 *   - never triggers workflows / message triggers / internal tools
 *   - never creates learning candidates
 *   - never calls MCP / webhooks / external HTTP execution
 *
 * Workspace isolation: retrieval is the same workspace-scoped function the
 * widget uses (retrieveHybridSources), and ai_knowledge_chunks.status='active'
 * is enforced inside that function (E5). Pending/rejected/unapproved learning
 * candidates are filtered there as well (E5-Final).
 */
import type { ServerConfig } from '../../config.js';
import { getOrCreateSettings } from './settings.js';
import { retrieveHybridSources, type HybridSource } from './retrievalHybrid.js';
import { decideStrategy } from './answerStrategy.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { resolveAIConfig, executeAICompletion } from '../ai/index.js';
import type { RetrievedSource } from './retrieval.js';

export interface DryRunInput {
  workspaceId: string;
  message: string;
  locale?: string;
  pageContext?: {
    currentPageUrl?: string | null;
    currentPageOrigin?: string | null;
    currentPagePath?: string | null;
    currentPageTitle?: string | null;
  } | null;
  /** Default true — skip LLM call entirely if false. */
  callLLM?: boolean;
}

export interface DryRunSelectedSource {
  id: string;
  source_id: string;
  source_type: string;
  kind: string;
  title: string;
  source_url: string | null;
  locale: string | null;
  final_score: number;
  keyword_score: number;
  vector_score: number;
  topic_boost: number;
  url_boost: number;
  locale_bonus: number;
  source_priority: number;
}

export interface DryRunResult {
  status: 'replied' | 'no_answer' | 'handoff' | 'clarification' | 'failed';
  output_text: string | null;
  confidence: number;
  selected_sources: DryRunSelectedSource[];
  retrieval_debug: any;
  excluded_summary: any;
  page_context: any;
  answer_strategy: {
    action: 'answer' | 'handoff' | 'clarification' | 'no_answer';
    decision_type: string;
    reason: string;
    retrieval_strength: string;
    top_score: number;
    handoff_required: boolean;
    source_types_used: string[];
  };
  prompt_preview: { system: string; user: string } | null;
  safety_notes: string[];
  provider: string | null;
  model: string | null;
  error?: string | null;
  runtime: {
    conversation_created: boolean;
    handoff_created: boolean;
    workflow_executed: boolean;
    learning_candidate_created: boolean;
    llm_called: boolean;
    /**
     * AI usage logging — when llm_called=true, executeAICompletion writes
     * to ai_usage_logs (provider/token/cost). This is NOT a visitor
     * conversation side effect; purely AI-cost telemetry.
     * Value can be "unknown" when an LLM call was attempted but threw
     * before the usage log path could complete deterministically.
     */
    ai_usage_logged: boolean | 'unknown';
  };
  runtime_parity: {
    retrieval: 'real_hybrid_retrieval';
    query_expansion: 'not_used' | 'used';
    conversation_history: 'not_used';
    workflow_execution: 'disabled';
    handoff_execution: 'disabled';
    learning_generation: 'disabled';
  };
}

const SENSITIVE_KEY_PATTERNS = [
  'storage_path', 'storagepath', 'storage_url', 'storageurl',
  'signed_url', 'signedurl', 'public_url', 'publicurl',
  'token', 'secret', 'password',
  'credential', 'credentials',
  'api_key', 'apikey', 'access_key', 'accesskey',
  'authorization', 'signature', 'bucket',
];
const SENSITIVE_VALUE_PATTERNS = [
  'storage_path', 'storage_url', 'signed_url', 'public_url',
  'signedurl', 'token=', 'secret', 'api_key', 'access_key',
  'x-amz-signature', 'awsaccesskeyid',
  'storage.googleapis.com', 'supabase.co/storage', '/storage/v1/object',
];

function buildRuntime(
  llmCalled: boolean,
  aiUsageLogged: boolean | 'unknown' = llmCalled,
): DryRunResult['runtime'] {
  return {
    conversation_created: false,
    handoff_created: false,
    workflow_executed: false,
    learning_candidate_created: false,
    llm_called: llmCalled,
    ai_usage_logged: aiUsageLogged,
  };
}
const RUNTIME_PARITY: DryRunResult['runtime_parity'] = {
  retrieval: 'real_hybrid_retrieval',
  query_expansion: 'not_used',
  conversation_history: 'not_used',
  workflow_execution: 'disabled',
  handoff_execution: 'disabled',
  learning_generation: 'disabled',
};

export function redactDeep(obj: any, depth = 0): any {
  if (obj == null || depth > 8) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactDeep(v, depth + 1));
  if (typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => lk.includes(p))) continue;
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  if (typeof obj === 'string') {
    const lv = obj.toLowerCase();
    if (SENSITIVE_VALUE_PATTERNS.some((p) => lv.includes(p))) return '[redacted]';
  }
  return obj;
}

/** Scan a free-form string (e.g. prompt_preview) and redact leak patterns. */
export function redactString(s: string | null | undefined): string | null | undefined {
  if (!s) return s;
  let out = s;
  // Replace matched patterns line-by-line so we keep mostly-readable output.
  const lower = out.toLowerCase();
  if (SENSITIVE_VALUE_PATTERNS.some((p) => lower.includes(p))) {
    out = out
      .split('\n')
      .map((line) => {
        const ll = line.toLowerCase();
        return SENSITIVE_VALUE_PATTERNS.some((p) => ll.includes(p)) ? '[redacted]' : line;
      })
      .join('\n');
  }
  return out;
}

function strategyToAction(decisionType: string, handoffRequired: boolean):
  'answer' | 'handoff' | 'clarification' | 'no_answer' {
  if (decisionType === 'handoff' || handoffRequired) return 'handoff';
  if (decisionType === 'ask_clarifying_question') return 'clarification';
  if (decisionType === 'no_answer_silent') return 'no_answer';
  return 'answer';
}

export async function runDryRunTest(
  config: ServerConfig,
  input: DryRunInput,
): Promise<DryRunResult> {
  const callLLM = input.callLLM !== false;
  const safetyNotes: string[] = [];
  const settings = await getOrCreateSettings(config, input.workspaceId);
  const locale = input.locale || settings.allowed_locales?.[0] || 'en';

  let hybrid: any;
  try {
    hybrid = await retrieveHybridSources(config, {
      workspaceId: input.workspaceId,
      originalMessage: input.message,
      retrievalQuery: input.message,
      expandedQuery: input.message,
      responseLanguage: locale,
      inputLanguage: locale,
      limit: 8,
      pageContext: input.pageContext ? {
        currentPageUrl: input.pageContext.currentPageUrl ?? null,
        currentPageOrigin: input.pageContext.currentPageOrigin ?? null,
        currentPagePath: input.pageContext.currentPagePath ?? null,
        currentPageTitle: input.pageContext.currentPageTitle ?? null,
      } : null,
    });
  } catch (err: any) {
    return {
      status: 'failed', output_text: null, confidence: 0,
      selected_sources: [], retrieval_debug: null, excluded_summary: null,
      page_context: null,
      answer_strategy: {
        action: 'no_answer', decision_type: 'failed', reason: 'retrieval_failed',
        retrieval_strength: 'none', top_score: 0, handoff_required: false, source_types_used: [],
      },
      prompt_preview: null,
      safety_notes: [`retrieval_error:${err?.message || 'unknown'}`],
      provider: null, model: null, error: err?.message || 'retrieval_failed',
      runtime: buildRuntime(false),
      runtime_parity: RUNTIME_PARITY,
    };
  }

  const sources: HybridSource[] = hybrid.sources || [];
  const selectedSources: DryRunSelectedSource[] = sources.map((s) => ({
    id: s.source_id,
    source_id: s.source_id,
    source_type: s.source_type,
    kind: s.kind,
    title: s.title,
    source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
    locale: s.locale ?? null,
    final_score: s.final_score,
    keyword_score: s.keyword_score,
    vector_score: s.vector_score,
    topic_boost: s.topic_boost,
    url_boost: s.url_boost,
    locale_bonus: s.locale_bonus,
    source_priority: s.source_priority,
  }));

  const enginePromptSources: RetrievedSource[] = sources.map((s) => ({
    kind: (s.kind === 'qna' ? 'qna' : 'kb_article'),
    id: s.source_id,
    title: s.title,
    excerpt: s.excerpt ?? null,
    content: s.content ?? null,
    slug: s.slug ?? null,
    locale: s.locale ?? null,
    score: s.final_score,
    source_type: s.source_type,
    source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
    url_boost: s.url_boost,
  } as any));

  const strategy = decideStrategy({
    settings,
    question: input.message,
    sources: enginePromptSources,
    clarificationAttemptCount: 0,
    hybridUsed: hybrid.hybridUsed,
  });

  const action = strategyToAction(strategy.decisionType, strategy.handoffRequired);

  const answerStrategy = {
    action,
    decision_type: strategy.decisionType,
    reason: strategy.reason,
    retrieval_strength: strategy.retrievalStrength,
    top_score: strategy.topScore,
    handoff_required: strategy.handoffRequired,
    source_types_used: strategy.sourceTypesUsed,
  };

  const systemPrompt = buildSystemPrompt(settings, locale, {
    responseLanguage: locale,
    inputLanguage: locale,
  });
  const userPrompt = buildUserPrompt(input.message, enginePromptSources, {
    decisionType: strategy.decisionType,
    clarificationHint: strategy.clarificationHint,
    safeGuidanceTopic: strategy.safeGuidanceTopic,
  }, {
    pageContext: input.pageContext ? {
      currentPageUrl: input.pageContext.currentPageUrl ?? null,
      currentPageTitle: input.pageContext.currentPageTitle ?? null,
    } : null,
    pageMatched: !!hybrid.pageContextDebug?.exact_page_match,
  });
  const promptPreview = { system: systemPrompt, user: userPrompt };

  if (action !== 'answer') {
    return {
      status: action,
      output_text: null,
      confidence: strategy.confidence,
      selected_sources: selectedSources,
      retrieval_debug: redactDeep(hybrid.retrievalDebug),
      excluded_summary: hybrid.excludedSummary || null,
      page_context: redactDeep(hybrid.pageContextDebug),
      answer_strategy: answerStrategy,
      prompt_preview: promptPreview,
      safety_notes: safetyNotes,
      provider: null, model: null,
      runtime: buildRuntime(false),
      runtime_parity: RUNTIME_PARITY,
    };
  }

  if (!callLLM) {
    return {
      status: 'replied',
      output_text: null,
      confidence: strategy.confidence,
      selected_sources: selectedSources,
      retrieval_debug: redactDeep(hybrid.retrievalDebug),
      excluded_summary: hybrid.excludedSummary || null,
      page_context: redactDeep(hybrid.pageContextDebug),
      answer_strategy: answerStrategy,
      prompt_preview: promptPreview,
      safety_notes: ['llm_call_skipped', ...safetyNotes],
      provider: null, model: null,
      runtime: buildRuntime(false),
      runtime_parity: RUNTIME_PARITY,
    };
  }

  const aiCfg = await resolveAIConfig(config, input.workspaceId);
  if (!aiCfg) {
    return {
      status: 'failed', output_text: null,
      confidence: strategy.confidence,
      selected_sources: selectedSources,
      retrieval_debug: redactDeep(hybrid.retrievalDebug),
      excluded_summary: hybrid.excludedSummary || null,
      page_context: redactDeep(hybrid.pageContextDebug),
      answer_strategy: answerStrategy,
      prompt_preview: promptPreview,
      safety_notes: ['no_ai_provider_configured', ...safetyNotes],
      provider: null, model: null,
      error: 'no_ai_provider_configured',
      runtime: buildRuntime(false),
      runtime_parity: RUNTIME_PARITY,
    };
  }

  try {
    const result = await executeAICompletion(config, {
      workspaceId: input.workspaceId,
      prompt: userPrompt,
      systemPrompt,
      maxTokens: 600,
      temperature: settings.answer_guidance === 'creative' ? 0.6
        : settings.answer_guidance === 'balanced' ? 0.4 : 0.2,
      billing: { entryPoint: 'agent_test_harness' },
    });
    return {
      status: 'replied',
      output_text: result.text,
      confidence: strategy.confidence,
      selected_sources: selectedSources,
      retrieval_debug: redactDeep(hybrid.retrievalDebug),
      excluded_summary: hybrid.excludedSummary || null,
      page_context: redactDeep(hybrid.pageContextDebug),
      answer_strategy: answerStrategy,
      prompt_preview: promptPreview,
      safety_notes: safetyNotes,
      provider: result.provider,
      model: result.model,
      runtime: buildRuntime(true),
      runtime_parity: RUNTIME_PARITY,
    };
  } catch (err: any) {
    return {
      status: 'failed', output_text: null,
      confidence: strategy.confidence,
      selected_sources: selectedSources,
      retrieval_debug: redactDeep(hybrid.retrievalDebug),
      excluded_summary: hybrid.excludedSummary || null,
      page_context: redactDeep(hybrid.pageContextDebug),
      answer_strategy: answerStrategy,
      prompt_preview: promptPreview,
      safety_notes: [`llm_error:${err?.message || 'unknown'}`, ...safetyNotes],
      provider: aiCfg.provider, model: aiCfg.model,
      error: err?.message || 'llm_call_failed',
      runtime: buildRuntime(true, 'unknown'),
      runtime_parity: RUNTIME_PARITY,
    };
  }
}

// ─── Evaluation ───────────────────────────────────────────────────────

export interface TestExpectations {
  workspaceId: string;
  expected_behavior: 'answer' | 'no_answer' | 'handoff' | 'clarification';
  expected_source_type?: string | null;
  expected_source_url?: string | null;
  expected_source_id?: string | null;
  expected_contains?: string[] | null;
  expected_not_contains?: string[] | null;
  min_confidence?: number | null;
}

export interface EvaluationResult {
  passed: boolean;
  failure_reasons: string[];
}

function containsCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function deepHasSensitive(value: any, depth = 0): boolean {
  if (value == null || depth > 8) return false;
  if (Array.isArray(value)) return value.some((v) => deepHasSensitive(v, depth + 1));
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const lk = k.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => lk.includes(p))) return true;
      if (deepHasSensitive(v, depth + 1)) return true;
    }
  }
  if (typeof value === 'string') {
    const lv = value.toLowerCase();
    if (SENSITIVE_VALUE_PATTERNS.some((p) => lv.includes(p))) return true;
  }
  return false;
}

const SUPPORTED_EXPECTED_SOURCE_TYPES = new Set(['qna','learned_qna','kb_article','web_page','file']);

export function evaluateExpectations(
  result: DryRunResult,
  exp: TestExpectations,
): EvaluationResult {
  const reasons: string[] = [];

  switch (exp.expected_behavior) {
    case 'answer':
      if (result.status !== 'replied' || !result.output_text || !result.output_text.trim()) {
        reasons.push(`expected_answer_got_${result.status}`);
      }
      if (result.answer_strategy.action === 'no_answer' || result.answer_strategy.action === 'handoff') {
        reasons.push(`strategy_${result.answer_strategy.action}_for_expected_answer`);
      }
      break;
    case 'no_answer':
      if (result.answer_strategy.action !== 'no_answer') {
        reasons.push(`expected_no_answer_got_${result.answer_strategy.action}`);
      }
      break;
    case 'handoff':
      if (result.answer_strategy.action !== 'handoff') {
        reasons.push(`expected_handoff_got_${result.answer_strategy.action}`);
      }
      break;
    case 'clarification':
      if (result.answer_strategy.action !== 'clarification') {
        reasons.push(`expected_clarification_got_${result.answer_strategy.action}`);
      }
      break;
  }

  if (exp.expected_source_type) {
    if (!SUPPORTED_EXPECTED_SOURCE_TYPES.has(exp.expected_source_type)) {
      reasons.push(`unsupported_expected_source_type:${exp.expected_source_type}`);
    }
    const has = result.selected_sources.some((s) => s.source_type === exp.expected_source_type);
    if (!has) reasons.push(`missing_expected_source_type:${exp.expected_source_type}`);
  }

  if (exp.expected_source_url) {
    const has = result.selected_sources.some((s) =>
      s.source_type !== 'file' && s.source_url === exp.expected_source_url,
    );
    if (!has) reasons.push(`missing_expected_source_url`);
  }

  if (exp.expected_source_id) {
    const has = result.selected_sources.some((s) =>
      s.source_id === exp.expected_source_id || s.id === exp.expected_source_id,
    );
    if (!has) reasons.push(`missing_expected_source_id`);
  }

  const out = result.output_text || '';
  for (const needle of exp.expected_contains || []) {
    if (needle && !containsCI(out, needle)) reasons.push(`missing_text:${needle.slice(0, 40)}`);
  }
  for (const needle of exp.expected_not_contains || []) {
    if (needle && containsCI(out, needle)) reasons.push(`forbidden_text:${needle.slice(0, 40)}`);
  }

  if (typeof exp.min_confidence === 'number') {
    if ((result.confidence || 0) < exp.min_confidence) {
      reasons.push(`low_confidence:${(result.confidence || 0).toFixed(2)}<${exp.min_confidence}`);
    }
  }

  for (const s of result.selected_sources) {
    if (s.source_type === 'file' && s.source_url) {
      reasons.push('file_url_leak');
      break;
    }
  }

  // Check retrieval_debug.selected_sources for file source_url leaks too
  const dbgSelected = (result.retrieval_debug && (result.retrieval_debug as any).selected_sources) || [];
  if (Array.isArray(dbgSelected)) {
    for (const s of dbgSelected) {
      if (s && s.source_type === 'file' && s.source_url) {
        reasons.push('file_url_leak_debug');
        break;
      }
    }
  }

  if (deepHasSensitive(result.retrieval_debug)
    || deepHasSensitive(result.selected_sources)
    || deepHasSensitive((result as any).page_context)) {
    reasons.push('sensitive_metadata_leak');
  }

  if (result.prompt_preview) {
    const blob = `${result.prompt_preview.system}\n${result.prompt_preview.user}`.toLowerCase();
    if (SENSITIVE_VALUE_PATTERNS.some((p) => blob.includes(p))) {
      reasons.push('prompt_preview_leak');
    }
  }

  return { passed: reasons.length === 0, failure_reasons: reasons };
}
