/**
 * Dynamic CORS middleware for widget & visitor public routes.
 * Returns the exact incoming Origin when it matches the workspace's allowed domains.
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

    if (!origin) return next();

    const config = (req as any).serverConfig as ServerConfig;
    let workspaceId = getWorkspaceId(req);

    if (!workspaceId && req.path === '/config' && config) {
      workspaceId = await resolveWorkspaceIdFromOrigin(config, getBootstrapOrigin(req));
    }

    if (!workspaceId || !config) {
      return next();
    }

    try {
      const { domains, allowSubdomains } = await getWorkspaceOriginRules(config, workspaceId);

      if (!domains.length || isOriginAllowed(origin, domains, allowSubdomains)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Vary', 'Origin');

        if (req.method === 'OPTIONS') {
          return res.status(204).end();
        }
      }
    } catch {
    }

    next();
  };
}
