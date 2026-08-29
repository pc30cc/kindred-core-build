/**
 * Meta WhatsApp Cloud API client.
 *
 * Exposes EXACTLY the same surface as the Telegram Bot API client so the
 * Channels Worker can drive either provider through one dispatcher
 * (`worker/channels/botApi.ts`) with no protocol branching in the handlers.
 *
 * - The credential is a JSON envelope `{ phone_number_id, access_token }`,
 *   decrypted by the worker and NEVER logged or forwarded to Core.
 * - Errors are normalized onto `TelegramApiError` so retry/permanence
 *   classification stays identical across providers.
 */

import { TelegramApiError, type BotCredential } from '../telegram/client.js';

const GRAPH_ROOT = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v21.0';
const DEFAULT_TIMEOUT_MS = 20_000;

export type WhatsAppCredential = {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string | null;
  apiRoot: string;
};

/** Redacts a Meta access token from any string before it is surfaced. */
export function redactWhatsAppToken(text: string): string {
  return text.replace(/EA[A-Za-z0-9]{20,}/g, '[REDACTED_ACCESS_TOKEN]');
}

export function parseWhatsAppCredential(credential: BotCredential): WhatsAppCredential {
  const raw = typeof credential === 'string' ? credential : credential.token;
  const apiRoot = (typeof credential === 'string' ? GRAPH_ROOT : credential.apiRoot || GRAPH_ROOT).replace(
    /\/+$/,
    '',
  );
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TelegramApiError('WhatsApp credential is not a valid JSON envelope', 400, null, null, false);
  }
  const phoneNumberId = String(parsed?.phone_number_id ?? '').trim();
  const accessToken = String(parsed?.access_token ?? '').trim();
  if (!phoneNumberId || !accessToken) {
    throw new TelegramApiError('WhatsApp credential is missing phone_number_id or access_token', 400, null, null, false);
  }
  return {
    phoneNumberId,
    accessToken,
    businessAccountId: parsed?.business_account_id ? String(parsed.business_account_id) : null,
    apiRoot,
  };
}

