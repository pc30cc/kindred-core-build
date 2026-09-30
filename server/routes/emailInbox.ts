/**
 * Email INBOX API — browser-facing. Backs `/email` in the app (a dedicated
 * Gmail/Yahoo inbox — see `server/services/email/inbox.ts`'s header
 * comment).
 *
 * Deliberately a separate router/path (`/api/email-inbox`) from
 * `server/routes/email.ts`'s `/api/email/*`: that one is the pre-existing
 * PLATFORM/TRANSACTIONAL + workspace "email channel" (outbound-only SMTP
 * sending, gated by `requireChannel('email')` — see
 * docs/EMAIL_SURFACE_SPLIT.md) and is functionally unrelated to this
 * feature (a real inbound+outbound mailbox backed by Gmail/Yahoo OAuth).
 * Reusing its path or its `emailRouter` export would conflate two different
 * things that happen to share the English word "email".
 */
import { Router, raw, type Request, type Response } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { enforceModule } from '../middleware/featureGating.js';
import {
  EmailInboxError,
  listThreads,
  getThread,
  setThreadRead,
  setThreadStarred,
  stageComposeAttachment,
  composeReply,
  getAttachmentFile,
  listChanges,
  isLiveInbox,
  sendLiveGmail,
  listMailboxes,
  type EmailProvider,
  type StagedAttachment,
} from '../services/email/inbox.js';

export const emailInboxRouter = Router();

// Live (Gmail) inbox: attachment bytes ride in the send request, never stored.
const MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const INLINE_KEY_PREFIX = 'inline:';

// Every route below also answers to the workspace plan: the Email Inbox is the
// `email_inbox` module, and a plan without it gets a 403 here exactly as the
// app hides the section.

