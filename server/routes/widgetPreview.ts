/**
 * Authenticated widget PREVIEW config.
 *
 * The admin live preview cannot use `GET /api/widget/config`: that route sits
 * below `enforceWidgetToken` and requires a visitor session token issued by
 * `/api/widget/bootstrap` for an allow-listed origin. The dashboard is not an
 * allow-listed widget origin, so calling it produced a 401.
 *
 * Rather than weakening widget security, this route re-uses the SAME config
 * builder behind operator authentication:
 *   • Supabase user JWT (Bearer) — real identity, never the anon key.
 *   • Workspace membership check via `authorizeWorkspaceAccess`.
 *
 * No visitor session token is minted here and no visitor-facing capability is
 * exposed: the response is the identical read-only config document the widget
 * runtime consumes, so preview and production render from one source.
 */
import { Router, type Request, type Response } from 'express';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import { widgetConfigHandler } from './widget.js';

export const widgetPreviewRouter = Router();

widgetPreviewRouter.get('/config', async (req: Request, res: Response) => {
  const workspaceId = typeof req.query.workspace_id === 'string' ? req.query.workspace_id.trim() : '';
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return; // authorizeWorkspaceAccess already wrote 400/401/403/500

  // The shared builder resolves the workspace from `_widgetWorkspaceId` (the
  // widget-token seam). We set it from the AUTHORIZED workspace id so the
  // preview can never read a workspace the operator does not belong to.
  (req as any)._widgetWorkspaceId = workspaceId;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return widgetConfigHandler(req, res);
});
