/**
 * YAHOO MAIL ADAPTER — OAuth2 + IMAP (receive) + SMTP (send), both via
 * XOAUTH2. The ONLY place in the codebase that talks to Yahoo's OAuth
 * endpoints and Yahoo Mail's IMAP/SMTP servers.
 *
 * Unlike Gmail (a REST API Core/Worker both call directly), Yahoo exposes no
 * equivalent REST mail API for third-party apps — the only supported access
 * is IMAP/SMTP with an OAuth2 access token used as the XOAUTH2 credential
 * (RFC 7628 SASL mechanism). `imapflow` and `nodemailer` both implement
 * XOAUTH2 natively (pass `accessToken` instead of a password), so this
 * module is much thinner than Gmail's hand-rolled REST client — it wires
 * those two libraries in rather than reimplementing SASL/MIME.
 *
 * Used from BOTH Core (server/services/channels/yahoo/oauth.ts, for the
 * connect-time token exchange) and the Channels Worker
 * (worker/channels/index.ts, for the poll/send jobs) — `server`, `worker`
 * and `channels` are one TypeScript project (tsconfig.server.json), so this
 * is a normal import on both sides.
 *
 * FIELD-MAPPING NOTE: written against Yahoo's documented OAuth 2.0 token
 * endpoint (HTTP Basic client authentication, per Yahoo's own developer
 * docs — unlike Google's fully form-based token exchange), the OpenID
 * Connect userinfo endpoint, and imapflow/nodemailer's own documented APIs.
 * Could not be verified against a live account from this sandboxed
 * environment (no network access to Yahoo, and no way to complete an
 * interactive OAuth consent flow here). Re-verify on first live test.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import { YahooError } from '../../../server/services/channels/yahoo/types.js';

export const YAHOO_TIMEOUT_MS = 20_000;
export const YAHOO_AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
export const YAHOO_TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
export const YAHOO_USERINFO_URL = 'https://api.login.yahoo.com/openid/v1/userinfo';
export const YAHOO_IMAP_HOST = 'imap.mail.yahoo.com';
export const YAHOO_IMAP_PORT = 993;
export const YAHOO_SMTP_HOST = 'smtp.mail.yahoo.com';
export const YAHOO_SMTP_PORT = 465;

// `mail-r`/`mail-w` are Yahoo Mail's documented read/write scopes; `openid`
// is requested so the userinfo endpoint can resolve the connected address.
export const YAHOO_OAUTH_SCOPES = 'openid mail-r mail-w';

export interface YahooOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface YahooTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
}

export function buildYahooAuthUrl(config: YahooOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: YAHOO_OAUTH_SCOPES,
    state,
  });
  return `${YAHOO_AUTH_URL}?${params.toString()}`;
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
      let body: any = null;
      try { body = await res.json(); } catch { /* ignore */ }
      const reason = typeof body?.error === 'string' ? body.error : '';
      const description = typeof body?.error_description === 'string' ? body.error_description : '';
      const detail = `Yahoo ${res.status} @ ${url.replace(/\?.*$/, '')} — ${[reason, description].filter(Boolean).join(': ') || '(no error detail)'}`;
      console.error(`[yahoo] ${url.replace(/\?.*$/, '')} returned ${res.status}: ${reason || description}`);
      if (reason === 'invalid_grant') throw new YahooError('yahoo_token_revoked', undefined, detail);
      throw new YahooError('yahoo_auth_failed', undefined, detail);
    }
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      const endpoint = url.replace(/\?.*$/, '');
      console.error(`[yahoo] ${endpoint} returned ${res.status}: ${bodyText || '(empty body)'}`);
      throw new YahooError('yahoo_provider_error', undefined, `Yahoo ${res.status} @ ${endpoint} — ${bodyText || '(empty body)'}`);
    }
    try {
      return await res.json();
    } catch {
      throw new YahooError('yahoo_provider_error', undefined, 'Yahoo returned a response that could not be parsed as JSON');
    }
  } catch (err) {
    if (err instanceof YahooError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new YahooError('yahoo_timeout');
    throw new YahooError('yahoo_network_error', undefined, `Could not reach ${url.replace(/\?.*$/, '')}: ${(err as Error)?.message || 'unknown network error'}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface YahooAdapterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createYahooAdapter(config: YahooOAuthConfig, options: YahooAdapterOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? YAHOO_TIMEOUT_MS;
  // Yahoo's token endpoint authenticates the CLIENT via HTTP Basic auth
  // (base64 client_id:client_secret), not a client_secret form field the
  // way Google's does — a deliberate difference from gmail/client.ts.
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  async function exchangeCodeForTokens(code: string): Promise<YahooTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code,
    });
    const json = (await requestJson(YAHOO_TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
    if (!accessToken) throw new YahooError('yahoo_auth_failed');
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
    };
  }

  async function refreshAccessToken(refreshToken: string): Promise<YahooTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      redirect_uri: config.redirectUri,
      refresh_token: refreshToken,
    });
    const json = (await requestJson(YAHOO_TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
    if (!accessToken) throw new YahooError('yahoo_auth_failed');
    return {
      accessToken,
      // Yahoo does not always re-issue a refresh token on refresh — keep the
      // caller's existing one when it doesn't.
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
    };
  }

  async function fetchAccountEmail(accessToken: string): Promise<string | null> {
    try {
      const json = (await requestJson(YAHOO_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, fetchImpl, timeoutMs)) as Record<string, unknown>;
      return typeof json.email === 'string' ? json.email : null;
    } catch {
      return null;
    }
  }

  return { exchangeCodeForTokens, refreshAccessToken, fetchAccountEmail };
}

export type YahooAdapter = ReturnType<typeof createYahooAdapter>;

// ── IMAP polling (inbound) ────────────────────────────────────────────────

export interface YahooAttachmentRef {
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  content: Buffer;
}

export interface YahooParsedMessage {
  uid: number;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  textBody: string | null;
  htmlBody: string | null;
  snippet: string | null;
  date: string | null;
  attachments: YahooAttachmentRef[];
}

function flattenAddresses(addr: AddressObject | AddressObject[] | undefined): string[] {
  if (!addr) return [];
  const objects = Array.isArray(addr) ? addr : [addr];
  const emails: string[] = [];
  for (const obj of objects) {
    for (const entry of obj.value || []) {
      if (entry.address) emails.push(entry.address);
    }
  }
  return emails;
}

function toYahooParsedMessage(uid: number, parsed: ParsedMail): YahooParsedMessage {
  const referencesRaw = parsed.references;
  const references = Array.isArray(referencesRaw) ? referencesRaw : referencesRaw ? [referencesRaw] : [];
  return {
    uid,
    messageIdHeader: parsed.messageId || null,
    inReplyTo: Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo[0] || null : parsed.inReplyTo || null,
    references,
    subject: parsed.subject || null,
    fromAddress: flattenAddresses(parsed.from)[0] || null,
    toAddresses: flattenAddresses(parsed.to),
    ccAddresses: flattenAddresses(parsed.cc),
    bccAddresses: flattenAddresses(parsed.bcc),
    textBody: parsed.text || null,
    htmlBody: typeof parsed.html === 'string' ? parsed.html : null,
    snippet: (parsed.text || '').slice(0, 200) || null,
    date: parsed.date ? parsed.date.toISOString() : null,
    attachments: (parsed.attachments || []).map((att) => ({
      filename: att.filename || 'attachment',
      contentType: att.contentType || 'application/octet-stream',
      sizeBytes: att.size ?? att.content?.byteLength ?? 0,
      contentId: att.cid || att.contentId || null,
      content: att.content,
    })),
  };
}

function classifyImapError(err: unknown): YahooError {
  const message = (err as Error)?.message || 'unknown IMAP error';
  if (/auth/i.test(message)) return new YahooError('yahoo_auth_failed', undefined, message);
  if (/timeout|timed out/i.test(message)) return new YahooError('yahoo_timeout', undefined, message);
  return new YahooError('yahoo_imap_error', undefined, message);
}

/**
 * Fetches messages newer than `sinceUid` (or, with no checkpoint yet, the
 * most recent `maxMessages`) from the INBOX. Returns the highest UID seen so
 * the caller can persist it as the next poll's checkpoint — IMAP UIDs are
 * assigned in strictly increasing order within a mailbox (RFC 3501), so a
 * simple watermark is sufficient (no UID ever reused while the mailbox's
 * UIDVALIDITY stays the same, which this adapter does not currently track —
 * a UIDVALIDITY change is rare, and the worst case is a handful of
 * messages re-synced, harmless given the idempotent upsert on
 * (thread_id, external_message_id)).
 */
export async function pollYahooInbox(
  emailAddress: string,
  accessToken: string,
  opts: { sinceUid?: number | null; maxMessages?: number } = {},
): Promise<{ messages: YahooParsedMessage[]; lastUid: number | null }> {
  const client = new ImapFlow({
    host: YAHOO_IMAP_HOST,
    port: YAHOO_IMAP_PORT,
    secure: true,
    auth: { user: emailAddress, accessToken },
    logger: false,
  });

  const messages: YahooParsedMessage[] = [];
  let lastUid: number | null = opts.sinceUid ?? null;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uidsToFetch: number[];
      if (opts.sinceUid) {
        uidsToFetch = await client.search({ uid: `${opts.sinceUid + 1}:*` }, { uid: true });
      } else {
        const maxMessages = opts.maxMessages ?? 25;
        const exists = client.mailbox && typeof client.mailbox === 'object' ? (client.mailbox as any).exists ?? 0 : 0;
        const startSeq = Math.max(1, exists - maxMessages + 1);
        uidsToFetch = exists > 0 ? await client.search({ seq: `${startSeq}:*` }, { uid: true }) : [];
      }

      for (const uid of uidsToFetch) {
        const message = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        if (!message || !(message as any).source) continue;
        const parsed = await simpleParser((message as any).source as Buffer);
        messages.push(toYahooParsedMessage(uid, parsed));
        if (lastUid === null || uid > lastUid) lastUid = uid;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    try { await client.close(); } catch { /* best-effort */ }
    throw classifyImapError(err);
  }

  return { messages, lastUid };
}

// ── SMTP send (outbound) ────────────────────────────────────────────────

export interface YahooOutboundMessage {
  fromEmail: string;
  fromName?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
  /**
   * Forces this exact Message-ID header instead of letting nodemailer
   * generate one — Core pre-generates and stores the id as
   * `email_messages.external_message_id` at compose time (before the
   * Worker ever runs), so the sent message must carry the SAME id rather
   * than whatever nodemailer would auto-assign.
   */
  messageId?: string;
}

export async function sendViaYahooSmtp(accessToken: string, msg: YahooOutboundMessage): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: YAHOO_SMTP_HOST,
    port: YAHOO_SMTP_PORT,
    secure: true,
    auth: { type: 'OAuth2', user: msg.fromEmail, accessToken } as any,
  });
  try {
    const info = await transporter.sendMail({
      from: msg.fromName ? { name: msg.fromName, address: msg.fromEmail } : msg.fromEmail,
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      text: msg.text,
      html: msg.html || undefined,
      inReplyTo: msg.inReplyTo || undefined,
      references: msg.references,
      attachments: msg.attachments,
      messageId: msg.messageId || undefined,
    });
    return { messageId: msg.messageId || info.messageId || '' };
  } catch (err) {
    throw new YahooError('yahoo_smtp_error', undefined, (err as Error)?.message);
  } finally {
    transporter.close();
  }
}
