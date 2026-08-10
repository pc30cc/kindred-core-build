/**
 * AI Agent — language policy service (Pass 1).
 *
 * Responsibilities:
 *   - Detect the visitor input language from the question text (cheap heuristic).
 *   - Read the active widget/workspace locale.
 *   - Decide which language the AI should reply in.
 *
 * Rules:
 *   - Understand visitor input in any supported language.
 *   - Always reply in the widget active language UNLESS widget locale is 'auto'.
 *   - If widget locale is 'auto' (or empty), reply in detected visitor language.
 *   - Fall back to 'en' when nothing else is known.
 *
 * No IO, no LLM. Safe to call inline.
 */

export type SupportedLanguage = 'en' | 'fa' | 'tr' | 'ar' | 'unknown';

export interface LanguageDecision {
  inputLanguage: SupportedLanguage;
  widgetLocale: string;          // raw value as stored on the workspace
  responseLanguage: string;      // BCP-47-ish locale the AI should use
  source: 'visitor_detected' | 'widget_fallback' | 'workspace_fallback' | 'fallback_en';
  detectionConfidence: number;   // 0..1 — how sure we are about inputLanguage
  mixedLanguageDetected: boolean;
}

/**
 * Cheap script-based language detection. Good enough for routing the
 * response; we are NOT trying to compete with a real langid model.
 */
export function detectInputLanguage(text: string): SupportedLanguage {
  const s = (text || '').trim();
  if (!s) return 'unknown';

  // Persian/Arabic script range. Persian-specific letters first.
  // U+0600–U+06FF Arabic; U+0750–U+077F Arabic Supplement; U+FB50–U+FDFF, U+FE70–U+FEFF
  const arabicScript = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  // Persian-only letters: گ پ چ ژ ک ی  (note: ک/ی also appear in some Arabic dialects)
  const persianMarkers = /[\u067E\u0686\u0698\u06A9\u06AF\u06CC]/;

  if (arabicScript.test(s)) {
    if (persianMarkers.test(s)) return 'fa';
    return 'ar';
  }

  // Turkish-specific letters give a strong signal.
  if (/[ğĞşŞıİçÇöÖüÜ]/.test(s)) return 'tr';

  // Common Turkish stopwords (avoid English false positives).
  const turkishWords = /\b(merhaba|selam|nasıl|nedir|fiyat|fiyatlar|destek|yardım|bilgi|teşekkür|lütfen|paket|abonelik|ücret|temsilci)\b/i;
  if (turkishWords.test(s)) return 'tr';

  // Default to English when ASCII-ish and no Turkish hints.
  if (/^[\x00-\x7F\s]+$/.test(s)) return 'en';

  return 'unknown';
}

/**
 * Detailed detection — returns language, confidence and mixed-language flag.
 * Heuristic: count chars in each script bucket and pick the dominant one.
 */
