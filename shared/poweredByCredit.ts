/**
 * The words of the chat widget's "Powered by" credit, as every template
 * renders them (public/widget/presentation-*.js footerHtml): the Super
 * Admin's prefix (widget_platform_settings.powered_by_text) is one string for
 * every language, so a widget uses it only when it is written in the
 * widget's language — Persian script for Persian, any other script for
 * English and Turkish — and its own word otherwise (the runtime dictionary's
 * `poweredBy`, mirrored here). An empty prefix is the widget's own word.
 *
 * The Super Admin's preview shows the credit per language with this rule, so
 * a prefix typed in one script is seen to fall back for the other languages.
 */
export const POWERED_BY_WIDGET_WORDS = {
  en: 'Powered by',
  fa: 'با فناوری',
  tr: 'Sağlayan',
} as const;

export type PoweredByLocale = keyof typeof POWERED_BY_WIDGET_WORDS;

const PERSIAN_SCRIPT = /[؀-ۿ]/;

function isPersian(locale: string): boolean {
  return String(locale || 'en').toLowerCase().split('-')[0] === 'fa';
}

/** Whether a platform-wide text is written in the widget's language (the renderers' textFitsLocale). */
export function poweredByTextFitsLocale(text: string, locale: string): boolean {
  return PERSIAN_SCRIPT.test(String(text)) === isPersian(locale);
}

/** The prefix a widget in `locale` shows before the platform's name or logo. */
export function poweredByPrefixFor(text: string | null | undefined, locale: string): string {
  const own = String(text ?? '').trim();
  if (own && poweredByTextFitsLocale(own, locale)) return own;
  const lang = String(locale || 'en').toLowerCase().split('-')[0];
  return (POWERED_BY_WIDGET_WORDS as Record<string, string>)[lang] ?? POWERED_BY_WIDGET_WORDS.en;
}
