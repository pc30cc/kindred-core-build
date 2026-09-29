/**
 * GMAIL LIVE INBOX — reads the mailbox from Gmail on demand; stores no email
 * content on our side.
 *
 * Gmail is the source of truth. Nothing here writes a subject, body, snippet,
 * address or attachment to the database, storage or logs: the thread list is
 * `users.threads.list` + `threads.get?format=metadata`, a thread is
 * `threads.get?format=full` when it is opened, attachments are streamed
 * straight from `messages.attachments.get`, read/star are Gmail labels, and a
 * reply is sent with `messages.send` in the request that composes it. The only
 * rows kept are the connection itself and its sync cursor (`gmail_history_id`
 * in `channel_integrations.metadata`). Requirements:
 * docs/EMAIL_INBOX_ARCHITECTURE.md.
 *
 * Every entry point is called after the route has authorized the caller for
 * the workspace; the in-flight de-duplication below only shares a Gmail call
 * between callers that were each authorized for the same integration.
 */
import type { ServerConfig } from '../../config.js';
import { updateIntegration, type ChannelIntegration } from '../channels/integrations.js';
import { createHash } from 'node:crypto';
import { getGmailAccessToken, evictGmailAccessToken } from '../channels/gmail/oauth.js';
import { getGmailOAuthConfig } from '../channels/gmail/oauthConfig.js';
import { GmailError } from '../channels/gmail/types.js';
import {
  createGmailAdapter,
  parseGmailMessage,
  type GmailAdapter,
  type ParsedGmailMessage,
} from '../../../channels/mail/gmail/client.js';

export class GmailLiveError extends Error {
  constructor(
    readonly code: 'email_thread_not_found' | 'email_attachment_not_found' | 'email_provider_error' | 'email_not_connected' | 'email_rate_limited',
    message?: string,
  ) {
    super(message || code);
    this.name = 'GmailLiveError';
  }
}

export interface LiveThreadSummary {
  id: string;
  provider: 'gmail';
  subject: string | null;
  participants: Array<{ email: string }>;
  lastMessageAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  lastMessageSnippet: string | null;
  /** Gmail's thread historyId: a client's cached body is valid while this is unchanged. */
  historyId: string | null;
  messageCount: number;
}

export interface LiveAttachmentView {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  contentId: string | null;
  /** The same signed-in API path as downloadPath (nothing public exists for Gmail mail). */
  url: string;
  downloadPath: string;
}

export interface LiveMessageView {
  id: string;
  externalMessageId: string;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  toAddresses: Array<{ email: string }>;
  ccAddresses: Array<{ email: string }>;
  bccAddresses: Array<{ email: string }>;
  textBody: string | null;
  htmlBody: string | null;
  snippet: string | null;
  isRead: boolean;
  deliveryStatus: 'sent';
  deliveryError: null;
  sentAt: string;
  attachments: LiveAttachmentView[];
}

const LIST_METADATA_HEADERS = ['From', 'To', 'Subject', 'Date'];
const METADATA_CONCURRENCY = 8;

function adapter(): GmailAdapter {
  const cfg = getGmailOAuthConfig();
  // A platform without Google OAuth configured is an outage, not this mailbox's fault.
  if (!cfg) throw new GmailLiveError('email_provider_error', 'gmail_not_configured');
  return createGmailAdapter(cfg);
}

// ─── In-flight de-duplication (single-flight) ──────────────────────────
//
// Concurrent identical reads for the same mailbox (two tabs, a web tab and
// the phone, a burst of realtime-triggered refreshes) share one Gmail call.
// Nothing is cached after the promise settles — this is not a content cache.

const inFlight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// ─── Error mapping ─────────────────────────────────────────────────────
//
// Only a grant that is really gone becomes `email_not_connected` (clients
// drop their device cache on it); quota and rate limits are transient.

/** Gmail thread/message ids are hex; anything else (a legacy UUID) is not one of ours to ask Gmail about. */
const GMAIL_ID = /^[0-9a-f]{1,32}$/i;

