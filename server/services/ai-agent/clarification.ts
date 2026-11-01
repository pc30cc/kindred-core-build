/**
 * AI Agent — clarifying questions: the owner's switch and limit, and how the
 * engine knows that a reply was one.
 *
 * The model asks its own clarifying questions (decideStrategy no longer
 * scripts them). Two settings control it:
 *
 *   allow_clarifying_questions  (default true)       may it ask at all
 *   max_clarification_attempts  (default 1, 0..5)    how many per conversation
 *
 * Both reach the model through the prompt (prompt.ts, from
 * resolveClarificationPolicy), with the number of clarifying questions the
 * conversation already has (answerStrategy.countClarificationAttempts): not
 * allowed, or the limit reached, and the prompt says not to ask (answer with
 * what is verified, say plainly what is missing, or follow the handoff
 * rules); otherwise at most one short question. allow_answer_with_caveat
 * stays answerStrategy's (decideStrategy).
 *
 * Counting needs the replies that WERE clarifying questions to be marked.
 * The generation stage records a reply as decision type
 * 'ask_clarifying_question' (run metadata `answer_strategy.decision_type`,
 * message metadata likewise, read back by countClarificationAttempts and by
 * the query builder's clarification follow-up) when classifyClarifyingReply
 * says it is one:
 *
 *   1. the model says so in its private status block (`<ai_control>`
 *      "clarifying_question": true or false, aiControl.ts). When it says,
 *      its answer is final, yes or no;
 *   2. when it does not (no block, a block that did not parse, or no such
 *      key), by shape: the whole reply is one short question back to the
 *      visitor (one question mark, at the end; at most two sentences; no
 *      link, no line break; at most 200 characters). A bare "How can I
 *      help?" has that shape too; counting it errs towards asking fewer
 *      questions, never more.
 */

export interface ClarificationPolicy {
  /** The owner allows clarifying questions at all. */
  allowed: boolean;
  /** Clarifying questions allowed per conversation (0..5). */
  max: number;
  /** Clarifying questions the conversation already has. */
  asked: number;
  /** One more may be asked now: allowed, and fewer than `max` asked. */
  canAskNow: boolean;
}

/** The columns' defaults (migration 016a) when a row has none. */
export function resolveClarificationPolicy(
  settings: { allow_clarifying_questions?: boolean | null; max_clarification_attempts?: number | null } | null | undefined,
  askedSoFar: number | null | undefined,
): ClarificationPolicy {
  const allowed = settings?.allow_clarifying_questions !== false;
  const rawMax = settings?.max_clarification_attempts;
  const max = typeof rawMax === 'number' && Number.isFinite(rawMax)
    ? Math.min(5, Math.max(0, Math.floor(rawMax)))
    : 1;
  const asked = Math.max(0, Math.floor(Number(askedSoFar) || 0));
  return { allowed, max, asked, canAskNow: allowed && asked < max };
}

const MAX_CLARIFYING_CHARS = 200;
const QUESTION_MARKS = /[?？؟]/gu;
const ENDS_WITH_QUESTION = /[?？؟]["'»”)\]]*$/u;
const LINK = /https?:\/\/|www\./i;
/** A sentence end followed by more text (". ", "! ", "。"). */
const SENTENCE_BREAK = /[.!。](?=\s+\S)/gu;

/** The deterministic fallback: the whole reply is one short question back to the visitor. */
export function looksLikeClarifyingQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim();
  if (!t || t.length > MAX_CLARIFYING_CHARS) return false;
  if (/[\r\n]/.test(t) || LINK.test(t)) return false;
  if (!ENDS_WITH_QUESTION.test(t)) return false;
  if ((t.match(QUESTION_MARKS) || []).length !== 1) return false;
  return (t.match(SENTENCE_BREAK) || []).length <= 1;
}

export interface ClarifyingReplyVerdict {
  clarifying: boolean;
  /** What decided it: the model's status block, or the reply's shape. */
  source: 'model' | 'shape' | null;
}

/**
 * `modelSays`: the status block's "clarifying_question" (true or false), or
 * null when the model did not say (AiControl.clarifyingQuestion).
 * `shapeFallback: false` skips rule 2 (a turn whose own directive ends it
 * with a question, such as the assist-first attempt).
 */
export function classifyClarifyingReply(
  text: string | null | undefined,
  modelSays: boolean | null,
  opts: { shapeFallback?: boolean } = {},
): ClarifyingReplyVerdict {
  if (modelSays !== null) return { clarifying: modelSays, source: modelSays ? 'model' : null };
  if (opts.shapeFallback !== false && looksLikeClarifyingQuestion(text)) {
    return { clarifying: true, source: 'shape' };
  }
  return { clarifying: false, source: null };
}
