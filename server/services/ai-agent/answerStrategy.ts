/**
 * AI Agent — answer strategy ladder. Pure functions, no IO.
 *
 * Decides HOW the AI should respond once retrieval has run, replacing the
 * older binary "answer / handoff" verdict from policy.ts. Used by engine.ts.
 *
 * Ladder (top wins):
 *   1. human_request          — visitor asked for a human → handoff
 *   2. answer                 — exact Q&A or strong KB grounding
 *   3. answer_with_caveat     — partial KB grounding (only when allowed)
 *   4. ask_clarifying_question — question is too vague AND attempts left
 *   5. handoff                — no usable grounding, clarification exhausted
 *   6. no_answer_silent       — fallback_behavior='silent' + no grounding
 *
 * The strategy never invents answers. answer_with_caveat still requires the
 * LLM to ground in retrieved sources — the prompt layer adds the hedge.
 */
import type { AgentSettings, EscalationStyle } from './settings.js';
import type { RetrievedSource } from './retrieval.js';
import { isHumanRequest } from './runtimePolicy.js';
import { detectSourceConflicts, type DetectedConflict } from './conflictDetection.js';

export type StrategyDecisionType =
  | 'answer'
  | 'answer_with_caveat'
  | 'ask_clarifying_question'
  | 'safe_guidance'
  | 'greeting'
  | 'handoff'
  | 'no_answer_silent';

/**
 * Meta intents — questions ABOUT the assistant itself ("what is your name?",
 * "are you a bot?", "what can you do?"). These are never business-fact
 * questions, so they must NOT be answered from a canned operator template
 * nor blocked by answer_only_from_kb: the model answers them itself using
 * the configured assistant name and persona.
 */
export type MetaIntent = 'assistant_identity' | 'assistant_capabilities';

export interface StrategyInput {
  settings: AgentSettings;
  question: string;
  sources: RetrievedSource[];
  /** How many clarifying questions AI has already asked in this conversation. */
  clarificationAttemptCount: number;
  /** Topic groups detected by query expansion (pricing, support, …). */
  topics?: string[];
  /** Workspace navigation context — pricing/contact/help URLs if known. */
  workspaceLinks?: { pricing?: string | null; contact?: string | null; help?: string | null };
  /** When set, hybrid retrieval was used and final_score replaces raw score for ladder. */
  hybridUsed?: boolean;
  /**
   * Phase 2.2 — the visitor's message IS the answer to a clarification the
   * AI just asked. Asking another clarification immediately would loop.
   */
  justAnsweredClarification?: boolean;
}

export interface StrategyDecision {
  decisionType: StrategyDecisionType;
  reason: string;
  retrievalStrength: 'none' | 'weak' | 'medium' | 'strong' | 'exact_qna';
  topScore: number;
  confidence: number;
  sourceTypesUsed: string[];
  handoffRequired: boolean;
  /** When asking clarification, the AI prompt should request a single
   *  short question — engine passes this hint into the LLM call. */
  clarificationHint?: string;
  /** When using safe_guidance, the topic the AI should orient around. */
  safeGuidanceTopic?: string;
  /** Phase 2.6 — coarse confidence band derived from real evidence. */
  confidenceBand: ConfidenceBand;
  /** Phase 2.6 — the inputs the band/confidence were computed from. */
  confidenceInputs: ConfidenceInputs;
  /** Phase 2.7 — materially conflicting sources on a business fact. */
  conflictDetected: boolean;
  conflicts: DetectedConflict[];
  /** Set when the visitor asked about the assistant itself. */
  metaIntent?: MetaIntent | null;
}

export type ConfidenceBand = 'none' | 'weak' | 'medium' | 'strong';

export interface ConfidenceInputs {
  top_score: number;
  retrieval_strength: StrategyDecision['retrievalStrength'];
  source_count: number;
  independent_source_count: number;
  exact_qna_match: boolean;
  source_types: string[];
  conflict_detected: boolean;
  just_answered_clarification: boolean;
}

/**
 * Phase 2.6 — evidence-based confidence. Starts from the ranked top score
 * and then applies bounded, common-sense adjustments so a single weak
 * keyword hit can never read as a confident answer:
 *   + exact Q&A match and corroboration from independent sources raise it
 *   - a single weak source, or conflicting sources, lower it
 * The numeric value is preserved for existing UI/API consumers.
 */
