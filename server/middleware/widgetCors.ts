/**
 * Dynamic CORS middleware for widget & visitor public routes.
 * Returns the exact incoming Origin when it matches the workspace's allowed domains.
 * Never returns Access-Control-Allow-Origin: *.
 */

import { Request, Response, NextFunction } from 'express';
import { extractHostname, isOriginAllowed } from '../utils/domain.js';
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';

// Simple in-memory cache for widget settings to avoid DB hit on every OPTIONS
const settingsCache = new Map<string, { domains: string[]; allowSubs: boolean; ts: number }>();
const CACHE_TTL = 60_000; // 1 min

async function getWidgetDomains(config: ServerConfig, workspaceId: string) {
  const cached = settingsCache.get(workspaceId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  const sb = getServiceClient(config);
  const [{ data: widgetData }, { data: domainData }] = await Promise.all([
    sb
      .from('widget_settings')
      .select('allowed_domains, allow_subdomains')
      .eq('workspace_id', workspaceId)
      .single(),
    sb
      .from('workspace_domains')
      .select('domain, verified')
      .eq('workspace_id', workspaceId)
      .eq('verified', true),
  ]);

  const mergedDomains = [
    ...(((widgetData?.allowed_domains as string[]) || []).filter(Boolean)),
    ...(((domainData || []).map((row: any) => row.domain)).filter(Boolean)),
  ];

  const uniqueDomains = Array.from(new Set(mergedDomains));

  const result = {
    domains: uniqueDomains,
    allowSubs: (widgetData?.allow_subdomains as boolean) ?? false,
    ts: Date.now(),
  };
  settingsCache.set(workspaceId, result);
  return result;
}

function getWorkspaceId(req: Request): string | null {
  return (
    (req.query.workspace_id as string) ||
    (req.body?.workspace_id as string) ||
    null
  );
}

export function widgetCorsMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    if (!origin) return next();

    const config = (req as any).serverConfig as ServerConfig;
    const workspaceId = getWorkspaceId(req);

    if (!workspaceId || !config) {
      return next();
    }

    try {
      const { domains, allowSubs } = await getWidgetDomains(config, workspaceId);

      if (!domains.length || isOriginAllowed(origin, domains, allowSubs)) {
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
