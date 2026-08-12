/**
 * AI Agent — answer strategy. Pure functions, no IO.
 *
 * LLM-FIRST ARCHITECTURE (rewrite):
 *   The LLM is the default response engine. This module no longer decides
 *   *whether* the model may speak based on knowledge-base hits; it decides
 *   how much VERIFIED BUSINESS EVIDENCE the turn has, and whether a
 *   deterministic handoff condition is present.
 *
 *   1. explicit human request                        -> handoff
 *   2. owner-configured silence with zero grounding  -> no_answer_silent
 *   3. otherwise                                     -> answer via the LLM,
 *      tagged with groundingMode: grounded | partial | unverified
 *
 *   A missing knowledge-base result is NOT a handoff and NOT a canned
 *   response. Hallucination protection lives in the prompt layer, which
 *   forbids stating unverified business facts.
 */
import type { AgentSettings } from './settings.js';
import type { RetrievedSource } from './retrieval.js';
import { isHumanRequest } from './runtimePolicy.js';
import { detectSourceConflicts, type DetectedConflict } from './conflictDetection.js';

/** How much verified business evidence backs this turn. */
export type GroundingMode = 'grounded' | 'partial' | 'unverified';

/**
 * Explicit, enumerated reasons a conversation may be escalated to a human.
 * "The knowledge base returned nothing" is deliberately NOT one of them:
 * missing evidence only means the assistant may not assert a business fact.
 */
export type HandoffReason =
  | 'explicit_human_request'
  | 'routing_rule'
  | 'human_only_action'
  | 'owner_policy'
  | 'insufficient_verified_info_requires_human';

export type StrategyDecisionType =
  | 'answer'
  | 'answer_with_caveat'
  | 'ask_clarifying_question'
  | 'safe_guidance'
  | 'greeting'
  | 'handoff'
  | 'no_answer_silent';

// NOTE: 'ask_clarifying_question' | 'safe_guidance' | 'greeting' are legacy
// values kept in the union so historical ai_agent_runs metadata and the
// learning/harness consumers still typecheck. decideStrategy() never
// produces them any more — the model asks its own clarifying questions and
// greets in its own words.

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
  /** How much verified business evidence backs this turn. */
  groundingMode: GroundingMode;
  /** Legacy hint fields, retained for existing consumers. */
  clarificationHint?: string;
  safeGuidanceTopic?: string;
  /** Phase 2.6 — coarse confidence band derived from real evidence. */
  confidenceBand: ConfidenceBand;
  /** Phase 2.6 — the inputs the band/confidence were computed from. */
  confidenceInputs: ConfidenceInputs;
  /** Phase 2.7 — materially conflicting sources on a business fact. */
  conflictDetected: boolean;
  conflicts: DetectedConflict[];
  /** Explicit escalation reason. Null whenever handoffRequired is false. */
  handoffReason: HandoffReason | null;
  /**
   * The single architectural question this module answers: does the turn
   * need trusted, business-specific knowledge to be answered safely?
   * Derived from evidence + question shape, never from phrase lists.
   */
  requiresBusinessKnowledge: boolean;
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

/**
 * COST GATE ONLY — never an answer gate.
 *
 * Decides whether spending a vector/keyword search on this turn is worth it.
 * Deliberately language-agnostic and phrase-free: we retrieve for anything
 * that carries enough signal to plausibly match a document, and skip only
 * ultra-short utterances with no question mark, digit or URL. When in doubt
 * we retrieve — skipping retrieval never changes WHETHER the model answers.
 */
