/**
 * Workspace-level Telegram settings.
 *
 * Persisted through the generic plugin installation `settings` JSON column
 * (see `services/plugins/state.ts#updateInstallationSettings`), never through
 * a dedicated table — Telegram has no special storage of its own.
 *
 * IMPORTANT — bot profile photo: the Telegram Bot API has NO method that lets
 * a bot set its own profile photo (there is no `setMyPhoto`; that capability
 * only exists for regular user accounts via MTProto, which bots cannot use).
 * Because of that hard platform limitation, `profile.photoUrl` below is
 * stored and rendered ONLY inside Lovable/Inbox (avatar next to the bot name
 * in this dialog and, where wired, in the Inbox channel badge). It is never
 * sent to Telegram and must not be confused with the bot's real Telegram
 * avatar, which an operator still has to set manually via @BotFather.
 */

import type { ServerConfig } from '../../../config.js';
import { checkModuleAccess } from '../../../middleware/featureGating.js';
import { getPlatformState } from '../../plugins/state.js';

export const TELEGRAM_LOCALES = ['en', 'fa', 'tr'] as const;
export type TelegramLocale = (typeof TELEGRAM_LOCALES)[number];

export const TELEGRAM_COMMAND_KEYS = ['start', 'new', 'faq', 'guides'] as const;
export type TelegramCommandKey = (typeof TELEGRAM_COMMAND_KEYS)[number];

/** Emoji shown next to every menu entry — one shared visual language. */
export const TELEGRAM_COMMAND_ICONS: Record<TelegramCommandKey, string> = {
  start: '🏠',
  new: '🆕',
  faq: '❓',
  guides: '📚',
};

/**
 * EVERY string the bot can send is operator-editable, per locale:
 * conversational replies AND the menu/FAQ/help-article/department chrome.
 * Nothing user-visible is hardcoded in the runtime anymore.
 */
export type TelegramLocaleMessages = {
  welcome: string;
  offline: string;
  fallback: string;
  menuTitle: string;
  menuHint: string;
  back: string;
  faqTitle: string;
  faqHint: string;
  faqEmpty: string;
  guidesTitle: string;
  guidesHint: string;
  guidesEmpty: string;
  prev: string;
  next: string;
  deptTitle: string;
  deptHint: string;
  /** `{department}` is replaced with the chosen department name. */
  deptConfirmed: string;
  deptChange: string;
  /** Sent when every operator is away and the AI is not answering. */
  offlineNotice: string;
  /** Sent when writing is closed (offline + AI off + lock switched on). */
  offlineLocked: string;
  /** Placeholder shown inside Telegram's text field while offline (≤64). */
  offlineInputHint: string;
};

export type TelegramHandlingMode = 'human_only' | 'ai_first';

/** A single operator-authored FAQ entry. */
export type TelegramFaqItem = { question: string; answer: string };

/** The AI capability used elsewhere to gate the assistant. */
export const TELEGRAM_AI_MODULE_KEY = 'ai_assistant';

export type TelegramSettings = {
  profile: {
    name: string;
    shortDescription: string;
    description: string;
    /** Lovable/Inbox-only avatar — see file header. Never sent to Telegram. */
    photoUrl: string;
  };
  locales: Record<TelegramLocale, TelegramLocaleMessages>;
  /** Legacy flat labels (English surface) — kept for backwards compatibility. */
  commands: Record<TelegramCommandKey, string>;
  /** Per-locale command labels; what the bot actually shows to a user. */
  commandLocales: Record<TelegramLocale, Record<TelegramCommandKey, string>>;
  /** Which optional menu entries the bot exposes. */
  menu: {
    faqEnabled: boolean;
    /** Help articles sourced from the workspace Knowledge Base. */
    guidesEnabled: boolean;
    /** Reply with the away notice when no operator is online. */
    offlineNoticeEnabled: boolean;
    /** Close writing while offline AND the AI is not answering. */
    lockWhenOffline: boolean;
  };
  /** Operator-authored FAQ, per locale. */
  faq: Record<TelegramLocale, TelegramFaqItem[]>;

  handlingMode: TelegramHandlingMode;
};

const MESSAGE_KEYS = [
  'welcome',
  'offline',
  'fallback',
  'menuTitle',
  'menuHint',
  'back',
  'faqTitle',
  'faqHint',
  'faqEmpty',
  'guidesTitle',
  'guidesHint',
  'guidesEmpty',
  'prev',
  'next',
  'deptTitle',
  'deptHint',
  'deptConfirmed',
  'deptChange',
  'offlineNotice',
  'offlineLocked',
  'offlineInputHint',
] as const;


