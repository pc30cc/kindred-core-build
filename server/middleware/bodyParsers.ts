/**
 * The JSON body parser for every route that has no raw-body parser of its own
 * (server/index.ts mounts it after the webhook routes).
 *
 * Three widget calls are the exception to "application/json only": the loader
 * sends their JSON with NO Content-Type, so the browser labels it text/plain
 * and the cross-origin request stays CORS-simple — no OPTIONS preflight, one
 * round trip less on a visitor's page view:
 *
 *   POST /api/widget/bootstrap              (16 KB; a body is ~150 bytes)
 *   POST /api/widget/track                  (64 KB; page URL, title, referrer)
 *   POST /api/realtime/visitor-presence     (64 KB)
 *
 * On those paths a text/plain body is parsed as JSON here, BEFORE
 * widgetCorsMiddleware, which reads body.workspace_id (and, on the last two,
 * the `widget_token` field that replaces the X-Widget-Token header — see
 * readWidgetToken in services/widget/security.ts). application/json keeps the
 * normal parser and its limit. Nothing about trust changes: the preflight
 * never authorized anything (widgetCors answers every OPTIONS with 204), and
 * the Origin and token checks run on the actual request either way.
 */
import express, { type RequestHandler } from 'express';

/** Express routes case-insensitively; so does this. */
const BOOTSTRAP_PATH = /^\/api\/widget\/bootstrap\/?$/i;
const TOKEN_BODY_PATH = /^\/api\/(?:widget\/track|realtime\/visitor-presence)\/?$/i;

export const WIDGET_BOOTSTRAP_BODY_LIMIT = '16kb';
export const WIDGET_TEXT_BODY_LIMIT = '64kb';

export function isTextJsonPath(path: string): boolean {
  return BOOTSTRAP_PATH.test(path) || TOKEN_BODY_PATH.test(path);
}

export function jsonBodyParser(): RequestHandler {
  const json = express.json({ limit: '50mb' });
  const widgetBootstrap = express.json({ limit: WIDGET_BOOTSTRAP_BODY_LIMIT, type: ['application/json', 'text/plain'] });
  // text/plain only: an application/json body on these paths keeps the
  // normal parser (body-parser skips a body that is already parsed).
  const widgetText = express.json({ limit: WIDGET_TEXT_BODY_LIMIT, type: 'text/plain' });
  return (req, res, next) => {
    if (BOOTSTRAP_PATH.test(req.path)) return widgetBootstrap(req, res, next);
    if (TOKEN_BODY_PATH.test(req.path)) {
      return widgetText(req, res, (err?: unknown) => (err ? next(err) : json(req, res, next)));
    }
    return json(req, res, next);
  };
}
