/**
 * PostgREST's "Perhaps you meant ..." suggestions come from the Haskell
 * `fuzzyset` package (a port of fuzzyset.js) with its default set: n-grams of
 * size 3 falling back to 2, cosine similarity, the top 50 re-ranked by
 * Levenshtein distance, and a minimum score of 0.33. This is the same
 * algorithm, so a hint names the same table or function PostgREST would.
 */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s,]/gu, '');
}

function grams(value: string, size: number): Map<string, number> {
  let padded = `-${normalize(value)}-`;
  if (padded.length < size) padded += '-'.repeat(size - padded.length);
  const out = new Map<string, number>();
  for (let i = 0; i + size <= padded.length; i++) {
    const g = padded.slice(i, i + size);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function magnitude(v: Map<string, number>): number {
  let sum = 0;
  for (const n of v.values()) sum += n * n;
  return Math.sqrt(sum);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The best match for `query` among `candidates`, or undefined below the 0.33 floor. */
export function fuzzyBest(query: string, candidates: Iterable<string>, minScore = 0.33): string | undefined {
  const list = [...new Set(candidates)];
  const q = normalize(query);
  const exact = list.find((c) => normalize(c) === q);
  if (exact !== undefined) return exact;

  for (const size of [3, 2]) {
    const qv = grams(query, size);
    const qm = magnitude(qv);
    const scored: { score: number; value: string }[] = [];
    for (const c of list) {
      const cv = grams(c, size);
      let dot = 0;
      for (const [g, n] of qv) dot += n * (cv.get(g) ?? 0);
      if (dot > 0) scored.push({ score: dot / (qm * magnitude(cv)), value: c });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => b.score - a.score);
    const rescored = scored.slice(0, 50).map(({ value }) => {
      const nv = normalize(value);
      return { score: 1 - levenshtein(nv, q) / Math.max(nv.length, q.length), value };
    });
    rescored.sort((a, b) => b.score - a.score);
    const best = rescored.filter((r) => r.score >= minScore);
    return best.length ? best[0].value : undefined;
  }
  return undefined;
}
