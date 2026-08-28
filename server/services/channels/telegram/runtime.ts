/**
 * Telegram runtime behavior driven by workspace settings: slash commands,
 * the inline menu (main menu, FAQ, Knowledge Base help articles) and the
 * human_only / ai_first handling-mode gate. Kept separate from
 * `inboundProcessing.ts` so the canonical cross-channel pipeline stays
 * provider-agnostic; this module is the only Telegram-specific hook into it.
 *
 * Menu presentation lives in `menu.ts`; this file only decides WHEN a screen
 * is shown and delivers it. Callback taps edit the existing bubble, so the
 * chat never fills up with menu copies.
 */

import type { ServerConfig } from '../../../config.js';
import type { NormalizedInboundMessage } from '../inboundProcessing.js';
import { getInstallation } from '../../plugins/state.js';
import { TELEGRAM_BOT_TOKEN_KEY, readPluginSecret } from '../../plugins/secrets.js';
import { getIntegrationForInstallation } from '../integrations.js';
import { answerCallbackQuery, editMessageText, sendChatAction, sendMessage } from './client.js';
import {
  commandKeyFromText,
  isTelegramMenuEntryEnabled,
  messageKeyForCommand,
  parseTelegramSettings,
  resolveLocalizedMessage,
  resolveTelegramHandlingMode,
  type TelegramCommandKey,
  type TelegramSettings,
} from './settings.js';
import {
  backKeyboard,
  buildArticleList,
  buildArticleView,
  buildFaqAnswer,
  buildFaqList,
  buildMainMenu,
  escapeHtml,
  listHelpArticles,
  matchReplyKeyboardCommand,
} from './menu.js';

import { getPlatformAllowedLocales } from '../../platformRegion.js';


export type TelegramInboundFlowResult = {
  /** Whether the shared AI entry point in inboundProcessing.ts may run. */
  aiAllowed: boolean;
  /** Whether a command was recognized and replied to directly. */
  handled: boolean;
  /** Locale every outbound reply (including AI) must speak. */
  locale: string | null;
  /** The menu/slash command the visitor tapped, when recognized. */
  command?: TelegramCommandKey | null;
};


/**
 * The language the bot must answer in: the Telegram user's language when the
 * platform actually offers it, otherwise the platform's primary locale.
 * A Persian-only deployment therefore never replies in English just because
 * Telegram reported `language_code: en`.
 */
export async function resolveTelegramReplyLocale(
  config: ServerConfig,
  senderLanguage: string | null | undefined,
): Promise<{ locale: string; fallbackLocale: string }> {
  const allowed = await getPlatformAllowedLocales(config).catch(() => ['en']);
  const fallbackLocale = allowed[0] || 'en';
  const normalized = (senderLanguage || '').toLowerCase().split('-')[0];
  return { locale: allowed.includes(normalized) ? normalized : fallbackLocale, fallbackLocale };
}


export { escapeHtml };

/**
 * A command screen: the operator-authored copy on top, the inline menu
 * underneath so the next action is always one tap away.
 */
export function renderCommandScreen(
  settings: TelegramSettings,
  command: TelegramCommandKey,
  locale: string | null | undefined,
  fallbackLocale?: string | null,
): { text: string; replyMarkup: Record<string, unknown> } {
  const body = escapeHtml(
    resolveLocalizedMessage(settings, locale, messageKeyForCommand(command), fallbackLocale),
  );
  const menu = buildMainMenu(settings, locale, fallbackLocale);
  if (command === 'human') {
    return { text: body, replyMarkup: backKeyboard(locale, fallbackLocale) };
  }
  return { text: `${body}\n\n${menu.text}`, replyMarkup: menu.replyMarkup };
}


/**
 * Resolves the workspace's Telegram settings, answers the slash commands
 * inline, and reports whether `ai_first` (entitlement-gated) is in effect so
 * the caller can decide whether to invoke the AI engine.
 * Never throws — a Telegram-specific hiccup must not break inbound
 * processing for the message itself.
 */
export async function handleTelegramInboundFlow(
  config: ServerConfig,
  input: NormalizedInboundMessage,
  conversationId: string,
): Promise<TelegramInboundFlowResult> {
  const { locale, fallbackLocale } = await resolveTelegramReplyLocale(config, input.senderLanguage);
  try {
    const installation = await getInstallation(config, input.workspaceId, 'telegram');
    const settings = parseTelegramSettings(installation?.settings);
    const { mode } = await resolveTelegramHandlingMode(config, input.workspaceId, settings.handlingMode);
    const aiAllowed = mode === 'ai_first';

    const command = commandKeyFromText(input.text) ?? matchReplyKeyboardCommand(settings, input.text);
    if (!command || !installation) return { aiAllowed, handled: false, locale };


    let screen: { text: string; replyMarkup: Record<string, unknown> };
    if (command === 'faq' && isTelegramMenuEntryEnabled(settings, 'faq')) {
      screen = buildFaqList(settings, locale, fallbackLocale);
    } else if (command === 'guides' && isTelegramMenuEntryEnabled(settings, 'guides')) {
      const articles = await listHelpArticles(config, input.workspaceId, locale, fallbackLocale).catch(() => []);
      screen = buildArticleList(articles, 0, locale, fallbackLocale);
    } else if (command === 'faq' || command === 'guides') {
      // Switched off in the plugin settings — never a dead end, show the menu.
      screen = buildMainMenu(settings, locale, fallbackLocale);
    } else {
      screen = renderCommandScreen(settings, command, locale, fallbackLocale);
    }

    const sent = await sendTelegramScreen(config, installation.id, input.externalChatId, screen);
    void conversationId; // command replies do not need the conversation row, only the chat id
    return { aiAllowed, handled: sent, locale };
  } catch (err) {
    console.warn('[telegram] inbound flow error:', err instanceof Error ? err.message : err);
    return { aiAllowed: false, handled: false, locale };
  }

}

