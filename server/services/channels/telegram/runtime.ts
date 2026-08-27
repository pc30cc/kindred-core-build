/**
 * Telegram runtime behavior driven by workspace settings: slash commands and
 * the human_only / ai_first handling-mode gate. Kept separate from
 * `inboundProcessing.ts` so the canonical cross-channel pipeline stays
 * provider-agnostic; this module is the only Telegram-specific hook into it.
 */

import type { ServerConfig } from '../../../config.js';
import type { NormalizedInboundMessage } from '../inboundProcessing.js';
import { getInstallation } from '../../plugins/state.js';
import { TELEGRAM_BOT_TOKEN_KEY, readPluginSecret } from '../../plugins/secrets.js';
import { getIntegrationForInstallation } from '../integrations.js';
import { sendChatAction, sendMessage } from './client.js';
import {
  commandKeyFromText,
  messageKeyForCommand,
  parseTelegramSettings,
  resolveLocalizedMessage,
  resolveTelegramHandlingMode,
  type TelegramCommandKey,
  type TelegramSettings,
} from './settings.js';

export type TelegramInboundFlowResult = {
  /** Whether the shared AI entry point in inboundProcessing.ts may run. */
  aiAllowed: boolean;
  /** Whether a command was recognized and replied to directly. */
  handled: boolean;
};

/** Telegram HTML parse-mode escaping — applied to every value we interpolate. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Persistent quick-reply keyboard. The buttons send the literal slash
 * commands, so they flow through exactly the same recognition path as typed
 * commands — no callback_query handling, nothing that can silently break.
 */
export function buildCommandKeyboard(settings: TelegramSettings) {
  void settings;
  return {
    keyboard: [[{ text: '/help' }, { text: '/human' }], [{ text: '/new' }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: '…',
  };
}

/**
 * Renders a command reply as light HTML: a bold title line followed by the
 * operator-authored body. Authored text is escaped, never trusted as markup.
 */
export function renderCommandReply(
  settings: TelegramSettings,
  command: TelegramCommandKey,
  locale: string | null | undefined,
  fallbackLocale?: string | null,
): string {
  const body = escapeHtml(
    resolveLocalizedMessage(settings, locale, messageKeyForCommand(command), fallbackLocale),
  );
  const title = escapeHtml(resolveCommandLabel(settings, locale, command, fallbackLocale) || '').trim();
  return title ? `<b>${title}</b>\n\n${body}` : body;
}


/**
 * Resolves the workspace's Telegram settings, replies to /start /help
 * /human /new inline, and reports whether `ai_first` (entitlement-gated) is
 * in effect so the caller can decide whether to invoke the AI engine.
 * Never throws — a Telegram-specific hiccup must not break inbound
 * processing for the message itself.
 */
export async function handleTelegramInboundFlow(
  config: ServerConfig,
  input: NormalizedInboundMessage,
  conversationId: string,
): Promise<TelegramInboundFlowResult> {
  try {
    const installation = await getInstallation(config, input.workspaceId, 'telegram');
    const settings = parseTelegramSettings(installation?.settings);
    const { mode } = await resolveTelegramHandlingMode(config, input.workspaceId, settings.handlingMode);
    const aiAllowed = mode === 'ai_first';

    const command = commandKeyFromText(input.text);
    if (!command || !installation) return { aiAllowed, handled: false };

    const replyText = renderCommandReply(settings, command, input.senderLanguage);
    const sent = await sendTelegramReply(config, installation.id, input.externalChatId, replyText, settings);
    void conversationId; // command replies do not need the conversation row, only the chat id
    return { aiAllowed, handled: sent };
  } catch (err) {
    console.warn('[telegram] inbound flow error:', err instanceof Error ? err.message : err);
    return { aiAllowed: false, handled: false };
  }
}

async function sendTelegramReply(
  config: ServerConfig,
  installationId: string,
  chatId: string,
  text: string,
  settings: TelegramSettings,
): Promise<boolean> {
  const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
  if (!token) return false;
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) return false;
  await sendChatAction(token, chatId, 'typing').catch(() => undefined);
  await sendMessage(token, {
    chatId,
    text,
    parseMode: 'HTML',
    replyMarkup: buildCommandKeyboard(settings),
  });
  return true;
}