function defaultLocaleMessages(locale: TelegramLocale): TelegramLocaleMessages {
  switch (locale) {
    case 'fa':
      return {
        welcome: 'سلام! به پشتیبانی ما خوش آمدید. چطور می‌توانیم کمکتان کنیم؟',
        offline: 'همکاران ما در حال حاضر آنلاین نیستند؛ پیام شما ثبت شد و به‌زودی پاسخ داده می‌شود.',
        fallback: 'متوجه پیام شما نشدیم. لطفاً پرسش خود را واضح‌تر بنویسید.',
        menuTitle: '✨ منوی اصلی',
        menuHint: 'یکی از گزینه‌های زیر را انتخاب کنید، یا پرسش خود را بنویسید؛ همهٔ پیام‌ها خوانده می‌شوند.',
        back: '⬅️ بازگشت',
        faqTitle: '❓ سوالات متداول',
        faqHint: 'روی هر پرسش بزنید تا پاسخ آن نمایش داده شود.',
        faqEmpty: 'هنوز پرسشی منتشر نشده است. پرسش خود را بنویسید تا پاسخ دهیم.',
        guidesTitle: '📚 مقالات راهنما',
        guidesHint: 'روی هر مقاله بزنید تا همین‌جا آن را بخوانید.',
        guidesEmpty: 'هنوز مقالهٔ راهنمایی منتشر نشده است.',
        prev: '◀️ قبلی',
        next: 'بعدی ▶️',
        deptTitle: '🗂 کدام بخش می‌تواند کمکتان کند؟',
        deptHint: 'بخش مرتبط با درخواست خود را انتخاب کنید تا به همکار مناسب وصل شوید. در همین حین هم می‌توانید بنویسید.',
        deptConfirmed: '✅ به بخش {department} وصل شدید. همکاران این بخش به‌زودی همین‌جا پاسخ می‌دهند.',
        deptChange: 'تغییر بخش',
        offlineNotice: '🌙 همکاران ما همین حالا آفلاین هستند. پیام شما ثبت شد و به‌محض آنلاین شدن تیم، همین‌جا پاسخ می‌گیرید.',
        offlineLocked: '🔒 پشتیبانی در حال حاضر آفلاین است. لطفاً کمی بعد دوباره سر بزنید؛ در این فاصله می‌توانید سوالات متداول و مقالات راهنما را ببینید.',
        offlineInputHint: 'پشتیبانی فعلاً آفلاین است',
      };
    case 'tr':
      return {
        welcome: 'Merhaba! Desteğimize hoş geldiniz. Size nasıl yardımcı olabiliriz?',
        offline: 'Ekibimiz şu anda çevrimdışı; mesajınız kaydedildi ve en kısa sürede yanıtlanacak.',
        fallback: 'Mesajınızı anlayamadık. Lütfen sorunuzu biraz daha açık yazın.',
        menuTitle: '✨ Ana menü',
        menuHint: 'Aşağıdan bir seçenek seçin ya da sorunuzu yazın; her mesajı okuyoruz.',
        back: '⬅️ Geri',
        faqTitle: '❓ Sıkça sorulan sorular',
        faqHint: 'Cevabı görmek için bir soruya dokunun.',
        faqEmpty: 'Henüz yayınlanmış bir soru yok. Sorunuzu yazın, yanıtlayalım.',
        guidesTitle: '📚 Yardım makaleleri',
        guidesHint: 'Okumak için bir makaleye dokunun.',
        guidesEmpty: 'Henüz yayınlanmış bir yardım makalesi yok.',
        prev: '◀️ Önceki',
        next: 'Sonraki ▶️',
        deptTitle: '🗂 Hangi ekip yardımcı olabilir?',
        deptHint: 'Talebinize uygun departmanı seçin; sizi doğru ekip arkadaşına bağlayalım. Bu sırada yazmaya devam edebilirsiniz.',
        deptConfirmed: '✅ {department} departmanına bağlandınız. Bu departmandan bir temsilci kısa süre içinde yanıtlayacak.',
        deptChange: 'Departmanı değiştir',
        offlineNotice: '🌙 Ekibimiz şu anda çevrimdışı. Mesajınız kaydedildi; ekip döner dönmez burada yanıtlayacağız.',
        offlineLocked: '🔒 Destek şu anda kapalı. Lütfen daha sonra tekrar deneyin; bu sırada SSS ve yardım makalelerine göz atabilirsiniz.',
        offlineInputHint: 'Destek şu anda çevrimdışı',
      };
    default:
      return {
        welcome: 'Hi! Welcome to our support chat. How can we help you today?',
        offline: 'Our team is offline right now — your message was saved and will be answered soon.',
        fallback: "Sorry, we didn't understand that. Try rephrasing your question.",
        menuTitle: '✨ Main menu',
        menuHint: 'Pick an option below, or just type your question — we read every message.',
        back: '⬅️ Back',
        faqTitle: '❓ Frequently asked questions',
        faqHint: 'Tap a question to see the answer.',
        faqEmpty: 'No questions have been published yet. Send us your question and we will answer it.',
        guidesTitle: '📚 Help articles',
        guidesHint: 'Tap an article to read it here.',
        guidesEmpty: 'No help articles have been published yet.',
        prev: '◀️ Previous',
        next: 'Next ▶️',
        deptTitle: '🗂 Which team can help you?',
        deptHint: 'Pick the department that fits your request — we will connect you with the right teammate. You can keep writing in the meantime.',
        deptConfirmed: '✅ Connected to {department}. A teammate from this department will reply here shortly.',
        deptChange: 'Change department',
        offlineNotice: '🌙 Our team is away right now. Your message is saved and you will get a reply here as soon as someone is back.',
        offlineLocked: '🔒 Support is closed at the moment. Please check back later — meanwhile you can browse the FAQ and help articles.',
        offlineInputHint: 'Support is offline right now',
      };
  }
}

