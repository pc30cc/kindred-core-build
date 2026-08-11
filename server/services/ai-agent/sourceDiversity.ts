/**
 * AI Agent — Phase 2.4: bounded retrieval diversity + deduplication.
 *
 * Pure, cheap and deterministic. No embeddings, no pairwise LLM calls:
 * near-duplicate detection uses normalized token sets (Jaccard) over a
 * capped candidate list, and monopoly control uses the parent source id.
 *
 * Guarantees:
 *   - identical / near-identical chunks are collapsed (best score wins)
 *   - one article/page cannot occupy every slot while other relevant
 *     sources are dropped (per-parent cap)
 *   - if slots remain unfilled, capped overflow is re-admitted in rank
 *     order, so ranking quality is preserved
 */

export interface DiversityCandidate {
  /** Stable identity of this candidate (chunk-level). */
  key: string;
  /** Group identity — article/page/file the candidate belongs to. */
  parentKey: string;
  score: number;
  text: string;
}

export interface DiversityDebug {
  candidates_before: number;
  candidates_after: number;
  duplicates_removed: number;
  capped_by_parent: number;
  reinstated_from_overflow: number;
  max_per_parent: number;
}

export interface DiversityResult<T> {
  selected: T[];
  debug: DiversityDebug;
}

export interface DiversityOptions {
  limit: number;
  /** Max candidates admitted from the same parent source. Default 2. */
  maxPerParent?: number;
  /** Jaccard similarity at/above which two candidates are near-duplicates. */
  duplicateThreshold?: number;
}

function tokenSet(text: string): Set<string> {
  const tokens = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 200);
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Applies dedupe + per-parent diversity to an already-ranked candidate list
 * (highest score first is assumed; the list is re-sorted defensively).
 */
export function diversifySources<T>(
  items: T[],
  toCandidate: (item: T) => DiversityCandidate,
  opts: DiversityOptions,
): DiversityResult<T> {
  const limit = Math.max(0, opts.limit);
  const maxPerParent = Math.max(1, opts.maxPerParent ?? 2);
  const threshold = opts.duplicateThreshold ?? 0.85;

  const enriched = items
    .map((item) => ({ item, cand: toCandidate(item) }))
    .sort((a, b) => (b.cand.score || 0) - (a.cand.score || 0));

  const debug: DiversityDebug = {
    candidates_before: enriched.length,
    candidates_after: 0,
    duplicates_removed: 0,
    capped_by_parent: 0,
    reinstated_from_overflow: 0,
    max_per_parent: maxPerParent,
  };
  if (!limit || !enriched.length) return { selected: [], debug };

  const acceptedTokens: Array<Set<string>> = [];
  const perParent = new Map<string, number>();
  const seenKeys = new Set<string>();
  const selected: T[] = [];
  const overflow: Array<{ item: T; tokens: Set<string> }> = [];

  for (const { item, cand } of enriched) {
    if (seenKeys.has(cand.key)) { debug.duplicates_removed++; continue; }
    seenKeys.add(cand.key);
    const tokens = tokenSet(cand.text);
    const isDuplicate = acceptedTokens.some((t) => jaccard(t, tokens) >= threshold);
    if (isDuplicate) { debug.duplicates_removed++; continue; }

    const used = perParent.get(cand.parentKey) || 0;
    if (used >= maxPerParent) {
      debug.capped_by_parent++;
      overflow.push({ item, tokens });
      continue;
    }
    if (selected.length >= limit) {
      overflow.push({ item, tokens });
      continue;
    }
    perParent.set(cand.parentKey, used + 1);
    acceptedTokens.push(tokens);
    selected.push(item);
  }

  // Slots left over (because of parent capping) → re-admit best overflow.
  for (const o of overflow) {
    if (selected.length >= limit) break;
    if (acceptedTokens.some((t) => jaccard(t, o.tokens) >= threshold)) continue;
    acceptedTokens.push(o.tokens);
    selected.push(o.item);
    debug.reinstated_from_overflow++;
  }

  debug.candidates_after = selected.length;
  return { selected, debug };
}