/**
 * Telegram inline menu: the bot's visual surface.
 *
 * Everything a user can tap is built here — the main menu, the FAQ browser
 * and the Knowledge Base help-article browser. Design rules:
 *
 *   - inline keyboards only (no persistent reply keyboard clutter); menu
 *     navigation EDITS the same bubble instead of spamming the chat
 *   - every entry carries an emoji icon and an operator-authored, localized
 *     label (see `settings.ts#resolveCommandLabel`)
 *   - optional entries (FAQ, help articles) appear only when switched on in
 *     the plugin settings — a disabled entry is invisible, never a dead end
 *   - callback payloads are short, opaque and always prefixed `tg:` so an
 *     unknown payload can be acknowledged and ignored safely
 *
 * Article bodies come from the workspace Knowledge Base (published +
 * visible-in-widget only) and are converted to Telegram-safe plain text.
 */

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import {
  TELEGRAM_COMMAND_ICONS,
  isTelegramMenuEntryEnabled,
  normalizeLocale,
  resolveCommandLabel,
  type TelegramCommandKey,
  type TelegramLocale,
  type TelegramSettings,
} from './settings.js';

export const TELEGRAM_CALLBACK_PREFIX = 'tg:';

/** Static chrome the operator does not author (titles, hints, navigation). */
type MenuStrings = {
  menuTitle: string;
  menuHint: string;
  back: string;
  faqTitle: string;
  faqHint: string;
  faqEmpty: string;
  guidesTitle: string;
  guidesHint: string;
  guidesEmpty: string;
  readMore: string;
  prev: string;
  next: string;
};

const STRINGS: Record<TelegramLocale, MenuStrings> = {
  en: {
    menuTitle: '✨ Main menu',
    menuHint: 'Pick an option below, or just type your question — we read every message.',
    back: '⬅️ Back',
    faqTitle: '❓ Frequently asked questions',
    faqHint: 'Tap a question to see the answer.',
    faqEmpty: 'No questions have been published yet. Send us your question and we will answer it.',
    guidesTitle: '📚 Help articles',
    guidesHint: 'Tap an article to read it here.',
    guidesEmpty: 'No help articles have been published yet.',
    readMore: 'Read the full article',
    prev: '◀️ Previous',
    next: 'Next ▶️',
  },
  fa: {
    menuTitle: '✨ منوی اصلی',
    menuHint: 'یکی از گزینه‌های زیر را انتخاب کنید، یا پرسش خود را بنویسید؛ همهٔ پیام‌ها خوانده می‌شوند.',
    back: '⬅️ بازگشت',
    faqTitle: '❓ سوالات متداول',
    faqHint: 'روی هر پرسش بزنید تا پاسخ آن نمایش داده شود.',
    faqEmpty: 'هنوز پرسشی منتشر نشده است. پرسش خود را بنویسید تا پاسخ دهیم.',
    guidesTitle: '📚 مقالات راهنما',
    guidesHint: 'روی هر مقاله بزنید تا همین‌جا آن را بخوانید.',
    guidesEmpty: 'هنوز مقالهٔ راهنمایی منتشر نشده است.',
    readMore: 'خواندن متن کامل مقاله',
    prev: '◀️ قبلی',
    next: 'بعدی ▶️',
  },
  tr: {
    menuTitle: '✨ Ana menü',
    menuHint: 'Aşağıdan bir seçenek seçin ya da sorunuzu yazın; her mesajı okuyoruz.',
    back: '⬅️ Geri',
    faqTitle: '❓ Sıkça sorulan sorular',
    faqHint: 'Cevabı görmek için bir soruya dokunun.',
    faqEmpty: 'Henüz yayınlanmış bir soru yok. Sorunuzu yazın, yanıtlayalım.',
    guidesTitle: '📚 Yardım makaleleri',
    guidesHint: 'Okumak için bir makaleye dokunun.',
    guidesEmpty: 'Henüz yayınlanmış bir yardım makalesi yok.',
    readMore: 'Makalenin tamamını oku',
    prev: '◀️ Önceki',
    next: 'Sonraki ▶️',
  },
};

