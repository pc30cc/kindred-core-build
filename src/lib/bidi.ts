/**
 * Unicode bidi isolation for short foreign-direction runs embedded inside a
 * sentence of the opposite direction — e.g. a Latin visitor code (`PTXJ`)
 * inside a Persian (RTL) sentence, or a Persian city name inside an English
 * (LTR) one.
 *
 * Why this is needed: the Unicode Bidirectional Algorithm resolves a plain
 * string's visual order from its *surrounding* paragraph direction plus the
 * strong-direction runs it finds. A short LTR run next to RTL punctuation
 * (e.g. "بازدیدکننده · PTXJ") can, depending on the renderer/font and the
 * neutral characters around it, come out visually reordered — the reported
 * symptom being a code like "PTXJ" rendering as "JXTP". Isolating the run
 * with FSI/PDI tells the algorithm "resolve this run's own direction from
 * its own content, and never let it interact with the surrounding text's
 * ordering" — the correct fix per the Unicode bidi spec (UAX #9), and it
 * works identically whether the string ends up in a React text node, a
 * plain `title`/`alt` attribute, a native `alert()`, or a non-DOM string
 * (search index, log line, etc.) — unlike the HTML `<bdi>` element, which
 * only helps once parsed as markup.
 *
 * Explicitly NOT: string reversal, manual character reordering, or writing
 * these control characters into stored data — this only ever wraps a value
 * at render/format time, right before interpolating it into a
 * translation string.
 */

/** First Strong Isolate (U+2068) — direction is auto-detected from the wrapped text's own first strong character. */
const FSI = '⁨';
/** Pop Directional Isolate (U+2069) — closes the isolate opened by FSI/LRI/RLI. */
const PDI = '⁩';

/**
 * Wrap `text` in a bidi isolate so its own direction is resolved
 * independently of whatever text surrounds it once interpolated. Safe to
 * call on already-isolated or empty input.
 */
export function isolateBidi(text: string | null | undefined): string {
  if (!text) return '';
  return `${FSI}${text}${PDI}`;
}
