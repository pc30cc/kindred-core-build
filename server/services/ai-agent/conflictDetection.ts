/**
 * AI Agent — Phase 2.7: bounded conflicting-source detection.
 *
 * NOT a general fact-checking engine. It only compares deterministic,
 * high-impact numeric business facts that appear in retrieved sources:
 *   - money amounts attached to the same plan/topic (pricing)
 *   - policy windows expressed in days (refund / trial / cancellation)
 *
 * When two DIFFERENT sources state different values for the same field, a
 * conflict is reported so the strategy layer can lower confidence instead of
 * confidently repeating one arbitrary value.
 */

export type ConflictField = 'price' | 'policy_days';

export interface ConflictSourceLike {
  id: string;
  title?: string | null;
  content?: string | null;
  excerpt?: string | null;
}

export interface DetectedConflict {
  field: ConflictField;
  values: string[];
  sourceIds: string[];
}

export interface ConflictResult {
  conflictDetected: boolean;
  conflicts: DetectedConflict[];
}

const MONEY_RE = /(?:[$€£]\s?(\d{1,6}(?:[.,]\d{1,2})?))|(?:\b(\d{1,6}(?:[.,]\d{1,2})?)\s?(?:usd|eur|gbp|dollars?|euros?)\b)/gi;
const DAYS_RE = /\b(\d{1,3})\s*(?:-|\s)?\s*(?:day|days|gün|روز)\b/gi;

const PRICE_CONTEXT = /(price|pricing|plan|cost|subscription|fee|fiyat|قیمت|پلن|هزینه)/i;
const POLICY_CONTEXT = /(refund|return|trial|cancel|guarantee|iade|deneme|بازگشت|مرجوع|آزمایشی|لغو)/i;

function textOf(s: ConflictSourceLike): string {
  return `${s.title || ''}\n${s.content || s.excerpt || ''}`;
}

function normalizeNumber(raw: string): string {
  const n = Number(String(raw).replace(/,/g, '.'));
  return Number.isFinite(n) ? String(n) : String(raw);
}

function extract(re: RegExp, text: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    if (raw) out.push(normalizeNumber(raw));
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Compares the top N sources (default 4) — deeper sources rarely reach the
 * answer and would only add noise.
 */
export function detectSourceConflicts(
  sources: ConflictSourceLike[],
  question: string,
  opts: { maxSources?: number } = {},
): ConflictResult {
  const list = (sources || []).slice(0, opts.maxSources ?? 4);
  if (list.length < 2) return { conflictDetected: false, conflicts: [] };

  const conflicts: DetectedConflict[] = [];
  const q = question || '';

  const check = (field: ConflictField, re: RegExp, contextRe: RegExp) => {
    const byValue = new Map<string, Set<string>>();
    for (const s of list) {
      const text = textOf(s);
      // Only compare when the source itself is about this kind of fact, or
      // the visitor explicitly asked about it.
      if (!contextRe.test(text) && !contextRe.test(q)) continue;
      for (const v of extract(re, text)) {
        if (!byValue.has(v)) byValue.set(v, new Set());
        byValue.get(v)!.add(s.id);
      }
    }
    if (byValue.size < 2) return;
    // A conflict only counts when the differing values come from DIFFERENT
    // sources (one source listing several plan prices is not a conflict).
    const values = Array.from(byValue.keys());
    const sourceIds = new Set<string>();
    for (const ids of byValue.values()) for (const id of ids) sourceIds.add(id);
    if (sourceIds.size < 2) return;
    const distinctSingleOwners = values.filter((v) => byValue.get(v)!.size === 1);
    if (distinctSingleOwners.length < 2) return;
    conflicts.push({ field, values: values.sort(), sourceIds: Array.from(sourceIds).sort() });
  };

  check('price', MONEY_RE, PRICE_CONTEXT);
  check('policy_days', DAYS_RE, POLICY_CONTEXT);

  return { conflictDetected: conflicts.length > 0, conflicts };
}