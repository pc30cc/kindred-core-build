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

export const TELEGRAM_COMMAND_KEYS = ['start', 'help', 'human', 'new', 'faq', 'guides'] as const;
export type TelegramCommandKey = (typeof TELEGRAM_COMMAND_KEYS)[number];

/** Emoji shown next to every menu entry — one shared visual language. */
export const TELEGRAM_COMMAND_ICONS: Record<TelegramCommandKey, string> = {
  start: '🏠',
  help: 'ℹ️',
  human: '👤',
  new: '🆕',
  faq: '❓',
  guides: '📚',
};

export type TelegramLocaleMessages = {
  welcome: string;
  help: string;
  offline: string;
  handoff: string;
  fallback: string;
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
  };
  /** Operator-authored FAQ, per locale. */
  faq: Record<TelegramLocale, TelegramFaqItem[]>;

  handlingMode: TelegramHandlingMode;
};

const MESSAGE_KEYS = ['welcome', 'help', 'offline', 'handoff', 'fallback'] as const;


function defaultLocaleMessages(locale: TelegramLocale): TelegramLocaleMessages {
  switch (locale) {
    case 'fa':
      return {
        welcome: 'سلام! به پشتیبانی ما خوش آمدید. چطور می‌توانیم کمکتان کنیم؟',
        help: 'برای شروع دوباره /start، برای صحبت با یک همکار /human و برای شروع گفتگوی تازه /new را بفرستید.',
        offline: 'همکاران ما در حال حاضر آنلاین نیستند؛ پیام شما ثبت شد و به‌زودی پاسخ داده می‌شود.',
        handoff: 'درخواست شما به یک همکار انسانی ارجاع داده شد و به‌زودی پاسخ می‌دهد.',
        fallback: 'متوجه پیام شما نشدیم. می‌توانید واضح‌تر بنویسید یا با دستور /human با یک همکار صحبت کنید؟',
      };
    case 'tr':
      return {
        welcome: 'Merhaba! Desteğimize hoş geldiniz. Size nasıl yardımcı olabiliriz?',
        help: 'Yeniden başlamak için /start, bir temsilciyle konuşmak için /human, yeni bir görüşme başlatmak için /new yazabilirsiniz.',
        offline: 'Ekibimiz şu anda çevrimdışı; mesajınız kaydedildi ve en kısa sürede yanıtlanacak.',
        handoff: 'Talebiniz bir temsilciye yönlendirildi ve kısa süre içinde yanıtlanacaktır.',
        fallback: 'Mesajınızı anlayamadık. Daha açık yazabilir veya bir temsilciyle konuşmak için /human yazabilirsiniz.',
      };
    default:
      return {
        welcome: 'Hi! Welcome to our support chat. How can we help you today?',
        help: 'Send /start to restart, /human to talk to a teammate, or /new to start a fresh conversation.',
        offline: 'Our team is offline right now — your message was saved and will be answered soon.',
        handoff: 'Your request has been handed off to a human teammate and will be answered shortly.',
        fallback: "Sorry, we didn't understand that. Try rephrasing, or send /human to reach a teammate.",
      };
  }
}

const DEFAULT_COMMANDS_BY_LOCALE: Record<TelegramLocale, Record<TelegramCommandKey, string>> = {
  en: {
    start: 'Start the conversation',
    help: 'Show available commands',
    human: 'Talk to a human teammate',
    new: 'Start a new conversation',
    faq: 'Frequently asked questions',
    guides: 'Help articles',
  },
  fa: {
    start: 'شروع گفتگو',
    help: 'نمایش دستورهای موجود',
    human: 'گفتگو با همکار انسانی',
    new: 'شروع گفتگوی تازه',
    faq: 'سوالات متداول',
    guides: 'مقالات راهنما',
  },
  tr: {
    start: 'Görüşmeyi başlat',
    help: 'Komutları göster',
    human: 'Bir temsilciyle konuş',
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
    menu: { faqEnabled: false, guidesEnabled: false },
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
    locales[locale] = {
      welcome: str(localeInput.welcome, 2000, base.welcome),
      help: str(localeInput.help, 2000, base.help),
      offline: str(localeInput.offline, 2000, base.offline),
      handoff: str(localeInput.handoff, 2000, base.handoff),
      fallback: str(localeInput.fallback, 2000, base.fallback),
    };
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
    faqEnabled: menuInput.faqEnabled === true,
    guidesEnabled: menuInput.guidesEnabled === true,
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

const COMMAND_PATTERN = /^\/(start|menu|help|human|new|faq|guides)(@[\w]+)?(?:\s|$)/i;

/** Recognizes a configured slash command regardless of bot-username suffix. */
export function commandKeyFromText(text: string): TelegramCommandKey | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  const key = match[1].toLowerCase();
  // `/menu` is an alias of `/start`: both open the main menu.
  return (key === 'menu' ? 'start' : key) as TelegramCommandKey;
}

/** Whether an optional menu entry is switched on for this workspace. */
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
export function messageKeyForCommand(command: TelegramCommandKey): keyof TelegramLocaleMessages {
  switch (command) {
    case 'start':
      return 'welcome';
    case 'help':
      return 'help';
    case 'human':
      return 'handoff';
    case 'new':
      return 'welcome';
    default:
      return 'help';
  }
}

export { MESSAGE_KEYS as TELEGRAM_MESSAGE_KEYS };

