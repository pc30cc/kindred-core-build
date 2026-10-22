/**
 * The chat widget's built-in texts a workspace may replace with its own, in
 * one table for the server (GET /config, server/services/widget/
 * configSnapshot.ts) and the panel (Widget → Appearance: the welcome
 * message's placeholder, the pill's text a launcher style starts with).
 *
 * English seeds: rows were once created with English text ("Chat with us",
 * "Hello! How can we help you?"). The owner never wrote such a value, so it
 * counts as unset in every language: the visitor gets the platform's
 * default, else the built-in text in the widget's language. The panel shows
 * an unset text as an empty field whose placeholder is what visitors see,
 * and never writes a default into the row by itself.
 *
 * Pure: no I/O.
 */

export type WidgetTextKind = 'launcher' | 'welcome' | 'pill';
export type WidgetTextLocale = 'en' | 'fa' | 'tr';

const SEEDS: Record<WidgetTextKind, readonly string[]> = {
  launcher: ['chat with us', 'support', 'hello!'],
  welcome: ['hello! how can we help you?', 'how can we help you?'],
  pill: [],
};

/** The built-in texts, per widget language. */
export const WIDGET_TEXT_DEFAULTS: Readonly<Record<WidgetTextLocale, Readonly<Record<WidgetTextKind, string>>>> = {
  en: { launcher: 'Chat with us', welcome: 'Hello! How can we help you?', pill: 'Questions? Ask us' },
  fa: { launcher: 'با ما گفتگو کنید', welcome: 'سلام! چطور می‌توانیم کمکتان کنیم؟', pill: 'سؤالی دارید؟ بپرسید' },
  tr: { launcher: 'Bizimle sohbet edin', welcome: 'Merhaba! Size nasıl yardımcı olabiliriz?', pill: 'Sorunuz mu var? Sorun' },
};

/** `fa-IR` → `fa`; anything else unknown → `en`. */
export function widgetTextLocale(locale: unknown): WidgetTextLocale {
  const base = String(locale || 'en').toLowerCase().split('-')[0];
  return base === 'fa' || base === 'tr' ? base : 'en';
}

/** The built-in text of `kind` in the widget's language. */
export function widgetTextDefault(kind: WidgetTextKind, locale: unknown): string {
  return WIDGET_TEXT_DEFAULTS[widgetTextLocale(locale)][kind];
}

/** True for a text somebody wrote: not empty and not one of the English seeds. */
export function isAuthoredWidgetText(value: unknown, kind: WidgetTextKind): value is string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return !!raw && !SEEDS[kind].includes(raw.toLowerCase());
}

/** What the editor shows for a stored text: the owner's own, else '' (the placeholder then shows the default). */
export function widgetTextValue(value: unknown, kind: WidgetTextKind): string {
  return isAuthoredWidgetText(value, kind) ? (value as string) : '';
}

/**
 * The welcome message visitors read: the workspace's own, else the Super
 * Admin's platform default (Super Admin → Widget settings, in every
 * language), else the built-in one in the widget's language.
 */
export function resolveWelcomeMessage(own: unknown, platformDefault: unknown, locale: unknown): string {
  if (isAuthoredWidgetText(own, 'welcome')) return own.trim();
  if (isAuthoredWidgetText(platformDefault, 'welcome')) return platformDefault.trim();
  return widgetTextDefault('welcome', locale);
}