export function requiresKnowledgeLookup(text: string): boolean {
  const q = (text || '').trim();
  if (!q) return false;
  if (/[?؟]/.test(q) || /\d/.test(q) || /https?:\/\//i.test(q)) return true;
  const words = q.split(/\s+/).filter(Boolean).length;
  return words > 3;
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

/**
 * New architecture (LLM-first):
 *
 *   1. explicit human request                       -> handoff
 *   2. owner configured silence AND zero grounding  -> no_answer_silent
 *   3. everything else                              -> the LLM answers,
 *      with a grounding mode describing how much verified business evidence
 *      is available for this turn.
 *
 * A missing knowledge-base result is NEVER a handoff by itself. It only
 * lowers `groundingMode` to 'unverified', which the prompt layer turns into
 * "you may converse freely, but do not state unverified business facts".
 */
export function decideStrategy(input: StrategyInput): StrategyDecision {
  const { settings, question, sources } = input;
  const sourceTypesUsed = Array.from(new Set(sources.map((s) => s.kind)));
  const { strength, topScore } = classifyRetrieval(sources, input.hybridUsed);
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
  const common = {
    retrievalStrength: strength,
    topScore,
    confidence,
    sourceTypesUsed,
    confidenceBand,
    confidenceInputs,
    conflictDetected: conflictResult.conflictDetected,
    conflicts: conflictResult.conflicts,
  };

  // 1. Explicit human request always wins.
  if (
    settings.handoff_on_human_request &&
    isHumanRequest(question, settings.handoff_keywords || [])
  ) {
    return {
      decisionType: 'handoff',
      reason: 'human_request',
      handoffRequired: true,
      groundingMode: 'unverified',
      ...common,
    };
  }

  // 2. Conversational turns — greetings, thanks, identity, capability and
  //    other small talk. These do not depend on business evidence at all,
  //    so the LLM answers them from the configured assistant persona. This
  //    is the core of the LLM-first architecture: a missing knowledge-base
  //    hit is NOT a reason to stay silent or escalate on such a turn.
  const knowledgeQuestion = requiresKnowledgeLookup(question);
  if (!knowledgeQuestion) {
    return {
      decisionType: 'answer',
      reason: 'conversational_turn',
      handoffRequired: false,
      groundingMode: strength === 'exact_qna' || strength === 'strong' ? 'grounded' : 'unverified',
      ...common,
    };
  }

  // ── From here on the visitor is asking about the BUSINESS, so evidence
  //    discipline applies: the model may speak, but what it is allowed to
  //    assert depends on the grounding available.
  const style: EscalationStyle = (settings.escalation_style as EscalationStyle) || 'balanced';
  const { answerMin, caveatMin } = thresholdsForStyle(style);
  const allowClar = settings.allow_clarifying_questions !== false;
  const allowCaveat = settings.allow_answer_with_caveat !== false;
  const maxClar = Math.max(0, settings.max_clarification_attempts ?? 1);
  const canAskClar =
    allowClar && (input.clarificationAttemptCount || 0) < maxClar && !input.justAnsweredClarification;

  // 3. Conflicting sources must never yield a confidently stated value.
  if (conflictResult.conflictDetected && allowCaveat
      && (strength === 'exact_qna' || strength === 'strong' || strength === 'medium')) {
    return {
      decisionType: 'answer_with_caveat',
      reason: 'conflicting_sources',
      handoffRequired: false,
      groundingMode: 'partial',
      ...common,
    };
  }

  // 4. Exact Q&A or strong grounding → confident, grounded answer.
  if (strength === 'exact_qna' || (strength === 'strong' && topScore >= answerMin)) {
    return {
      decisionType: 'answer',
      reason: strength === 'exact_qna' ? 'exact_qna_match' : 'strong_kb_match',
      handoffRequired: false,
      groundingMode: 'grounded',
      ...common,
    };
  }

  // 5. Medium grounding → caveated answer when allowed.
  if (strength === 'medium' && topScore >= caveatMin && allowCaveat) {
    return {
      decisionType: 'answer_with_caveat',
      reason: 'medium_kb_match',
      handoffRequired: false,
      groundingMode: 'partial',
      ...common,
    };
  }

  const noQualifyingSource = strength === 'weak' || strength === 'none';
  // `answer_only_from_kb` is an explicit owner decision: on BUSINESS
  // questions the model must not speak without a qualifying source match.
  // It no longer touches conversational turns, which returned above.
  const strictKbNoGrounding = isStrictKbNoGrounding(settings, strength);

  // 6. Known commercial/support topic → safe guidance instead of a dead end.
  const knownTopics = (input.topics || []).filter(Boolean);
  if (knownTopics.length > 0 && style !== 'conservative' && !strictKbNoGrounding) {
    return {
      decisionType: 'safe_guidance',
      reason: 'safe_guidance_known_topic',
      handoffRequired: false,
      groundingMode: 'unverified',
      safeGuidanceTopic: knownTopics[0],
      ...common,
    };
  }

  // 7. Vague or weakly matched → ask ONE clarifying question.
  if (canAskClar && !strictKbNoGrounding && (isVague(question) || noQualifyingSource)) {
    return {
      decisionType: 'ask_clarifying_question',
      reason: strength === 'none' ? 'no_kb_match_clarify' : 'vague_or_weak',
      handoffRequired: false,
      groundingMode: 'unverified',
      clarificationHint:
        'Ask exactly ONE short, friendly clarifying question to narrow down what the visitor needs. Do not invent facts and do not promise an answer.',
      ...common,
    };
  }

  // 8. Out of options on a business question → handoff (or stay silent).
  if (settings.fallback_behavior === 'silent' && strength === 'none') {
    return {
      decisionType: 'no_answer_silent',
      reason: 'no_kb_match_silent',
      handoffRequired: false,
      groundingMode: 'unverified',
      ...common,
    };
  }
  return {
    decisionType: 'handoff',
    reason: strength === 'none' ? 'no_kb_match' : 'low_confidence',
    handoffRequired: true,
    groundingMode: 'unverified',
    ...common,
  };
}

export type EscalationStyle = 'conservative' | 'balanced' | 'proactive';

function thresholdsForStyle(style: EscalationStyle): { answerMin: number; caveatMin: number } {
  if (style === 'conservative') return { answerMin: 0.75, caveatMin: 0.6 };
  if (style === 'proactive') return { answerMin: 0.6, caveatMin: 0.35 };
  return { answerMin: 0.68, caveatMin: 0.45 };
}

const VAGUE_PATTERNS: RegExp[] = [
  /^\s*\??\s*$/,
  /^\s*(help|info|information|question|problem|issue)\s*[?!.]*\s*$/i,
  /^\s*(کمک|سوال|مشکل|راهنمایی)\s*[؟?!.]*\s*$/,
  /^\s*(yardım|soru|sorun|bilgi)\s*[?!.]*\s*$/i,
];

export function isVague(text: string): boolean {
  const q = (text || '').trim();
  if (!q) return true;
  if (q.split(/\s+/).filter(Boolean).length <= 2 && q.length <= 14) return true;
  return VAGUE_PATTERNS.some((p) => p.test(q));
}

/**
 * Strict knowledge-only mode with no qualifying grounding. Applies ONLY to
 * business questions — conversational turns are resolved before this is
 * ever consulted.
 */
export function isStrictKbNoGrounding(
  settings: AgentSettings,
  strength: StrategyDecision['retrievalStrength'],
): boolean {
  if (!settings.answer_only_from_kb) return false;
  return strength === 'weak' || strength === 'none';
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