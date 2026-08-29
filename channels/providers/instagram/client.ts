/**
 * Instagram Messaging (Meta Messenger Platform) client.
 *
 * Exposes EXACTLY the same surface as the Telegram Bot API client so the
 * Channels Worker can drive Telegram, Bale, WhatsApp and Instagram through
 * one dispatcher (`worker/channels/botApi.ts`) with no protocol branching in
 * the job handlers.
 *
 * - The credential is a JSON envelope
 *   `{ ig_account_id, access_token, page_id? }`, decrypted by the worker and
 *   NEVER logged or forwarded to Core.
 * - Errors are normalized onto `TelegramApiError` so retry/permanence
 *   classification stays identical across providers.
 */

import { TelegramApiError, type BotCredential } from '../telegram/client.js';

const GRAPH_ROOT = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v21.0';
const DEFAULT_TIMEOUT_MS = 20_000;

export type InstagramCredential = {
  /** Instagram professional account id (IG user id) that owns the inbox. */
  igAccountId: string;
  /** Page/IG access token with instagram_manage_messages. */
  accessToken: string;
  /** Linked Facebook Page id, when the operator supplied it. */
  pageId: string | null;
  apiRoot: string;
};

/** Redacts a Meta access token from any string before it is surfaced. */
export function redactInstagramToken(text: string): string {
  return text.replace(/EA[A-Za-z0-9]{20,}/g, '[REDACTED_ACCESS_TOKEN]');
}

export function parseInstagramCredential(credential: BotCredential): InstagramCredential {
  const raw = typeof credential === 'string' ? credential : credential.token;
  const apiRoot = (typeof credential === 'string' ? GRAPH_ROOT : credential.apiRoot || GRAPH_ROOT).replace(
    /\/+$/,
    '',
  );
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TelegramApiError('Instagram credential is not a valid JSON envelope', 400, null, null, false);
  }
  const igAccountId = String(parsed?.ig_account_id ?? '').trim();
  const accessToken = String(parsed?.access_token ?? '').trim();
  if (!igAccountId || !accessToken) {
    throw new TelegramApiError(
      'Instagram credential is missing ig_account_id or access_token',
      400,
      null,
      null,
      false,
    );
  }
  return {
    igAccountId,
    accessToken,
    pageId: parsed?.page_id ? String(parsed.page_id) : null,
    apiRoot,
  };
}

async function graph<T = any>(
  cred: InstagramCredential,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${cred.apiRoot}/${GRAPH_VERSION}/${path.replace(/^\/+/, '')}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new TelegramApiError(
      `Instagram transport failure on ${path}: ${redactInstagramToken(String((err as Error).message))}`,
      0,
      null,
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* handled below */
  }

  if (!response.ok || parsed?.error) {
    const error = parsed?.error ?? {};
    const code: number | null = typeof error?.code === 'number' ? error.code : null;
    const description = redactInstagramToken(String(error?.message ?? raw ?? 'unknown error')).slice(0, 500);
    // 4 / 17 / 32 / 613 are Meta's throttling families.
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      code === 4 ||
      code === 17 ||
      code === 32 ||
      code === 613;
    throw new TelegramApiError(
      `Instagram ${path} failed [${response.status}]: ${description}`,
      response.status,
      code,
      null,
      retryable,
    );
  }

  return parsed as T;
}

// ── identity ──────────────────────────────────────────────────────────

export async function getMe(credential: BotCredential) {
  const cred = parseInstagramCredential(credential);
  const profile = await graph<any>(cred, 'GET', `${cred.igAccountId}?fields=username,name`);
  return {
    id: cred.igAccountId,
    username: profile?.username ?? null,
    firstName: profile?.name ?? null,
  };
}

// ── webhook lifecycle (owned by the Meta app dashboard) ───────────────

export async function setWebhook(): Promise<void> {
  /* not applicable — subscribed once per Meta app */
}

export async function deleteWebhook(): Promise<void> {
  /* not applicable */
}

export async function getWebhookInfo() {
  return { url: '', pending_update_count: 0 };
}

// ── messaging ─────────────────────────────────────────────────────────

/**
 * Translates a Bot-API keyboard into Instagram quick replies.
 *
 * Instagram has no inline keyboard: quick replies are chips above the input
 * that disappear once tapped, and Meta caps them at 13 per message with a
 * 20-character title.
 */
