/**
 * AI Agent — decision policy. Pure functions, no IO.
 */
import type { AgentSettings } from './settings.js';
import type { RetrievedSource } from './retrieval.js';

export type DecisionAction = 'answer' | 'handoff' | 'no_answer' | 'blocked';

export interface DecisionInput {
  settings: AgentSettings;
  question: string;
  sources: RetrievedSource[];
}

export interface Decision {
  action: DecisionAction;
  reason?: string;
  confidence: number;
  topScore: number;
}

export function isHumanRequest(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (keywords || []).some((k) => k && lower.includes(k.toLowerCase()));
}

export function decide({ settings, question, sources }: DecisionInput): Decision {
  const topScore = sources[0]?.score || 0;
  // crude confidence proxy in [0,1]
  const confidence = Math.min(1, topScore);

  if (settings.handoff_on_human_request && isHumanRequest(question, settings.handoff_keywords)) {
    return { action: 'handoff', reason: 'human_request', confidence, topScore };
  }
  if (sources.length === 0) {
    if (settings.answer_only_from_kb || settings.handoff_when_no_kb_match) {
      return { action: 'handoff', reason: 'no_kb_match', confidence, topScore };
    }
    return { action: 'no_answer', reason: 'no_sources', confidence, topScore };
  }
  if (settings.handoff_on_low_confidence && confidence < settings.confidence_threshold) {
    return { action: 'handoff', reason: 'low_confidence', confidence, topScore };
  }
  return { action: 'answer', confidence, topScore };
}

/**
 * Multilingual "the model gave up" detector. The English-only version let
 * Persian and Turkish non-answers ("نمی‌دانم", "bilmiyorum") through as valid
 * replies, so those conversations were never escalated.
 */
const UNSURE_PATTERNS: RegExp[] = [
  // English
  /^\s*i\s+(do not|don'?t|don´t)\s+know/i,
  /\bi'?m\s+not\s+sure\b/i,
  /\bi\s+am\s+not\s+sure\b/i,
  /\bi\s+(do not|don'?t)\s+have\s+(that|this|enough)\s+information\b/i,
  // Persian / Farsi
  /نمی[\s\u200c]?دانم/,
  /نمی[\s\u200c]?دونم/,
  /مطمئن\s*نیستم/,
  /اطلاعات\s*(کافی|کاملی)?\s*ندارم/,
  /پاسخ\s*(این|آن)?\s*(سوال|پرسش)?\s*را\s*نمی[\s\u200c]?دانم/,
  // Turkish
  /\bbilmiyorum\b/i,
  /\bemin\s+değilim\b/i,
  /\bbu\s+konuda\s+bilgim\s+yok\b/i,
  /\byeterli\s+bilgi(m|ye)?\s+(yok|sahip\s+değilim)\b/i,
  // Arabic (shares script with Persian; common phrasing)
  /لا\s*أعرف/,
  /لست\s*متأكد/,
];

/**
 * Strategy-aware post-validation (vNext §32).
 *
 * Honest uncertainty is the CORRECT answer when nothing verified was
 * retrieved: "اطلاعات تأییدشده‌ای درباره این مورد ندارم." must not be
 * silently rewritten into `model_unsure → handoff`.
 *
 * It stays a failure signal for a GROUNDED turn: if strong evidence was in
 * the prompt and the model still gave up, that is genuinely poor output.
 *
 * Legacy callers that pass only a string keep the old strict behaviour.
 */
export interface PostValidateContext {
  /** Retrieval grounding for this turn. */
  groundingMode?: 'grounded' | 'partial' | 'unverified';
  /** Owner asked for escalation whenever verified knowledge is missing. */
  escalateOnUncertainty?: boolean;
}

export function postValidateAnswer(
  answer: string,
  ctx: PostValidateContext = {},
): { ok: boolean; reason?: string } {
  if (!answer || answer.trim().length < 2) return { ok: false, reason: 'empty' };
  const text = answer.trim();

  const unsure = UNSURE_PATTERNS.some((re) => re.test(text));
  if (!unsure) return { ok: true };

  // Ungrounded turn: saying so is honest and allowed, unless the workspace
  // explicitly opted into escalating on missing verified information.
  if (ctx.groundingMode === 'unverified' && ctx.escalateOnUncertainty !== true) {
    return { ok: true };
  }
  // Partial grounding: allowed to hedge as long as the reply is substantive.
  if (ctx.groundingMode === 'partial' && text.length >= 80 && ctx.escalateOnUncertainty !== true) {
    return { ok: true };
  }
  return { ok: false, reason: 'model_unsure' };
}