export function menuStrings(locale: string | null | undefined, fallback?: string | null): MenuStrings {
  return STRINGS[normalizeLocale(locale) || normalizeLocale(fallback) || 'en'];
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Button = { text: string; callback_data?: string; url?: string };

function labelFor(
  settings: TelegramSettings,
  locale: string | null | undefined,
  key: TelegramCommandKey,
  fallback?: string | null,
): string {
  return `${TELEGRAM_COMMAND_ICONS[key]} ${resolveCommandLabel(settings, locale, key, fallback)}`.trim();
}

/**
 * Main menu. Rendered as a PERSISTENT REPLY KEYBOARD that sits right under
 * the Telegram text field (operator preference) — not as an inline keyboard
 * inside the bubble. Taps arrive as plain text messages and are mapped back
 * to a command by `matchReplyKeyboardCommand`.
 */
export function buildMainMenu(
  settings: TelegramSettings,
  locale: string | null | undefined,
  fallback?: string | null,
): { text: string; replyMarkup: Record<string, unknown> } {
  const s = menuStrings(locale, fallback);
  return {
    text: `<b>${escapeHtml(s.menuTitle)}</b>\n\n${escapeHtml(s.menuHint)}`,
    replyMarkup: buildReplyKeyboard(settings, locale, fallback),
  };
}

/** The persistent keyboard shown under the message input field. */
export function buildReplyKeyboard(
  settings: TelegramSettings,
  locale: string | null | undefined,
  fallback?: string | null,
): Record<string, unknown> {
  const rows: { text: string }[][] = [];

  const contentRow: { text: string }[] = [];
  if (isTelegramMenuEntryEnabled(settings, 'guides')) {
    contentRow.push({ text: labelFor(settings, locale, 'guides', fallback) });
  }
  if (isTelegramMenuEntryEnabled(settings, 'faq')) {
    contentRow.push({ text: labelFor(settings, locale, 'faq', fallback) });
  }
  if (contentRow.length) rows.push(contentRow);

  const actionRow: { text: string }[] = [];
  // "Talk to a human" is only meaningful while AI answers first — otherwise
  // an operator is already the default recipient.
  if (isTelegramMenuEntryEnabled(settings, 'human')) {
    actionRow.push({ text: labelFor(settings, locale, 'human', fallback) });
  }
  actionRow.push({ text: labelFor(settings, locale, 'new', fallback) });
  rows.push(actionRow);

  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: menuStrings(locale, fallback).menuHint.slice(0, 64),
  };
}

/** Normalizes a tapped keyboard label (drops icons/whitespace) for matching. */
function normalizeLabel(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Maps a plain-text message coming from the persistent keyboard back to the
 * command it represents, across every configured locale.
 */
export function matchReplyKeyboardCommand(
  settings: TelegramSettings,
  text: string | null | undefined,
): TelegramCommandKey | null {
  const needle = normalizeLabel(String(text ?? ''));
  if (!needle) return null;
  const keys: TelegramCommandKey[] = ['guides', 'faq', 'human', 'new', 'start'];
  for (const key of keys) {
    if (!isTelegramMenuEntryEnabled(settings, key)) continue;
    for (const locale of ['fa', 'en', 'tr'] as TelegramLocale[]) {
      if (normalizeLabel(resolveCommandLabel(settings, locale, key, locale)) === needle) return key;
    }
  }
  return null;
}


/** A single "back to main menu" keyboard, used under every leaf screen. */
export function backKeyboard(locale: string | null | undefined, fallback?: string | null) {
  return { inline_keyboard: [[{ text: menuStrings(locale, fallback).back, callback_data: 'tg:menu' }]] };
}

// ── FAQ ───────────────────────────────────────────────────────────────

function shortLabel(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function buildFaqList(
  settings: TelegramSettings,
  locale: string | null | undefined,
  fallback?: string | null,
) {
  const s = menuStrings(locale, fallback);
  const items = faqItems(settings, locale, fallback);
  if (!items.length) {
    return {
      text: `<b>${escapeHtml(s.faqTitle)}</b>\n\n${escapeHtml(s.faqEmpty)}`,
      replyMarkup: backKeyboard(locale, fallback),
    };
  }
  const rows: Button[][] = items.map((item, index) => [
    { text: `${index + 1}. ${shortLabel(item.question)}`, callback_data: `tg:faq:${index}` },
  ]);
  rows.push([{ text: s.back, callback_data: 'tg:menu' }]);
  return {
    text: `<b>${escapeHtml(s.faqTitle)}</b>\n\n${escapeHtml(s.faqHint)}`,
    replyMarkup: { inline_keyboard: rows },
  };
}

export function faqItems(
  settings: TelegramSettings,
  locale: string | null | undefined,
  fallback?: string | null,
) {
  const chain = [normalizeLocale(locale), normalizeLocale(fallback), 'en' as TelegramLocale];
  for (const candidate of chain) {
    if (!candidate) continue;
    const list = settings.faq?.[candidate];
    if (list && list.length) return list;
  }
  return [];
}

export function buildFaqAnswer(
  settings: TelegramSettings,
  locale: string | null | undefined,
  index: number,
  fallback?: string | null,
) {
  const s = menuStrings(locale, fallback);
  const item = faqItems(settings, locale, fallback)[index];
  if (!item) return buildFaqList(settings, locale, fallback);
  return {
    text: `<b>${escapeHtml(item.question)}</b>\n\n${escapeHtml(item.answer)}`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: `${TELEGRAM_COMMAND_ICONS.faq} ${s.faqTitle}`, callback_data: 'tg:faq' }],
        [{ text: s.back, callback_data: 'tg:menu' }],
      ],
    },
  };
}