export function detectInputLanguageDetailed(text: string): {
  language: SupportedLanguage;
  confidence: number;
  mixed: boolean;
  scores: Record<SupportedLanguage, number>;
} {
  const s = (text || '').trim();
  const empty = { language: 'unknown' as SupportedLanguage, confidence: 0, mixed: false, scores: { en: 0, fa: 0, tr: 0, ar: 0, unknown: 0 } };
  if (!s) return empty;

  let fa = 0, ar = 0, tr = 0, en = 0, total = 0;
  // Persian and Arabic share the vast majority of their alphabet (both are
  // Perso-Arabic script), so per-character scoring MUST NOT weight shared
  // letters as strongly as script-specific ones -- doing so previously made
  // ordinary Persian sentences classify as 'ar', since most Persian letters
  // are also valid Arabic letters. Three buckets instead of two:
  //   - persianOnly: letters that exist ONLY in Persian orthography, never
  //     standard Arabic (\u067E \u0686 \u0698 \u06A9 \u06AF \u06CC).
  //   - arabicOnly: letters/marks that exist in standard Arabic orthography
  //     but that correctly-typed Persian never uses -- the Arabic forms of
  //     kaf/yeh (\u0643/\u064A, as opposed to Persian's \u06A9/\u06CC) and
  //     taa marbuta (\u0629), plus Arabic diacritics (harakat,
  //     \u064B-\u0652) common in formal/vocalized Arabic and essentially
  //     never used in Persian.
  //   - the remaining shared Perso-Arabic-script range: still a real signal
  //     that the text is Persian-or-Arabic rather than Latin/other, but
  //     weighted low so it can't drown out the two script-specific buckets.
  const persianOnly = /[\u067E\u0686\u0698\u06A9\u06AF\u06CC]/;
  const arabicOnly = /[\u0643\u064A\u0629\u064B-\u0652]/;
  const arabicRange = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const turkishOnly = /[ğĞşŞıİçÇöÖüÜ]/;
  const asciiLetter = /[A-Za-z]/;
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    total += 1;
    if (persianOnly.test(ch)) { fa += 3; continue; }
    if (arabicOnly.test(ch)) { ar += 3; continue; }
    if (arabicRange.test(ch)) { ar += 0.1; continue; }
    if (turkishOnly.test(ch)) { tr += 2; continue; }
    if (asciiLetter.test(ch)) { en += 1; continue; }
  }
  // Turkish word bonus — short tokens like "plan fiyat" have no diacritics.
  const trWords = (s.match(/\b(merhaba|selam|nasıl|nedir|fiyat|fiyatlar|destek|yardım|bilgi|teşekkür|lütfen|paket|abonelik|ücret|temsilci|plan)\b/gi) || []).length;
  tr += trWords * 3;
  // English word bonus — common interrogatives & support words.
  const enWords = (s.match(/\b(hi|hello|help|price|pricing|plan|plans|support|how|what|when|where|why|the|and|please|thanks)\b/gi) || []).length;
  en += enWords * 2;
  // Persian function-word bonus — same pattern as the Turkish/English word
  // bonuses above, needed for Persian sentences that use few or no
  // Persian-only letters (e.g. "\u0645\u0646 \u0633\u0648\u0627\u0644 \u062f\u0627\u0631\u0645 \u062f\u0631\u0628\u0627\u0631\u0647 \u0634\u0645\u0627").
  // Follow-up: plain Persian sentences built entirely from shared-script
  // letters and none of these markers (e.g. "\u0633\u0644\u0627\u0645 \u0645\u0646 \u062E\u0648\u0628\u0645", "\u062D\u0627\u0644\u0645 \u062E\u0648\u0628\u0647") still scored
  // 'ar' -- \u062E\u0648\u0628 (khoob, "good"/"well") is added below as
  // Persian-exclusive vocabulary (not standard Arabic) to close that gap.
  // Also: JS `\b` is defined via `\w` ([A-Za-z0-9_]) and never matches
  // Perso-Arabic letters, so a literal `\bWORD\b` around a Persian/Arabic
  // word can never assert a boundary there and silently never matches
  // (verified: /\b\u0631\u0627\b/.test('\u0627\u06CC\u0646 \u0631\u0627 \u0645\u0646') === false). The
  // three/four word-only markers below (\u0631\u0627/\u0627\u06CC\u0646/\u0634\u0645\u0627 and
  // \u0641\u064A/\u0639\u0644\u0649/\u0623\u0646\u062A/\u0623\u0646\u0627) now use an explicit Unicode
  // letter/mark/digit boundary instead (`u` flag + \p{L}\p{M}\p{N}) so they
  // work as originally intended.
  const faWords = (s.match(/(\u0645\u06CC[\u200c ]?|\u0627\u0633\u062A|\u0647\u0633\u062A\u0645|\u0647\u0633\u062A\u06CC\u062F|\u062F\u0627\u0631\u0645|\u062F\u0627\u0631\u06CC|\u062F\u0627\u0631\u062F|\u062F\u0627\u0631\u06CC\u0645|\u062F\u0627\u0631\u0646\u062F|\u0686\u06CC\u0633\u062A|\u0686\u0637\u0648\u0631|\u0686\u06AF\u0648\u0646\u0647|\u062F\u0631\u0628\u0627\u0631\u0647|\u062E\u0648\u0628|(?<![\p{L}\p{M}\p{N}_])\u0631\u0627(?![\p{L}\p{M}\p{N}_])|(?<![\p{L}\p{M}\p{N}_])\u0627\u06CC\u0646(?![\p{L}\p{M}\p{N}_])|(?<![\p{L}\p{M}\p{N}_])\u0634\u0645\u0627(?![\p{L}\p{M}\p{N}_]))/gu) || []).length;
  fa += faWords * 3;
  // Arabic function-word bonus — common Arabic-only grammatical markers
  // (relative pronouns, prepositions) that never occur in Persian.
  const arWords = (s.match(/(\u0647\u0630\u0627|\u0647\u0630\u0647|\u0627\u0644\u062A\u064A|\u0627\u0644\u0630\u064A|(?<![\p{L}\p{M}\p{N}_])\u0641\u064A(?![\p{L}\p{M}\p{N}_])|(?<![\p{L}\p{M}\p{N}_])\u0639\u0644\u0649(?![\p{L}\p{M}\p{N}_])|\u0625\u0644\u0649|\u0643\u064A\u0641|\u0645\u0627\u0630\u0627|(?<![\p{L}\p{M}\p{N}_])\u0623\u0646\u062A(?![\p{L}\p{M}\p{N}_])|(?<![\p{L}\p{M}\p{N}_])\u0623\u0646\u0627(?![\p{L}\p{M}\p{N}_]))/gu) || []).length;
  ar += arWords * 3;

  const scores: Record<SupportedLanguage, number> = { en, fa, tr, ar, unknown: 0 };
  const entries = (Object.entries(scores) as Array<[SupportedLanguage, number]>).filter(([k]) => k !== 'unknown');
  entries.sort((a, b) => b[1] - a[1]);
  const [topLang, topScore] = entries[0];
  const [, secondScore] = entries[1] || ['en' as SupportedLanguage, 0];
  const sum = en + fa + tr + ar;
  if (sum === 0) {
    return { language: 'unknown', confidence: 0, mixed: false, scores };
  }
  const confidence = Math.min(1, topScore / sum);
  // Mixed if the runner-up has at least 35% of the dominant signal.
  const mixed = secondScore > 0 && secondScore / Math.max(topScore, 1) >= 0.35;
  // Too short & ambiguous → unknown.
  if (total < 2 && trWords === 0 && enWords === 0) {
    return { language: 'unknown', confidence: 0, mixed: false, scores };
  }
  return { language: topLang, confidence, mixed, scores };
}

