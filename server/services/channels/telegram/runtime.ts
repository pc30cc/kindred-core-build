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
import { hasPluginSecret } from '../../plugins/secrets.js';
import { botProvider } from '../../../../shared/channels/botProviders.js';
import { getIntegrationForInstallation } from '../integrations.js';
import { enqueueProviderActions, type ProviderAction } from '../providerActions.js';
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
  buildArticleList,
  buildArticleView,
  buildFaqAnswer,
  buildFaqList,
  buildMainMenu,
  escapeHtml,
  listHelpArticles,
  matchReplyKeyboardCommand,
} from './menu.js';
import {
  applyDepartmentChoice,
  findTelegramConversationId,
  reopenDepartmentPicker,
  resolveDepartmentPickerScreen,
} from './departmentPicker.js';


import { getPlatformAllowedLocales } from '../../platformRegion.js';
import { getServiceClient } from '../../../supabase.js';
import { maybeQueueTelegramOfflineScreen } from './offlineDelivery.js';
export { isWorkspaceUnreachable } from './offlineDelivery.js';

/**
 * Is the workspace unreachable for a live human right now?
 *
 * Two independent signals, either of which means "nobody can answer":
 *   1. The widget availability resolver (business hours / offline mode).
 *      Note: with business hours DISABLED it always reports 'online', which
 *      is why signal 2 exists.
 *   2. Operator presence — every member force-offline / invisible / outside
 *      their personal schedule. Workspaces with zero members fail open.
 */
export type TelegramInboundFlowResult = {
  /** Whether the shared AI entry point in inboundProcessing.ts may run. */
  aiAllowed: boolean;
  /** Whether a command was recognized and replied to directly. */
  handled: boolean;
  /** Locale every outbound reply (including AI) must speak. */
  locale: string | null;
  /** The menu/slash command the visitor tapped, when recognized. */
  command?: TelegramCommandKey | null;
  /**
   * Text the AI engine should answer instead of the raw update text. Used for
   * `/start` while the assistant is live: the visitor sees an AI greeting
   * rather than the static welcome copy.
   */
  aiPrompt?: string | null;
};


async function conversationIsWaitingForHuman(
  config: ServerConfig,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await getServiceClient(config)
    .from('conversations')
    .select('ai_state, metadata')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) {
    console.warn('[telegram] conversation ownership lookup failed:', error.message);
    return false;
  }
  const metadata = (((data as any)?.metadata as Record<string, unknown>) || {});
  const aiState = String((data as any)?.ai_state ?? metadata.ai_state ?? '');
  return aiState === 'needs_human'
    || metadata.ai_handoff_requested === true
    || metadata.managed_by_ai === false
    || metadata.ai_managed_by_ai === false;
}


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


/**
 * The opening line handed to the AI engine when a visitor taps /start while
 * the assistant is live — a plain greeting in the visitor's language so the
 * assistant answers naturally instead of parroting the raw command.
 */
