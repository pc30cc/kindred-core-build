/**
 * The assistant may only hand out links it was actually given.
 *
 * A product URL for a Persian-named product is percent-encoded — that is the
 * only form that survives HTTP — and a model asked to repeat one does not
 * copy it, it RETYPES it. On the live store:
 *
 *   given  …/product/%d9%be%d8%a7%d9%88%d8%b1%d8%a8%d8%a7%d9%86%da%a9-%db%b2%db%b0%db%b0%db%b0%db%b0-%d9%85%db%8c%d9%84%db%8c%d8%a2%d9%85%d9%be%d8%b1-…/
 *   sent   …/product/پاوربانک-%d۲%DB%B0%DB%B0%DB%B0%DB%B0-میليياٟمپر-ولتمکس/
 *
 * Half of it was decoded by hand, `%db%b2` became `%d` followed by a Persian
 * ۲, and «میلی‌آمپر» came back as «میليياٟمپر» — different letters plus a
 * stray U+065F. The link 404s, and it looks authoritative while doing so.
 *
 * No amount of prompting fixes this reliably, so the text is repaired instead:
 * a store link in the answer is either byte-identical to one the tools
 * supplied this turn, or it is replaced by the one it was clearly meant to be,
 * or it is removed. Only hosts the tools themselves named are touched — a URL
 * from the knowledge base or from the operator's own text is left alone.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;

/**
 * Percent-decoding that survives a broken escape.
 *
 * `decodeURIComponent` is all-or-nothing: one malformed sequence and it
 * throws, leaving the whole path as hex. That is exactly the input here — the
 * model's `%d۲` is a `%d` followed by a Persian ۲, which is not an escape at
 * all — so a mangled URL fingerprinted as hex soup, matched nothing, and was
 * dropped instead of repaired. Each maximal run of VALID escapes is decoded
 * on its own; a broken one stays the literal characters it is.
 */
function decodeLoose(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (sequence) => {
    try { return decodeURIComponent(sequence); } catch { return sequence; }
  });
}

/**
 * The discriminating part of a URL, percent-decoded and stripped to letters
 * and digits, with the spellings a model mixes up folded together.
 *
 * Deliberately the PATH only. The host is already known to match before any
 * of this runs, and every product on one shop also shares its `/product/`
 * prefix — scoring those shared characters made two unrelated products look
 * 60% alike, so an invented URL matched a real product instead of being
 * dropped.
 */
function fingerprint(raw: string): string {
  let path = raw;
  try {
    const parsed = new URL(raw);
    path = parsed.pathname + parsed.search;
  } catch { /* not parseable — fall back to the whole string */ }
  return decodeLoose(path)
    .toLowerCase()
    .normalize('NFKC')
    // Arabic ی/ک and the Persian ones are the same letter to a reader, and a
    // model mixes them freely; combining marks are noise it invents.
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    // آ / أ / إ all get typed as a plain ا.
    .replace(/[آأإ]/g, 'ا')
    .replace(/[ً-ٰٟ‌‏‎]/g, '')
    // Persian and Arabic-Indic digits → ASCII, so ۲ and 2 compare equal.
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Longest common subsequence length — tolerant of the letters a model drops or invents. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Bounded so a pathological pair cannot cost more than a fixed amount of
  // work; real paths are far shorter than this.
  const x = a.slice(0, 200);
  const y = b.slice(0, 200);
  let previous = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    const current = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j += 1) {
      current[j] = x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[y.length] / Math.max(x.length, y.length);
}

function hostOf(url: string): string | null {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

/**
 * A retyped link has to be recognisably the same product, not merely a link
 * to the same shop — below this the answer loses the link rather than
 * pointing the visitor at the wrong page.
 */
const MIN_SIMILARITY = 0.6;

export function repairCommerceLinks(text: string, allowedUrls: readonly string[]): string {
  const source = String(text ?? '');
  if (!source || !allowedUrls.length) return source;

  const allowed = [...new Set(allowedUrls.filter(Boolean))];
  const allowedSet = new Set(allowed);
  const allowedHosts = new Set(allowed.map(hostOf).filter((h): h is string => !!h));
  const candidates = allowed.map((url) => ({ url, print: fingerprint(url) }));

  return source.replace(URL_PATTERN, (match) => {
    // Sentence punctuation is not part of the address.
    const trailing = match.match(/[.,;:!?؟،؛"'»]+$/)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;

    if (allowedSet.has(url)) return match;
    const host = hostOf(url);
    // Not a store host: someone else's link, and none of this code's business.
    if (!host || !allowedHosts.has(host)) return match;

    const print = fingerprint(url);
    let best: { url: string; score: number } | null = null;
    for (const candidate of candidates) {
      const score = similarity(print, candidate.print);
      if (!best || score > best.score) best = { url: candidate.url, score };
    }
    if (best && best.score >= MIN_SIMILARITY) return best.url + trailing;
    // Nothing it plausibly meant. A link that 404s is worse than no link, and
    // the sentence around it still answers the question.
    return trailing;
  });
}

/** Every URL this turn's commerce tools put in front of the model. */
export function urlsFromToolResults(results: readonly { data?: unknown }[]): string[] {
  const out: string[] = [];
  for (const result of results) {
    const data = result?.data;
    if (!data || typeof data !== 'object') continue;
    const url = (data as { url?: unknown }).url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) out.push(url);
  }
  return out;
}
