/**
 * EMAIL INBOX — Core-side service backing `/api/email-inbox/*`.
 *
 * Reads/writes `email_threads` / `email_messages` / `email_attachments`
 * (163_email_inbox.sql) directly — Core owns every canonical write, same
 * rule as every other channel. Provider-specific work (talking to Gmail or
 * Yahoo Mail) never happens here: composing a reply enqueues a
 * `gmail_outbound_message` or `yahoo_outbound_message` channel_job and the
 * Channels Worker executes it, reporting back through
 * `server/routes/internalChannels.ts`'s `/gmail/outbound-result` or
 * `/yahoo/outbound-result`.
 *
 * Deliberately provider-generic where it can be: `listThreads`/`getThread`/
 * `setThreadRead`/`setThreadStarred` don't care whether a thread's messages
 * came from Gmail or Yahoo Mail — only `resolveConnectedIntegration` (which
 * of the two, if either, is connected for this workspace) and `composeReply`
 * (which job type/payload shape to enqueue) branch on `integration.provider`.
 */
import { randomBytes } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getInstallation } from '../plugins/state.js';
import { getIntegrationForInstallation, type ChannelIntegration } from '../channels/integrations.js';
import { enqueueChannelJob } from '../channels/jobs.js';
import { uploadFile, getFileUrl, downloadFile } from '../storage/index.js';
import { emailAttachmentKey } from '../storage/keys.js';
import { GMAIL_PLUGIN_ID } from '../channels/gmail/oauth.js';
import { YAHOO_PLUGIN_ID } from '../../../shared/channels/yahooKeys.js';

export class EmailInboxError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message || code);
    this.name = 'EmailInboxError';
  }
}

export interface EmailThreadSummary {
  id: string;
  provider: string;
  subject: string | null;
  participants: unknown;
  lastMessageAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  lastMessageSnippet: string | null;
}

export interface EmailAttachmentView {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  contentId: string | null;
  url: string | null;
  /**
   * The same file through this API (signed-in, `/api/...`), read from whichever
   * storage provider is primary at the moment of the download. Apps use it in
   * preference to `url`: it works for providers with no public URL, private
   * buckets, and survives a provider or CDN change without anything stored.
   */
  downloadPath: string;
}

interface EmailThreadRow {
  id: string;
  provider: string;
  subject: string | null;
  participants: unknown;
  last_message_at: string | null;
  is_read: boolean;
  is_starred: boolean;
  labels: string[] | null;
}

interface EmailMessageSnippetRow {
  thread_id: string;
  snippet: string | null;
  sent_at: string;
}

interface EmailAttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  storage_key: string;
  content_id: string | null;
}

interface EmailMessageRow {
  id: string;
  external_message_id: string;
  direction: 'inbound' | 'outbound';
  from_address: string;
  to_addresses: unknown;
  cc_addresses: unknown;
  bcc_addresses: unknown;
  text_body: string | null;
  html_body: string | null;
  snippet: string | null;
  is_read: boolean;
  delivery_status: 'queued' | 'sent' | 'failed';
  delivery_error: string | null;
  sent_at: string;
}

export interface EmailMessageView {
  id: string;
  externalMessageId: string;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  toAddresses: unknown;
  ccAddresses: unknown;
  bccAddresses: unknown;
  textBody: string | null;
  htmlBody: string | null;
  snippet: string | null;
  isRead: boolean;
  deliveryStatus: 'queued' | 'sent' | 'failed';
  deliveryError: string | null;
  sentAt: string;
  attachments: EmailAttachmentView[];
}

/**
 * Resolves whichever of Gmail/Yahoo is connected for this workspace. A
 * workspace can only meaningfully have one connected mailbox integration at
 * a time in this feature's current shape (the Email Inbox UI shows one
 * "connected as <address>" state, not a picker) — Gmail is checked first
 * only as an arbitrary but stable tie-break; nothing prevents both from
 * existing, but composeReply only ever targets the one this resolves to.
 */
async function resolveConnectedIntegration(config: ServerConfig, workspaceId: string): Promise<ChannelIntegration> {
  for (const pluginId of [GMAIL_PLUGIN_ID, YAHOO_PLUGIN_ID]) {
    const installation = await getInstallation(config, workspaceId, pluginId);
    if (!installation) continue;
    const integration = await getIntegrationForInstallation(config, installation.id);
    if (integration && integration.status === 'connected') return integration;
  }
  throw new EmailInboxError('email_not_connected');
}

