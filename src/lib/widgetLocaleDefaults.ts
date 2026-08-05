/**
 * Locale-aware defaults for widget texts.
 *
 * Legacy workspaces were seeded with English strings ("Chat with us",
 * "Hello! How can we help you?"). When the widget language is not English
 * those seeds are treated as *unset* — both by the runtime (server/routes/widget.ts)
 * and by the live preview — so the localized default is shown instead.
 * The settings form must follow the same rule, otherwise the operator sees
 * English text in the input while the widget renders Persian.
 */
export type WidgetTextKind = 'launcher' | 'welcome';

const SEED_TEXTS: Record<WidgetTextKind, string[]> = {
  launcher: ['chat with us', 'support', 'hello!'],
  welcome: ['hello! how can we help you?', 'how can we help you?'],
};

const DEFAULTS: Record<string, Record<WidgetTextKind, string>> = {
  en: { launcher: 'Chat with us', welcome: 'How can we help?' },
  fa: { launcher: 'با ما گفتگو کنید', welcome: 'چطور می‌توانیم کمک کنیم؟' },
  tr: { launcher: 'Bizimle sohbet edin', welcome: 'Nasıl yardımcı olabiliriz?' },
};

export function normalizeLocale(locale: string | null | undefined): string {
  return (locale || 'en').toLowerCase().split('-')[0];
}

/** Localized fallback text shown as placeholder for the given field. */
export function widgetTextDefault(kind: WidgetTextKind, locale: string | null | undefined): string {
  const lang = normalizeLocale(locale);
  return (DEFAULTS[lang] || DEFAULTS.en)[kind];
}

/** Value to display in the editor: empty when the stored text is an English seed. */
export function widgetTextValue(
  value: unknown,
  kind: WidgetTextKind,
  locale: string | null | undefined,
): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (normalizeLocale(locale) === 'en') return typeof value === 'string' ? value : '';
  if (!raw || SEED_TEXTS[kind].includes(raw.toLowerCase())) return '';
  return typeof value === 'string' ? value : '';
}