const DEFAULT_COMMANDS_BY_LOCALE: Record<TelegramLocale, Record<TelegramCommandKey, string>> = {
  en: {
    start: 'Start the conversation',
    new: 'Start a new conversation',
    faq: 'Frequently asked questions',
    guides: 'Help articles',
  },
  fa: {
    start: 'شروع گفتگو',
    new: 'شروع گفتگوی تازه',
    faq: 'سوالات متداول',
    guides: 'مقالات راهنما',
  },
  tr: {
    start: 'Görüşmeyi başlat',
    new: 'Yeni görüşme başlat',
    faq: 'Sıkça sorulan sorular',
    guides: 'Yardım makaleleri',
  },
};

const DEFAULT_COMMANDS: Record<TelegramCommandKey, string> = { ...DEFAULT_COMMANDS_BY_LOCALE.en };

const DEFAULT_FAQ: Record<TelegramLocale, TelegramFaqItem[]> = {
  en: [],
  fa: [],
  tr: [],
};

export function defaultTelegramSettings(): TelegramSettings {
  return {
    profile: { name: '', shortDescription: '', description: '', photoUrl: '' },
    locales: {
      en: defaultLocaleMessages('en'),
      fa: defaultLocaleMessages('fa'),
      tr: defaultLocaleMessages('tr'),
    },
    commands: { ...DEFAULT_COMMANDS },
    commandLocales: {
      en: { ...DEFAULT_COMMANDS_BY_LOCALE.en },
      fa: { ...DEFAULT_COMMANDS_BY_LOCALE.fa },
      tr: { ...DEFAULT_COMMANDS_BY_LOCALE.tr },
    },
    menu: { faqEnabled: true, guidesEnabled: true, offlineNoticeEnabled: true, lockWhenOffline: false },
    faq: { en: [...DEFAULT_FAQ.en], fa: [...DEFAULT_FAQ.fa], tr: [...DEFAULT_FAQ.tr] },
    handlingMode: 'human_only',
  };
}



