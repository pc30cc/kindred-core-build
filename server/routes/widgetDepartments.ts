/**
 * Phase 8H Completion — Widget-facing department visibility endpoint.
 *
 * Mounted under /api/widget/departments. Inherits widget CORS, rate
 * limiting, token + origin enforcement from the parent widget router.
 *
 * Returns the minimum data the widget needs to decide which UI mode to
 * render (general / single / multi) without leaking operator identities or
 * any internal routing state.
 */
import { Router, Request, Response } from 'express';
import type { ServerConfig } from '../config.js';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import {
  enforceWidgetToken,
  enforceOrigin,
  resolveWorkspaceId,
} from '../services/widget/security.js';
import { resolveWidgetDepartmentMode } from '../services/calls/departments.js';
import { availableOperatorIds } from '../services/widget/senderIdentity.js';

export const widgetDepartmentsRouter = Router();

widgetDepartmentsRouter.use(enforceWidgetToken);
widgetDepartmentsRouter.use(enforceOrigin);

// GET /api/widget/departments/visible?channel=chat|audio|video
widgetDepartmentsRouter.get('/visible', async (req: Request, res: Response) => {
  const config: ServerConfig = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res);
  if (!workspaceId) {
    // resolveWorkspaceId may have already responded on mismatch.
    if (!res.headersSent) res.status(400).json({ error: 'workspace_unresolved' });
    return;
  }
  const channelRaw = String(req.query.channel || 'chat');
  const channel = (['chat', 'audio', 'video'].includes(channelRaw)
    ? channelRaw
    : 'chat') as 'chat' | 'audio' | 'video';
  try {
    // Chat: who is there now, as the widget's online/offline counts it, so
    // the picker can mark a department nobody answers at the moment.
    const onlineIds = channel === 'chat' ? await availableOperatorIds(config, workspaceId) : undefined;
    const resolution = await resolveWidgetDepartmentMode(config, workspaceId, channel, { onlineIds });
    // Public-safe shape — no member ids, no diagnostics. `online` is one
    // boolean per department, no person in it.
    res.set('Cache-Control', 'no-store');
    res.json({
      mode: resolution.mode,
      channel,
      default_department_id: resolution.default_department_id,
      visible_departments: resolution.visible_departments.map((d) => ({
        id: d.id,
        name: d.name,
        sort_order: d.sort_order,
        capabilities: { chat: d.chat, audio: d.audio, video: d.video },
        online: d.online,
      })),
    });
  } catch (err) {
    console.error('[widget/departments/visible] error:', (err as { message?: string } | null)?.message);
    res.status(500).json({ error: 'internal' });
  }
});