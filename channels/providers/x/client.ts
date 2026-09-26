/**
 * X (formerly Twitter) Direct Messages client — API v2.
 *
 * Exposes the same surface as the Telegram Bot API client so the Channels
 * Worker can drive Telegram, Bale, WhatsApp, Instagram and X through one
 * dispatcher (`worker/channels/botApi.ts`) with no protocol branching in the
 * job handlers.
 *
 * Auth is OAuth 1.0a User Context (API key/secret + access token/secret),
 * not OAuth 2.0: an OAuth2 user-context bearer token for X expires in ~2
 * hours and needs a background refresh flow, while an OAuth 1.0a user
 * token/secret pair never expires on its own — the same "paste it once"
 * pattern this platform already uses for WhatsApp/Instagram. It is also the
 * auth mode X's Direct Message endpoints have supported the longest.
 *
 * X has no broadly-available real-time DM webhook (the Account Activity API
 * replacement requires Enterprise-tier access), so there is no `setWebhook`
 * here — inbound delivery is a Channels Worker poll loop driven by
 * `pollDmEvents` (see `worker/channels/index.ts`, job type
 * `x_poll_dm_events`).
 *
 * The credential is a JSON envelope
 * `{ api_key, api_secret, access_token, access_token_secret }`, decrypted by
 * the worker and NEVER logged or forwarded to Core.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { TelegramApiError, mediaDownloadError, type BotCredential } from '../telegram/client.js';
import type { XDmEvent } from '../../../shared/channels/xDmEvent.js';
import { assertPublicHttpUrl, fetchBytesBounded } from '../../../shared/net/boundedFetch.js';

const API_ROOT = 'https://api.twitter.com';
const UPLOAD_ROOT = 'https://upload.twitter.com';
const API_VERSION = '2';
const DEFAULT_TIMEOUT_MS = 20_000;

export type XCredential = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

/** Redacts an X OAuth1 secret/token from any string before it is surfaced. */
export function redactXToken(text: string): string {
  return text.replace(/[A-Za-z0-9]{35,60}-[A-Za-z0-9]{20,60}/g, '[REDACTED_ACCESS_TOKEN]');
}

export function parseXCredential(credential: BotCredential): XCredential {
  const raw = typeof credential === 'string' ? credential : credential.token;
  let parsed: {
    api_key?: unknown;
    api_secret?: unknown;
    access_token?: unknown;
    access_token_secret?: unknown;
  } | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TelegramApiError('X credential is not a valid JSON envelope', 400, null, null, false);
  }
  const apiKey = String(parsed?.api_key ?? '').trim();
  const apiSecret = String(parsed?.api_secret ?? '').trim();
  const accessToken = String(parsed?.access_token ?? '').trim();
  const accessTokenSecret = String(parsed?.access_token_secret ?? '').trim();
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    throw new TelegramApiError('X credential is missing one of api_key/api_secret/access_token/access_token_secret', 400, null, null, false);
  }
  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

// ── OAuth 1.0a signing (pure, exported for tests) ───────────────────────

/** RFC 3986 percent-encoding — stricter than `encodeURIComponent`. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Builds the OAuth 1.0a `Authorization` header for one request.
 *
 * `bodyParams` are included in the signature base ONLY for
 * `application/x-www-form-urlencoded` bodies (per the OAuth 1.0a spec) — a
 * JSON body or a multipart upload never contributes to the signature, so
 * callers pass `null` for those.
 */