export async function listThreads(
  config: ServerConfig,
  workspaceId: string,
  opts: { limit?: number; before?: string | null; unreadOnly?: boolean; starredOnly?: boolean; search?: string } = {},
): Promise<{ threads: EmailThreadSummary[]; nextBefore: string | null }> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);

  let query = sb
    .from('email_threads')
    .select('id, provider, subject, participants, last_message_at, is_read, is_starred, labels')
    .eq('workspace_id', workspaceId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit + 1);

  if (opts.before) query = query.lt('last_message_at', opts.before);
  if (opts.unreadOnly) query = query.eq('is_read', false);
  if (opts.starredOnly) query = query.eq('is_starred', true);
  if (opts.search?.trim()) query = query.ilike('subject', `%${opts.search.trim().slice(0, 200)}%`);

  const { data, error } = await query;
  if (error) throw new EmailInboxError('email_provider_error', error.message);

  const rows = (data ?? []) as EmailThreadRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const threadIds = page.map((r) => r.id);
  const snippetByThread = new Map<string, string | null>();
  if (threadIds.length) {
    const { data: lastMessages } = await sb
      .from('email_messages')
      .select('thread_id, snippet, sent_at')
      .in('thread_id', threadIds)
      .order('sent_at', { ascending: false });
    for (const m of (lastMessages ?? []) as EmailMessageSnippetRow[]) {
      if (!snippetByThread.has(m.thread_id)) snippetByThread.set(m.thread_id, m.snippet ?? null);
    }
  }

  const threads: EmailThreadSummary[] = page.map((r) => ({
    id: r.id,
    provider: r.provider,
    subject: r.subject,
    participants: r.participants,
    lastMessageAt: r.last_message_at,
    isRead: r.is_read,
    isStarred: r.is_starred,
    labels: r.labels ?? [],
    lastMessageSnippet: snippetByThread.get(r.id) ?? null,
  }));

  return { threads, nextBefore: hasMore ? page[page.length - 1].last_message_at : null };
}

async function resolveAttachmentUrls(
  config: ServerConfig,
  workspaceId: string,
  attachments: EmailAttachmentRow[],
): Promise<EmailAttachmentView[]> {
  return Promise.all(
    attachments.map(async (a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      contentId: a.content_id,
      // Rows written before the email-attachments/ -> canonical
      // workspace/<id>/attachments/email/ migration may still carry the old
      // key shape until backfilled — the storage service recognizes that
      // legacy shape automatically (see server/services/storage/keys.ts).
      url: await getFileUrl(config, workspaceId, a.storage_key).catch(() => null),
      downloadPath: `/api/email-inbox/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(a.id)}/file`,
    })),
  );
}

/**
 * One mailbox attachment's bytes, for the signed-in download route: looked up
 * by id within the workspace, read by key from the current provider.
 */
export async function getAttachmentFile(
  config: ServerConfig,
  workspaceId: string,
  attachmentId: string,
): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('email_attachments')
    .select('id, filename, content_type, storage_key')
    .eq('id', attachmentId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const found = row as Pick<EmailAttachmentRow, 'id' | 'filename' | 'content_type' | 'storage_key'> | null;
  if (!found?.storage_key) return null;
  const file = await downloadFile(config, workspaceId, found.storage_key, { allowLegacyKey: true });
  if (!file.success || !file.data) return null;
  return {
    data: file.data,
    filename: found.filename || 'attachment',
    contentType: found.content_type || 'application/octet-stream',
  };
}

