/**
 * AI Agent — learning candidate safety filters.
 *
 * Rejects obviously useless or risky operator replies before they ever
 * become candidates. Pure functions, no IO.
 */

const TOO_SHORT_MIN_CHARS = 12;
const TOO_SHORT_MIN_WORDS = 3;

const ACK_ONLY = [
  /^\s*(ok|okay|okey|sure|thanks|thank you|thx|cool|great|yes|no|yep|nope)[\s!.,?]*$/i,
  /^\s*(tamam|sağol|teşekkürler|teşekkür ederim|olur|evet|hayır)[\s!.,?]*$/i,
  /^\s*(باشه|ممنون|متشکرم|بله|نه|خوبه)[\s!.,?]*$/i,
];

const SENSITIVE_PATTERNS = [
  /password/i, /api[\s_-]?key/i, /secret/i, /token\s*[:=]/i,
  /\b[A-Za-z0-9]{32,}\b/,                         // long opaque tokens
  /\bsk-[A-Za-z0-9]{20,}\b/,                      // OpenAI-style keys
  /\bxox[abp]-[A-Za-z0-9-]+\b/,                   // Slack tokens
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,   // credit-card-like
];

export interface SafetyResult {
  ok: boolean;
  reason?: string;
}

export function isAnswerLearnable(answer: string): SafetyResult {
  const a = (answer || '').trim();
  if (!a) return { ok: false, reason: 'empty' };
  if (a.length < TOO_SHORT_MIN_CHARS) return { ok: false, reason: 'too_short' };
  if (a.split(/\s+/).filter(Boolean).length < TOO_SHORT_MIN_WORDS) return { ok: false, reason: 'too_few_words' };
  if (ACK_ONLY.some((p) => p.test(a))) return { ok: false, reason: 'ack_only' };
  if (SENSITIVE_PATTERNS.some((p) => p.test(a))) return { ok: false, reason: 'sensitive_token' };
  return { ok: true };
}

export function isQuestionLearnable(question: string): SafetyResult {
  const q = (question || '').trim();
  if (!q) return { ok: false, reason: 'empty_question' };
  if (q.length < 3) return { ok: false, reason: 'question_too_short' };
  return { ok: true };
}