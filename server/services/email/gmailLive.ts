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
import type { ChannelIntegration } from '../channels/integrations.js';
import { getGmailAccessToken } from '../channels/gmail/oauth.js';
import { getGmailOAuthConfig } from '../channels/gmail/oauthConfig.js';
import { GmailError } from '../channels/gmail/types.js';
import {
  createGmailAdapter,
  parseGmailMessage,
  type GmailAdapter,
  type ParsedGmailMessage,
} from '../../../channels/mail/gmail/client.js';

export class GmailLiveError extends Error {
  constructor(readonly code: 'email_thread_not_found' | 'email_attachment_not_found' | 'email_provider_error' | 'email_not_connected', message?: string) {
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
  url: null;
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
  if (!cfg) throw new GmailLiveError('email_not_connected');
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

function toGmailError(err: unknown): never {
  if (err instanceof GmailLiveError) throw err;
  if (err instanceof GmailError) {
    if (err.code === 'gmail_not_connected' || err.code === 'gmail_auth_failed') throw new GmailLiveError('email_not_connected', err.message);
    if (/^Gmail 404\b/.test(err.detail || '') || /404/.test(err.detail || '')) throw new GmailLiveError('email_thread_not_found');
  }
  throw new GmailLiveError('email_provider_error', (err as Error)?.message);
}

async function tokenFor(config: ServerConfig, integration: ChannelIntegration): Promise<string> {
  return getGmailAccessToken(config, integration.installation_id);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function toIso(internalDate: string | null): string | null {
  const ms = Number(internalDate);
  return internalDate && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function summarize(raw: Record<string, unknown>, fallbackSnippet: string | null): LiveThreadSummary | null {
  const rawMessages = (Array.isArray(raw.messages) ? raw.messages : []) as Record<string, unknown>[];
  if (!rawMessages.length) return null;
  const messages = rawMessages.map(parseGmailMessage);
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

  return singleFlight(key, async () => {
    try {
      const ga = adapter();
      const accessToken = await tokenFor(config, integration);
      const page = await ga.listThreads(accessToken, { labelIds, q, pageToken: opts.pageToken, maxResults: limit });
      const threads = await mapWithConcurrency(page.threads, METADATA_CONCURRENCY, async (t) => {
        try {
          const raw = await ga.getThreadRaw(accessToken, t.id, 'metadata', LIST_METADATA_HEADERS);
          return summarize(raw, t.snippet);
        } catch {
          return null; // deleted between list and get
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
    } catch (err) {
      toGmailError(err);
    }
  });
}

function attachmentPath(workspaceId: string, gmailMessageId: string, attachmentId: string): string {
  // Gmail ids are base64url, which never contains '.', so it can join them.
  const id = `${gmailMessageId}.${attachmentId}`;
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
    attachments: m.attachments.map((a) => ({
      id: `${m.id}.${a.attachmentId}`,
      filename: a.filename,
      contentType: a.mimeType || null,
      sizeBytes: a.sizeBytes ?? null,
      contentId: a.contentId,
      url: null,
      downloadPath: attachmentPath(workspaceId, m.id, a.attachmentId),
    })),
  };
}

export async function getGmailThread(
  config: ServerConfig,
  workspaceId: string,
  integration: ChannelIntegration,
  threadId: string,
): Promise<{ thread: LiveThreadSummary; messages: LiveMessageView[] }> {
  return singleFlight(`thread:${integration.id}:${threadId}`, async () => {
    try {
      const ga = adapter();
      const accessToken = await tokenFor(config, integration);
      const raw = await ga.getThreadRaw(accessToken, threadId, 'full');
      const thread = summarize(raw, null);
      if (!thread) throw new GmailLiveError('email_thread_not_found');
      const rawMessages = (Array.isArray(raw.messages) ? raw.messages : []) as Record<string, unknown>[];
      return { thread, messages: rawMessages.map((r) => messageView(workspaceId, parseGmailMessage(r))) };
    } catch (err) {
      toGmailError(err);
    }
  });
}

/** Attachment bytes streamed from Gmail for one download; never stored. */
export async function getGmailAttachment(
  config: ServerConfig,
  integration: ChannelIntegration,
  compositeId: string,
): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  const dot = compositeId.indexOf('.');
  if (dot <= 0) return null;
  const gmailMessageId = compositeId.slice(0, dot);
  const attachmentId = compositeId.slice(dot + 1);
  try {
    const ga = adapter();
    const accessToken = await tokenFor(config, integration);
    // The filename/type live on the message part, not on the attachment resource.
    const parsed = await ga.getMessage(accessToken, gmailMessageId);
    const ref = parsed.attachments.find((a) => a.attachmentId === attachmentId);
    if (!ref) return null;
    const data = await ga.getAttachmentBytes(accessToken, gmailMessageId, attachmentId);
    return { data, filename: ref.filename || 'attachment', contentType: ref.mimeType || 'application/octet-stream' };
  } catch (err) {
    if (err instanceof GmailError && /404/.test(err.detail || '')) return null;
    toGmailError(err);
  }
}

// ─── Label writes (Gmail is the store for read/star) ───────────────────

export async function setGmailThreadRead(config: ServerConfig, integration: ChannelIntegration, threadId: string, isRead: boolean): Promise<void> {
  try {
    const accessToken = await tokenFor(config, integration);
    await adapter().modifyThread(accessToken, threadId, isRead ? [] : ['UNREAD'], isRead ? ['UNREAD'] : []);
  } catch (err) {
    toGmailError(err);
  }
}

export async function setGmailThreadStarred(config: ServerConfig, integration: ChannelIntegration, threadId: string, starred: boolean): Promise<void> {
  try {
    const accessToken = await tokenFor(config, integration);
    await adapter().modifyThread(accessToken, threadId, starred ? ['STARRED'] : [], starred ? [] : ['STARRED']);
  } catch (err) {
    toGmailError(err);
  }
}

// ─── Incremental changes ───────────────────────────────────────────────

/**
 * Thread ids changed since the client's cursor. `reset` means the cursor is
 * too old (or the delta too large) and the client should drop its list cache
 * and reload page one; message bodies stay valid per their own historyId.
 */
export async function listGmailChanges(
  config: ServerConfig,
  integration: ChannelIntegration,
  sinceHistoryId: string,
): Promise<{ historyId: string | null; threadIds: string[]; reset: boolean }> {
  return singleFlight(`changes:${integration.id}:${sinceHistoryId}`, async () => {
    try {
      const accessToken = await tokenFor(config, integration);
      const ga = adapter();
      const result = await ga.listChangedThreadIds(accessToken, sinceHistoryId);
      if (result.expired || result.truncated) {
        return { historyId: await ga.getProfileHistoryId(accessToken), threadIds: [], reset: true };
      }
      return { historyId: result.historyId ?? sinceHistoryId, threadIds: result.threadIds, reset: false };
    } catch (err) {
      toGmailError(err);
    }
  });
}

// ─── Send (synchronous; the reply exists only in the request) ──────────

export interface GmailSendInput {
  threadId: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  attachments?: Array<{ filename: string; contentType: string; bytes: Buffer }>;
}

export async function sendGmail(
  config: ServerConfig,
  integration: ChannelIntegration,
  input: GmailSendInput,
  subjectForReply: (subject: string) => string,
): Promise<{ messageId: string; threadId: string }> {
  const fromEmail = integration.external_account_id;
  if (!fromEmail) throw new GmailLiveError('email_not_connected');
  try {
    const ga = adapter();
    const accessToken = await tokenFor(config, integration);
    let subject = input.subject;
    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (input.threadId) {
      const raw = await ga.getThreadRaw(accessToken, input.threadId, 'metadata', ['Subject', 'Message-ID', 'References']);
      const messages = ((Array.isArray(raw.messages) ? raw.messages : []) as Record<string, unknown>[]).map(parseGmailMessage);
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
  } catch (err) {
    toGmailError(err);
  }
}