export async function getThread(
  config: ServerConfig,
  workspaceId: string,
  threadId: string,
): Promise<{ thread: EmailThreadSummary; messages: EmailMessageView[] }> {
  const sb = getServiceClient(config);
  const { data: thread, error: threadError } = await sb
    .from('email_threads')
    .select('id, provider, subject, participants, last_message_at, is_read, is_starred, labels')
    .eq('id', threadId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (threadError) throw new EmailInboxError('email_provider_error', threadError.message);
  if (!thread) throw new EmailInboxError('email_thread_not_found');

  const { data: messages, error: messagesError } = await sb
    .from('email_messages')
    .select('id, external_message_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, text_body, html_body, snippet, is_read, delivery_status, delivery_error, sent_at')
    .eq('thread_id', threadId)
    .order('sent_at', { ascending: true });
  if (messagesError) throw new EmailInboxError('email_provider_error', messagesError.message);

  const messageRows = (messages ?? []) as EmailMessageRow[];
  const messageIds = messageRows.map((m) => m.id);
  const attachmentsByMessage = new Map<string, EmailAttachmentRow[]>();
  if (messageIds.length) {
    const { data: attachments } = await sb
      .from('email_attachments')
      .select('id, message_id, filename, content_type, size_bytes, storage_key, content_id')
      .in('message_id', messageIds);
    for (const a of (attachments ?? []) as EmailAttachmentRow[]) {
      const list = attachmentsByMessage.get(a.message_id) ?? [];
      list.push(a);
      attachmentsByMessage.set(a.message_id, list);
    }
  }

  const views: EmailMessageView[] = await Promise.all(
    messageRows.map(async (m) => ({
      id: m.id,
      externalMessageId: m.external_message_id,
      direction: m.direction,
      fromAddress: m.from_address,
      toAddresses: m.to_addresses,
      ccAddresses: m.cc_addresses,
      bccAddresses: m.bcc_addresses,
      textBody: m.text_body,
      htmlBody: m.html_body,
      snippet: m.snippet,
      isRead: m.is_read,
      deliveryStatus: m.delivery_status,
      deliveryError: m.delivery_error,
      sentAt: m.sent_at,
      attachments: await resolveAttachmentUrls(config, workspaceId, attachmentsByMessage.get(m.id) ?? []),
    })),
  );

  return {
    thread: {
      id: thread.id,
      provider: thread.provider,
      subject: thread.subject,
      participants: thread.participants,
      lastMessageAt: thread.last_message_at,
      isRead: thread.is_read,
      isStarred: thread.is_starred,
      labels: thread.labels ?? [],
      lastMessageSnippet: null,
    },
    messages: views,
  };
}

export async function setThreadRead(config: ServerConfig, workspaceId: string, threadId: string, isRead: boolean): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('email_threads')
    .update({ is_read: isRead })
    .eq('id', threadId)
    .eq('workspace_id', workspaceId);
  if (error) throw new EmailInboxError('email_provider_error', error.message);
  if (isRead) {
    await sb.from('email_messages').update({ is_read: true }).eq('thread_id', threadId).eq('workspace_id', workspaceId);
  }
}

export async function setThreadStarred(config: ServerConfig, workspaceId: string, threadId: string, starred: boolean): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('email_threads')
    .update({ is_starred: starred })
    .eq('id', threadId)
    .eq('workspace_id', workspaceId);
  if (error) throw new EmailInboxError('email_provider_error', error.message);
}

// ─── Attachment staging (compose) ──────────────────────────────────────

