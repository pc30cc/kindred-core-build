/**
 * Telegram update → provider-neutral inbound message.
 *
 * All text is length-capped and control characters stripped before it can
 * reach the database, the Inbox UI or an AI prompt. Unsupported update kinds
 * return null so the worker can complete the job as "ignored" instead of
 * retrying forever.
 */

import type { NormalizedInboundMessage } from '../inboundProcessing.js';

const MAX_TEXT_LENGTH = 8000;
const MAX_NAME_LENGTH = 120;

export function sanitizeText(input: unknown, max = MAX_TEXT_LENGTH): string {
  if (typeof input !== 'string') return '';
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

type Ctx = { workspaceId: string; integrationId: string };

export function normalizeTelegramUpdate(
  update: Record<string, any>,
  ctx: Ctx,
): NormalizedInboundMessage | null {
  const message = update?.message ?? update?.edited_message;
  if (!message || typeof update?.update_id !== 'number') return null;

  const chatId = message?.chat?.id;
  if (chatId === undefined || chatId === null) return null;

  const from = message.from ?? {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');

  const attachments: NormalizedInboundMessage['attachments'] = [];
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    attachments.push({ fileId: largest.file_id, kind: 'photo', size: largest.file_size ?? null });
  }
  for (const [kind, key] of [
    ['document', 'document'],
    ['voice', 'voice'],
    ['audio', 'audio'],
    ['video', 'video'],
  ] as const) {
    const media = message[key];
    if (media?.file_id) {
      attachments.push({
        fileId: media.file_id,
        kind,
        fileName: sanitizeText(media.file_name, MAX_NAME_LENGTH) || null,
        mimeType: sanitizeText(media.mime_type, 120) || null,
        size: media.file_size ?? null,
      });
    }
  }

  const text = sanitizeText(message.text ?? message.caption);
  if (!text && attachments.length === 0) return null;

  return {
    provider: 'telegram',
    workspaceId: ctx.workspaceId,
    integrationId: ctx.integrationId,
    providerEventId: String(update.update_id),
    externalChatId: String(chatId),
    externalUserId: from.id ? String(from.id) : null,
    senderName: sanitizeText(name, MAX_NAME_LENGTH) || null,
    senderUsername: sanitizeText(from.username, MAX_NAME_LENGTH) || null,
    senderLanguage: sanitizeText(from.language_code, 10) || null,
    senderProfile: {
      firstName: sanitizeText(from.first_name, MAX_NAME_LENGTH) || null,
      lastName: sanitizeText(from.last_name, MAX_NAME_LENGTH) || null,
      isPremium: from.is_premium === true,
      isBot: from.is_bot === true,
      chatType: sanitizeText(message?.chat?.type, 32) || null,
    },
    text,
    attachments,
    sentAt: message.date ? new Date(message.date * 1000).toISOString() : null,
  };
}
