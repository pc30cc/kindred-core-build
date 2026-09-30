/**
 * /api/platform-support — an operator's side of platform support.
 *
 * Any signed-in user (cookie on the web, Bearer in the apps). Nothing here is
 * scoped to a workspace the caller belongs to: every thread is read through
 * `platform_support_threads` by the caller's own user id. See
 * server/services/platformSupport/service.ts for the model, and
 * docs/PLATFORM_SUPPORT.md for the contract the apps follow.
 *
 *   GET  /status                     { enabled, available, online, ticketsEnabled, teamName }
 *   GET  /threads                    { threads: SupportThread[] }
 *   GET  /threads/:id                { thread, messages: SupportMessage[] }
 *   POST /chat                       { body, clientMessageId?, workspaceId? } → { thread, message }
 *   POST /tickets                    { subject, body, clientMessageId?, workspaceId? } → { thread, message }
 *   POST /threads/:id/messages       { body, clientMessageId? } → { thread, message }
 *   POST /threads/:id/read           → { ok: true }
 *
 * Errors are `{ error: <code> }`: support_disabled, support_not_configured,
 * support_member, tickets_disabled, invalid_body, invalid_subject,
 * thread_not_found, thread_closed, rate_limited.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireUser, serverConfigOf } from '../lib/workspaceAuth.js';
import {
  createTicket,
  listThreads,
  markThreadRead,
  replyInThread,
  sendChatMessage,
  SupportError,
  supportStatus,
  threadMessages,
} from '../services/platformSupport/service.js';

export const platformSupportRouter = Router();

function fail(res: Response, err: unknown): Response {
  if (err instanceof SupportError) return res.status(err.status).json({ error: err.code });
  console.error('[platform-support] request failed:', err instanceof Error ? err.message : err);
  return res.status(500).json({ error: 'internal_error' });
}

function localeOf(req: Request): string {
  const q = typeof req.query.locale === 'string' ? req.query.locale : '';
  const header = String(req.headers['accept-language'] || '');
  return (q || header || 'en').toLowerCase().split(/[-_,;]/)[0] || 'en';
}

platformSupportRouter.get('/status', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    return res.json(await supportStatus(serverConfigOf(req), userId, localeOf(req)));
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.get('/threads', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    return res.json({ threads: await listThreads(serverConfigOf(req), userId) });
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.get('/threads/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    return res.json(await threadMessages(serverConfigOf(req), userId, String(req.params.id)));
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/chat', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const body = req.body ?? {};
    return res.json(
      await sendChatMessage(serverConfigOf(req), userId, {
        body: body.body,
        clientMessageId: body.clientMessageId,
        sourceWorkspaceId: body.workspaceId,
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/tickets', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const body = req.body ?? {};
    return res.json(
      await createTicket(serverConfigOf(req), userId, {
        subject: body.subject,
        body: body.body,
        clientMessageId: body.clientMessageId,
        sourceWorkspaceId: body.workspaceId,
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/threads/:id/messages', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const body = req.body ?? {};
    return res.json(
      await replyInThread(serverConfigOf(req), userId, String(req.params.id), {
        body: body.body,
        clientMessageId: body.clientMessageId,
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/threads/:id/read', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    await markThreadRead(serverConfigOf(req), userId, String(req.params.id));
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});
