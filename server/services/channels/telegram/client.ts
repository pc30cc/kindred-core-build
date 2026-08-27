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
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_ROOT}/bot${botToken}/${method}`, {
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

export async function getMe(botToken: string): Promise<TelegramBotIdentity> {
  const me = await callTelegram<any>(botToken, 'getMe');
  return { id: me.id, username: me.username ?? null, firstName: me.first_name ?? null };
}

export async function setWebhook(
  botToken: string,
  url: string,
  secretToken: string,
  allowedUpdates: string[] = ['message', 'edited_message', 'callback_query'],
): Promise<void> {
  await callTelegram(botToken, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: allowedUpdates,
    drop_pending_updates: false,
    max_connections: 40,
  });
}

export async function deleteWebhook(botToken: string): Promise<void> {
  await callTelegram(botToken, 'deleteWebhook', { drop_pending_updates: false });
}

export type TelegramWebhookInfo = {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  ip_address?: string;
};

export async function getWebhookInfo(botToken: string): Promise<TelegramWebhookInfo> {
  return callTelegram<TelegramWebhookInfo>(botToken, 'getWebhookInfo');
}

export async function sendMessage(
  botToken: string,
  input: { chatId: number | string; text: string; replyToMessageId?: number },
): Promise<{ message_id: number }> {
  return callTelegram(botToken, 'sendMessage', {
    chat_id: input.chatId,
    text: input.text,
    reply_to_message_id: input.replyToMessageId,
    disable_web_page_preview: true,
  });
}

export async function getFile(botToken: string, fileId: string): Promise<{ file_path: string; file_size?: number }> {
  return callTelegram(botToken, 'getFile', { file_id: fileId });
}

export async function downloadFile(
  botToken: string,
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const response = await fetch(`${TELEGRAM_API_ROOT}/file/bot${botToken}/${filePath}`);
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
