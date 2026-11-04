/**
 * The JSON body parser for every route that has no raw-body parser of its own
 * (server/index.ts mounts it after the webhook routes).
 *
 * ── Size limits (audit widgetapi-1, 2026-11-04) ─────────────────────────────
 *
 * This parser runs before the IP block, the abuse check, every rate limiter
 * and every auth check, so its limit is what ANY anonymous client may make the
 * backend allocate and parse. body-parser 1.20 counts `limit` on the INFLATED
 * bytes (read.js pipes a gzip/deflate body through zlib, raw-body counts what
 * comes out), so with inflation on a ~50 KB gzip body became a 50 MB parse.
 *
 * - Inflation is OFF everywhere but the provider webhooks below: no browser,
 *   app, plugin or worker of ours compresses a request body, and a compressed
 *   one now gets a clean 415.
 * - The visitor-facing and pre-sign-in prefixes (PUBLIC_JSON_PREFIXES) get
 *   64 KB. Their largest real bodies are a 5,000-character chat message plus
 *   contact fields (/api/widget/message, /offline-messages, ~20 KB as UTF-8)
 *   and the page-journey telemetry (/smart/event, /nudge/evaluate, a few KB).
 * - The one public route that carries a file, the widget's attachment upload
 *   (POST /api/widget/attachments/:id/upload, base64 JSON, the file at most
 *   widgetAttachments.ts's 25 MB HARD_MAX_BYTES), gets 35 MB on that exact
 *   path only: 25 MiB as base64 is 34.95 MB, plus the `{"data":""}` wrapper.
 * - Provider webhooks parsed here (`/webhooks`, Gmail's Pub/Sub push, a few
 *   hundred bytes) get 1 MB, with inflation kept: it is a third party's body.
 * - Everything else (the signed-in panel, Super Admin, the internal channel
 *   routes) keeps 50 MB: several panel uploads are base64 JSON of up to tens
 *   of MB (conversation attachments, AI knowledge files, bot logs, storage).
 *
 * A body over its limit is refused by body-parser with a 413 (Content-Length
 * checked before reading; a chunked body stops at the limit), which the
 * error handler in server/index.ts answers as JSON, before any handler runs.
 *
 * ── text/plain JSON ─────────────────────────────────────────────────────────
 *
 * Three widget calls are the exception to "application/json only": the loader
 * sends their JSON with NO Content-Type, so the browser labels it text/plain
 * and the cross-origin request stays CORS-simple — no OPTIONS preflight, one
 * round trip less on a visitor's page view:
 *
 *   POST /api/widget/boot, /bootstrap       (16 KB; a body is ~150 bytes)
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
import { PUBLIC_WIDGET_REALTIME_ROUTES } from '../lib/routePrefix.js';

/** Express routes case-insensitively; so does this. */
const BOOTSTRAP_PATH = /^\/api\/widget\/boot(?:strap)?\/?$/i;
const TOKEN_BODY_PATH = /^\/api\/(?:widget\/track|realtime\/visitor-presence)\/?$/i;
const WIDGET_ATTACHMENT_UPLOAD_PATH = /^\/api\/widget\/attachments\/[^/]+\/upload\/?$/i;

export const WIDGET_BOOTSTRAP_BODY_LIMIT = '16kb';
export const WIDGET_TEXT_BODY_LIMIT = '64kb';
export const PUBLIC_JSON_BODY_LIMIT = '64kb';
export const WIDGET_ATTACHMENT_UPLOAD_BODY_LIMIT = '35mb';
export const WEBHOOK_JSON_BODY_LIMIT = '1mb';
export const PANEL_JSON_BODY_LIMIT = '50mb';

/**
 * Prefixes reached without a session: the widget (chat, KB, commerce
 * identity), the visitors API, the call widget, and the sign-in, sign-up,
 * phone check and unsubscribe routes.
 */
export const PUBLIC_JSON_PREFIXES = [
  '/api/widget',
  '/api/visitors',
  '/api/call-widget',
  '/api/auth',
  '/api/auth-email',
  '/api/phone-verification',
  '/api/notifications/email/unsubscribe',
  '/api/platform/public',
] as const;

/** Third-party webhooks parsed by this parser (not by a raw parser of their own). */
export const WEBHOOK_JSON_PREFIXES = ['/webhooks'] as const;

const PUBLIC_REALTIME_PATHS = new Set<string>(PUBLIC_WIDGET_REALTIME_ROUTES.map((p) => p.toLowerCase()));

function underPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Lower-cased, without trailing slashes: how Express matches a mount. */
function normalize(path: string): string {
  const lower = path.toLowerCase();
  const trimmed = lower.replace(/\/+$/, '');
  return trimmed || '/';
}

export type JsonBodyClass = 'widget-attachment-upload' | 'public' | 'webhook' | 'panel';

export function jsonBodyClassOf(path: string): JsonBodyClass {
  const p = normalize(path);
  if (WIDGET_ATTACHMENT_UPLOAD_PATH.test(p)) return 'widget-attachment-upload';
  if (underPrefix(p, PUBLIC_JSON_PREFIXES) || PUBLIC_REALTIME_PATHS.has(p)) return 'public';
  if (underPrefix(p, WEBHOOK_JSON_PREFIXES)) return 'webhook';
  return 'panel';
}

export function isTextJsonPath(path: string): boolean {
  return BOOTSTRAP_PATH.test(path) || TOKEN_BODY_PATH.test(path);
}

export function jsonBodyParser(): RequestHandler {
  const byClass: Record<JsonBodyClass, RequestHandler> = {
    'widget-attachment-upload': express.json({ limit: WIDGET_ATTACHMENT_UPLOAD_BODY_LIMIT, inflate: false }),
    public: express.json({ limit: PUBLIC_JSON_BODY_LIMIT, inflate: false }),
    webhook: express.json({ limit: WEBHOOK_JSON_BODY_LIMIT }),
    panel: express.json({ limit: PANEL_JSON_BODY_LIMIT, inflate: false }),
  };
  const widgetBootstrap = express.json({
    limit: WIDGET_BOOTSTRAP_BODY_LIMIT,
    inflate: false,
    type: ['application/json', 'text/plain'],
  });
  // text/plain only: an application/json body on these paths keeps the
  // public parser (body-parser skips a body that is already parsed).
  const widgetText = express.json({ limit: WIDGET_TEXT_BODY_LIMIT, inflate: false, type: 'text/plain' });
  return (req, res, next) => {
    if (BOOTSTRAP_PATH.test(req.path)) return widgetBootstrap(req, res, next);
    const json = byClass[jsonBodyClassOf(req.path)];
    if (TOKEN_BODY_PATH.test(req.path)) {
      return widgetText(req, res, (err?: unknown) => (err ? next(err) : json(req, res, next)));
    }
    return json(req, res, next);
  };
}