function str(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

/**
 * Merges arbitrary stored/submitted JSON on top of the defaults. Never
 * trusts shape from the DB or the request body, and NEVER reads/writes
 * `bot_token` — the token lives only in the encrypted secrets store.
 */
export function parseTelegramSettings(raw: unknown): TelegramSettings {
  const defaults = defaultTelegramSettings();
  if (!raw || typeof raw !== 'object') return defaults;
  const input = raw as Record<string, unknown>;

  const profileInput = (input.profile ?? {}) as Record<string, unknown>;
  const profile = {
    name: str(profileInput.name, 64, defaults.profile.name),
    shortDescription: str(profileInput.shortDescription, 120, defaults.profile.shortDescription),
    description: str(profileInput.description, 512, defaults.profile.description),
    photoUrl: str(profileInput.photoUrl, 2048, defaults.profile.photoUrl),
  };

  const localesInput = (input.locales ?? {}) as Record<string, unknown>;
  const locales = {} as Record<TelegramLocale, TelegramLocaleMessages>;
  for (const locale of TELEGRAM_LOCALES) {
    const localeInput = (localesInput[locale] ?? {}) as Record<string, unknown>;
    const base = defaults.locales[locale];
    const merged = {} as TelegramLocaleMessages;
    for (const key of MESSAGE_KEYS) {
      merged[key] = str(localeInput[key], 2000, base[key]);
    }
    locales[locale] = merged;
  }

  const commandsInput = (input.commands ?? {}) as Record<string, unknown>;
  const commands = {} as Record<TelegramCommandKey, string>;
  for (const key of TELEGRAM_COMMAND_KEYS) {
    commands[key] = str(commandsInput[key], 256, DEFAULT_COMMANDS[key]);
  }

  // Per-locale labels: authored values win; otherwise the localized default.
  // The legacy flat labels only ever seed English, so a Persian deployment
  // can never inherit an English command description by accident.
  const commandLocalesInput = (input.commandLocales ?? {}) as Record<string, unknown>;
  const commandLocales = {} as Record<TelegramLocale, Record<TelegramCommandKey, string>>;
  for (const locale of TELEGRAM_LOCALES) {
    const localeInput = (commandLocalesInput[locale] ?? {}) as Record<string, unknown>;
    const base = locale === 'en' ? commands : DEFAULT_COMMANDS_BY_LOCALE[locale];
    commandLocales[locale] = {} as Record<TelegramCommandKey, string>;
    for (const key of TELEGRAM_COMMAND_KEYS) {
      commandLocales[locale][key] = str(localeInput[key], 256, base[key]);
    }
  }

  const handlingMode: TelegramHandlingMode = input.handlingMode === 'ai_first' ? 'ai_first' : 'human_only';

  const menuInput = (input.menu ?? {}) as Record<string, unknown>;
  const menu = {
    // Absent means ON: the FAQ and help-article entries are part of the
    // bot's default menu, an operator has to switch them off deliberately.
    faqEnabled: menuInput.faqEnabled !== false,
    guidesEnabled: menuInput.guidesEnabled !== false,
    // Away-mode UX: tell the visitor nobody is online instead of leaving the
    // message unanswered, and (optionally) close writing when neither a
    // human nor the AI can answer.
    offlineNoticeEnabled: menuInput.offlineNoticeEnabled !== false,
    lockWhenOffline: menuInput.lockWhenOffline === true,
  };

  // FAQ entries are authored copy: capped in count and length, never markup.
  const faqInput = (input.faq ?? {}) as Record<string, unknown>;
  const faq = {} as Record<TelegramLocale, TelegramFaqItem[]>;
  for (const locale of TELEGRAM_LOCALES) {
    const list = Array.isArray(faqInput[locale]) ? (faqInput[locale] as unknown[]) : [];
    faq[locale] = list
      .slice(0, 30)
      .map((raw) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        return { question: str(item.question, 200, ''), answer: str(item.answer, 3000, '') };
      })
      .filter((item) => item.question.trim() && item.answer.trim());
  }

  return { profile, locales, commands, commandLocales, menu, faq, handlingMode };



}

/**
 * `ai_first` is only ever honored when the Super Admin master switch is on
 * AND the workspace holds the AI entitlement. Without it Telegram silently (and safely) runs human_only —
 * the channel itself must keep working either way.
 */
export async function resolveTelegramHandlingMode(
  config: ServerConfig,
  workspaceId: string,
  requestedMode: TelegramHandlingMode,
): Promise<{ mode: TelegramHandlingMode; aiAvailable: boolean }> {
  const [platformEnabled, entitled] = await Promise.all([
    isTelegramAiPlatformEnabled(config),
    hasAiEntitlement(config, workspaceId),
  ]);
  const aiAvailable = platformEnabled && entitled;
  if (requestedMode !== 'ai_first') return { mode: 'human_only', aiAvailable };
  return { mode: aiAvailable ? 'ai_first' : 'human_only', aiAvailable };
}

/**
 * Super Admin master switch for the Telegram AI assistant, stored on the
 * plugin platform state (`policy.aiEnabled`). Absent means ON, so existing
 * deployments keep their behavior. When OFF, no workspace may enable AI on
 * Telegram and the bot never answers with AI.
 */
/**
 * Super Admin switch controlling whether Telegram bot menu taps are surfaced
 * in the operator inbox. Absent means ON (existing behavior).
 */
export async function isTelegramMenuEventsVisible(config: ServerConfig): Promise<boolean> {
  try {
    const state = await getPlatformState(config, 'telegram');
    return (state.policy as Record<string, unknown> | null)?.menuEventsVisible !== false;
  } catch {
    return true;
  }
}

