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
  /** Recognised entity/field scope the values were compared within. */
  entity: string;
  values: string[];
  sourceIds: string[];
}

export interface ConflictResult {
  conflictDetected: boolean;
  conflicts: DetectedConflict[];
}

const MONEY_RE = /(?:[$€£]\s?(\d{1,6}(?:[.,]\d{1,2})?))|(?:\b(\d{1,6}(?:[.,]\d{1,2})?)\s?(?:usd|eur|gbp|dollars?|euros?)\b)/gi;
const DAYS_RE = /\b(\d{1,3})\s*(?:-|\s)?\s*(?:day|days|gün|روز)\b/gi;

/** Recognised plan/product identities used to scope price comparisons. */
const PLAN_NAMES: Array<{ key: string; re: RegExp }> = [
  { key: 'free', re: /\bfree\b|\bرایگان\b|\bücretsiz\b/i },
  { key: 'starter', re: /\bstarter\b|\bbasic\b|\bشروع\b|\bباشلانگیچ\b/i },
  { key: 'pro', re: /\bpro\b|\bprofessional\b|\bحرفه ?ای\b/i },
  { key: 'business', re: /\bbusiness\b|\bteam\b|\bکسب ?و ?کار\b/i },
  { key: 'growth', re: /\bgrowth\b|\bplus\b|\bpremium\b/i },
  { key: 'enterprise', re: /\benterprise\b|\bسازمانی\b|\bkurumsal\b/i },
];

/** Recognised policy-duration categories. */
const POLICY_CATEGORIES: Array<{ key: string; re: RegExp }> = [
  { key: 'refund', re: /\b(refund|refunds|return|returns|money[- ]back)\b|بازگشت|مرجوع|iade/i },
  { key: 'trial', re: /\b(trial|free trial|evaluation)\b|آزمایشی|deneme/i },
  { key: 'cancellation', re: /\b(cancel|cancellation|terminate|termination)\b|لغو|iptal/i },
];

/** Characters of context scanned on each side of a number for its label. */
const WINDOW = 80;

interface LabelledValue { entity: string; value: string }

function labelFor(
  text: string,
  index: number,
  labels: Array<{ key: string; re: RegExp }>,
): string | null {
  const start = Math.max(0, index - WINDOW);
  const window = text.slice(start, index + WINDOW);
  // Prefer the label closest to the number.
  let best: { key: string; distance: number } | null = null;
  for (const l of labels) {
    const re = new RegExp(l.re.source, l.re.flags.includes('g') ? l.re.flags : `${l.re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      const absolute = start + m.index;
      const distance = Math.abs(absolute - index);
      if (!best || distance < best.distance) best = { key: l.key, distance };
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return best ? best.key : null;
}

function textOf(s: ConflictSourceLike): string {
  return `${s.title || ''}\n${s.content || s.excerpt || ''}`;
}

function normalizeNumber(raw: string): string {
  const n = Number(String(raw).replace(/,/g, '.'));
  return Number.isFinite(n) ? String(n) : String(raw);
}

function extractLabelled(
  re: RegExp,
  text: string,
  labels: Array<{ key: string; re: RegExp }>,
): LabelledValue[] {
  const out: LabelledValue[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    if (raw) {
      const entity = labelFor(text, m.index, labels);
      // Unlabelled numbers can't be proven to describe the same entity/field:
      // skip them rather than risk a false conflict.
      if (entity) out.push({ entity, value: normalizeNumber(raw) });
    }
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

  const check = (
    field: ConflictField,
    re: RegExp,
    labels: Array<{ key: string; re: RegExp }>,
    contextRe: RegExp,
  ) => {
    // entity -> value -> sourceIds
    const byEntity = new Map<string, Map<string, Set<string>>>();
    for (const s of list) {
      const text = textOf(s);
      if (!contextRe.test(text) && !contextRe.test(q)) continue;
      for (const { entity, value } of extractLabelled(re, text, labels)) {
        if (!byEntity.has(entity)) byEntity.set(entity, new Map());
        const byValue = byEntity.get(entity)!;
        if (!byValue.has(value)) byValue.set(value, new Set());
        byValue.get(value)!.add(s.id);
      }
    }

    for (const [entity, byValue] of byEntity) {
      if (byValue.size < 2) continue;
      const values = Array.from(byValue.keys());
      const sourceIds = new Set<string>();
      for (const ids of byValue.values()) for (const id of ids) sourceIds.add(id);
      if (sourceIds.size < 2) continue;
      // Differing values must come from DIFFERENT sources (one source listing
      // several values for the same entity is a range, not a conflict).
      const distinctSingleOwners = values.filter((v) => byValue.get(v)!.size === 1);
      if (distinctSingleOwners.length < 2) continue;
      const owners = new Set<string>();
      for (const v of distinctSingleOwners) for (const id of byValue.get(v)!) owners.add(id);
      if (owners.size < 2) continue;
      conflicts.push({
        field,
        entity,
        values: values.sort(),
        sourceIds: Array.from(sourceIds).sort(),
      });
    }
  };

  const PRICE_CONTEXT = /(price|pricing|plan|cost|subscription|fee|fiyat|قیمت|پلن|هزینه)/i;
  const POLICY_CONTEXT = /(refund|return|trial|cancel|guarantee|iade|deneme|بازگشت|مرجوع|آزمایشی|لغو)/i;

  check('price', MONEY_RE, PLAN_NAMES, PRICE_CONTEXT);
  check('policy_days', DAYS_RE, POLICY_CATEGORIES, POLICY_CONTEXT);

  return { conflictDetected: conflicts.length > 0, conflicts };
}