function normalizeLocale(loc: string | null | undefined): string {
  const v = (loc || '').toLowerCase().trim();
  if (!v) return '';
  // Accept 'fa', 'fa-IR', 'tr-TR', etc. — keep base tag.
  return v.split(/[-_]/)[0];
}

/**
 * Decide the response language.
 *
 * Rule (visitor language WINS):
 *   1. If detected visitor language is supported → reply in visitor language.
 *   2. Else fall back to widget locale (if real, not 'auto').
 *   3. Else fall back to workspace locale.
 *   4. Else 'en'.
 *
 * If a locale allow-list is configured, the chosen language must be allowed.
 */
export function decideResponseLanguage(args: {
  visitorText: string;
  widgetLocale?: string | null;        // workspace.widget_language
  workspaceLocale?: string | null;     // workspace.locale fallback
  allowedLocales?: string[];
}): LanguageDecision {
  const detail = detectInputLanguageDetailed(args.visitorText);
  const inputLanguage = detail.language;
  // PHASE 2 FIX: detectInputLanguageDetailed() now distinguishes Persian
  // from Arabic on script/lexical signals alone (see its own comment for
  // the persianOnly/arabicOnly/shared-range weighting), so it no longer
  // needs an allow-list-dependent correction here. The previous version of
  // this function unconditionally relabeled ANY 'ar' detection as 'fa'
  // whenever the allow-list contained fa but not ar — which incorrectly
  // relabeled genuine Arabic input too, not just misclassified Persian.
  // That branch has been removed; Arabic input is no longer biased toward
  // Persian regardless of the allow-list.
  const allowedNorm = (args.allowedLocales || []).map((l) => normalizeLocale(l)).filter(Boolean);
  const widgetRaw = (args.widgetLocale || '').toString();
  const widgetNorm = normalizeLocale(widgetRaw);
  const wsNorm = normalizeLocale(args.workspaceLocale);
  const allowed = allowedNorm;

  let response = 'en';
  let source: LanguageDecision['source'] = 'fallback_en';

  const widgetIsAuto = !widgetRaw || widgetRaw.toLowerCase() === 'auto';

  // 1) Visitor language wins.
  if (inputLanguage !== 'unknown' && detail.confidence >= 0.4) {
    response = inputLanguage;
    source = 'visitor_detected';
  } else if (!widgetIsAuto && widgetNorm) {
    response = widgetNorm;
    source = 'widget_fallback';
  } else if (wsNorm) {
    response = wsNorm;
    source = 'workspace_fallback';
  }

  // Honour allow-list when configured. If response not allowed, fall back
  // to the first allowed locale rather than silently switching languages.
  if (allowed.length && !allowed.includes(response)) {
    response = allowed[0];
    source = 'fallback_en';
  }

  return {
    inputLanguage,
    widgetLocale: widgetRaw || '',
    responseLanguage: response,
    source,
    detectionConfidence: Number(detail.confidence.toFixed(3)),
    mixedLanguageDetected: detail.mixed,
  };
}

export function languageDisplayName(code: string): string {
  const c = (code || '').toLowerCase();
  if (c.startsWith('fa')) return 'Persian (Farsi)';
  if (c.startsWith('tr')) return 'Turkish';
  if (c.startsWith('ar')) return 'Arabic';
  if (c.startsWith('en')) return 'English';
  return code || 'English';
}