export function buildOAuth1Header(
  cred: XCredential,
  method: 'GET' | 'POST',
  url: string,
  queryParams: Record<string, string> | null,
  bodyParams: Record<string, string> | null,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: cred.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: cred.accessToken,
    oauth_version: '1.0',
  };

  const allParams: Record<string, string> = { ...oauthParams, ...(queryParams ?? {}), ...(bodyParams ?? {}) };
  const paramString = Object.keys(allParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  const baseUrl = url.split('?')[0];
  const baseString = `${method}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(cred.apiSecret)}&${percentEncode(cred.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header = Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(', ');
  return `OAuth ${header}`;
}

/** The error fields of an X API v2 response body, as far as they are read here. */
type XApiErrorBody = { errors?: unknown; title?: unknown } | null;

/** `data` of an X API v2 response, as far as it is read here. */
type XDataResult<D> = { data?: D } | null;

type XUserRaw = { id?: unknown; username?: string };
type XMediaRaw = { media_key?: unknown; type?: unknown; url?: unknown; preview_image_url?: unknown };
type XDmEventRaw = {
  id?: unknown;
  text?: unknown;
  event_type?: unknown;
  created_at?: string;
  dm_conversation_id?: unknown;
  sender_id?: unknown;
  attachments?: { media_keys?: unknown };
};

async function apiV2<T = unknown>(
  cred: XCredential,
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, string>; jsonBody?: Record<string, unknown> } = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = new URL(`${API_ROOT}/${API_VERSION}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

  const authorization = buildOAuth1Header(cred, method, url.toString().split('?')[0], options.query ?? null, null);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: authorization,
        ...(options.jsonBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new TelegramApiError(
      `X transport failure on ${path}: ${redactXToken(String((err as Error).message))}`,
      0,
      null,
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let parsed: XApiErrorBody = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* handled below */
  }

  if (!response.ok || parsed?.errors) {
    const firstError = (Array.isArray(parsed?.errors) ? parsed.errors[0] : parsed?.errors) as
      | { message?: unknown }
      | null
      | undefined;
    const description = redactXToken(String(firstError?.message ?? parsed?.title ?? raw ?? 'unknown error')).slice(0, 500);
    const retryable = response.status === 429 || response.status >= 500;
    throw new TelegramApiError(`X ${path} failed [${response.status}]: ${description}`, response.status, null, null, retryable);
  }

  return parsed as T;
}

// ── identity ──────────────────────────────────────────────────────────

export async function getMe(credential: BotCredential) {
  const cred = parseXCredential(credential);
  const result = await apiV2<XDataResult<{ id?: unknown; username?: string; name?: string }>>(cred, 'GET', 'users/me', { query: { 'user.fields': 'username,name' } });
  return {
    id: String(result?.data?.id ?? ''),
    username: result?.data?.username ?? null,
    firstName: result?.data?.name ?? null,
  };
}

// ── webhook lifecycle (not applicable — see pollDmEvents instead) ─────

export async function setWebhook(): Promise<void> {
  /* not applicable — X's DM webhook (Account Activity API) requires
     Enterprise access; inbound delivery is polled instead. */
}

export async function deleteWebhook(): Promise<void> {
  /* not applicable */
}

export async function getWebhookInfo() {
  return { url: '', pending_update_count: 0 };
}

// ── inbound polling ──────────────────────────────────────────────────

/**
 * Fetches the most recent DM events across every conversation the connected
 * account can see, resolving `sender_id`/`attachments.media_keys`
 * expansions inline so the caller never has to.
 *
 * There is no `since_id` filter on this endpoint, so the caller is expected
 * to de-duplicate (Core already does — every inbound event is deduped on
 * `(integration_id, external_event_id)` before it becomes a conversation
 * message, so re-polling the same page is always safe, just wasteful).
 */
export async function pollDmEvents(credential: BotCredential, maxResults = 50): Promise<XDmEvent[]> {
  const cred = parseXCredential(credential);
  const result = await apiV2<{
    data?: unknown;
    includes?: { users?: XUserRaw[]; media?: XMediaRaw[] };
  } | null>(cred, 'GET', 'dm_events', {
    query: {
      max_results: String(Math.min(Math.max(maxResults, 1), 100)),
      event_types: 'MessageCreate',
      'dm_event.fields': 'id,text,event_type,created_at,dm_conversation_id,sender_id,attachments',
      expansions: 'sender_id,attachments.media_keys',
      'media.fields': 'url,type,preview_image_url',
      'user.fields': 'username',
    },
  });

  const usersById = new Map<string, XUserRaw>(
    (result?.includes?.users ?? []).map((u): [string, XUserRaw] => [String(u.id), u]),
  );
  const mediaByKey = new Map<string, XMediaRaw>(
    (result?.includes?.media ?? []).map((m): [string, XMediaRaw] => [String(m.media_key), m]),
  );

  const events: XDmEventRaw[] = Array.isArray(result?.data) ? result.data : [];
  return events
    .filter((event) => event?.event_type === 'MessageCreate')
    .map((event): XDmEvent => {
      const senderId = String(event?.sender_id ?? '');
      const user = usersById.get(senderId);
      const mediaKeys: string[] = Array.isArray(event?.attachments?.media_keys) ? event.attachments.media_keys : [];
      const mediaUrls = mediaKeys
        .map((key) => mediaByKey.get(key))
        .filter((media): media is XMediaRaw => Boolean(media))
        .map((media) => {
          const type = media.type === 'video' || media.type === 'animated_gif' ? 'video' : media.type === 'photo' ? 'photo' : 'audio';
          const url = type === 'video' ? media.preview_image_url || media.url : media.url;
          return url ? { kind: type as 'photo' | 'video' | 'audio', url: String(url) } : null;
        })
        .filter((x): x is { kind: 'photo' | 'video' | 'audio'; url: string } => x !== null);

      return {
        id: String(event.id),
        text: event.text ? String(event.text) : null,
        eventType: String(event.event_type),
        createdAt: event.created_at ?? null,
        dmConversationId: String(event.dm_conversation_id ?? ''),
        senderId,
        senderUsername: user?.username ?? null,
        mediaUrls,
      };
    });
}

// ── messaging ─────────────────────────────────────────────────────────

/** X's DM endpoints accept no keyboard/quick-reply payload — plain text only. */
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
  const cred = parseXCredential(credential);
  const dmConversationId = String(input.chatId);
  const result = await apiV2<XDataResult<{ dm_event_id?: string }>>(cred, 'POST', `dm_conversations/${percentEncode(dmConversationId)}/messages`, {
    jsonBody: { text: input.text.slice(0, 10_000) || '…' },
  });
  return { message_id: result?.data?.dm_event_id ?? 0 };
}