export function telegramGreetingPrompt(
  locale: string | null | undefined,
  fallbackLocale?: string | null,
): string {
  const map: Record<string, string> = {
    fa: 'سلام',
    tr: 'Merhaba',
    en: 'Hello',
  };
  return map[(locale || '').toLowerCase()] || map[(fallbackLocale || '').toLowerCase()] || 'Hello';
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
    const provider = input.provider || 'telegram';
    const installation = await getInstallation(config, input.workspaceId, provider);
    const parsed = parseTelegramSettings(installation?.settings);
    const { mode } = await resolveTelegramHandlingMode(config, input.workspaceId, parsed.handlingMode, provider);
    // The plugin may remain in ai_first while this particular conversation
    // has already been handed to a human. In that state AI is not a live
    // responder and must not suppress the away notice / offline lock.
    const waitingForHuman = mode === 'ai_first'
      ? await conversationIsWaitingForHuman(config, conversationId)
      : false;
    const aiAllowed = mode === 'ai_first' && !waitingForHuman;
    // Menu visibility follows the RESOLVED mode, not the stored request.
    const settings = { ...parsed, handlingMode: mode };

    const command = commandKeyFromText(input.text) ?? matchReplyKeyboardCommand(settings, input.text);
    if (!installation) return { aiAllowed, handled: false, locale, command: null };

    if (!command) {
      // Nobody online and no AI to cover → tell the visitor, instead of
      // leaving the message in a silent void. Resolved BEFORE the department
      // picker so a closed workspace never asks "which team?" first.
      const away = !aiAllowed
        ? await maybeQueueTelegramOfflineScreen(config, {
            workspaceId: input.workspaceId,
            conversationId,
            locale,
            fallbackLocale,
          }).catch(() => false)
        : false;

      // Department routing — a workspace with several chat departments asks the
      // visitor once, on the first real message, so the thread reaches the right
      // team. Skipped while writing is closed (a locked bot must not ask).
      const locked = settings.menu?.lockWhenOffline === true;
      if (!aiAllowed && !(away && locked)) {
        const picker = await resolveDepartmentPickerScreen(config, {
          settings,
          workspaceId: input.workspaceId,
          conversationId,
          locale,
          fallbackLocale,
        });
        if (picker) {
          await sendTelegramScreen(config, installation.id, input.externalChatId, picker, provider);
        }
      }

      return { aiAllowed, handled: away, locale, command: null };
    }

    // `/start` with a live assistant: the AI greets the visitor itself, so the
    // static welcome screen is skipped entirely. When AI is off (or the thread
    // already belongs to a human) the operator-authored welcome still shows.
    if (command === 'start' && aiAllowed) {
      return {
        aiAllowed,
        handled: false,
        locale,
        command,
        aiPrompt: telegramGreetingPrompt(locale, fallbackLocale),
      };
    }

    let screen: { text: string; replyMarkup: Record<string, unknown> };

    if (!isTelegramMenuEntryEnabled(settings, command) && command !== 'start') {
      // Retired or switched-off command — never a dead end, show the menu.
      screen = buildMainMenu(settings, locale, fallbackLocale);
    } else if (command === 'faq' && isTelegramMenuEntryEnabled(settings, 'faq')) {
      screen = buildFaqList(settings, locale, fallbackLocale);
    } else if (command === 'guides' && isTelegramMenuEntryEnabled(settings, 'guides')) {
      const articles = await listHelpArticles(config, input.workspaceId, locale, fallbackLocale).catch(() => []);
      screen = buildArticleList(settings, articles, 0, locale, fallbackLocale);
    } else if (command === 'faq' || command === 'guides') {
      // Switched off in the plugin settings — never a dead end, show the menu.
      screen = buildMainMenu(settings, locale, fallbackLocale);
    } else {
      screen = renderCommandScreen(settings, command, locale, fallbackLocale);
    }

    const sent = await sendTelegramScreen(config, installation.id, input.externalChatId, screen, provider);
    return { aiAllowed, handled: sent, locale, command };

  } catch (err) {
    console.warn('[telegram] inbound flow error:', err instanceof Error ? err.message : err);
    return { aiAllowed: false, handled: false, locale, command: null };
  }


}

/**
 * Inline-button taps. Returns true when the update was a callback query we
 * consumed, so the caller must NOT run it through the message pipeline.
 * Never throws.
 */
export async function handleTelegramCallbackQuery(
  config: ServerConfig,
  ctx: { workspaceId: string; update: Record<string, any>; provider?: string },
): Promise<boolean> {
  const query = ctx.update?.callback_query;
  if (!query?.id) return false;

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = typeof query.data === 'string' ? query.data : '';

  try {
    const provider = ctx.provider || 'telegram';
    const installation = await getInstallation(config, ctx.workspaceId, provider);
    if (!installation) return true;
    if (!(await hasPluginSecret(config, installation.id, botProvider(provider).secretKeys.live))) return true;
    const integration = await getIntegrationForInstallation(config, installation.id);
    if (!integration) return true;

    // Acknowledge the tap first so the button stops spinning, then render.
    const actions: ProviderAction[] = [{ kind: 'answer_callback', callbackQueryId: String(query.id) }];
    const flush = () =>
      enqueueProviderActions(config, {
        provider,
        workspaceId: ctx.workspaceId,
        integrationId: integration.id,
        actions,
      });

    if (chatId === undefined || chatId === null || !messageId || !data.startsWith('tg:')) {
      await flush();
      return true;
    }

    const parsedSettings = parseTelegramSettings(installation.settings);
    const { mode } = await resolveTelegramHandlingMode(config, ctx.workspaceId, parsedSettings.handlingMode, ctx.provider ?? 'telegram');
    const settings = { ...parsedSettings, handlingMode: mode };
    const { locale, fallbackLocale } = await resolveTelegramReplyLocale(config, query.from?.language_code);

    const payload = data.slice('tg:'.length);
    let screen: { text: string; replyMarkup: Record<string, unknown> } | null;
    if (payload === 'dept' || payload.startsWith('dept:')) {
      screen = await resolveDepartmentCallback(config, {
        settings,
        workspaceId: ctx.workspaceId,
        installationId: installation.id,
        chatId: String(chatId),
        payload,
        locale,
        fallbackLocale,
      });
    } else {
      screen = await resolveCallbackScreen(config, ctx.workspaceId, settings, data, locale, fallbackLocale);
    }
    if (!screen) {
      await flush();
      return true;
    }
    const view = screen;

    // A persistent reply keyboard cannot be attached to an edited message —
    // those screens are delivered as a fresh message instead. The worker
    // falls back to a fresh message when an old bubble refuses the edit.
    if ((view.replyMarkup as any)?.keyboard) {
      actions.push({
        kind: 'send_message',
        chatId,
        text: view.text,
        parseMode: 'HTML',
        replyMarkup: view.replyMarkup,
      });
    } else {
      actions.push({
        kind: 'edit_message',
        chatId,
        messageId,
        text: view.text,
        parseMode: 'HTML',
        replyMarkup: view.replyMarkup,
        sendOnEditFailure: true,
      });
    }
    await flush();
    return true;


  } catch (err) {
    console.warn('[telegram] callback error:', err instanceof Error ? err.message : err);
    return true;
  }
}

