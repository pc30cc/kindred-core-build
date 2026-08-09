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

export type StrategyDecisionType =
  | 'answer'
  | 'answer_with_caveat'
  | 'ask_clarifying_question'
  | 'safe_guidance'
  | 'greeting'
  | 'handoff'
  | 'no_answer_silent';

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

export function decideStrategy(input: StrategyInput): StrategyDecision {
  const { settings, question, sources, clarificationAttemptCount } = input;
  const sourceTypesUsed = Array.from(new Set(sources.map((s) => s.kind)));
  const { strength, topScore } = classifyRetrieval(sources, input.hybridUsed);
  const confidence = Math.min(1, topScore);

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
    };
  }

  const style: EscalationStyle = (settings.escalation_style as EscalationStyle) || 'balanced';
  const { answerMin, caveatMin } = thresholdsForStyle(style);
  const allowClar = settings.allow_clarifying_questions !== false;
  const allowCaveat = settings.allow_answer_with_caveat !== false;
  const maxClar = Math.max(0, settings.max_clarification_attempts ?? 1);
  const canAskClar = allowClar && clarificationAttemptCount < maxClar;

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
    };
  }

  // 4. Known commercial / support topic → SAFE GUIDANCE first.
  //    This is the key change: for topics like pricing/features/support we
  //    NEVER fall through to a generic "could you clarify?" — we always
  //    say something useful, even when the source grounding is weak.
  const knownTopics = (input.topics || []).filter(Boolean);
  if (knownTopics.length > 0 && style !== 'conservative') {
    return {
      decisionType: 'safe_guidance',
      reason: 'safe_guidance_known_topic',
      retrievalStrength: strength,
      topScore,
      confidence,
      sourceTypesUsed,
      handoffRequired: false,
      safeGuidanceTopic: knownTopics[0],
    };
  }

  // 5. Vague / ambiguous (and NOT a known topic) → ask ONE clarifying question.
  //    answer_only_from_kb=true means the LLM must never run without at
  //    least a qualifying source match — including just to ask a
  //    clarifying question — so when retrieval strength is weak/none under
  //    that setting, this branch is skipped and falls through to the
  //    existing handoff/no_answer_silent logic in step 6 below instead.
  const noQualifyingSource = strength === 'weak' || strength === 'none';
  const strictKbBlocksClarify = settings.answer_only_from_kb === true && noQualifyingSource;
  if (canAskClar && !strictKbBlocksClarify && (isVague(question) || noQualifyingSource)) {
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