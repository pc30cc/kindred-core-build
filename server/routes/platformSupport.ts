/**
 * Platform support — the operator's side (docs/PLATFORM_SUPPORT.md).
 *
 * Any signed-in operator, from any client: the cookie on the web, a bearer
 * token in the apps. camelCase JSON both ways, so every client reads the
 * same shape.
 *
 *   GET  /status                      { enabled, available, online, teamName, unread, hours, nextOpenAt }
 *   GET  /history                     { conversations, items, activeConversationId }
 *   POST /messages                    { body, clientMessageId, workspaceId? } → { conversation, item }
 *   POST /attachments                 { fileName, mimeType, data, clientMessageId, workspaceId? } → { conversation, item }
 *   GET  /attachments/:id             the file's bytes
 *   POST /conversations/:id/rating    { score, comment? } → { conversation }
 *   POST /read                        → { ok: true }
 *
 * Errors are `{ error: <code> }`: support_disabled, support_not_configured,
 * conversation_not_found, attachment_not_found, already_rated, not_ratable,
 * invalid_body, invalid_rating, invalid_file, file_type_not_allowed,
 * file_too_large, rate_limited.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireUser, serverConfigOf } from '../lib/workspaceAuth.js';
import {
  attachmentFile,
  markRead,
  rateConversation,
  sendAttachment,
  sendMessage,
  SupportError,
  supportHistory,
  supportStatus,
} from '../services/platformSupport/service.js';
import { clientPlatformOf } from '../services/platformSupport/text.js';

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

/** The body as an object, whatever was posted. */
function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
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

platformSupportRouter.get('/history', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    return res.json(await supportHistory(serverConfigOf(req), userId));
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/messages', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const body = bodyOf(req);
    return res.json(
      await sendMessage(serverConfigOf(req), userId, {
        body: body.body,
        clientMessageId: body.clientMessageId,
        sourceWorkspaceId: body.workspaceId,
        client: clientPlatformOf(req.headers['x-client-platform']),
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/attachments', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const body = bodyOf(req);
    return res.json(
      await sendAttachment(serverConfigOf(req), userId, {
        fileName: body.fileName,
        mimeType: body.mimeType,
        data: body.data,
        clientMessageId: body.clientMessageId,
        sourceWorkspaceId: body.workspaceId,
        client: clientPlatformOf(req.headers['x-client-platform']),
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.get('/attachments/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const file = await attachmentFile(serverConfigOf(req), userId, String(req.params.id));
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName.replace(/"/g, '')}"`);
    return res.end(file.bytes);
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/conversations/:id/rating', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const body = bodyOf(req);
    return res.json(
      await rateConversation(serverConfigOf(req), userId, String(req.params.id), {
        score: body.score,
        comment: body.comment,
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

platformSupportRouter.post('/read', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    await markRead(serverConfigOf(req), userId);
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});