export async function isTelegramAiPlatformEnabled(config: ServerConfig): Promise<boolean> {
  try {
    const state = await getPlatformState(config, 'telegram');
    return (state.policy as Record<string, unknown> | null)?.aiEnabled !== false;
  } catch {
    return true;
  }
}

async function hasAiEntitlement(config: ServerConfig, workspaceId: string): Promise<boolean> {
  try {
    const result = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      TELEGRAM_AI_MODULE_KEY,
    );
    return result.allowed === true;
  } catch {
    return false;
  }
}

/** Downgrades `ai_first` to `human_only` in-place when unentitled, and persists the safe value. */
export async function sanitizeTelegramSettingsForSave(
  config: ServerConfig,
  workspaceId: string,
  settings: TelegramSettings,
): Promise<TelegramSettings> {
  const { mode } = await resolveTelegramHandlingMode(config, workspaceId, settings.handlingMode);
  return { ...settings, handlingMode: mode };
}

/**
 * Locale fallback chain used for every outbound Telegram string:
 * requested locale → platform fallback locale → English → hardcoded default.
 */
export function resolveLocalizedMessage(
  settings: TelegramSettings,
  locale: string | null | undefined,
  key: keyof TelegramLocaleMessages,
  fallbackLocale?: string | null,
): string {
  const chain = [normalizeLocale(locale), normalizeLocale(fallbackLocale), 'en' as TelegramLocale];
  for (const candidate of chain) {
    if (!candidate) continue;
    const value = settings.locales[candidate]?.[key];
    if (value && value.trim()) return value;
  }
  const fallback = normalizeLocale(fallbackLocale) || 'en';
  return defaultLocaleMessages(fallback)[key];
}

export function normalizeLocale(locale: string | null | undefined): TelegramLocale | null {
  if (!locale) return null;
  const short = locale.slice(0, 2).toLowerCase();
  return (TELEGRAM_LOCALES as readonly string[]).includes(short) ? (short as TelegramLocale) : null;
}

const COMMAND_PATTERN = /^\/(start|menu|new|faq|guides)(@[\w]+)?(?:\s|$)/i;

/** Recognizes a configured slash command regardless of bot-username suffix. */
export function commandKeyFromText(text: string): TelegramCommandKey | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  const key = match[1].toLowerCase();
  // `/menu` is an alias of `/start`: both open the main menu.
  return (key === 'menu' ? 'start' : key) as TelegramCommandKey;
}

/**
 * Whether an optional menu entry is switched on for this workspace.
 * The "available commands" screen and the "talk to a human" entry are
 * retired: the menu is self-explanatory and an operator is always reachable
 * by simply writing, so neither is ever advertised.
 */
export function isTelegramMenuEntryEnabled(settings: TelegramSettings, key: TelegramCommandKey): boolean {
  if (key === 'faq') return settings.menu?.faqEnabled === true;
  if (key === 'guides') return settings.menu?.guidesEnabled === true;
  return true;
}


/**
 * Command label for a locale: authored per-locale text → platform fallback
 * locale → legacy flat label → localized default. Never English-by-accident.
 */
export function resolveCommandLabel(
  settings: TelegramSettings,
  locale: string | null | undefined,
  key: TelegramCommandKey,
  fallbackLocale?: string | null,
): string {
  const chain = [normalizeLocale(locale), normalizeLocale(fallbackLocale)];
  for (const candidate of chain) {
    if (!candidate) continue;
    const value = settings.commandLocales?.[candidate]?.[key];
    if (value && value.trim()) return value;
  }
  const preferred = normalizeLocale(locale) || normalizeLocale(fallbackLocale) || 'en';
  if (preferred === 'en' && settings.commands[key]?.trim()) return settings.commands[key];
  return DEFAULT_COMMANDS_BY_LOCALE[preferred][key];
}

/**
 * Builds the setMyCommands payload. Disabled menu entries (FAQ, help
 * articles) are omitted so Telegram's native command list never advertises
 * something the bot will not answer.
 */
export function buildTelegramCommandList(
  settings: TelegramSettings,
  locale?: string | null,
): { command: string; description: string }[] {
  return TELEGRAM_COMMAND_KEYS.filter((key) => isTelegramMenuEntryEnabled(settings, key)).map((key) => ({
    command: key,
    description: resolveCommandLabel(settings, locale, key),
  }));
}


/** Maps a recognized command to the localized reply key it should send. */
export function messageKeyForCommand(_command: TelegramCommandKey): keyof TelegramLocaleMessages {
  return 'welcome';
}

export { MESSAGE_KEYS as TELEGRAM_MESSAGE_KEYS };

