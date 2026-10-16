/**
 * The JSON body parser for every route that has no raw-body parser of its own
 * (server/index.ts mounts it after the webhook routes).
 *
 * POST /api/widget/bootstrap is the one exception to "application/json only":
 * the loader sends its body with NO Content-Type, so the browser labels it
 * text/plain and the cross-origin request stays CORS-simple — no OPTIONS
 * preflight, one round trip less on a visitor's first page view. That body is
 * parsed as JSON here, on this path only, with a 16 KB limit (a bootstrap
 * body is ~150 bytes). It must be parsed BEFORE widgetCorsMiddleware, which
 * reads body.workspace_id. Nothing about trust changes: the preflight never
 * authorized anything (widgetCors answers every OPTIONS with 204), and the
 * Origin checks run on the actual request either way.
 */
import express, { type RequestHandler } from 'express';

/** Express routes case-insensitively; so does this. */
const TEXT_JSON_PATH = /^\/api\/widget\/bootstrap\/?$/i;

export const WIDGET_BOOTSTRAP_BODY_LIMIT = '16kb';

export function isTextJsonPath(path: string): boolean {
  return TEXT_JSON_PATH.test(path);
}

export function jsonBodyParser(): RequestHandler {
  const json = express.json({ limit: '50mb' });
  const widgetBootstrap = express.json({ limit: WIDGET_BOOTSTRAP_BODY_LIMIT, type: ['application/json', 'text/plain'] });
  return (req, res, next) => (isTextJsonPath(req.path) ? widgetBootstrap(req, res, next) : json(req, res, next));
}
