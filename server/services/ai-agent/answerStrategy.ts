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
  | 'handoff'
  | 'no_answer_silent';

export interface StrategyInput {
  settings: AgentSettings;
  question: string;
  sources: RetrievedSource[];
  /** How many clarifying questions AI has already asked in this conversation. */
  clarificationAttemptCount: number;
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
}

const VAGUE_PATTERNS = [
  /^\s*(hi|hello|hey|سلام|درود|merhaba|selam)\b[\s!.,?]*$/i,
  /^\s*(help|info|question|سوال|پرسش|yardım|soru)\b[\s!.,?]*$/i,
  /^\s*(how|what|when|where|why|چی|چه|چطور|nasıl|ne|nerede)\s*\??\s*$/i,
];

function isVague(question: string): boolean {
  const q = (question || '').trim();
  if (q.length < 8) return true;
  if (q.split(/\s+/).filter(Boolean).length < 3) return true;
  return VAGUE_PATTERNS.some((p) => p.test(q));
}

function classifyRetrieval(
  sources: RetrievedSource[],
): { strength: StrategyDecision['retrievalStrength']; topScore: number } {
  if (!sources.length) return { strength: 'none', topScore: 0 };
  const top = sources[0];
  const topScore = top.score || 0;
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
  const { strength, topScore } = classifyRetrieval(sources);
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

  // 4. Vague / ambiguous → ask one clarifying question if allowed.
  if (canAskClar && (isVague(question) || strength === 'weak' || strength === 'none')) {
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

  // 5/6. Out of options → handoff (or stay silent).
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