function sendEmailInboxError(res: Response, err: unknown) {
  if (err instanceof EmailInboxError) {
    const status =
      err.code === 'email_not_connected' ? 409 :
      err.code === 'email_thread_not_found' ? 404 :
      err.code === 'email_attachment_not_found' ? 404 :
      err.code === 'email_rate_limited' ? 429 :
      err.code === 'email_missing_recipient' ? 400 :
      500;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  console.error('[email-inbox] unexpected error:', err);
  res.status(500).json({ error: 'email_inbox_unexpected_error' });
}

/**
 * `?provider=gmail|yahoo` (every route, POSTs included): the mailbox the
 * request is about, when a workspace has more than one connected. Absent,
 * the first connected one is used (Gmail, then Yahoo), as before. `null`
 * means the value was invalid and a 400 has been sent.
 */
function mailboxOf(req: Request, res: Response): EmailProvider | undefined | null {
  const value = req.query.provider;
  if (value === undefined || value === '') return undefined;
  if (value === 'gmail' || value === 'yahoo') return value;
  res.status(400).json({ error: 'invalid_provider' });
  return null;
}

/**
 * GET /:workspaceId/mailboxes — the connected mailboxes (Gmail first), each
 * `{ provider, address, status: 'connected', unread }`, so apps can offer a
 * picker and badge it. `unread` = unread INBOX threads, or null when it could
 * not be read just now. No mail content.
 */
emailInboxRouter.get('/:workspaceId/mailboxes', async (req, res) => {
  const { workspaceId } = req.params;
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ mailboxes: await listMailboxes(serverConfigOf(req), workspaceId, provider) });
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

emailInboxRouter.get('/:workspaceId/threads', async (req, res) => {
  const { workspaceId } = req.params;
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    const result = await listThreads(serverConfigOf(req), workspaceId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      before: typeof req.query.before === 'string' ? req.query.before : null,
      pageToken: typeof req.query.page_token === 'string' ? req.query.page_token : null,
      unreadOnly: req.query.unread === 'true',
      starredOnly: req.query.starred === 'true',
      search: typeof req.query.q === 'string' ? req.query.q : undefined,
    }, provider);
    res.json(result);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

emailInboxRouter.get('/:workspaceId/threads/:threadId', async (req, res) => {
  const { workspaceId, threadId } = req.params;
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    const result = await getThread(serverConfigOf(req), workspaceId, threadId, provider);
    res.json(result);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

/**
 * GET /:workspaceId/changes?since=<historyId> — thread ids changed since a
 * client's cursor, so apps refresh only those. Carries ids only, no content.
 */
emailInboxRouter.get('/:workspaceId/changes', async (req, res) => {
  const { workspaceId } = req.params;
  const since = typeof req.query.since === 'string' && /^\d{1,30}$/.test(req.query.since) ? req.query.since : null;
  if (!since) return res.status(400).json({ error: 'invalid_since' });
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await listChanges(serverConfigOf(req), workspaceId, since, provider));
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

const readSchema = z.object({ is_read: z.boolean() });
emailInboxRouter.post('/:workspaceId/threads/:threadId/read', async (req, res) => {
  const { workspaceId, threadId } = req.params;
  const parsed = readSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    await setThreadRead(serverConfigOf(req), workspaceId, threadId, parsed.data.is_read, provider);
    res.json({ ok: true });
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

const starSchema = z.object({ starred: z.boolean() });
emailInboxRouter.post('/:workspaceId/threads/:threadId/star', async (req, res) => {
  const { workspaceId, threadId } = req.params;
  const parsed = starSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    await setThreadStarred(serverConfigOf(req), workspaceId, threadId, parsed.data.starred, provider);
    res.json({ ok: true });
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

/**
 * GET /:workspaceId/attachments/:attachmentId/file — a received or sent
 * attachment's bytes, for signed-in apps. Read by key from the storage
 * provider that is primary now, so nothing breaks when Super Admin changes the
 * provider or its CDN, and providers with no public URL (or private buckets)
 * still serve it.
 */
emailInboxRouter.get('/:workspaceId/attachments/:attachmentId/file', async (req, res) => {
  const { workspaceId, attachmentId } = req.params;
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    const file = await getAttachmentFile(serverConfigOf(req), workspaceId, attachmentId, provider);
    if (!file) return res.status(404).json({ error: 'attachment_not_found' });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.data.byteLength));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.data);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

/**
 * POST /:workspaceId/attachments?filename=&content_type= — raw bytes,
 * staged under a fresh storage key. The returned `storageKey` is passed back
 * in a subsequent /send call, which is what actually creates the
 * `email_attachments` row (that table's `message_id` is NOT NULL, so an
 * attachment cannot be persisted before the message it belongs to exists).
 */
emailInboxRouter.post('/:workspaceId/attachments', raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const { workspaceId } = req.params;
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  try {
    const filename = typeof req.query.filename === 'string' ? req.query.filename : 'attachment';
    const contentType = typeof req.query.content_type === 'string' ? req.query.content_type : 'application/octet-stream';
    const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    if (!bytes.byteLength) return res.status(400).json({ error: 'empty_body' });
    // A live (Gmail) inbox stores nothing. Apps that stage before sending get
    // their file handed straight back as the "key" (INLINE_KEY_PREFIX) and
    // return it with /send; nothing is written anywhere in between.
    if (await isLiveInbox(serverConfigOf(req), workspaceId, provider)) {
      if (bytes.byteLength > MAX_INLINE_ATTACHMENT_BYTES) return res.status(413).json({ error: 'attachments_too_large' });
      const safeName = filename.replace(/[^\w.-]+/g, '_').slice(0, 150) || 'attachment';
      const inline: StagedAttachment = {
        storageKey: `${INLINE_KEY_PREFIX}${bytes.toString('base64')}`,
        filename: safeName,
        contentType,
        sizeBytes: bytes.byteLength,
      };
      return res.json(inline);
    }
    const staged = await stageComposeAttachment(serverConfigOf(req), workspaceId, filename, contentType, bytes);
    res.json(staged);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

const sendSchema = z.object({
  // Gmail thread ids are provider ids (hex), Yahoo's are our UUIDs.
  thread_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9-]+$/).nullable().optional(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  text_body: z.string().min(1).max(200_000),
  html_body: z.string().max(500_000).nullable().optional(),
  attachments: z.array(z.object({
    storageKey: z.string(),
    filename: z.string(),
    contentType: z.string(),
    sizeBytes: z.number(),
  })).optional(),
  // Live (Gmail) inbox only: a retry with the same id does not send twice.
  client_request_id: z.string().min(8).max(100).regex(/^[A-Za-z0-9-]+$/).optional(),
  // Live (Gmail) inbox only: bytes sent with the reply, never stored.
  inline_attachments: z.array(z.object({
    filename: z.string().min(1).max(200),
    content_type: z.string().min(1).max(200),
    data_base64: z.string().min(1),
  })).max(10).optional(),
});

emailInboxRouter.post('/:workspaceId/send', async (req, res) => {
  const { workspaceId } = req.params;
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  const provider = mailboxOf(req, res);
  if (provider === null) return;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await enforceModule(req, res, workspaceId, 'email_inbox'))) return;
  const config = serverConfigOf(req);
  try {
    if (await isLiveInbox(config, workspaceId, provider)) {
      // Staged attachments from apps that upload first carry their bytes in
      // the key (see POST /attachments); a storage key means nothing here.
      const staged = parsed.data.attachments ?? [];
      if (staged.some((a) => !a.storageKey.startsWith(INLINE_KEY_PREFIX))) {
        return res.status(400).json({ error: 'invalid_attachment' });
      }
      const inline = [
        ...staged.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          bytes: Buffer.from(a.storageKey.slice(INLINE_KEY_PREFIX.length), 'base64'),
        })),
        ...(parsed.data.inline_attachments ?? []).map((a) => ({
          filename: a.filename,
          contentType: a.content_type,
          bytes: Buffer.from(a.data_base64, 'base64'),
        })),
      ].map((a) => ({ ...a, filename: a.filename.replace(/[\r\n\0"]+/g, '_') }));
      const total = inline.reduce((sum, a) => sum + a.bytes.byteLength, 0);
      if (total > MAX_INLINE_ATTACHMENT_BYTES) return res.status(413).json({ error: 'attachments_too_large' });
      const result = await sendLiveGmail(config, workspaceId, {
        clientRequestId: parsed.data.client_request_id ?? null,
        threadId: parsed.data.thread_id ?? null,
        to: parsed.data.to,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        subject: parsed.data.subject,
        textBody: parsed.data.text_body,
        htmlBody: parsed.data.html_body,
        attachments: inline,
      }, provider);
      return res.json(result);
    }
    if (parsed.data.thread_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.data.thread_id)) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    const attachments: StagedAttachment[] | undefined = parsed.data.attachments?.map((a) => ({
      storageKey: a.storageKey,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));
    const result = await composeReply(config, workspaceId, auth.userId, {
      threadId: parsed.data.thread_id ?? null,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      subject: parsed.data.subject,
      textBody: parsed.data.text_body,
      htmlBody: parsed.data.html_body,
      attachments,
    }, provider);
    res.json(result);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});