export function computeConfidence(inputs: ConfidenceInputs): { confidence: number; band: ConfidenceBand } {
  if (inputs.retrieval_strength === 'none' || inputs.source_count === 0) {
    return { confidence: 0, band: 'none' };
  }
  let c = Math.max(0, Math.min(1, inputs.top_score));
  if (inputs.exact_qna_match) c = Math.max(c, 0.85);
  if (inputs.independent_source_count >= 2) c += 0.05;
  if (inputs.independent_source_count <= 1 && !inputs.exact_qna_match) c -= 0.05;
  if (inputs.retrieval_strength === 'weak') c = Math.min(c, 0.35);
  if (inputs.conflict_detected) c = Math.min(c * 0.6, 0.45);
  c = Math.max(0, Math.min(1, Number(c.toFixed(4))));
  const band: ConfidenceBand = c >= 0.7 ? 'strong' : c >= 0.45 ? 'medium' : c > 0 ? 'weak' : 'none';
  return { confidence: c, band };
}

const VAGUE_PATTERNS = [
  /^\s*(hi|hello|hey|سلام|درود|merhaba|selam)\b[\s!.,?]*$/i,
  /^\s*(help|info|question|سوال|پرسش|yardım|soru)\b[\s!.,?]*$/i,
  /^\s*(how|what|when|where|why|چی|چه|چطور|nasıl|ne|nerede)\s*\??\s*$/i,
];

const GREETING_PATTERNS = [
  /^\s*(hi|hello|hey|hiya|yo|good\s+(morning|afternoon|evening))[\s!.,?]*$/i,
  /^\s*(merhaba|selam|selamlar|günaydın|iyi\s+(akşamlar|günler))[\s!.,?]*$/i,
  /^\s*(سلام|سلام\s+علیکم|درود|صبح\s+بخیر|عصر\s+بخیر|شب\s+بخیر)[\s!.,?]*$/i,
];

export function isGreeting(text: string): boolean {
  const q = (text || '').trim();
  if (!q) return false;
  if (q.split(/\s+/).filter(Boolean).length > 4) return false;
  return GREETING_PATTERNS.some((p) => p.test(q));
}