export interface StagedAttachment {
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export async function stageComposeAttachment(
  config: ServerConfig,
  workspaceId: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<StagedAttachment> {
  const safeName = filename.replace(/[^\w.-]+/g, '_').slice(0, 150) || 'attachment';
  const fileKey = emailAttachmentKey({ workspaceId, fileName: safeName });
  const result = await uploadFile(config, { workspaceId, fileKey, data: bytes, contentType });
  if (!result.success || !result.fileKey) throw new EmailInboxError('email_attachment_upload_failed', result.error);
  return { storageKey: result.fileKey, filename: safeName, contentType, sizeBytes: bytes.byteLength };
}

// ─── Compose / reply ────────────────────────────────────────────────────

export interface ComposeReplyInput {
  threadId: string | null; // null = new thread
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  attachments?: StagedAttachment[];
}

function subjectWithReplyPrefix(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/**
 * Generates the Message-ID Core will store as `external_message_id` BEFORE
 * the Worker ever runs — both providers' outbound job payload carries this
 * exact value so the sent message's real header matches the stored row
 * (Gmail's raw MIME sets it explicitly; Yahoo's nodemailer send is told to
 * force it via `messageId` rather than auto-generating its own).
 */
function generateEmailMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || 'localhost';
  return `<${randomBytes(16).toString('hex')}.${Date.now()}@${domain}>`;
}

export async function composeReply(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  input: ComposeReplyInput,
): Promise<{ messageId: string }> {
  if (!input.to.length) throw new EmailInboxError('email_missing_recipient');
  const integration = await resolveConnectedIntegration(config, workspaceId);
  const fromEmail = integration.external_account_id;
  if (!fromEmail) throw new EmailInboxError('email_not_connected');

  const sb = getServiceClient(config);

  let threadId = input.threadId;
  let externalThreadId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  let subject = input.subject;

  if (threadId) {
    const { data: thread } = await sb
      .from('email_threads')
      .select('id, external_thread_id, subject')
      .eq('id', threadId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!thread) throw new EmailInboxError('email_thread_not_found');
    externalThreadId = thread.external_thread_id;
    subject = subjectWithReplyPrefix(thread.subject || input.subject);

    const { data: lastMessage } = await sb
      .from('email_messages')
      .select('external_message_id, message_references')
      .eq('thread_id', threadId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastMessage) {
      inReplyTo = lastMessage.external_message_id;
      references = [...(lastMessage.message_references ?? []), lastMessage.external_message_id];
    }
  }

  const messageId = generateEmailMessageId(fromEmail);
  const sentAt = new Date().toISOString();
  const isGmail = integration.provider === 'gmail';

  // A brand-new (non-reply) thread has no server-side row yet — one is
  // created here so the outbound message always has a thread_id to attach
  // to. Gmail assigns its OWN thread id only once the message is actually
  // sent, so its external_thread_id starts as a `pending-` placeholder the
  // Worker's send response patches (see /gmail/outbound-result). Yahoo has
  // no provider-side thread id at all — Core derives one from headers the
  // same way inbound sync does (deriveYahooThreadId in
  // internalChannels.ts): a message with no References/In-Reply-To yet is
  // the root of its own thread, so its own Message-ID IS the thread id,
  // final from the start — no patch-up needed.
  if (!threadId) {
    const { data: newThread, error: threadError } = await sb
      .from('email_threads')
      .insert({
        workspace_id: workspaceId,
        integration_id: integration.id,
        provider: integration.provider,
        external_thread_id: isGmail ? `pending-${messageId}` : messageId,
        subject,
        participants: input.to.map((email) => ({ email })),
        last_message_at: sentAt,
        is_read: true,
      })
      .select('id')
      .single();
    if (threadError || !newThread) throw new EmailInboxError('email_provider_error', threadError?.message);
    threadId = newThread.id;
  } else {
    await sb.from('email_threads').update({ last_message_at: sentAt, is_read: true }).eq('id', threadId);
  }

  const { data: messageRow, error: messageError } = await sb
    .from('email_messages')
    .insert({
      thread_id: threadId,
      workspace_id: workspaceId,
      external_message_id: messageId,
      in_reply_to: inReplyTo,
      message_references: references,
      direction: 'outbound',
      from_address: fromEmail,
      to_addresses: input.to.map((email) => ({ email })),
      cc_addresses: (input.cc ?? []).map((email) => ({ email })),
      bcc_addresses: (input.bcc ?? []).map((email) => ({ email })),
      text_body: input.textBody,
      html_body: input.htmlBody ?? null,
      snippet: input.textBody.slice(0, 200),
      is_read: true,
      sent_by: userId,
      sent_at: sentAt,
      delivery_status: 'queued',
    })
    .select('id')
    .single();
  if (messageError || !messageRow) throw new EmailInboxError('email_provider_error', messageError?.message);

  const attachmentRefs: Array<{ filename: string; content_type: string; url: string | null }> = [];
  for (const att of input.attachments ?? []) {
    const { error: attError } = await sb.from('email_attachments').insert({
      message_id: messageRow.id,
      workspace_id: workspaceId,
      filename: att.filename,
      content_type: att.contentType,
      size_bytes: att.sizeBytes,
      storage_key: att.storageKey,
    });
    if (attError) throw new EmailInboxError('email_provider_error', attError.message);
    attachmentRefs.push({
      filename: att.filename,
      content_type: att.contentType,
      url: await getFileUrl(config, workspaceId, att.storageKey).catch(() => null),
    });
  }

  const commonOutboundPayload = {
    email_message_id: messageRow.id,
    message_id: messageId,
    from_email: fromEmail,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject,
    text_body: input.textBody,
    html_body: input.htmlBody ?? null,
    in_reply_to: inReplyTo,
    references,
    attachments: attachmentRefs,
  };

  await enqueueChannelJob(sb, isGmail
    ? {
        provider: 'gmail',
        jobType: 'gmail_outbound_message',
        workspaceId,
        integrationId: integration.id,
        payload: {
          ...commonOutboundPayload,
          local_thread_id: threadId,
          gmail_thread_id: externalThreadId,
        },
      }
    : {
        provider: 'yahoo',
        jobType: 'yahoo_outbound_message',
        workspaceId,
        integrationId: integration.id,
        payload: commonOutboundPayload,
      });

  return { messageId: messageRow.id };
}
