/**
 * The language a conversation is answered in, for ranking canned responses
 * (finding I-14). It used to be the operator's panel language, so on RESPOK an
 * operator with an English panel answering a Turkish widget saw the English
 * replies first.
 *
 * In order, as the AI agent decides its reply language (visitor first,
 * server/services/ai-agent/language.ts):
 *   1. the language the visitor writes in (their latest messages);
 *   2. the widget's language (`workspaces.widget_locale`), unless automatic;
 *   3. the workspace's language (`default_locale`);
 *   4. the operator's own language.
 * Only the languages a canned response can have (en, fa, tr) count.
 */
import type { CannedLocale } from '@/lib/canned-responses-api';

const LOCALES: readonly CannedLocale[] = ['en', 'fa', 'tr'];

/** Perso-Arabic script (Persian and Arabic share it; fa is the only such reply language). */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/g;
/** Letters only Turkish writes among the three languages. */
const TURKISH_LETTER = /[ğĞşŞıİ]/g;
/** Letters Turkish shares with other Latin languages, a weaker sign. */
const TURKISH_SHARED = /[çÇöÖüÜ]/g;
const TURKISH_WORDS = /(?:^|[^\p{L}])(merhaba|selam|teşekkür(?:ler)?|lütfen|nasıl|fiyat|sipariş|kargo|yardım|evet|hayır|iyi günler|tamam|bir|ve|için|bu|ne)(?=$|[^\p{L}])/giu;
const ENGLISH_WORDS = /(?:^|[^\p{L}])(hi|hello|thanks|thank you|please|the|and|is|my|order|help|how|what|where|when|can|you)(?=$|[^\p{L}])/giu;

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** A reply language tag ('fa-IR' → 'fa'), or null when none of the three. */
export function replyLocaleOf(tag: string | null | undefined): CannedLocale | null {
  const base = String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0] as CannedLocale;
  return LOCALES.includes(base) ? base : null;
}

/**
 * The language of a visitor's text, or null when it cannot tell (too short,
 * digits, emoji, or as much of one script as the other).
 */
export function detectReplyLocale(text: string | null | undefined): CannedLocale | null {
  const s = String(text ?? '');
  const arabic = count(s, ARABIC_SCRIPT);
  const latin = count(s, LATIN_LETTER);
  if (arabic + latin < 2) return null;
  if (arabic > latin) return 'fa';
  if (latin > arabic) {
    const turkish = count(s, TURKISH_LETTER) * 3 + count(s, TURKISH_SHARED) + count(s, TURKISH_WORDS) * 2;
    const english = count(s, ENGLISH_WORDS) * 2;
    if (turkish > english) return 'tr';
    return latin >= 3 ? 'en' : null;
  }
  return null;
}

export interface ReplyLocaleSources {
  /** The visitor's messages, newest first (only the latest few are read). */
  visitorTexts?: ReadonlyArray<string | null | undefined>;
  widgetLocale?: string | null;
  workspaceLocale?: string | null;
  operatorLocale: CannedLocale;
}

/** How many of the visitor's latest messages are read. */
const VISITOR_TEXTS_READ = 5;

export function conversationReplyLocale(src: ReplyLocaleSources): CannedLocale {
  const texts = (src.visitorTexts ?? []).filter((x): x is string => typeof x === 'string' && !!x.trim());
  const fromVisitor = detectReplyLocale(texts.slice(0, VISITOR_TEXTS_READ).join('\n'));
  return fromVisitor
    ?? replyLocaleOf(src.widgetLocale)
    ?? replyLocaleOf(src.workspaceLocale)
    ?? src.operatorLocale;
}