function isQuota(err: GmailError): boolean {
  return err.code === 'gmail_rate_limited' || /rate ?limit|quota|limit exceeded/i.test(err.detail || '');
}

/**
 * The user's grant is gone: the refresh token was revoked or expired
 * (token endpoint `invalid_grant`), or the Gmail scope was not granted.
 * Platform-side failures (`invalid_client`, a missing config) are not this.
 */
function isGrantRevoked(err: GmailError): boolean {
  const detail = err.detail || '';
  if (err.code === 'gmail_not_connected' || err.code === 'gmail_token_revoked' || err.code === 'gmail_insufficient_scope') return true;
  return /oauth2\.googleapis\.com\/token/.test(detail) && /invalid_grant/.test(detail);
}

/** Gmail rejected the access token itself (401 from the API, not the token endpoint). */
function isApiUnauthorized(err: unknown): boolean {
  return err instanceof GmailError && err.code === 'gmail_auth_failed' && /^Google 401 @ https:\/\/gmail\.googleapis\.com/.test(err.detail || '');
}

function classify(err: unknown): GmailLiveError {
  if (err instanceof GmailLiveError) return err;
  if (err instanceof GmailError) {
    const detail = err.detail || '';
    if (isQuota(err)) return new GmailLiveError('email_rate_limited');
    if (isGrantRevoked(err) || isApiUnauthorized(err)) return new GmailLiveError('email_not_connected', err.message);
    if (/^Gmail 404\b/.test(detail) || (/^Gmail 400\b/.test(detail) && /invalid id value/i.test(detail))) {
      return new GmailLiveError('email_thread_not_found');
    }
  }
  return new GmailLiveError('email_provider_error', (err as Error)?.message);
}

/**
 * Runs one Gmail operation with an access token and maps its failure.
 *
 * A 401 from Gmail on a cached token (revoked elsewhere, or reissued after a
 * reconnect on another instance) drops that token and retries once with a
 * fresh one. Only a grant the token endpoint itself refuses marks the
 * integration errored, so every app shows the mailbox disconnected and clears
 * its cache instead of retrying.
 */