// ── Knowledge Base help articles ──────────────────────────────────────

export type HelpArticle = { id: string; title: string; excerpt: string; content: string; slug: string };

const ARTICLES_PER_PAGE = 6;

/**
 * Published, widget-visible Knowledge Base articles for the workspace,
 * preferring the requested locale and falling back to the platform locale.
 */
export async function listHelpArticles(
  config: ServerConfig,
  workspaceId: string,
  locale: string | null | undefined,
  fallback?: string | null,
): Promise<HelpArticle[]> {
  const sb = getServiceClient(config);
  const wanted = [normalizeLocale(locale), normalizeLocale(fallback)].filter(Boolean) as string[];

  const { data, error } = await sb
    .from('knowledge_base_articles')
    .select('id, title, excerpt, content, slug, locale, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'published')
    .eq('visible_in_widget', true)
    .order('updated_at', { ascending: false })
    .limit(120);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as any[];
  for (const candidate of wanted) {
    const scoped = rows.filter((row) => String(row.locale ?? '').slice(0, 2).toLowerCase() === candidate);
    if (scoped.length) return scoped.slice(0, 60).map(toArticle);
  }
  return rows.slice(0, 60).map(toArticle);
}

function toArticle(row: any): HelpArticle {
  return {
    id: String(row.id),
    title: String(row.title ?? '').slice(0, 200),
    excerpt: String(row.excerpt ?? '').slice(0, 400),
    content: String(row.content ?? ''),
    slug: String(row.slug ?? ''),
  };
}

/** HTML/markdown article body → Telegram-safe, readable plain text. */
export function articleToTelegramText(article: HelpArticle): string {
  const body = article.content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_`#]{1,3}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const trimmed = body.length > 3200 ? `${body.slice(0, 3200)}…` : body;
  return `<b>${escapeHtml(article.title)}</b>\n\n${escapeHtml(trimmed || article.excerpt)}`;
}

export function buildArticleList(
  articles: HelpArticle[],
  page: number,
  locale: string | null | undefined,
  fallback?: string | null,
) {
  const s = menuStrings(locale, fallback);
  if (!articles.length) {
    return {
      text: `<b>${escapeHtml(s.guidesTitle)}</b>\n\n${escapeHtml(s.guidesEmpty)}`,
      replyMarkup: backKeyboard(locale, fallback),
    };
  }
  const pages = Math.max(1, Math.ceil(articles.length / ARTICLES_PER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = articles.slice(current * ARTICLES_PER_PAGE, current * ARTICLES_PER_PAGE + ARTICLES_PER_PAGE);

  const rows: Button[][] = slice.map((article) => [
    { text: `📄 ${shortLabel(article.title, 56)}`, callback_data: `tg:kb:a:${article.id}` },
  ]);

  if (pages > 1) {
    const nav: Button[] = [];
    if (current > 0) nav.push({ text: s.prev, callback_data: `tg:kb:p:${current - 1}` });
    if (current < pages - 1) nav.push({ text: s.next, callback_data: `tg:kb:p:${current + 1}` });
    if (nav.length) rows.push(nav);
  }
  rows.push([{ text: s.back, callback_data: 'tg:menu' }]);

  const heading = pages > 1 ? `${s.guidesTitle} (${current + 1}/${pages})` : s.guidesTitle;
  return {
    text: `<b>${escapeHtml(heading)}</b>\n\n${escapeHtml(s.guidesHint)}`,
    replyMarkup: { inline_keyboard: rows },
  };
}

export function buildArticleView(
  article: HelpArticle,
  locale: string | null | undefined,
  fallback?: string | null,
) {
  const s = menuStrings(locale, fallback);
  return {
    text: articleToTelegramText(article),
    replyMarkup: {
      inline_keyboard: [
        [{ text: `${TELEGRAM_COMMAND_ICONS.guides} ${s.guidesTitle}`, callback_data: 'tg:kb' }],
        [{ text: s.back, callback_data: 'tg:menu' }],
      ],
    },
  };
}
