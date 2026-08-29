/**
 * PROVIDER DIALECT DISPATCHER — Channels Worker.
 *
 * One protocol-neutral surface, two implementations:
 *   - `telegram-bot`   → Telegram Bot API (Telegram, Bale)
 *   - `whatsapp-cloud` → Meta Graph API (WhatsApp Cloud)
 *
 * Job handlers and the provider-operation executor talk ONLY to this
 * interface, so adding a dialect never touches business logic and Core stays
 * completely network-isolated from providers.
 */

import * as telegram from '../../channels/providers/telegram/client.js';
import * as whatsapp from '../../channels/providers/whatsapp/client.js';
import * as instagram from '../../channels/providers/instagram/client.js';
import { botProvider, type BotProviderDescriptor } from '../../shared/channels/botProviders.js';
import type { BotCredential } from '../../channels/providers/telegram/client.js';

export type BotApi = {
  getMe(credential: BotCredential): Promise<{ id: number | string; username: string | null; firstName: string | null }>;
  setWebhook(
    credential: BotCredential,
    url: string,
    secretToken: string | null,
    allowedUpdates?: string[] | null,
  ): Promise<void>;
  deleteWebhook(credential: BotCredential): Promise<void>;
  getWebhookInfo(credential: BotCredential): Promise<{
    url: string;
    pending_update_count: number;
    last_error_date?: number;
    last_error_message?: string;
  }>;
  sendMessage(
    credential: BotCredential,
    input: {
      chatId: number | string;
      text: string;
      replyToMessageId?: number;
      parseMode?: 'HTML' | 'MarkdownV2';
      replyMarkup?: Record<string, unknown>;
    },
  ): Promise<{ message_id: number | string }>;
  sendChatAction(credential: BotCredential, chatId: number | string, action?: 'typing'): Promise<void>;
  editMessageText(
    credential: BotCredential,
    input: {
      chatId: number | string;
      messageId: number;
      text: string;
      parseMode?: 'HTML' | 'MarkdownV2';
      replyMarkup?: Record<string, unknown>;
    },
  ): Promise<void>;
  answerCallbackQuery(credential: BotCredential, callbackQueryId: string, text?: string): Promise<void>;
  getFile(credential: BotCredential, fileId: string): Promise<{ file_path: string; file_size?: number }>;
  downloadFile(credential: BotCredential, filePath: string, maxBytes: number): Promise<Uint8Array>;
  sendMedia(
    credential: BotCredential,
    input: { chatId: number | string; kind: string; url: string; caption?: string | null },
  ): Promise<{ message_id: number | string }>;
  setMyName(credential: BotCredential, name: string): Promise<void>;
  setMyShortDescription(credential: BotCredential, value: string): Promise<void>;
  setMyDescription(credential: BotCredential, value: string): Promise<void>;
  setMyCommands(credential: BotCredential, commands: Array<{ command: string; description: string }>): Promise<void>;
  getUserProfilePhotoFileId(credential: BotCredential, userId: string | number): Promise<string | null>;
};

const TELEGRAM_API: BotApi = {
  getMe: telegram.getMe,
  setWebhook: (c, url, secret, allowed) => telegram.setWebhook(c, url, secret, allowed),
  deleteWebhook: telegram.deleteWebhook,
  getWebhookInfo: telegram.getWebhookInfo,
  sendMessage: telegram.sendMessage,
  sendChatAction: (c, chatId, action) => telegram.sendChatAction(c, chatId, action),
  editMessageText: async (c, input) => {
    await telegram.editMessageText(c, input);
  },
  answerCallbackQuery: async (c, id, text) => {
    await telegram.answerCallbackQuery(c, id, text);
  },
  getFile: telegram.getFile,
  downloadFile: telegram.downloadFile,
  sendMedia: telegram.sendMedia,
  setMyName: telegram.setMyName,
  setMyShortDescription: telegram.setMyShortDescription,
  setMyDescription: telegram.setMyDescription,
  setMyCommands: telegram.setMyCommands,
  getUserProfilePhotoFileId: telegram.getUserProfilePhotoFileId,
};

const WHATSAPP_API: BotApi = {
  getMe: whatsapp.getMe,
  setWebhook: async () => whatsapp.setWebhook(),
  deleteWebhook: async () => whatsapp.deleteWebhook(),
  getWebhookInfo: async () => whatsapp.getWebhookInfo(),
  sendMessage: whatsapp.sendMessage,
  sendChatAction: async () => whatsapp.sendChatAction(),
  editMessageText: async () => whatsapp.editMessageText(),
  answerCallbackQuery: async () => whatsapp.answerCallbackQuery(),
  getFile: whatsapp.getFile,
  downloadFile: whatsapp.downloadFile,
  sendMedia: whatsapp.sendMedia,
  setMyName: async () => whatsapp.setMyName(),
  setMyShortDescription: whatsapp.setMyShortDescription,
  setMyDescription: whatsapp.setMyDescription,
  setMyCommands: async () => whatsapp.setMyCommands(),
  getUserProfilePhotoFileId: async () => whatsapp.getUserProfilePhotoFileId(),
};

const INSTAGRAM_API: BotApi = {
  getMe: instagram.getMe,
  setWebhook: async () => instagram.setWebhook(),
  deleteWebhook: async () => instagram.deleteWebhook(),
  getWebhookInfo: async () => instagram.getWebhookInfo(),
  sendMessage: instagram.sendMessage,
  sendChatAction: (c, chatId) => instagram.sendChatAction(c, chatId),
  editMessageText: async () => instagram.editMessageText(),
  answerCallbackQuery: async () => instagram.answerCallbackQuery(),
  getFile: instagram.getFile,
  downloadFile: instagram.downloadFile,
  sendMedia: instagram.sendMedia,
  setMyName: async () => instagram.setMyName(),
  setMyShortDescription: async () => instagram.setMyShortDescription(),
  setMyDescription: async () => instagram.setMyDescription(),
  setMyCommands: async () => instagram.setMyCommands(),
  getUserProfilePhotoFileId: instagram.getUserProfilePhotoFileId,
};

export function botApiFor(provider: string | BotProviderDescriptor): BotApi {
  const descriptor = typeof provider === 'string' ? botProvider(provider) : provider;
  if (descriptor.dialect === 'whatsapp-cloud') return WHATSAPP_API;
  if (descriptor.dialect === 'instagram-graph') return INSTAGRAM_API;
  return TELEGRAM_API;
}