async function withGmail<T>(
  config: ServerConfig,
  integration: ChannelIntegration,
  run: (ga: GmailAdapter, accessToken: string) => Promise<T>,
): Promise<T> {
  try {
    const ga = adapter();
    try {
      return await run(ga, await getGmailAccessToken(config, integration.installation_id));
    } catch (err) {
      if (!isApiUnauthorized(err)) throw err;
      evictGmailAccessToken(integration.installation_id);
      return await run(ga, await getGmailAccessToken(config, integration.installation_id));
    }
  } catch (err) {
    const mapped = classify(err);
    if (err instanceof GmailError && isGrantRevoked(err)) {
      await updateIntegration(config, integration.id, {
        status: 'error',
        last_error_code: 'gmail_token_revoked',
        last_error_at: new Date().toISOString(),
      }).catch(() => {});
    }
    throw mapped;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof GmailError && /^Gmail 404\b/.test(err.detail || '');
}

/** Bounded fan-out; the first failure stops the remaining work. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        out[index] = await fn(items[index]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function toIso(internalDate: string | null): string | null {
  const ms = Number(internalDate);
  return internalDate && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Messages the inbox shows: not drafts (unsent work), not trashed or spam messages of an inbox thread. */
const HIDDEN_LABELS = ['DRAFT', 'TRASH', 'SPAM'];

function visibleMessages(raw: Record<string, unknown>): ParsedGmailMessage[] {
  const rawMessages = (Array.isArray(raw.messages) ? raw.messages : []) as Record<string, unknown>[];
  return rawMessages.map(parseGmailMessage).filter((m) => !m.labelIds.some((l) => HIDDEN_LABELS.includes(l)));
}

function summarize(raw: Record<string, unknown>, fallbackSnippet: string | null): LiveThreadSummary | null {
  const messages = visibleMessages(raw);
  if (!messages.length) return null;
  const first = messages[0];
  const last = messages[messages.length - 1];
  // Show who wrote to us: the latest message not sent from this mailbox,
  // falling back to the first sender for threads we started.
  const lastInbound = [...messages].reverse().find((m) => !m.labelIds.includes('SENT'));
  const sender = lastInbound?.fromAddress || first.fromAddress;
  const labels = Array.from(new Set(messages.flatMap((m) => m.labelIds)));
  return {
    id: String(raw.id ?? first.threadId),
    provider: 'gmail',
    subject: first.subject,
    participants: sender ? [{ email: sender }] : [],
    lastMessageAt: toIso(last.internalDate),
    isRead: !labels.includes('UNREAD'),
    isStarred: labels.includes('STARRED'),
    labels,
    lastMessageSnippet: last.snippet ?? fallbackSnippet,
    historyId: raw.historyId != null ? String(raw.historyId) : null,
    messageCount: messages.length,
  };
}

// ─── Reads ─────────────────────────────────────────────────────────────

export async function listGmailThreads(
  config: ServerConfig,
  integration: ChannelIntegration,
  opts: { pageToken?: string | null; limit?: number; unreadOnly?: boolean; starredOnly?: boolean; search?: string },
): Promise<{ threads: LiveThreadSummary[]; nextPageToken: string | null; historyId: string | null }> {
  const labelIds = ['INBOX'];
  if (opts.unreadOnly) labelIds.push('UNREAD');
  if (opts.starredOnly) labelIds.push('STARRED');
  const q = opts.search?.trim().slice(0, 200) || null;
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
  const key = `list:${integration.id}:${labelIds.join(',')}:${q ?? ''}:${opts.pageToken ?? ''}:${limit}`;

  return singleFlight(key, () => withGmail(config, integration, async (ga, accessToken) => {
    const page = await ga.listThreads(accessToken, { labelIds, q, pageToken: opts.pageToken, maxResults: limit });
    const threads = await mapWithConcurrency(page.threads, METADATA_CONCURRENCY, async (t) => {
      try {
        const raw = await ga.getThreadRaw(accessToken, t.id, 'metadata', LIST_METADATA_HEADERS);
        return summarize(raw, t.snippet);
      } catch (err) {
        // Deleted between list and get: nothing to show. Anything else fails
        // the page rather than silently dropping rows.
        if (isNotFound(err)) return null;
        throw err;
      }
    });
    const historyId = page.threads.reduce<string | null>((max, t) => {
      if (!t.historyId) return max;
      return !max || Number(t.historyId) > Number(max) ? t.historyId : max;
    }, null);
    return {
      threads: threads.filter((t): t is LiveThreadSummary => !!t),
      nextPageToken: page.nextPageToken,
      historyId,
    };
  }));
}

// Attachment ids: `<hash>-p<partId>~<messageId>`. The MIME part id is stable
// for a message, unlike Gmail's attachmentId, which is reissued on every
// read; the root part of a single-part message has partId "". The short hash
// of both comes first so ids differ from their first characters (Android
// keys its file cache on a 12-character prefix). '~' and '-p' never appear
// in the parts they separate.
function attachmentKey(gmailMessageId: string, partId: string): string {
  const hash = createHash('sha256').update(`${gmailMessageId}:${partId}`).digest('hex').slice(0, 12);
  return `${hash}-p${partId}~${gmailMessageId}`;
}

function parseAttachmentKey(id: string): { gmailMessageId: string; partId: string } | null {
  const match = /^(?:[0-9a-f]{12}-)?p([0-9.]*)~([0-9a-f]{1,32})$/i.exec(id);
  return match ? { partId: match[1], gmailMessageId: match[2] } : null;
}

function attachmentPath(workspaceId: string, id: string): string {
  return `/api/email-inbox/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(id)}/file`;
}

function messageView(workspaceId: string, m: ParsedGmailMessage): LiveMessageView {
  return {
    id: m.id,
    externalMessageId: m.messageIdHeader || `gmail-${m.id}`,
    direction: m.labelIds.includes('SENT') ? 'outbound' : 'inbound',
    fromAddress: m.fromAddress || '',
    toAddresses: m.toAddresses.map((email) => ({ email })),
    ccAddresses: m.ccAddresses.map((email) => ({ email })),
    bccAddresses: m.bccAddresses.map((email) => ({ email })),
    textBody: m.textBody,
    htmlBody: m.htmlBody,
    snippet: m.snippet,
    isRead: !m.labelIds.includes('UNREAD'),
    deliveryStatus: 'sent',
    deliveryError: null,
    sentAt: toIso(m.internalDate) || new Date(0).toISOString(),
    attachments: m.attachments.map((a) => {
      const id = attachmentKey(m.id, a.partId);
      const path = attachmentPath(workspaceId, id);
      return {
        id,
        filename: a.filename,
        contentType: a.mimeType || null,
        sizeBytes: a.sizeBytes ?? null,
        contentId: a.contentId,
        // Apps that only read `url` resolve an /api/ path against their API
        // origin and fetch it signed in; nothing public exists for Gmail mail.
        url: path,
        downloadPath: path,
      };
    }),
  };
}

export async function getGmailThread(
  config: ServerConfig,
  workspaceId: string,
  integration: ChannelIntegration,
  threadId: string,
): Promise<{ thread: LiveThreadSummary; messages: LiveMessageView[] }> {
  if (!GMAIL_ID.test(threadId)) throw new GmailLiveError('email_thread_not_found');
  return singleFlight(`thread:${integration.id}:${threadId}`, () => withGmail(config, integration, async (ga, accessToken) => {
    const raw = await ga.getThreadRaw(accessToken, threadId, 'full');
    const thread = summarize(raw, null);
    if (!thread) throw new GmailLiveError('email_thread_not_found');
    return { thread, messages: visibleMessages(raw).map((m) => messageView(workspaceId, m)) };
  }));
}

/** Attachment bytes streamed from Gmail for one download; never stored. */
export async function getGmailAttachment(
  config: ServerConfig,
  integration: ChannelIntegration,
  compositeId: string,
): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  const key = parseAttachmentKey(compositeId);
  if (!key) return null;
  try {
    return await withGmail(config, integration, async (ga, accessToken) => {
      // Re-read the message for a current attachmentId and the part's name/type.
      const parsed = await ga.getMessage(accessToken, key.gmailMessageId);
      const ref = parsed.attachments.find((a) => a.partId === key.partId);
      if (!ref) return null;
      const data = await ga.getAttachmentBytes(accessToken, key.gmailMessageId, ref.attachmentId);
      return { data, filename: ref.filename || 'attachment', contentType: ref.mimeType || 'application/octet-stream' };
    });
  } catch (err) {
    if (err instanceof GmailLiveError && err.code === 'email_thread_not_found') return null;
    throw err;
  }
}