/**
 * `tg:dept` (re-open picker) and `tg:dept:<id>` (choose department) taps.
 * The conversation is resolved from the Telegram chat id so the choice is
 * stored on the very thread the operator sees in the Inbox.
 */
async function resolveDepartmentCallback(
  config: ServerConfig,
  args: {
    settings: TelegramSettings;
    workspaceId: string;
    installationId: string;
    chatId: string;
    payload: string;
    locale: string;
    fallbackLocale: string;
  },
): Promise<{ text: string; replyMarkup: Record<string, unknown> } | null> {
  if (args.payload === 'dept') {
    return reopenDepartmentPicker(config, {
      settings: args.settings,
      workspaceId: args.workspaceId,
      locale: args.locale,
      fallbackLocale: args.fallbackLocale,
    });
  }
  const departmentId = args.payload.slice('dept:'.length);
  if (!departmentId) return null;
  const integration = await getIntegrationForInstallation(config, args.installationId);
  const conversationId = integration
    ? await findTelegramConversationId(config, {
        workspaceId: args.workspaceId,
        integrationId: integration.id,
        chatId: args.chatId,
      })
    : null;
  return applyDepartmentChoice(config, {
    settings: args.settings,
    workspaceId: args.workspaceId,
    conversationId,
    departmentId,
    locale: args.locale,
    fallbackLocale: args.fallbackLocale,
  });
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
    if (!['start', 'new'].includes(command)) return null;
    if (!isTelegramMenuEntryEnabled(settings, command)) {
      return buildMainMenu(settings, locale, fallbackLocale);
    }
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
      if (article) return buildArticleView(settings, article, locale, fallbackLocale);
      return buildArticleList(settings, articles, 0, locale, fallbackLocale);
    }
    const page = payload.startsWith('kb:p:') ? Number.parseInt(payload.slice(5), 10) : 0;
    return buildArticleList(settings, articles, Number.isFinite(page) ? page : 0, locale, fallbackLocale);
  }

  return null;
}

/**
 * Queues a bot screen for delivery. Core does NOT talk to Telegram: the
 * Channels Worker picks the action up and performs the socket work.
 */
async function sendTelegramScreen(
  config: ServerConfig,
  installationId: string,
  chatId: string,
  screen: { text: string; replyMarkup: Record<string, unknown> },
  provider = 'telegram',
): Promise<boolean> {
  if (!(await hasPluginSecret(config, installationId, botProvider(provider).secretKeys.live))) {
    console.warn('[telegram] screen not queued: credential missing');
    return false;
  }
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) {
    console.warn('[telegram] screen not queued: integration missing');
    return false;
  }
  const queued = await enqueueProviderActions(config, {
    provider,
    workspaceId: integration.workspace_id,
    integrationId: integration.id,
    actions: [
      {
        kind: 'send_message',
        chatId,
        text: screen.text,
        parseMode: 'HTML',
        replyMarkup: screen.replyMarkup,
        typing: true,
      },
    ],
  });
  if (!queued) console.warn('[telegram] screen not queued: provider action enqueue failed');
  return queued;
}
