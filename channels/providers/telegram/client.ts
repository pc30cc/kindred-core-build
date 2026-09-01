/**
 * Minimal, hardened Telegram Bot API client.
 *
 * - The bot token is passed in by the caller after decryption and is NEVER
 *   logged, echoed, or persisted in plaintext.
 * - Errors are normalized so the worker can distinguish retryable transport /
 *   rate-limit failures from permanent 4xx rejections.
 */

const TELEGRAM_API_ROOT = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A bot credential plus the API root it belongs to.
 *
 * Bale (بله) speaks the same Bot API on a different host, so every function
 * here accepts either a bare Telegram token (legacy call sites) or an
 * explicit `{ token, apiRoot }` pair. NOTHING else in this file is
 * provider-specific — capability differences live in
 * `shared/channels/botProviders.ts`.
 */
export type BotCredential = string | { token: string; apiRoot?: string | null };

function credentialParts(credential: BotCredential): { token: string; apiRoot: string } {
  if (typeof credential === 'string') return { token: credential, apiRoot: TELEGRAM_API_ROOT };
  return {
    token: credential.token,
    apiRoot: (credential.apiRoot || TELEGRAM_API_ROOT).replace(/\/+$/, ''),
  };
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly errorCode: number | null,
    readonly retryAfterSeconds: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/** Redacts any bot token accidentally present in a string. */
export function redactToken(text: string): string {
  return text.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED_BOT_TOKEN]');
}

export async function callTelegram<T = any>(
  botToken: BotCredential,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const { token, apiRoot } = credentialParts(botToken);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${apiRoot}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    // Network/timeout failures are always retryable.
    throw new TelegramApiError(
      `Telegram transport failure on ${method}: ${redactToken(String((err as Error).message))}`,
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
    /* non-JSON body handled below */
  }

  // Telegram reports failures inside the body as well as via HTTP status.
  if (!response.ok || !parsed?.ok) {
    const errorCode: number | null = parsed?.error_code ?? null;
    const retryAfter: number | null = parsed?.parameters?.retry_after ?? null;
    const description = redactToken(String(parsed?.description ?? raw ?? 'unknown error')).slice(0, 500);
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      errorCode === 429 ||
      (errorCode ?? 0) >= 500;

    throw new TelegramApiError(
      `Telegram ${method} failed [${response.status}]: ${description}`,
      response.status,
      errorCode,
      retryAfter,
      retryable,
    );
  }

  return parsed.result as T;
}

export type TelegramBotIdentity = {
  id: number;
  username: string | null;
  firstName: string | null;
};

export async function getMe(botToken: BotCredential): Promise<TelegramBotIdentity> {
  const me = await callTelegram<any>(botToken, 'getMe');
  return { id: me.id, username: me.username ?? null, firstName: me.first_name ?? null };
}

export async function setWebhook(
  botToken: BotCredential,
  url: string,
  secretToken: string | null,
  allowedUpdates: string[] | null = ['message', 'edited_message', 'callback_query'],
): Promise<void> {
  // Providers without a secret-token mechanism (Bale) reject unknown fields,
  // so optional parameters are omitted rather than sent as null.
  await callTelegram(botToken, 'setWebhook', {
    url,
    ...(secretToken ? { secret_token: secretToken } : {}),
    ...(allowedUpdates ? { allowed_updates: allowedUpdates } : {}),
    drop_pending_updates: false,
  });
}

export async function deleteWebhook(botToken: BotCredential): Promise<void> {
  await callTelegram(botToken, 'deleteWebhook', { drop_pending_updates: false });
}

export type TelegramWebhookInfo = {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  ip_address?: string;
};

export async function getWebhookInfo(botToken: BotCredential): Promise<TelegramWebhookInfo> {
  return callTelegram<TelegramWebhookInfo>(botToken, 'getWebhookInfo');
}

export async function sendMessage(
  botToken: BotCredential,
  input: {
    chatId: number | string;
    text: string;
    replyToMessageId?: number;
    /** Telegram formatting mode. Only pass it for text we generated ourselves. */
    parseMode?: 'HTML' | 'MarkdownV2';
    /** Inline / reply keyboard payload, already shaped for the Bot API. */
    replyMarkup?: Record<string, unknown>;
  },
): Promise<{ message_id: number }> {
  return callTelegram(botToken, 'sendMessage', {
    chat_id: input.chatId,
    text: input.text,
    reply_to_message_id: input.replyToMessageId,
    parse_mode: input.parseMode,
    reply_markup: input.replyMarkup,
    disable_web_page_preview: true,
  });
}

/**
 * Shows the native "typing…" bubble. Best-effort only: a failure here must
 * never block the actual reply, so callers should ignore rejections.
 */
export async function sendChatAction(
  botToken: BotCredential,
  chatId: number | string,
  action: 'typing' | 'upload_photo' | 'upload_document' = 'typing',
): Promise<void> {
  await callTelegram(botToken, 'sendChatAction', { chat_id: chatId, action });
}


export async function getFile(botToken: BotCredential, fileId: string): Promise<{ file_path: string; file_size?: number }> {
  return callTelegram(botToken, 'getFile', { file_id: fileId });
}

/** Largest available size of the user's current profile photo, if any. */
export async function getUserProfilePhotoFileId(
  botToken: BotCredential,
  userId: string | number,
): Promise<string | null> {
  const photos = await callTelegram<{ total_count: number; photos: Array<Array<{ file_id: string }>> }>(
    botToken,
    'getUserProfilePhotos',
    { user_id: userId, limit: 1 },
  );
  const sizes = photos?.photos?.[0];
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  return sizes[sizes.length - 1]?.file_id ?? null;
}