// ─── Label writes (Gmail is the store for read/star) ───────────────────

export async function setGmailThreadRead(config: ServerConfig, integration: ChannelIntegration, threadId: string, isRead: boolean): Promise<void> {
  if (!GMAIL_ID.test(threadId)) throw new GmailLiveError('email_thread_not_found');
  await withGmail(config, integration, (ga, accessToken) =>
    ga.modifyThread(accessToken, threadId, isRead ? [] : ['UNREAD'], isRead ? ['UNREAD'] : []));
}

export async function setGmailThreadStarred(config: ServerConfig, integration: ChannelIntegration, threadId: string, starred: boolean): Promise<void> {
  if (!GMAIL_ID.test(threadId)) throw new GmailLiveError('email_thread_not_found');
  await withGmail(config, integration, (ga, accessToken) =>
    ga.modifyThread(accessToken, threadId, starred ? ['STARRED'] : [], starred ? [] : ['STARRED']));
}

// ─── Incremental changes ───────────────────────────────────────────────

/**
 * Thread ids changed since the client's cursor: `threadIds` for any change,
 * `contentThreadIds` for those whose messages were added or removed (only
 * these invalidate a cached body; label changes such as read/star do not).
 * `reset` means the cursor is too old (or the delta too large): the client
 * reloads page one.
 */
