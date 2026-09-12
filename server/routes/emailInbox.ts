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
import { Router, raw } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import {
  EmailInboxError,
  listThreads,
  getThread,
  setThreadRead,
  setThreadStarred,
  stageComposeAttachment,
  composeReply,
  type StagedAttachment,
} from '../services/email/inbox.js';

export const emailInboxRouter = Router();

function sendEmailInboxError(res: any, err: unknown) {
  if (err instanceof EmailInboxError) {
    const status =
      err.code === 'email_not_connected' ? 409 :
      err.code === 'email_thread_not_found' ? 404 :
      err.code === 'email_missing_recipient' ? 400 :
      500;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  console.error('[email-inbox] unexpected error:', err);
  res.status(500).json({ error: 'email_inbox_unexpected_error' });
}

emailInboxRouter.get('/:workspaceId/threads', async (req: any, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const result = await listThreads(serverConfigOf(req), workspaceId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      before: typeof req.query.before === 'string' ? req.query.before : null,
      unreadOnly: req.query.unread === 'true',
      starredOnly: req.query.starred === 'true',
      search: typeof req.query.q === 'string' ? req.query.q : undefined,
    });
    res.json(result);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

emailInboxRouter.get('/:workspaceId/threads/:threadId', async (req: any, res) => {
  const { workspaceId, threadId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const result = await getThread(serverConfigOf(req), workspaceId, threadId);
    res.json(result);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

const readSchema = z.object({ is_read: z.boolean() });
emailInboxRouter.post('/:workspaceId/threads/:threadId/read', async (req: any, res) => {
  const { workspaceId, threadId } = req.params;
  const parsed = readSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    await setThreadRead(serverConfigOf(req), workspaceId, threadId, parsed.data.is_read);
    res.json({ ok: true });
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

const starSchema = z.object({ starred: z.boolean() });
emailInboxRouter.post('/:workspaceId/threads/:threadId/star', async (req: any, res) => {
  const { workspaceId, threadId } = req.params;
  const parsed = starSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    await setThreadStarred(serverConfigOf(req), workspaceId, threadId, parsed.data.starred);
    res.json({ ok: true });
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
emailInboxRouter.post('/:workspaceId/attachments', raw({ type: '*/*', limit: '25mb' }), async (req: any, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const filename = typeof req.query.filename === 'string' ? req.query.filename : 'attachment';
    const contentType = typeof req.query.content_type === 'string' ? req.query.content_type : 'application/octet-stream';
    const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    if (!bytes.byteLength) return res.status(400).json({ error: 'empty_body' });
    const staged = await stageComposeAttachment(serverConfigOf(req), workspaceId, filename, contentType, bytes);
    res.json(staged);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});

const sendSchema = z.object({
  thread_id: z.string().uuid().nullable().optional(),
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
});

emailInboxRouter.post('/:workspaceId/send', async (req: any, res) => {
  const { workspaceId } = req.params;
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const attachments: StagedAttachment[] | undefined = parsed.data.attachments?.map((a) => ({
      storageKey: a.storageKey,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));
    const result = await composeReply(serverConfigOf(req), workspaceId, auth.userId, {
      threadId: parsed.data.thread_id ?? null,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      subject: parsed.data.subject,
      textBody: parsed.data.text_body,
      htmlBody: parsed.data.html_body,
      attachments,
    });
    res.json(result);
  } catch (err) {
    sendEmailInboxError(res, err);
  }
});