/** No typing-indicator endpoint exists on the X DM API. */
export async function sendChatAction(): Promise<void> {
  /* not applicable */
}

/** X cannot edit a delivered DM. */
export async function editMessageText(): Promise<void> {
  throw new TelegramApiError('X cannot edit a delivered message', 400, null, null, false);
}

/** No quick replies on X DMs — nothing to acknowledge. */
export async function answerCallbackQuery(): Promise<void> {
  /* not applicable */
}

// ── media ─────────────────────────────────────────────────────────────

/** Inbound X media arrives as an absolute CDN URL — same strategy as Instagram. */
export async function getFile(
  _credential: BotCredential,
  fileId: string,
): Promise<{ file_path: string; file_size?: number }> {
  if (!/^https:\/\//i.test(fileId)) {
    throw new TelegramApiError('X media reference is not a URL', 400, null, null, false);
  }
  return { file_path: fileId };
}

/**
 * X DM media URLs returned by `pollDmEvents` are pre-authorized CDN links
 * (pbs.twimg.com / video.twimg.com) and need no additional signing to fetch.
 */
export async function downloadFile(_credential: BotCredential, filePath: string, maxBytes: number): Promise<Uint8Array> {
  if (!/^https:\/\//i.test(filePath)) {
    throw new TelegramApiError('X media URL is not https', 400, null, null, false);
  }
  try {
    const { bytes } = await fetchBytesBounded(filePath, {
      maxBytes,
      maxRedirects: 3,
      validate: (url) => assertPublicHttpUrl(url),
    });
    return bytes;
  } catch (err) {
    throw mediaDownloadError(err, 'X');
  }
}