export function quickRepliesFromReplyMarkup(
  replyMarkup: Record<string, any> | undefined,
): Array<Record<string, unknown>> | null {
  if (!replyMarkup) return null;
  const rows: any[] = Array.isArray(replyMarkup.inline_keyboard)
    ? replyMarkup.inline_keyboard
    : Array.isArray(replyMarkup.keyboard)
      ? replyMarkup.keyboard
      : [];

  const chips = rows
    .flat()
    .map((button: any) => {
      const label = String(button?.text ?? '').trim();
      if (!label) return null;
      return {
        content_type: 'text',
        title: label.slice(0, 20),
        payload: String(button?.callback_data ?? label).slice(0, 1000),
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  return chips.length ? chips.slice(0, 13) : null;
}

async function send(cred: InstagramCredential, recipientId: string, message: Record<string, unknown>) {
  const result = await graph<any>(cred, 'POST', `${cred.igAccountId}/messages`, {
    messaging_product: 'instagram',
    recipient: { id: recipientId },
    message,
  });
  return { message_id: result?.message_id ?? result?.messages?.[0]?.id ?? 0 };
}

export async function sendMessage(
  credential: BotCredential,
  input: {
    chatId: number | string;
    text: string;
    replyToMessageId?: number;
    parseMode?: 'HTML' | 'MarkdownV2';
    replyMarkup?: Record<string, unknown>;
  },
): Promise<{ message_id: number | string }> {
  const cred = parseInstagramCredential(credential);
  const quickReplies = quickRepliesFromReplyMarkup(input.replyMarkup as any);
  const message: Record<string, unknown> = { text: input.text.slice(0, 1000) || '…' };
  if (quickReplies) message.quick_replies = quickReplies;
  return send(cred, String(input.chatId), message);
}

/** Messenger Platform typing indicator. */
export async function sendChatAction(credential: BotCredential, chatId: number | string): Promise<void> {
  const cred = parseInstagramCredential(credential);
  await graph(cred, 'POST', `${cred.igAccountId}/messages`, {
    messaging_product: 'instagram',
    recipient: { id: String(chatId) },
    sender_action: 'typing_on',
  });
}

/** Instagram cannot edit a delivered message. */
export async function editMessageText(): Promise<void> {
  throw new TelegramApiError('Instagram cannot edit a delivered message', 400, null, null, false);
}

/** Quick replies need no acknowledgement round trip. */
export async function answerCallbackQuery(): Promise<void> {
  /* not applicable */
}

// ── media ─────────────────────────────────────────────────────────────

/**
 * Instagram inbound attachments arrive as absolute CDN URLs, so the mapper
 * stores the URL itself as the `file_id` and there is nothing to resolve.
 */
export async function getFile(
  _credential: BotCredential,
  fileId: string,
): Promise<{ file_path: string; file_size?: number }> {
  if (!/^https:\/\//i.test(fileId)) {
    throw new TelegramApiError('Instagram media reference is not a URL', 400, null, null, false);
  }
  return { file_path: fileId };
}

export async function downloadFile(
  credential: BotCredential,
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const cred = parseInstagramCredential(credential);
  if (!/^https:\/\//i.test(filePath)) {
    throw new TelegramApiError('Instagram media URL is not https', 400, null, null, false);
  }
  const response = await fetch(filePath, { headers: { Authorization: `Bearer ${cred.accessToken}` } });
  if (!response.ok) {
    throw new TelegramApiError(
      `Instagram media download failed [${response.status}]`,
      response.status,
      null,
      null,
      response.status >= 500 || response.status === 429,
    );
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new TelegramApiError('Instagram media exceeds allowed size', 413, null, null, false);
  }
  return buffer;
}

const MEDIA_TYPES: Record<string, string> = {
  photo: 'image',
  image: 'image',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  document: 'file',
};

export async function sendMedia(
  credential: BotCredential,
  input: { chatId: number | string; kind: string; url: string; caption?: string | null },
): Promise<{ message_id: number | string }> {
  const cred = parseInstagramCredential(credential);
  const type = MEDIA_TYPES[String(input.kind ?? '').toLowerCase()] ?? 'file';
  const sent = await send(cred, String(input.chatId), {
    attachment: { type, payload: { url: input.url, is_reusable: false } },
  });
  // Instagram carries no media caption: send it as a follow-up text message.
  if (input.caption?.trim()) {
    await send(cred, String(input.chatId), { text: input.caption.slice(0, 1000) });
  }
  return sent;
}

// ── profile (managed inside the Instagram app) ────────────────────────

export async function setMyName(): Promise<void> {
  /* not applicable */
}

export async function setMyShortDescription(): Promise<void> {
  /* not applicable */
}

export async function setMyDescription(): Promise<void> {
  /* not applicable */
}

export async function setMyCommands(): Promise<void> {
  /* not applicable */
}

/** Contact avatar: the IG user profile picture URL, used directly. */
export async function getUserProfilePhotoFileId(
  credential: BotCredential,
  userId: string | number,
): Promise<string | null> {
  try {
    const cred = parseInstagramCredential(credential);
    const profile = await graph<any>(cred, 'GET', `${userId}?fields=profile_pic`);
    const url = profile?.profile_pic ? String(profile.profile_pic) : null;
    return url && /^https:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}