const IDENTITY_PATTERNS: RegExp[] = [
  // English
  /\b(what('?s| is)\s+your\s+name|who\s+are\s+you|what\s+are\s+you|are\s+you\s+(a\s+)?(bot|robot|human|real\s+person|ai)|do\s+you\s+have\s+a\s+name)\b/i,
  // Persian
  /(اسمت?\s*چیه|اسم\s*شما\s*چیست|نامت?\s*چیه|نام\s*شما\s*چیست|چه\s*اسمی\s*داری|تو\s*کی\s*هستی|شما\s*کی\s*هستید|شما\s*کی\s*هستی|ربات\s*هستی|آیا\s*ربات|انسان\s*هستی|هوش\s*مصنوعی\s*هستی)/i,
  // Turkish
  /(adın\s*ne|isminiz\s*ne|sen\s*kimsin|siz\s*kimsiniz|robot\s*musun|insan\s*mısın)/i,
];

const CAPABILITY_PATTERNS: RegExp[] = [
  /\b(what\s+can\s+you\s+do|how\s+can\s+you\s+help|what\s+do\s+you\s+do)\b/i,
  /(چه\s*کاری\s*(می‌?توانی|میتونی)|چیکار\s*میتونی|چه\s*کمکی\s*(می‌?توانی|میتونی)|توانایی(‌|\s)*هات)/i,
  /(neler\s+yapabilirsin|nasıl\s+yardımcı\s+olabilirsin)/i,
];

export function detectMetaIntent(text: string): MetaIntent | null {
  const q = (text || '').trim();
  if (!q || q.length > 160) return null;
  if (IDENTITY_PATTERNS.some((p) => p.test(q))) return 'assistant_identity';
  if (CAPABILITY_PATTERNS.some((p) => p.test(q))) return 'assistant_capabilities';
  return null;
}

function isVague(question: string): boolean {
  const q = (question || '').trim();
  if (q.length < 8) return true;
  if (q.split(/\s+/).filter(Boolean).length < 3) return true;
  return VAGUE_PATTERNS.some((p) => p.test(q));
}

function classifyRetrieval(
  sources: RetrievedSource[],
  hybridUsed?: boolean,
): { strength: StrategyDecision['retrievalStrength']; topScore: number } {
  if (!sources.length) return { strength: 'none', topScore: 0 };
  const top = sources[0];
  const topScore = top.score || 0;
  // Hybrid retrieval thresholds (Pass 2): final_score is normalised differently.
  if (hybridUsed) {
    if (top.kind === 'qna' && topScore >= 0.6) return { strength: 'exact_qna', topScore };
    if (topScore >= 0.72) return { strength: 'strong', topScore };
    if (topScore >= 0.45) return { strength: 'medium', topScore };
    if (topScore > 0) return { strength: 'weak', topScore };
    return { strength: 'none', topScore };
  }
  if (top.kind === 'qna' && topScore >= 0.7) return { strength: 'exact_qna', topScore };
  if (topScore >= 0.7) return { strength: 'strong', topScore };
  if (topScore >= 0.45) return { strength: 'medium', topScore };
  if (topScore > 0) return { strength: 'weak', topScore };
  return { strength: 'none', topScore };
}

function thresholdsForStyle(style: EscalationStyle): {
  answerMin: number;
  caveatMin: number;
} {
  // Higher = more conservative. helpful_first lets the AI try harder before
  // falling back to clarification/handoff; conservative does the opposite.
  if (style === 'conservative') return { answerMin: 0.7, caveatMin: 0.55 };
  if (style === 'helpful_first') return { answerMin: 0.5, caveatMin: 0.3 };
  return { answerMin: 0.6, caveatMin: 0.4 }; // balanced
}

/**
 * Canonical strict-KB-no-grounding predicate (Follow-up 9D.1/9D.2). True
 * when answer_only_from_kb is on AND retrieval didn't qualify (weak/none).
 * This is the ONE definition of "no LLM call without a Q&A/KB match" —
 * decideStrategy() uses it below, and it is the same predicate the
 * generation boundary and the routingKeepAi override re-check downstream,
 * so the definition cannot drift between call sites. Deliberately keyed off
 * the already-computed retrievalStrength classification, not off raw
 * `sources.length` — a weak source can exist while still being
 * non-qualifying.
 */
export function isStrictKbNoGrounding(
  settings: Pick<AgentSettings, 'answer_only_from_kb'>,
  retrievalStrength: StrategyDecision['retrievalStrength'],
  /**
   * Meta intents (identity / capabilities) are about the assistant itself,
   * not about business facts, so strict-KB must not silence them.
   */
  metaIntent?: MetaIntent | null,
): boolean {
  if (metaIntent) return false;
  const noQualifyingSource = retrievalStrength === 'weak' || retrievalStrength === 'none';
  return settings.answer_only_from_kb === true && noQualifyingSource;
}

export function decideStrategy(input: StrategyInput): StrategyDecision {
  const { settings, question, sources, clarificationAttemptCount } = input;
  const sourceTypesUsed = Array.from(new Set(sources.map((s) => s.kind)));
  const { strength, topScore } = classifyRetrieval(sources, input.hybridUsed);
  // Phase 2.7 — conflicting business facts across independent sources.
  const conflictResult = detectSourceConflicts(
    sources.map((s) => ({ id: s.id, title: s.title, content: s.content, excerpt: s.excerpt })),
    question,
  );
  const independentSourceCount = new Set(sources.map((s) => (s as any).source_id || s.id)).size;
  const confidenceInputs: ConfidenceInputs = {
    top_score: topScore,
    retrieval_strength: strength,
    source_count: sources.length,
    independent_source_count: independentSourceCount,
    exact_qna_match: strength === 'exact_qna',
    source_types: sourceTypesUsed,
    conflict_detected: conflictResult.conflictDetected,
    just_answered_clarification: !!input.justAnsweredClarification,
  };
  const { confidence, band: confidenceBand } = computeConfidence(confidenceInputs);
  const metaIntent = detectMetaIntent(question);
  const common = {
    confidenceBand,
    confidenceInputs,
    conflictDetected: conflictResult.conflictDetected,
    conflicts: conflictResult.conflicts,
    metaIntent,
  };

  // 1. Human request always wins — never try to outsmart the visitor.
  if (
    settings.handoff_on_human_request &&
    isHumanRequest(question, settings.handoff_keywords || [])
  ) {
    return {
      decisionType: 'handoff',
      reason: 'human_request',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: true,
      ...common,
    };
  }

  // 1.5 Greeting / small talk → friendly greeting in visitor language.
  if (isGreeting(question)) {
    return {
      decisionType: 'greeting',
      reason: 'greeting_detected',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      ...common,
    };
  }

  // 1.6 Questions about the assistant itself → the MODEL answers, using the
  //     configured assistant name/persona. Never a canned template, never a
  //     handoff, never blocked by answer_only_from_kb.
  if (metaIntent) {
    return {
      decisionType: 'answer',
      reason: `meta_${metaIntent}`,
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      ...common,
    };
  }

  const style: EscalationStyle = (settings.escalation_style as EscalationStyle) || 'balanced';
  const { answerMin, caveatMin } = thresholdsForStyle(style);
  const allowClar = settings.allow_clarifying_questions !== false;
  const allowCaveat = settings.allow_answer_with_caveat !== false;
  const maxClar = Math.max(0, settings.max_clarification_attempts ?? 1);
  // Phase 2.2 — never answer a clarification answer with another
  // clarification: that is the loop visitors experience as "it forgot".
  const canAskClar =
    allowClar && clarificationAttemptCount < maxClar && !input.justAnsweredClarification;

  // Phase 2.7 — a detected conflict must not produce a confidently stated
  // arbitrary value. Downgrade a confident answer to a caveated one (or,
  // when caveats are disabled, to clarification/handoff below).
  if (conflictResult.conflictDetected && allowCaveat
      && (strength === 'exact_qna' || strength === 'strong' || strength === 'medium')) {
    return {
      decisionType: 'answer_with_caveat',
      reason: 'conflicting_sources',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      ...common,
    };
  }

  // 2. Exact Q&A or strong grounding → confident answer.
  if (strength === 'exact_qna' || (strength === 'strong' && topScore >= answerMin)) {
    return {
      decisionType: 'answer',
      reason: strength === 'exact_qna' ? 'exact_qna_match' : 'strong_kb_match',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      ...common,
    };
  }

  // 3. Medium grounding → caveated answer when allowed, else clarify/handoff.
  if (strength === 'medium' && topScore >= caveatMin && allowCaveat) {
    return {
      decisionType: 'answer_with_caveat',
      reason: 'medium_kb_match',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      ...common,
    };
  }

  // answer_only_from_kb=true means the LLM must never run without at least a
  // qualifying source match — not for safe_guidance, and not just to ask a
  // clarifying question — so both of those branches are skipped when
  // retrieval strength is weak/none under that setting, falling through to
  // the existing handoff/no_answer_silent logic in step 6 below instead.
  const noQualifyingSource = strength === 'weak' || strength === 'none';
  const strictKbNoGrounding = isStrictKbNoGrounding(settings, strength, metaIntent);

  // 4. Known commercial / support topic → SAFE GUIDANCE first.
  //    This is the key change: for topics like pricing/features/support we
  //    NEVER fall through to a generic "could you clarify?" — we always
  //    say something useful, even when the source grounding is weak.
  const knownTopics = (input.topics || []).filter(Boolean);
  if (knownTopics.length > 0 && style !== 'conservative' && !strictKbNoGrounding) {
    return {
      decisionType: 'safe_guidance',
      reason: 'safe_guidance_known_topic',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      safeGuidanceTopic: knownTopics[0],
      ...common,
    };
  }

  // 5. Vague / ambiguous (and NOT a known topic) → ask ONE clarifying question.
  if (canAskClar && !strictKbNoGrounding && (isVague(question) || noQualifyingSource)) {
    return {
      decisionType: 'ask_clarifying_question',
      reason: strength === 'none' ? 'no_kb_match_clarify' : 'vague_or_weak',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      clarificationHint:
        'Ask exactly ONE short, friendly clarifying question to narrow down what the visitor needs. Do not invent facts and do not promise an answer.',
      ...common,
    };
  }

  // 6. Out of options → handoff (or stay silent).
  if (settings.fallback_behavior === 'silent' && strength === 'none') {
    return {
      decisionType: 'no_answer_silent',
      reason: 'no_kb_match_silent',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      ...common,
    };
  }
  return {
    decisionType: 'handoff',
    reason: strength === 'none' ? 'no_kb_match' : 'low_confidence',
    retrievalStrength: strength,
    topScore,
    confidence,
    sourceTypesUsed,
    handoffRequired: true,
    ...common,
  };
}

/**
 * Counts AI runs in the current conversation that asked a clarifying
 * question already (engine logs `metadata.answer_strategy.decision_type`).
 * Cheap to call inline before the next decision.
 */
export async function countClarificationAttempts(
  sb: any,
  conversationId: string,
): Promise<number> {
  try {
    const { data } = await sb
      .from('ai_agent_runs')
      .select('metadata')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(20);
    return (data || []).filter(
      (r: any) => r?.metadata?.answer_strategy?.decision_type === 'ask_clarifying_question',
    ).length;
  } catch {
    return 0;
  }
}