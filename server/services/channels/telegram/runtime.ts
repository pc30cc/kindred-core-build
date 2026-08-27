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
import { sendMessage } from './client.js';
import {
  commandKeyFromText,
  messageKeyForCommand,
  parseTelegramSettings,
  resolveLocalizedMessage,
  resolveTelegramHandlingMode,
} from './settings.js';

export type TelegramInboundFlowResult = {
  /** Whether the shared AI entry point in inboundProcessing.ts may run. */
  aiAllowed: boolean;
  /** Whether a command was recognized and replied to directly. */
  handled: boolean;
};

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

    const replyText = resolveLocalizedMessage(settings, input.senderLanguage, messageKeyForCommand(command));
    const sent = await sendTelegramReply(config, installation.id, input.externalChatId, replyText);
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
): Promise<boolean> {
  const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
  if (!token) return false;
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) return false;
  await sendMessage(token, { chatId, text });
  return true;
}
