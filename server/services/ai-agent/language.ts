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
  source: 'widget_locale' | 'visitor_detected' | 'fallback';
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

function normalizeLocale(loc: string | null | undefined): string {
  const v = (loc || '').toLowerCase().trim();
  if (!v) return '';
  // Accept 'fa', 'fa-IR', 'tr-TR', etc. — keep base tag.
  return v.split(/[-_]/)[0];
}

/**
 * Decide the response language. Widget locale wins unless it is 'auto'/empty.
 */
export function decideResponseLanguage(args: {
  visitorText: string;
  widgetLocale?: string | null;        // workspace.widget_language
  workspaceLocale?: string | null;     // workspace.locale fallback
  allowedLocales?: string[];
}): LanguageDecision {
  const inputLanguage = detectInputLanguage(args.visitorText);
  const widgetRaw = (args.widgetLocale || '').toString();
  const widgetNorm = normalizeLocale(widgetRaw);
  const wsNorm = normalizeLocale(args.workspaceLocale);
  const allowed = (args.allowedLocales || []).map((l) => normalizeLocale(l)).filter(Boolean);

  let response = 'en';
  let source: LanguageDecision['source'] = 'fallback';

  const widgetIsAuto = !widgetRaw || widgetRaw.toLowerCase() === 'auto';

  if (!widgetIsAuto && widgetNorm) {
    response = widgetNorm;
    source = 'widget_locale';
  } else if (inputLanguage !== 'unknown') {
    response = inputLanguage;
    source = 'visitor_detected';
  } else if (wsNorm) {
    response = wsNorm;
    source = 'fallback';
  }

  // Honour allow-list when configured. If response not allowed, fall back
  // to the first allowed locale rather than silently switching languages.
  if (allowed.length && !allowed.includes(response)) {
    response = allowed[0];
    source = 'fallback';
  }

  return {
    inputLanguage,
    widgetLocale: widgetRaw || '',
    responseLanguage: response,
    source,
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