export async function downloadFile(
  botToken: BotCredential,
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const { token, apiRoot } = credentialParts(botToken);
  const response = await fetch(`${apiRoot}/file/bot${token}/${filePath}`);
  if (!response.ok) {
    throw new TelegramApiError(
      `Telegram file download failed [${response.status}]`,
      response.status,
      null,
      null,
      response.status >= 500 || response.status === 429,
    );
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new TelegramApiError('Telegram file exceeds allowed size', 413, null, null, false);
  }
  return buffer;
}

// ── Bot branding / commands (APPLY ON DEMAND ONLY) ────────────────────

export type TelegramCommand = { command: string; description: string };

export async function setMyName(botToken: BotCredential, name: string): Promise<void> {
  await callTelegram(botToken, 'setMyName', { name: name.slice(0, 64) });
}

export async function setMyShortDescription(botToken: BotCredential, shortDescription: string): Promise<void> {
  await callTelegram(botToken, 'setMyShortDescription', {
    short_description: shortDescription.slice(0, 120),
  });
}

export async function setMyDescription(botToken: BotCredential, description: string): Promise<void> {
  await callTelegram(botToken, 'setMyDescription', { description: description.slice(0, 512) });
}

export async function setMyCommands(botToken: BotCredential, commands: TelegramCommand[]): Promise<void> {
  await callTelegram(botToken, 'setMyCommands', {
    commands: commands.slice(0, 20).map((c) => ({
      command: c.command.replace(/^\//, '').slice(0, 32),
      description: c.description.slice(0, 256),
    })),
  });
}

// ── Outbound media ────────────────────────────────────────────────────

/** Maps an attachment kind to the Telegram send method + payload field. */
const MEDIA_METHODS: Record<string, { method: string; field: string }> = {
  photo: { method: 'sendPhoto', field: 'photo' },
  image: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  voice: { method: 'sendVoice', field: 'voice' },
  document: { method: 'sendDocument', field: 'document' },
};

export function telegramMediaMethod(kind: string | null | undefined) {
  return MEDIA_METHODS[String(kind ?? '').toLowerCase()] ?? MEDIA_METHODS.document;
}

/**
 * Sends a media attachment by PUBLIC URL. The URL is fetched by Telegram, so
 * it must never carry credentials — Core passes a signed, expiring storage
 * URL, never a raw service key.
 */
export async function sendMedia(
  botToken: BotCredential,
  input: { chatId: number | string; kind: string; url: string; caption?: string | null },
): Promise<{ message_id: number }> {
  const { method, field } = telegramMediaMethod(input.kind);
  return callTelegram(botToken, method, {
    chat_id: input.chatId,
    [field]: input.url,
    caption: input.caption ? input.caption.slice(0, 1024) : undefined,
  });
}

/**
 * Sends a media attachment by UPLOADING THE BYTES (multipart/form-data).
 *
 * Preferred over `sendMedia()` for the Telegram Bot API dialect: it does not
 * require our storage/API host to be publicly reachable by Telegram's
 * fetchers (self-hosted deployments behind private DNS, fresh TLS, or
 * IP allow-lists otherwise fail with "failed to get HTTP URL content").
 */
export async function sendMediaBytes(
  botToken: BotCredential,
  input: {
    chatId: number | string;
    kind: string;
    bytes: Uint8Array;
    fileName?: string | null;
    mimeType?: string | null;
    caption?: string | null;
  },
  timeoutMs = 60_000,
): Promise<{ message_id: number }> {
  const { token, apiRoot } = credentialParts(botToken);
  const { method, field } = telegramMediaMethod(input.kind);

  const form = new FormData();
  form.append('chat_id', String(input.chatId));
  if (input.caption) form.append('caption', input.caption.slice(0, 1024));
  const bytes = input.bytes;
  const buf = bytes instanceof Uint8Array
    ? bytes.slice().buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : bytes;
  form.append(
    field,
    new Blob([buf as ArrayBuffer], { type: input.mimeType || 'application/octet-stream' }),
    input.fileName || 'file',
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${apiRoot}/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new TelegramApiError(
      `Telegram ${method} upload transport error: ${redactToken(String(err?.message || err))}`,
      0, null, null, true,
    );
  } finally {
    clearTimeout(timer);
  }

  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const description = redactToken(String(payload?.description ?? response.statusText));
    const retryAfter = payload?.parameters?.retry_after ?? null;
    throw new TelegramApiError(
      `Telegram ${method} upload failed [${response.status}]: ${description}`,
      response.status,
      payload?.error_code ?? null,
      retryAfter,
      response.status === 429 || response.status >= 500,
    );
  }
  return payload.result;
}

// ── Inline menu interactions ──────────────────────────────────────────

/**
 * Acknowledges a callback query. Telegram shows a spinner on the button
 * until this returns, so it is always called — even for unknown payloads.
 */
export async function answerCallbackQuery(
  botToken: BotCredential,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await callTelegram(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ? text.slice(0, 200) : undefined,
  });
}

/**
 * Rewrites the message the button belongs to. Used for menu navigation so a
 * single chat bubble morphs instead of flooding the chat with new messages.
 */
export async function editMessageText(
  botToken: BotCredential,
  input: {
    chatId: number | string;
    messageId: number;
    text: string;
    parseMode?: 'HTML' | 'MarkdownV2';
    replyMarkup?: Record<string, unknown>;
  },
): Promise<void> {
  await callTelegram(botToken, 'editMessageText', {
    chat_id: input.chatId,
    message_id: input.messageId,
    text: input.text,
    parse_mode: input.parseMode,
    reply_markup: input.replyMarkup,
    disable_web_page_preview: true,
  });
}
