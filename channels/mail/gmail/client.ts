/**
 * GMAIL API + OAUTH ADAPTER
 *
 * The ONLY place in the codebase that talks to Google's OAuth token endpoint
 * and the Gmail API (v1). Used from BOTH Core (`server/services/channels/
 * gmail/oauth.ts`, for the connect-time token exchange + the initial
 * `users.watch` call — the same "Core calls Google directly" shape already
 * used for Search Console, see `server/services/seo/gsc/providers/
 * google.ts`) and the Channels Worker (`worker/channels/index.ts`, for the
 * ongoing `history.list` / `messages.get` / `messages.send` calls a Pub/Sub
 * push or an outbound reply trigger — `server`, `worker` and `channels` are
 * one TypeScript project (see tsconfig.server.json), so this module is a
 * normal import on both sides, not a duplicated copy).
 *
 * Every call is fail-closed: HTTP errors, malformed JSON and timeouts all
 * resolve to a normalized `GmailError`. No credential (client secret,
 * refresh token, access token) is ever placed in an error message, log line
 * or return value.
 *
 * FIELD-MAPPING NOTE: written against the long-stable OAuth 2.0 token
 * endpoint and Gmail API v1 response envelopes as documented by Google. It
 * could not be verified against a live response from this environment
 * (network policy blocks outbound calls to Google's API from this sandbox),
 * so parsing is deliberately defensive — unknown/missing fields fall back to
 * null/empty rather than throwing. Re-verify field names against a real
 * response on first live test.
 */

import { randomBytes } from 'node:crypto';
import { GmailError } from '../../../server/services/channels/gmail/types.js';

export const GMAIL_TIMEOUT_MS = 20_000;
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// gmail.modify: read, mark read/unread, label, trash — NOT send.
// gmail.send: send-only, cannot read the mailbox. Both are needed for a real
// inbox (receive + reply), so both are requested.
export const GMAIL_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
].join(' ');