export async function listGmailChanges(
  config: ServerConfig,
  integration: ChannelIntegration,
  sinceHistoryId: string,
): Promise<{ historyId: string | null; threadIds: string[]; contentThreadIds: string[]; reset: boolean }> {
  return singleFlight(`changes:${integration.id}:${sinceHistoryId}`, () => withGmail(config, integration, async (ga, accessToken) => {
    const result = await ga.listChangedThreadIds(accessToken, sinceHistoryId);
    if (result.expired || result.truncated) {
      return { historyId: await ga.getProfileHistoryId(accessToken), threadIds: [], contentThreadIds: [], reset: true };
    }
    return {
      historyId: result.historyId ?? sinceHistoryId,
      threadIds: result.threadIds,
      contentThreadIds: result.contentThreadIds,
      reset: false,
    };
  }));
}

// ─── Send (synchronous; the reply exists only in the request) ──────────

export interface GmailSendInput {
  /** Client-chosen key for this reply: a retry with the same key within SEND_REPLAY_MS gets the first result, not a second email. */
  clientRequestId?: string | null;
  threadId: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  attachments?: Array<{ filename: string; contentType: string; bytes: Buffer }>;
}

// A send the client gave up on (timeout, dropped connection) may still have
// gone out; its retry must not send the mail twice. Results are kept by
// client request id for a few minutes, in this process only — ids, not content.
const SEND_REPLAY_MS = 10 * 60 * 1000;
const recentSends = new Map<string, { at: number; result: Promise<{ messageId: string; threadId: string }> }>();

export async function sendGmail(
  config: ServerConfig,
  integration: ChannelIntegration,
  input: GmailSendInput,
  subjectForReply: (subject: string) => string,
): Promise<{ messageId: string; threadId: string }> {
  const now = Date.now();
  for (const [key, entry] of recentSends) if (now - entry.at > SEND_REPLAY_MS) recentSends.delete(key);
  const replayKey = input.clientRequestId ? `${integration.id}:${input.clientRequestId}` : null;
  const previous = replayKey ? recentSends.get(replayKey) : undefined;
  if (previous) return previous.result;
  const result = sendGmailOnce(config, integration, input, subjectForReply);
  if (replayKey) {
    recentSends.set(replayKey, { at: now, result });
    // A definite failure may be retried for real.
    result.catch(() => recentSends.delete(replayKey));
  }
  return result;
}

async function sendGmailOnce(
  config: ServerConfig,
  integration: ChannelIntegration,
  input: GmailSendInput,
  subjectForReply: (subject: string) => string,
): Promise<{ messageId: string; threadId: string }> {
  const fromEmail = integration.external_account_id;
  if (!fromEmail) throw new GmailLiveError('email_not_connected');
  if (input.threadId && !GMAIL_ID.test(input.threadId)) throw new GmailLiveError('email_thread_not_found');
  return withGmail(config, integration, async (ga, accessToken) => {
    let subject = input.subject;
    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (input.threadId) {
      const raw = await ga.getThreadRaw(accessToken, input.threadId, 'metadata', ['Subject', 'Message-ID', 'References']);
      const messages = visibleMessages(raw);
      const last = messages[messages.length - 1];
      if (!last) throw new GmailLiveError('email_thread_not_found');
      subject = subjectForReply(messages[0].subject || input.subject);
      inReplyTo = last.messageIdHeader;
      references = [...last.references, ...(last.messageIdHeader ? [last.messageIdHeader] : [])];
    }
    const sent = await ga.sendMessage(accessToken, {
      from: { email: fromEmail },
      to: input.to.map((email) => ({ email })),
      cc: (input.cc ?? []).map((email) => ({ email })),
      bcc: (input.bcc ?? []).map((email) => ({ email })),
      subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody ?? null,
      inReplyTo,
      references,
      attachments: input.attachments,
    }, input.threadId);
    return { messageId: sent.gmailId, threadId: sent.threadId };
  });
}
