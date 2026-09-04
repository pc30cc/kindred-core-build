/**
 * Dynamic CORS middleware for widget & visitor public routes.
 *
 * This module is the ONE canonical place that decides whether a
 * credentialed widget response may be exposed to a cross-origin caller and
 * the ONE place that writes the CORS response headers. Route handlers must
 * never set `Access-Control-Allow-Origin` themselves — a partial contract
 * (ACAO without Allow-Credentials, or ACAO written for an origin this
 * module deliberately refused) is exactly the failure mode that broke
 * /api/widget/session/refresh in production.
 *
 * Workspace resolution order (most → least authoritative):
 *   1. `X-Widget-Token` — verified with the canonical HMAC verifier, so the
 *      workspace id is SERVER-SIGNED and cannot be chosen by the caller.
 *      /session/refresh uses the refresh-grace verifier so a
 *      recently-expired-but-refreshable token can still establish its
 *      signed workspace/origin context (otherwise the very request meant to
 *      recover the session is the one the browser blocks).
 *   2. Explicit `workspace_id` in query/body (bootstrap, realtime connect).
 *   3. Origin → workspace lookup, for /bootstrap and /config only.
 *
 * Strategy:
 *  - OPTIONS preflight → always reply 204 with the requesting Origin echoed
 *    back (workspace allow-list is enforced on the actual request).
 *  - Actual request → echo Origin only when the workspace allows it.
 *
 * Never returns Access-Control-Allow-Origin: *. Fail-closed everywhere: an
 * invalid, forged or expired-beyond-grace token contributes nothing, and a
 * token for workspace A can only ever authorize workspace A's origins.
 */

import { Request, Response, NextFunction } from 'express';
import type { ServerConfig } from '../config.js';
import {
  getBootstrapOrigin,
  getWorkspaceOriginRules,
  getRequestBaseUrl,
  resolveWorkspaceIdFromOrigin,
} from '../services/widget/public.js';
import { verifySessionToken, verifyTokenForRefresh } from '../services/widget/security.js';
import { isOriginAllowed, toStrictOrigin } from '../utils/domain.js';

const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Widget-Token, x-widget-token';
const ALLOWED_METHODS = 'GET, POST, PUT, OPTIONS';

/**
 * Canonical credentialed-CORS response contract. Exported so any other
 * layer that needs to express "this origin is authorized" uses the exact
 * same header set instead of re-implementing a partial one.
 */
export function applyWidgetCorsHeaders(res: Response, origin: string) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '3600');
  res.setHeader('Vary', 'Origin');
}

function getWorkspaceId(req: Request): string | null {
  return (
    (req.query.workspace_id as string) ||
    (req.body?.workspace_id as string) ||
    (req.body?.workspaceId as string) ||
    null
  );
}

/** True for the session-refresh endpoint, where refresh-grace applies. */
function isSessionRefreshPath(req: Request): boolean {
  const p = req.path || '';
  const full = req.originalUrl || '';
  return p === '/session/refresh' || full.split('?')[0].endsWith('/api/widget/session/refresh');
}

/**
 * Server-signed workspace context derived from the widget session token.
 * Returns null for a missing, malformed, forged or expired-beyond-grace
 * token — such a token must never widen CORS in any way.
 */
function getTokenContext(req: Request): { workspaceId: string; tokenOrigin: string } | null {
  const raw = req.headers['x-widget-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (typeof token !== 'string' || !token) return null;
  const result = isSessionRefreshPath(req) ? verifyTokenForRefresh(token) : verifySessionToken(token);
  if (!result.valid || !result.workspaceId) return null;
  return { workspaceId: result.workspaceId, tokenOrigin: (result.origin || '').toLowerCase().replace(/\/+$/, '') };
}

/**
 * Same-origin fallback: when we cannot positively authorize the origin
 * (no workspace context, or the workspace has no allow-list configured yet)
 * the ONLY origin we still echo is our own host. Everything else gets no
 * CORS headers at all, so the browser blocks the cross-origin read.
 */
function isSameOrigin(req: Request, origin: string): boolean {
  // Browser origin semantics: scheme + host + effective port must all match.
  const requestOrigin = toStrictOrigin(origin);
  const selfOrigin = toStrictOrigin(getRequestBaseUrl(req));
  return !!requestOrigin && !!selfOrigin && requestOrigin === selfOrigin;
}

export function widgetCorsMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // Preflight is always answered immediately so the browser can issue the
    // real request — workspace authorization happens there.
    if (req.method === 'OPTIONS') {
      if (origin) applyWidgetCorsHeaders(res, origin);
      return res.status(204).end();
    }

    if (!origin) return next();

    const config = (req as any).serverConfig as ServerConfig;
    if (!config) {
      // Fail closed: no server config means we cannot verify the workspace's
      // origin allow-list, so do not echo Access-Control-Allow-Origin (which,
      // combined with Allow-Credentials, would let any origin read
      // cookie-authenticated widget responses). The browser will surface a
      // CORS error to the client, which is the safe outcome here.
      return next();
    }

    // 1) Server-signed workspace from the widget session token. This is the
    //    only resolution path available to token-secured routes that carry
    //    no workspace_id at all (notably /session/refresh).
    const tokenCtx = getTokenContext(req);
    let workspaceId = tokenCtx?.workspaceId || null;

    // 2) Client-declared workspace. Only consulted when the token did not
    //    already pin one — a token for workspace A can never be used to
    //    resolve workspace B's allow-list.
    if (!workspaceId) workspaceId = getWorkspaceId(req);

    // 3) For bootstrap and config endpoints we may not have an explicit
    //    workspace yet — resolve it from the origin / referrer header.
    if (!workspaceId && (req.path === '/bootstrap' || req.path === '/config')) {
      try {
        workspaceId = await resolveWorkspaceIdFromOrigin(config, getBootstrapOrigin(req));
      } catch {
        workspaceId = null;
      }
    }

    if (!workspaceId) {
      // Fail closed: we cannot tie this request to a workspace, so we cannot
      // verify the origin. Only our own origin is echoed back; any third-party
      // origin gets no CORS headers (the request still reaches the handler,
      // the browser just refuses to expose the response).
      if (isSameOrigin(req, origin)) applyWidgetCorsHeaders(res, origin);
      return next();
    }

    try {
      const { domains, allowSubdomains } = await getWorkspaceOriginRules(config, workspaceId);

      if (domains.length) {
        if (isOriginAllowed(origin, domains, allowSubdomains)) applyWidgetCorsHeaders(res, origin);
      } else if (isSameOrigin(req, origin)) {
        // Unconfigured allow-list is NOT "allow all" — same-origin only.
        applyWidgetCorsHeaders(res, origin);
      } else if (
        tokenCtx &&
        tokenCtx.workspaceId === workspaceId &&
        tokenCtx.tokenOrigin &&
        tokenCtx.tokenOrigin === origin.toLowerCase().replace(/\/+$/, '')
      ) {
        // Workspace has NOT configured an allow-list yet AND the caller
        // presents a server-signed token whose bound origin is exactly this
        // Origin. The binding was written by our own bootstrap, so this is
        // strictly narrower than the previous behaviour (where the widget
        // routes echoed any origin unconditionally) and cannot leak another
        // workspace's data: the token pins the workspace, and the signed
        // origin pins the domain. Configured workspaces never reach here.
        applyWidgetCorsHeaders(res, origin);
      }
    } catch {
      // Fail closed: a lookup error means we cannot confirm this origin is
      // allowed for the workspace, so do not echo it back. Do not widen
      // trust on an error path — see widget-cors fail-open fix.
    }

    next();
  };
}