export interface GmailAdapterOptions {
  /** Test seam — injects a fake fetch. Production leaves this undefined. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GmailTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string | null;
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      let body: { error?: unknown; error_description?: unknown } | null = null;
      try { body = (await res.json()) as typeof body; } catch { /* ignore */ }
      // Two different Google error envelopes share this 401/403 branch: the
      // OAuth token endpoint's flat { error, error_description }, and every
      // Gmail API resource call's structured { error: { code, message,
      // status, errors: [...] } }.
      const flatReason = typeof body?.error === 'string' ? body.error : '';
      const flatDescription = typeof body?.error_description === 'string' ? body.error_description : '';
      const structured = (body?.error ?? null) as { message?: unknown; status?: unknown } | null;
      const structuredMessage = typeof structured?.message === 'string' ? structured.message : null;
      const structuredStatus = typeof structured?.status === 'string' ? structured.status : null;
      const reasonText =
        structuredMessage || structuredStatus ||
        [flatReason, flatDescription].filter(Boolean).join(': ') ||
        '(no error detail in response body)';
      const endpoint = url.replace(/\?.*$/, '');
      const detail = `Google ${res.status} @ ${endpoint} — ${reasonText}`;
      if (flatReason === 'invalid_grant') throw new GmailError('gmail_token_revoked', undefined, detail);
      console.error(`[gmail] ${endpoint} returned ${res.status}: ${reasonText}`);
      if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reasonText)) {
        throw new GmailError('gmail_insufficient_scope', undefined, detail);
      }
      throw new GmailError('gmail_auth_failed', undefined, detail);
    }
    if (res.status === 429) throw new GmailError('gmail_rate_limited');
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      const endpoint = url.replace(/\?.*$/, '');
      console.error(`[gmail] ${endpoint} returned ${res.status}: ${bodyText || '(empty body)'}`);
      throw new GmailError('gmail_provider_error', undefined, `Gmail ${res.status} @ ${endpoint} — ${bodyText || '(empty body)'}`);
    }
    if (res.status === 204) return {};
    try {
      return await res.json();
    } catch {
      throw new GmailError('gmail_provider_error', undefined, 'Gmail returned a response that could not be parsed as JSON');
    }
  } catch (err) {
    if (err instanceof GmailError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new GmailError('gmail_timeout');
    throw new GmailError('gmail_network_error', undefined, `Could not reach ${url.replace(/\?.*$/, '')}: ${(err as Error)?.message || 'unknown network error'}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildGmailAuthUrl(config: GmailOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GMAIL_OAUTH_SCOPES,
    access_type: 'offline',
    // Forces Google to re-issue a refresh_token even on a reconnect.
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ── base64url helpers (Gmail uses URL-safe base64 everywhere, not RFC 4648 std) ──

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── MIME parsing (inbound) ────────────────────────────────────────────────

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailAttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Present only for inline/cid-referenced parts (e.g. images in html_body). */
  contentId: string | null;
}

export interface ParsedGmailMessage {
  id: string;
  threadId: string;
  historyId: string | null;
  internalDate: string | null;
  subject: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  textBody: string | null;
  htmlBody: string | null;
  snippet: string | null;
  attachments: GmailAttachmentRef[];
  labelIds: string[];
}

function getHeader(headers: GmailHeader[], name: string): string | null {
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

/**
 * Decodes an RFC 2047 encoded-word ("=?UTF-8?B?...?=" / "=?UTF-8?Q?...?=")
 * that may appear inside a Subject or a display name. Defensive: any
 * unrecognized form is returned unchanged rather than throwing.
 */
function decodeMimeWords(value: string): string {
  // An encoded-word can smuggle CR/LF/NUL bytes into what is later re-used
  // as a header value (e.g. the reply Subject); flatten them to spaces.
  return stripHeaderBreaks(decodeMimeWordsRaw(value));
}

function decodeMimeWordsRaw(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_m, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString(charset.toLowerCase().includes('utf') ? 'utf8' : 'latin1');
      }
      // Q-encoding: '_' is a space, '=XX' is a hex byte.
      const withSpaces = text.replace(/_/g, ' ');
      const bytes = withSpaces.replace(/=([0-9A-Fa-f]{2})/g, (_mm: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, 'latin1').toString(charset.toLowerCase().includes('utf') ? 'utf8' : 'latin1');
    } catch {
      return text;
    }
  });
}

/**
 * Splits a comma-separated address-list header into individual `email` or
 * `"Name" <email>` strings, respecting quoted strings and angle brackets so
 * a display name containing a literal comma is not split incorrectly.
 */
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let angleDepth = 0;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && ch === '<') angleDepth++;
    if (!inQuotes && ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (ch === ',' && !inQuotes && angleDepth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.map((entry) => decodeMimeWords(entry));
}

function parseAddressHeader(headers: GmailHeader[], name: string): string[] {
  const raw = getHeader(headers, name);
  if (!raw) return [];
  return splitAddressList(raw);
}

interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayloadPart[];
}

function walkParts(
  part: GmailPayloadPart,
  acc: { textBody: string[]; htmlBody: string[]; attachments: GmailAttachmentRef[] },
): void {
  const mimeType = part.mimeType || '';
  const filename = part.filename || '';

  if (mimeType.startsWith('multipart/')) {
    for (const child of part.parts || []) walkParts(child, acc);
    return;
  }

  // An attachment is any part carrying a filename OR an attachmentId with no
  // inline text/html role — Gmail's own convention (RFC 2183 Content-Disposition
  // is not reliably present in Gmail's simplified header set).
  if (filename && part.body?.attachmentId) {
    const contentIdHeader = part.headers ? getHeader(part.headers, 'Content-ID') : null;
    acc.attachments.push({
      attachmentId: part.body.attachmentId,
      filename,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: typeof part.body.size === 'number' ? part.body.size : 0,
      contentId: contentIdHeader ? contentIdHeader.replace(/^<|>$/g, '') : null,
    });
    return;
  }

  if (mimeType === 'text/plain' && part.body?.data) {
    acc.textBody.push(base64UrlDecode(part.body.data).toString('utf8'));
    return;
  }
  if (mimeType === 'text/html' && part.body?.data) {
    acc.htmlBody.push(base64UrlDecode(part.body.data).toString('utf8'));
    return;
  }
  // A part with a body but no recognized role and no filename — most often a
  // top-level single-part text/plain message with no explicit Content-Type
  // sub-parts. Fall back to treating base64 body data as plain text.
  if (!filename && part.body?.data && !mimeType.startsWith('image/') && !mimeType.startsWith('application/')) {
    acc.textBody.push(base64UrlDecode(part.body.data).toString('utf8'));
  }
}

export function parseGmailMessage(raw: Record<string, unknown>): ParsedGmailMessage {
  const payload = (raw.payload || {}) as GmailPayloadPart;
  const headers = (payload.headers || []) as GmailHeader[];
  const acc = { textBody: [] as string[], htmlBody: [] as string[], attachments: [] as GmailAttachmentRef[] };
  walkParts(payload, acc);

  const referencesRaw = getHeader(headers, 'References');
  const subjectRaw = getHeader(headers, 'Subject');

  return {
    id: String(raw.id ?? ''),
    threadId: String(raw.threadId ?? ''),
    historyId: typeof raw.historyId === 'string' ? raw.historyId : raw.historyId != null ? String(raw.historyId) : null,
    internalDate: typeof raw.internalDate === 'string' ? raw.internalDate : null,
    subject: subjectRaw ? decodeMimeWords(subjectRaw) : null,
    fromAddress: parseAddressHeader(headers, 'From')[0] ?? null,
    toAddresses: parseAddressHeader(headers, 'To'),
    ccAddresses: parseAddressHeader(headers, 'Cc'),
    bccAddresses: parseAddressHeader(headers, 'Bcc'),
    messageIdHeader: getHeader(headers, 'Message-ID'),
    inReplyTo: getHeader(headers, 'In-Reply-To'),
    references: referencesRaw ? referencesRaw.split(/\s+/).filter(Boolean) : [],
    textBody: acc.textBody.length ? acc.textBody.join('\n') : null,
    htmlBody: acc.htmlBody.length ? acc.htmlBody.join('\n') : null,
    snippet: typeof raw.snippet === 'string' ? raw.snippet : null,
    attachments: acc.attachments,
    labelIds: Array.isArray(raw.labelIds) ? (raw.labelIds as unknown[]).map(String) : [],
  };
}

// ── MIME building (outbound) ──────────────────────────────────────────────

/**
 * Header-injection guard: CR, LF and NUL can never appear inside a header
 * value (a bare CRLF would start a new header — Bcc:, a forged From:, or a
 * whole injected MIME body). Every value placed into a header line passes
 * through here; line breaks become a single space.
 */
export function stripHeaderBreaks(value: string): string {
  return String(value ?? '').replace(/[\r\n\0]+/g, ' ');
}

/** Builds one `Name: value` header line with the value sanitized. */
function headerLine(name: string, value: string): string {
  return `${name}: ${stripHeaderBreaks(value)}`;
}

/** Splits a string into chunks of at most `maxBytes` UTF-8 bytes without breaking a code point. */
function utf8Chunks(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of value) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + bytes > maxBytes && current) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * RFC 2047-encodes a header value (after stripping CR/LF/NUL) when it
 * contains non-ASCII or control characters, an encoded-word lookalike, or —
 * with `encodeSpecials` — any RFC 5322 `specials` (needed for display names,
 * where `"`, `<`, `,` … would otherwise change how the address list parses).
 * Long values are split into several encoded-words joined by folding
 * whitespace, keeping each word within the RFC 2047 75-character limit.
 */
export function encodeHeaderWord(value: string, opts: { encodeSpecials?: boolean } = {}): string {
  const clean = stripHeaderBreaks(value);
  const needsEncoding =
    /[^\x20-\x7E\t]/.test(clean) ||
    clean.includes('=?') ||
    (opts.encodeSpecials === true && /[()<>[\]:;@\\,."]/.test(clean));
  if (!needsEncoding) return clean;
  return utf8Chunks(clean, 45)
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

/** An addr-spec with anything that could break out of `<...>` removed. */
function sanitizeEmail(email: string): string {
  return stripHeaderBreaks(email).replace(/[<>\s,;"]/g, '');
}

/** A msg-id list entry (`<id@host>`): no whitespace or line breaks inside. */
function sanitizeMessageId(id: string): string {
  return stripHeaderBreaks(id).replace(/\s+/g, '');
}

/** MIME type for a Content-Type header: `type/subtype` token only. */
function sanitizeContentType(value: string | null | undefined): string {
  const v = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(v) ? v : 'application/octet-stream';
}

/** Drops C0 control characters (U+0000–U+001F) and DEL (U+007F). */
function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) out += value[i];
  }
  return out;
}

/**
 * `name="…"` / `filename="…"` MIME parameters. The quoted form escapes `\`
 * and `"`; non-ASCII names additionally get an RFC 2231 `*=UTF-8''…` form
 * (with an ASCII fallback in the quoted one) so clients show the real name.
 */
export function mimeFilenameParams(param: 'name' | 'filename', filename: string): string {
  const clean = stripControlChars(stripHeaderBreaks(filename)).trim() || 'attachment';
  const ascii = clean.replace(/[^\x20-\x7E]/g, '_');
  const quoted = `${param}="${ascii.replace(/[\\"]/g, '\\$&')}"`;
  if (ascii === clean) return quoted;
  const extended = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${quoted}; ${param}*=UTF-8''${extended}`;
}

export interface GmailAddress {
  name?: string | null;
  email: string;
}

function formatAddress(addr: GmailAddress): string {
  const email = sanitizeEmail(addr.email);
  const name = addr.name ? stripHeaderBreaks(addr.name).trim() : '';
  if (!name) return email;
  return `${encodeHeaderWord(name, { encodeSpecials: true })} <${email}>`;
}

export function generateGmailMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || 'localhost';
  return `<${randomBytes(16).toString('hex')}.${Date.now()}@${domain}>`;
}

export interface GmailOutboundAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface GmailOutboundMessage {
  from: GmailAddress;
  to: GmailAddress[];
  cc?: GmailAddress[];
  bcc?: GmailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: GmailOutboundAttachment[];
  messageId?: string;
}

/**
 * Builds a base64url-encoded RFC 2822 message ready for `users.messages.send`.
 *
 * Structure: multipart/mixed(attachments) wrapping multipart/alternative
 * (text/plain, text/html) when both an HTML body and attachments are
 * present; multipart/alternative alone when there are no attachments; a
 * single text/plain part in the rare case no HTML body was supplied at all.
 */
export function buildRawGmailMessage(msg: GmailOutboundMessage): { raw: string; messageId: string } {
  const messageId = msg.messageId || generateGmailMessageId(msg.from.email);
  const boundaryMixed = `mixed_${randomBytes(12).toString('hex')}`;
  const boundaryAlt = `alt_${randomBytes(12).toString('hex')}`;

  // Every value is sanitized by headerLine()/encodeHeaderWord(): no header
  // value can contain a CR/LF/NUL, so no caller-supplied field can inject a
  // header or a body part. The only CRLFs inside a line are the RFC 5322
  // folding whitespace that encodeHeaderWord() emits between encoded-words.
  const references = (msg.references ?? []).map(sanitizeMessageId).filter(Boolean);
  const inReplyTo = msg.inReplyTo ? sanitizeMessageId(msg.inReplyTo) : '';
  const headerLines: string[] = [
    headerLine('From', formatAddress(msg.from)),
    headerLine('To', msg.to.map(formatAddress).join(', ')),
  ];
  if (msg.cc?.length) headerLines.push(headerLine('Cc', msg.cc.map(formatAddress).join(', ')));
  if (msg.bcc?.length) headerLines.push(headerLine('Bcc', msg.bcc.map(formatAddress).join(', ')));
  headerLines.push(`Subject: ${encodeHeaderWord(msg.subject)}`);
  headerLines.push(headerLine('Date', new Date().toUTCString()));
  headerLines.push(headerLine('Message-ID', sanitizeMessageId(messageId)));
  if (inReplyTo) headerLines.push(headerLine('In-Reply-To', inReplyTo));
  if (references.length) headerLines.push(headerLine('References', references.join(' ')));
  headerLines.push('MIME-Version: 1.0');

  const altPart = [
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64UrlToStdChunked(msg.textBody),
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64UrlToStdChunked(msg.htmlBody || textToHtmlFallback(msg.textBody)),
    `--${boundaryAlt}--`,
  ].join('\r\n');

  const attachments = msg.attachments || [];
  if (attachments.length === 0) {
    const body = [
      `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
      '',
      altPart,
    ].join('\r\n');
    const full = `${headerLines.join('\r\n')}\r\n${body}`;
    return { raw: base64UrlEncode(Buffer.from(full, 'utf8')), messageId };
  }

  const attachmentParts = attachments
    .map((att) =>
      [
        `--${boundaryMixed}`,
        `Content-Type: ${sanitizeContentType(att.contentType)}; ${mimeFilenameParams('name', att.filename)}`,
        `Content-Disposition: attachment; ${mimeFilenameParams('filename', att.filename)}`,
        'Content-Transfer-Encoding: base64',
        '',
        chunkBase64(att.bytes.toString('base64')),
      ].join('\r\n'),
    )
    .join('\r\n');

  const body = [
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    '',
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    '',
    altPart,
    attachmentParts,
    `--${boundaryMixed}--`,
  ].join('\r\n');

  const full = `${headerLines.join('\r\n')}\r\n${body}`;
  return { raw: base64UrlEncode(Buffer.from(full, 'utf8')), messageId };
}

function chunkBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

function base64UrlToStdChunked(text: string): string {
  return chunkBase64(Buffer.from(text, 'utf8').toString('base64'));
}

/** Minimal plain->html fallback when a caller supplies only a text body. */
function textToHtmlFallback(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div>${escaped.replace(/\n/g, '<br>')}</div>`;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export interface GmailHistoryResult {
  historyId: string | null;
  messageIds: string[];
  /** True when Google reports the requested startHistoryId is too old
   *  (410/404-shaped "historyId too old") — the caller must fall back to a
   *  fresh `messages.list` resync instead of retrying history.list. */
  expired: boolean;
}

export function createGmailAdapter(config: GmailOAuthConfig, options: GmailAdapterOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GMAIL_TIMEOUT_MS;

  async function exchangeCodeForTokens(code: string): Promise<GmailTokenResponse> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    });
    const json = (await requestJson(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
    if (!accessToken) throw new GmailError('gmail_auth_failed');
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
      scope: typeof json.scope === 'string' ? json.scope : null,
    };
  }

  async function refreshAccessToken(refreshToken: string): Promise<GmailTokenResponse> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const json = (await requestJson(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
    if (!accessToken) throw new GmailError('gmail_auth_failed');
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
      scope: typeof json.scope === 'string' ? json.scope : null,
    };
  }

  async function revokeToken(token: string): Promise<void> {
    try {
      await fetchImpl(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
    } catch {
      // Best-effort: the local integration row is torn down regardless.
    }
  }

  async function fetchAccountEmail(accessToken: string): Promise<string | null> {
    try {
      const json = (await requestJson(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, fetchImpl, timeoutMs)) as Record<string, unknown>;
      return typeof json.email === 'string' ? json.email : null;
    } catch {
      return null;
    }
  }

  /**
   * Subscribes the mailbox to Cloud Pub/Sub push notifications. `topicName`
   * is the fully-qualified topic (`projects/<project>/topics/<topic>`) the
   * operator created per SELF_HOST_GUIDE.md. Watches expire after 7 days —
   * `gmailWatchRenewalTicker.ts` re-calls this before expiry.
   */
  async function watchMailbox(
    accessToken: string,
    topicName: string,
  ): Promise<{ historyId: string; expiration: string }> {
    const json = (await requestJson(`${GMAIL_API_BASE}/watch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterAction: 'include' }),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const historyId = json.historyId != null ? String(json.historyId) : null;
    const expiration = json.expiration != null ? String(json.expiration) : null;
    if (!historyId || !expiration) throw new GmailError('gmail_watch_failed');
    return { historyId, expiration };
  }

  async function stopWatch(accessToken: string): Promise<void> {
    try {
      await requestJson(`${GMAIL_API_BASE}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }, fetchImpl, timeoutMs);
    } catch {
      // Best-effort — disconnect proceeds regardless (Google also expires
      // an orphaned watch on its own after 7 days).
    }
  }

  async function listHistorySince(accessToken: string, startHistoryId: string): Promise<GmailHistoryResult> {
    const messageIds = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId: string | null = null;

    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: 'messageAdded',
        labelId: 'INBOX',
        maxResults: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);

      let json: Record<string, unknown>;
      try {
        json = (await requestJson(`${GMAIL_API_BASE}/history?${params.toString()}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }, fetchImpl, timeoutMs)) as Record<string, unknown>;
      } catch (err) {
        // Gmail returns 404 with a "Requested entity was not found" style
        // message when startHistoryId has fallen outside the retention
        // window (~1 week) — the only recoverable signal in this call.
        if (err instanceof GmailError && err.code === 'gmail_provider_error' && /404/.test(err.detail || '')) {
          return { historyId: null, messageIds: [], expired: true };
        }
        throw err;
      }

      if (typeof json.historyId === 'string') latestHistoryId = json.historyId;
      const history = Array.isArray(json.history) ? json.history : [];
      for (const entry of history as Record<string, unknown>[]) {
        const added = Array.isArray(entry.messagesAdded) ? entry.messagesAdded : [];
        for (const item of added as Record<string, unknown>[]) {
          const id = (item.message as Record<string, unknown> | undefined)?.id;
          if (typeof id === 'string') messageIds.add(id);
        }
      }
      pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : undefined;
      if (!pageToken) break;
    }

    return { historyId: latestHistoryId, messageIds: Array.from(messageIds), expired: false };
  }

  /** Fallback resync — the most recent INBOX messages, used when history has expired. */
  async function listRecentInboxMessageIds(accessToken: string, maxResults = 50): Promise<string[]> {
    const params = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(maxResults) });
    const json = (await requestJson(`${GMAIL_API_BASE}/messages?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const messages = Array.isArray(json.messages) ? json.messages : [];
    return (messages as Record<string, unknown>[])
      .map((m) => (typeof m.id === 'string' ? m.id : null))
      .filter((id): id is string => !!id);
  }

  /** Current mailbox historyId — used to seed a fresh watch/resync baseline. */
  async function getProfileHistoryId(accessToken: string): Promise<string | null> {
    const json = (await requestJson(`${GMAIL_API_BASE}/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    return json.historyId != null ? String(json.historyId) : null;
  }

  async function getMessage(accessToken: string, messageId: string): Promise<ParsedGmailMessage> {
    const json = (await requestJson(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    return parseGmailMessage(json);
  }

  async function getAttachmentBytes(accessToken: string, messageId: string, attachmentId: string): Promise<Buffer> {
    const json = (await requestJson(
      `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      fetchImpl,
      timeoutMs,
    )) as Record<string, unknown>;
    const data = typeof json.data === 'string' ? json.data : '';
    return base64UrlDecode(data);
  }

  async function sendMessage(
    accessToken: string,
    outbound: GmailOutboundMessage,
    threadId?: string | null,
  ): Promise<{ gmailId: string; threadId: string; messageId: string }> {
    const { raw, messageId } = buildRawGmailMessage(outbound);
    const json = (await requestJson(`${GMAIL_API_BASE}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    return {
      gmailId: String(json.id ?? ''),
      threadId: String(json.threadId ?? threadId ?? ''),
      messageId,
    };
  }

  return {
    exchangeCodeForTokens,
    refreshAccessToken,
    revokeToken,
    fetchAccountEmail,
    watchMailbox,
    stopWatch,
    listHistorySince,
    listRecentInboxMessageIds,
    getProfileHistoryId,
    getMessage,
    getAttachmentBytes,
    sendMessage,
  };
}

export type GmailAdapter = ReturnType<typeof createGmailAdapter>;
