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
  const persianOnly = /[\u067E\u0686\u0698\u06A9\u06AF\u06CC]/;
  const arabicRange = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const turkishOnly = /[ğĞşŞıİçÇöÖüÜ]/;
  const asciiLetter = /[A-Za-z]/;
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    total += 1;
    if (persianOnly.test(ch)) { fa += 2; continue; }
    if (arabicRange.test(ch)) { ar += 1; continue; }
    if (turkishOnly.test(ch)) { tr += 2; continue; }
    if (asciiLetter.test(ch)) { en += 1; continue; }
  }
  // Turkish strong-bias commercial / support words. A single match is
  // enough to override an ASCII-only English fallback ("fiyat" must be
  // detected as Turkish even though it's all ASCII letters).
  // NOTE: JS \b doesn't treat ü/ç/ı/ş/ö/ğ/İ as word chars, so we use
  // explicit non-letter delimiters instead.
  const TR_STRONG = ['merhaba','selam','selamlar','nasılsın','nasilsin','nasıl','nasil','nedir','fiyat','fiyatlar','fiyatlandırma','fiyatlandirma','ücret','ucret','ücretler','ucretler','destek','yardım','yardim','temsilci','paket','paketler','abonelik','abonman','teşekkür','tesekkur','lütfen','lutfen','bilgi','sorun','hesap','fatura','ödeme','odeme'];
  const trStrongRe = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${TR_STRONG.join('|')})(?=[^\\p{L}\\p{N}]|$)`, 'giu');
  const trStrong = (s.match(trStrongRe) || []).length;
  // Turkish soft-bias words (also used in English) — small bonus only.
  const trSoft = (s.match(/(?:^|[^\p{L}\p{N}])(plan|planlar)(?=[^\p{L}\p{N}]|$)/giu) || []).length;
  tr += trStrong * 20 + trSoft * 2;
  // English word bonus — common interrogatives & support words.
  const enWords = (s.match(/\b(hi|hello|help|price|pricing|plans|support|how|what|when|where|why|the|and|please|thanks|thank|account|billing|payment|refund|invoice)\b/gi) || []).length;
  en += enWords * 2;

  const scores: Record<SupportedLanguage, number> = { en, fa, tr, ar, unknown: 0 };
  const entries = (Object.entries(scores) as Array<[SupportedLanguage, number]>).filter(([k]) => k !== 'unknown');
  entries.sort((a, b) => b[1] - a[1]);
  const [topLang, topScore] = entries[0];
  const [, secondScore] = entries[1] || ['en' as SupportedLanguage, 0];
  const sum = en + fa + tr + ar;
  if (sum === 0) {
    return { language: 'unknown', confidence: 0, mixed: false, scores };
  }
  let confidence = Math.min(1, topScore / sum);
  // If a strong Turkish keyword was found, force high confidence.
  if (topLang === 'tr' && trStrong > 0) {
    confidence = Math.max(confidence, 0.85);
  }
  // Mixed if the runner-up has at least 35% of the dominant signal.
  const mixed = secondScore > 0 && secondScore / Math.max(topScore, 1) >= 0.35;
  // Too short & ambiguous → unknown.
  if (total < 2 && trStrong === 0 && trSoft === 0 && enWords === 0) {
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
 * If a locale allow-list is configured, the chosen language must be allowed
 * (with a special case: Persian visitor input maps to 'fa' even when the
 * allow-list contains fa but not ar).
 */
export function decideResponseLanguage(args: {
  visitorText: string;
  widgetLocale?: string | null;        // workspace.widget_language
  workspaceLocale?: string | null;     // workspace.locale fallback
  allowedLocales?: string[];
}): LanguageDecision {
  const detail = detectInputLanguageDetailed(args.visitorText);
  let inputLanguage = detail.language;
  // Bias Persian when ar detected but Persian is allowed and ar is not.
  // Common case: short Persian word that doesn't include گ/پ/چ/ژ/ک/ی.
  const allowedNorm = (args.allowedLocales || []).map((l) => normalizeLocale(l)).filter(Boolean);
  if (inputLanguage === 'ar' && allowedNorm.includes('fa') && !allowedNorm.includes('ar')) {
    inputLanguage = 'fa';
  }
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