async function graph<T = any>(
  cred: WhatsAppCredential,
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
      `WhatsApp transport failure on ${path}: ${redactWhatsAppToken(String((err as Error).message))}`,
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
    const description = redactWhatsAppToken(String(error?.message ?? raw ?? 'unknown error')).slice(0, 500);
    // 4 = app rate limit, 80007 = business rate limit, 131048 = spam throttle.
    const retryable =
      response.status === 429 || response.status >= 500 || code === 4 || code === 80007 || code === 131048;
    throw new TelegramApiError(
      `WhatsApp ${path} failed [${response.status}]: ${description}`,
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
  const cred = parseWhatsAppCredential(credential);
  const profile = await graph<any>(
    cred,
    'GET',
    `${cred.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
  );
  return {
    id: cred.phoneNumberId,
    username: profile?.display_phone_number ?? null,
    firstName: profile?.verified_name ?? null,
  };
}

// ── webhook lifecycle (owned by the Meta app dashboard) ───────────────
//
// Cloud API webhooks are configured ONCE per Meta app, not per bot, so there
// is no programmatic equivalent of `setWebhook`. These are intentional no-ops
// and the descriptor flag `supportsWebhookRegistration: false` keeps the
// connect flow from asserting a URL the platform cannot set.

export async function setWebhook(): Promise<void> {
  /* not applicable */
}

export async function deleteWebhook(): Promise<void> {
  /* not applicable */
}

export async function getWebhookInfo() {
  return { url: '', pending_update_count: 0 };
}

// ── messaging ─────────────────────────────────────────────────────────

/**
 * Translates a Bot-API keyboard into a WhatsApp interactive payload.
 *
 * ≤3 actions become reply buttons; more become a single-section list, which
 * is the only way Cloud API can present a larger menu.
 */
export function interactiveFromReplyMarkup(
  text: string,
  replyMarkup: Record<string, any> | undefined,
): Record<string, unknown> | null {
  if (!replyMarkup) return null;
  const rows: any[] = Array.isArray(replyMarkup.inline_keyboard)
    ? replyMarkup.inline_keyboard
    : Array.isArray(replyMarkup.keyboard)
      ? replyMarkup.keyboard
      : [];

  const buttons = rows
    .flat()
    .map((button: any) => {
      const label = String(button?.text ?? '').trim();
      if (!label) return null;
      const id = String(button?.callback_data ?? label).slice(0, 200);
      return { id, label: label.slice(0, 20), description: String(button?.text ?? '').slice(0, 72) };
    })
    .filter(Boolean) as Array<{ id: string; label: string; description: string }>;

  if (buttons.length === 0) return null;

  const body = { text: text.slice(0, 1024) || '…' };

  if (buttons.length <= 3) {
    return {
      type: 'button',
      body,
      action: {
        buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.label } })),
      },
    };
  }

  return {
    type: 'list',
    body,
    action: {
      button: 'Menu',
      sections: [
        {
          title: 'Menu',
          rows: buttons.slice(0, 10).map((b) => ({
            id: b.id,
            title: b.label,
            description: b.description === b.label ? undefined : b.description,
          })),
        },
      ],
    },
  };
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
): Promise<{ message_id: number }> {
  const cred = parseWhatsAppCredential(credential);
  const interactive = interactiveFromReplyMarkup(input.text, input.replyMarkup as any);

  const payload: Record<string, unknown> = interactive
    ? { messaging_product: 'whatsapp', to: String(input.chatId), type: 'interactive', interactive }
    : {
        messaging_product: 'whatsapp',
        to: String(input.chatId),
        type: 'text',
        text: { body: input.text.slice(0, 4096), preview_url: false },
      };

  const result = await graph<any>(cred, 'POST', `${cred.phoneNumberId}/messages`, payload);
  return { message_id: result?.messages?.[0]?.id ?? 0 };
}

/** Cloud API has no free-standing typing signal; deliberately a no-op. */
export async function sendChatAction(): Promise<void> {
  /* not applicable */
}

/** Cloud API cannot edit a delivered message. */
export async function editMessageText(): Promise<void> {
  throw new TelegramApiError('WhatsApp cannot edit a delivered message', 400, null, null, false);
}

/** No callback-query acknowledgement concept exists. */
export async function answerCallbackQuery(): Promise<void> {
  /* not applicable */
}

// ── media ─────────────────────────────────────────────────────────────

export async function getFile(
  credential: BotCredential,
  mediaId: string,
): Promise<{ file_path: string; file_size?: number }> {
  const cred = parseWhatsAppCredential(credential);
  const meta = await graph<any>(cred, 'GET', mediaId);
  if (!meta?.url) {
    throw new TelegramApiError('WhatsApp media has no download URL', 404, null, null, false);
  }
  return { file_path: String(meta.url), file_size: Number(meta.file_size ?? 0) || undefined };
}

export async function downloadFile(
  credential: BotCredential,
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const cred = parseWhatsAppCredential(credential);
  // `file_path` is the absolute, short-lived Graph CDN URL returned by getFile.
  if (!/^https:\/\//i.test(filePath)) {
    throw new TelegramApiError('WhatsApp media URL is not https', 400, null, null, false);
  }
  const response = await fetch(filePath, { headers: { Authorization: `Bearer ${cred.accessToken}` } });
  if (!response.ok) {
    throw new TelegramApiError(
      `WhatsApp media download failed [${response.status}]`,
      response.status,
      null,
      null,
      response.status >= 500 || response.status === 429,
    );
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new TelegramApiError('WhatsApp media exceeds allowed size', 413, null, null, false);
  }
  return buffer;
}

const MEDIA_TYPES: Record<string, string> = {
  photo: 'image',
  image: 'image',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  document: 'document',
};

export async function sendMedia(
  credential: BotCredential,
  input: { chatId: number | string; kind: string; url: string; caption?: string | null },
): Promise<{ message_id: number }> {
  const cred = parseWhatsAppCredential(credential);
  const type = MEDIA_TYPES[String(input.kind ?? '').toLowerCase()] ?? 'document';
  const media: Record<string, unknown> = { link: input.url };
  if (input.caption && type !== 'audio') media.caption = input.caption.slice(0, 1024);

  const result = await graph<any>(cred, 'POST', `${cred.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: String(input.chatId),
    type,
    [type]: media,
  });
  return { message_id: result?.messages?.[0]?.id ?? 0 };
}

// ── business profile (WhatsApp's equivalent of bot branding) ──────────

export async function setMyName(): Promise<void> {
  // The display name is governed by Meta's verified-name review, not the API.
}

export async function setMyShortDescription(credential: BotCredential, about: string): Promise<void> {
  const cred = parseWhatsAppCredential(credential);
  await graph(cred, 'POST', `${cred.phoneNumberId}/whatsapp_business_profile`, {
    messaging_product: 'whatsapp',
    about: about.slice(0, 139),
  });
}

export async function setMyDescription(credential: BotCredential, description: string): Promise<void> {
  const cred = parseWhatsAppCredential(credential);
  await graph(cred, 'POST', `${cred.phoneNumberId}/whatsapp_business_profile`, {
    messaging_product: 'whatsapp',
    description: description.slice(0, 512),
  });
}

/** No native command menu on WhatsApp. */
export async function setMyCommands(): Promise<void> {
  /* not applicable */
}

/** Cloud API exposes no contact profile photo. */
export async function getUserProfilePhotoFileId(): Promise<string | null> {
  return null;
}