/**
 * Inline-button taps. Returns true when the update was a callback query we
 * consumed, so the caller must NOT run it through the message pipeline.
 * Never throws.
 */
export async function handleTelegramCallbackQuery(
  config: ServerConfig,
  ctx: { workspaceId: string; update: Record<string, any> },
): Promise<boolean> {
  const query = ctx.update?.callback_query;
  if (!query?.id) return false;

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = typeof query.data === 'string' ? query.data : '';

  try {
    const installation = await getInstallation(config, ctx.workspaceId, 'telegram');
    if (!installation) return true;
    const token = await readPluginSecret(config, installation.id, TELEGRAM_BOT_TOKEN_KEY);
    if (!token) return true;

    await answerCallbackQuery(token, String(query.id)).catch(() => undefined);
    if (chatId === undefined || chatId === null || !messageId || !data.startsWith('tg:')) return true;

    const settings = parseTelegramSettings(installation.settings);
    const { locale, fallbackLocale } = await resolveTelegramReplyLocale(config, query.from?.language_code);

    const screen = await resolveCallbackScreen(config, ctx.workspaceId, settings, data, locale, fallbackLocale);
    if (!screen) return true;

    // A persistent reply keyboard cannot be attached to an edited message —
    // those screens are delivered as a fresh message instead.
    if ((screen.replyMarkup as any)?.keyboard) {
      await sendMessage(token, {
        chatId,
        text: screen.text,
        parseMode: 'HTML',
        replyMarkup: screen.replyMarkup,
      });
      return true;
    }

    await editMessageText(token, {
      chatId,
      messageId,
      text: screen.text,
      parseMode: 'HTML',
      replyMarkup: screen.replyMarkup,
    }).catch(async () => {
      // The bubble may be too old to edit — fall back to a fresh message.
      await sendMessage(token, {
        chatId,
        text: screen.text,
        parseMode: 'HTML',
        replyMarkup: screen.replyMarkup,
      });
    });
    return true;

  } catch (err) {
    console.warn('[telegram] callback error:', err instanceof Error ? err.message : err);
    return true;
  }
}

async function resolveCallbackScreen(
  config: ServerConfig,
  workspaceId: string,
  settings: TelegramSettings,
  data: string,
  locale: string,
  fallbackLocale: string,
): Promise<{ text: string; replyMarkup: Record<string, unknown> } | null> {
  const payload = data.slice('tg:'.length);

  if (payload === 'menu') return buildMainMenu(settings, locale, fallbackLocale);

  if (payload.startsWith('cmd:')) {
    const command = payload.slice(4) as TelegramCommandKey;
    if (!['start', 'help', 'human', 'new'].includes(command)) return null;
    return renderCommandScreen(settings, command, locale, fallbackLocale);
  }

  if (payload === 'faq' || payload.startsWith('faq:')) {
    if (!isTelegramMenuEntryEnabled(settings, 'faq')) return buildMainMenu(settings, locale, fallbackLocale);
    if (payload === 'faq') return buildFaqList(settings, locale, fallbackLocale);
    const index = Number.parseInt(payload.slice(4), 10);
    return Number.isFinite(index)
      ? buildFaqAnswer(settings, locale, index, fallbackLocale)
      : buildFaqList(settings, locale, fallbackLocale);
  }

  if (payload === 'kb' || payload.startsWith('kb:')) {
    if (!isTelegramMenuEntryEnabled(settings, 'guides')) return buildMainMenu(settings, locale, fallbackLocale);
    const articles = await listHelpArticles(config, workspaceId, locale, fallbackLocale).catch(() => []);
    if (payload.startsWith('kb:a:')) {
      const article = articles.find((item) => item.id === payload.slice(5));
      if (article) return buildArticleView(article, locale, fallbackLocale);
      return buildArticleList(articles, 0, locale, fallbackLocale);
    }
    const page = payload.startsWith('kb:p:') ? Number.parseInt(payload.slice(5), 10) : 0;
    return buildArticleList(articles, Number.isFinite(page) ? page : 0, locale, fallbackLocale);
  }

  return null;
}

async function sendTelegramScreen(
  config: ServerConfig,
  installationId: string,
  chatId: string,
  screen: { text: string; replyMarkup: Record<string, unknown> },
): Promise<boolean> {
  const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
  if (!token) return false;
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) return false;
  await sendChatAction(token, chatId, 'typing').catch(() => undefined);
  await sendMessage(token, {
    chatId,
    text: screen.text,
    parseMode: 'HTML',
    replyMarkup: screen.replyMarkup,
  });
  return true;
}
