/**
 * Dynamic CORS middleware for widget & visitor public routes.
 *
 * Strategy:
 *  - OPTIONS preflight → always reply 204 with the requesting Origin echoed back
 *    (workspace allow-list is enforced on the actual request, not preflight).
 *  - Actual request → echo Origin only when the workspace allows it (or the
 *    workspace has no allow-list configured yet). Bootstrap is allowed to fall
 *    back to body/origin lookup so first-time installs are not blocked.
 *
 * Never returns Access-Control-Allow-Origin: *.
 */

import { Request, Response, NextFunction } from 'express';
import type { ServerConfig } from '../config.js';
import {
  getBootstrapOrigin,
  getWorkspaceOriginRules,
  resolveWorkspaceIdFromOrigin,
} from '../services/widget/public.js';
import { isOriginAllowed } from '../utils/domain.js';

const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Widget-Token, x-widget-token';
const ALLOWED_METHODS = 'GET, POST, PUT, OPTIONS';

function applyCorsHeaders(res: Response, origin: string) {
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

export function widgetCorsMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // Preflight is always answered immediately so the browser can issue the
    // real request — workspace authorization happens there.
    if (req.method === 'OPTIONS') {
      if (origin) applyCorsHeaders(res, origin);
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

    let workspaceId = getWorkspaceId(req);

    // For bootstrap and config endpoints we may not have an explicit workspace
    // yet — try to resolve it from the origin / referrer header.
    if (!workspaceId && (req.path === '/bootstrap' || req.path === '/config')) {
      try {
        workspaceId = await resolveWorkspaceIdFromOrigin(config, getBootstrapOrigin(req));
      } catch {
        workspaceId = null;
      }
    }

    if (!workspaceId) {
      // No workspace context yet — echo origin so bootstrap can proceed; the
      // bootstrap handler itself enforces the allow-list.
      applyCorsHeaders(res, origin);
      return next();
    }

    try {
      const { domains, allowSubdomains } = await getWorkspaceOriginRules(config, workspaceId);

      if (!domains.length || isOriginAllowed(origin, domains, allowSubdomains)) {
        applyCorsHeaders(res, origin);
      }
    } catch {
      // Fail closed: a lookup error means we cannot confirm this origin is
      // allowed for the workspace, so do not echo it back. Do not widen
      // trust on an error path — see widget-cors fail-open fix.
    }

    next();
  };
}