/** X's simple (non-chunked) media upload accepts images up to 5 MB. */
const X_SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Uploads bytes to the (still-live) v1.1 media endpoint and attaches the
 * resulting media id to a DM. Simple (non-chunked) upload only, so this
 * supports images up to 5MB; anything else is sent as a follow-up text
 * message carrying the source URL instead of failing outright.
 */
async function uploadMedia(cred: XCredential, bytes: Uint8Array, mimeType: string): Promise<string> {
  const url = `${UPLOAD_ROOT}/1.1/media/upload.json`;
  const boundary = `----webyar${randomBytes(12).toString('hex')}`;
  const authorization = buildOAuth1Header(cred, 'POST', url, null, null);

  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="upload"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, Buffer.from(bytes), epilogue]);

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new TelegramApiError(`X media upload failed [${response.status}]: ${redactXToken(raw).slice(0, 300)}`, response.status, null, null, response.status >= 500 || response.status === 429);
  }
  const parsed = JSON.parse(raw);
  const mediaId = String(parsed?.media_id_string ?? parsed?.media_id ?? '');
  if (!mediaId) throw new TelegramApiError('X media upload returned no media id', 502, null, null, true);
  return mediaId;
}

const UPLOADABLE_IMAGE_TYPES: Record<string, string> = {
  photo: 'image/jpeg',
  image: 'image/jpeg',
};

export async function sendMedia(
  credential: BotCredential,
  input: { chatId: number | string; kind: string; url: string; caption?: string | null },
): Promise<{ message_id: number | string }> {
  const cred = parseXCredential(credential);
  const dmConversationId = String(input.chatId);
  const kind = String(input.kind ?? '').toLowerCase();
  const mimeType = UPLOADABLE_IMAGE_TYPES[kind];

  if (mimeType) {
    try {
      // The URL comes from a queued job payload: SSRF-guard every hop and
      // cap the download at the upload limit (an oversized image falls
      // through to the link fallback below, exactly as before).
      const { bytes } = await fetchBytesBounded(input.url, {
        maxBytes: X_SIMPLE_UPLOAD_MAX_BYTES,
        maxRedirects: 3,
        validate: (url) => assertPublicHttpUrl(url, { allowHttp: true }),
      });
      if (bytes.byteLength > 0) {
        const mediaId = await uploadMedia(cred, bytes, mimeType);
        const result = await apiV2<XDataResult<{ dm_event_id?: string }>>(cred, 'POST', `dm_conversations/${percentEncode(dmConversationId)}/messages`, {
          jsonBody: { attachments: [{ media_id: mediaId }], ...(input.caption?.trim() ? { text: input.caption.slice(0, 10_000) } : {}) },
        });
        return { message_id: result?.data?.dm_event_id ?? 0 };
      }
    } catch {
      // Fall through to the link fallback below — never lose the message.
    }
  }

  // Video/audio/documents, or an image that failed to fetch/upload: send the
  // link as text rather than dropping the attachment silently.
  const text = [input.caption?.trim(), input.url].filter(Boolean).join('\n').slice(0, 10_000);
  return sendMessage(credential, { chatId: dmConversationId, text });
}

// ── profile (managed inside the X app) ─────────────────────────────────

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

/** Contact avatar: the X user profile image URL, used directly. */
export async function getUserProfilePhotoFileId(credential: BotCredential, userId: string | number): Promise<string | null> {
  try {
    const cred = parseXCredential(credential);
    const result = await apiV2<XDataResult<{ profile_image_url?: unknown }>>(cred, 'GET', `users/${percentEncode(String(userId))}`, {
      query: { 'user.fields': 'profile_image_url' },
    });
    const url = result?.data?.profile_image_url ? String(result.data.profile_image_url) : null;
    return url && /^https:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}
