/**
 * Pre-auth trusted workspace context
 * ==================================
 *
 * Public (pre-token) widget/visitor endpoints legitimately receive a
 * `workspace_id` in the body/query — but a raw identifier is NOT proof that a
 * request is a legitimate visitor of that workspace. Without validation an
 * anonymous attacker rotating IPs could drain the victim workspace's shared
 * per-workspace rate-limit bucket.
 *
 * This middleware runs AFTER the per-IP limiter and BEFORE the per-workspace
 * limiter. It performs the same canonical server-side validation the handler
 * performs (workspace existence + origin / public-key / session authority) and
 * only then attaches:
 *
 *   req._rateLimitTrustedWorkspaceId
 *
 * If validation does not conclusively prove the target workspace — unknown
 * workspace, unauthorized origin, mismatching session, DB failure, wrong HTTP
 * method — nothing is attached and the limiter falls back to the IP bucket.
 * It never rejects the request itself: authorization stays the handler's job,
 * so existing endpoint semantics (403/404/500 bodies) are unchanged.
 */

import type { Request, Response, NextFunction } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  getWorkspaceOriginRules,
  isWorkspaceOriginAllowed,
  resolveWorkspaceIdFromOrigin,
} from '../services/widget/public.js';
import { findWorkspaceByPublicKey, originAllowed } from '../services/callCenter/settings.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Resolver = (req: Request, config: ServerConfig) => Promise<string | null>;

interface PreAuthRoute {
  method: string;
  /** Matched against the path WITHOUT query string, mount-prefix included. */
  pattern: RegExp;
  resolve: Resolver;
}

export function requestPath(req: Request): string {
  const raw = (req as any).originalUrl || req.url || (req as any).path || '';
  return String(raw).split('?')[0];
}

function requestOrigin(req: Request): string | null {
  const o = req.headers?.origin;
  if (typeof o === 'string' && o) return o;
  const r = req.headers?.referer;
  if (typeof r === 'string' && r) {
    try { return new URL(r).origin; } catch { return null; }
  }
  return null;
}

function hostOrigin(req: Request): string | null {
  const proto = (req.headers?.['x-forwarded-proto'] as string) || (req as any).protocol || 'https';
  const host = typeof req.headers?.host === 'string' ? req.headers.host : '';
  return host ? `${proto}://${host}` : null;
}

function isLocalDevOrigin(origin: string | null): boolean {
  return !!origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * An origin proves a workspace only when the workspace actually publishes an
 * allow-list AND the origin matches it. `isWorkspaceOriginAllowed` returns
 * true for an EMPTY allow-list (legacy same-origin-only installs); that is not
 * proof of targeting, so it can never mint a trusted workspace here.
 */
async function originProvesWorkspace(
  config: ServerConfig,
  workspaceId: string,
  origin: string | null,
): Promise<boolean> {
  if (!origin) return false;
  const rules = await getWorkspaceOriginRules(config, workspaceId);
  if (!rules.domains.length) return false;
  return isWorkspaceOriginAllowed(config, workspaceId, origin);
}

// ─── Per-route resolvers ────────────────────────────────────────────

/** POST /api/widget/bootstrap — workspace by explicit id or verified origin mapping. */
const resolveWidgetBootstrap: Resolver = async (req, config) => {
  const origin = requestOrigin(req);
  const byOrigin = origin ? await resolveWorkspaceIdFromOrigin(config, origin) : null;

  const claimed = typeof req.body?.workspace_id === 'string' ? req.body.workspace_id.trim() : '';
  if (!claimed) return byOrigin; // origin mapping is itself proof

  if (byOrigin) return byOrigin === claimed ? claimed : null;
  if (!UUID_RE.test(claimed)) return null;

  // Explicit id: require the workspace to exist and the origin to match its
  // published allow-list. Localhost is accepted for local development only.
  const supabase = getServiceClient(config);
  const { data: ws, error } = await supabase
    .from('workspaces').select('id').eq('id', claimed).maybeSingle();
  if (error || !ws) return null;

  if (isLocalDevOrigin(origin)) return claimed;
  return (await originProvesWorkspace(config, claimed, origin)) ? claimed : null;
};

/** POST /api/visitors/track — workspace + tracking enabled + allowed origin. */
const resolveVisitorTrack: Resolver = async (req, config) => {
  const claimed = typeof req.body?.workspace_id === 'string' ? req.body.workspace_id.trim() : '';
  if (!claimed || !UUID_RE.test(claimed)) return null;

  const supabase = getServiceClient(config);
  const { data: widget, error } = await supabase
    .from('widget_settings')
    .select('visitor_tracking_enabled')
    .eq('workspace_id', claimed)
    .maybeSingle();
  if (error || !widget || widget.visitor_tracking_enabled !== true) return null;

  const origin = requestOrigin(req);
  if (isLocalDevOrigin(origin)) return claimed;
  return (await originProvesWorkspace(config, claimed, origin)) ? claimed : null;
};

/**
 * POST /api/visitors/heartbeat and /disconnect — the visitor session row is the
 * authority. A body `workspace_id` that disagrees with the session's owner is
 * ignored entirely (never trusted, never used to select a bucket).
 */
const resolveVisitorSessionOwner: Resolver = async (req, config) => {
  const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.trim() : '';
  if (!sessionId || !UUID_RE.test(sessionId)) return null;

  const supabase = getServiceClient(config);
  const { data: session, error } = await supabase
    .from('visitor_sessions')
    .select('workspace_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !session?.workspace_id) return null;

  const claimed = typeof req.body?.workspace_id === 'string' ? req.body.workspace_id.trim() : '';
  if (claimed && claimed !== session.workspace_id) return null;
  return session.workspace_id as string;
};

/**
 * GET /api/widget/kb/* — public reads. The only proof available is the request
 * Host, resolved through the same verified `workspace_domains` mapping the KB
 * routes use. A `workspace_id` query param is a hint only: it must agree with
 * the host-resolved workspace, otherwise no workspace bucket is granted.
 */
const resolveKbHost: Resolver = async (req, config) => {
  const host = hostOrigin(req);
  const byHost = host ? await resolveWorkspaceIdFromOrigin(config, host) : null;
  if (!byHost) return null;
  const claimed = typeof req.query?.workspace_id === 'string' ? req.query.workspace_id.trim() : '';
  if (claimed && claimed !== byHost) return null;
  return byHost;
};

/**
 * GET /api/call-widget/bootstrap — trusted only via a real `publicKey` whose
 * workspace also authorizes the request Origin. A bare `workspaceId` query is
 * an unauthenticated identifier and never mints a workspace bucket.
 */
const resolveCallWidgetBootstrap: Resolver = async (req, config) => {
  const publicKey = typeof req.query?.publicKey === 'string' ? req.query.publicKey.trim() : '';
  if (!publicKey) return null;

  const ws = await findWorkspaceByPublicKey(config, publicKey);
  if (!ws) return null;

  const claimed = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (claimed && claimed !== ws.workspace_id) return null;

  return originAllowed(ws, requestOrigin(req)) ? ws.workspace_id : null;
};

/**
 * Explicit METHOD + PATH table. A path alone is never enough: e.g. only
 * `POST /api/widget/bootstrap` is a pre-auth workspace route — GET/PUT/DELETE
 * on the same path get no pre-auth workspace classification.
 */
export const PRE_AUTH_WORKSPACE_ROUTES: PreAuthRoute[] = [
  { method: 'POST', pattern: /^\/api\/widget\/bootstrap\/?$/, resolve: resolveWidgetBootstrap },
  { method: 'POST', pattern: /^\/api\/visitors\/track\/?$/, resolve: resolveVisitorTrack },
  { method: 'POST', pattern: /^\/api\/visitors\/heartbeat\/?$/, resolve: resolveVisitorSessionOwner },
  { method: 'POST', pattern: /^\/api\/visitors\/disconnect\/?$/, resolve: resolveVisitorSessionOwner },
  { method: 'GET', pattern: /^\/api\/widget\/kb(\/|$)/, resolve: resolveKbHost },
  { method: 'GET', pattern: /^\/api\/call-widget\/bootstrap\/?$/, resolve: resolveCallWidgetBootstrap },
];

export function matchPreAuthWorkspaceRoute(req: Request): PreAuthRoute | null {
  const method = String(req.method || '').toUpperCase();
  const path = requestPath(req);
  return PRE_AUTH_WORKSPACE_ROUTES.find((r) => r.method === method && r.pattern.test(path)) || null;
}

/**
 * Attach a validated workspace identity for the per-workspace limiter.
 * Fail-safe: any error resolves to "no trusted workspace" (IP bucket), never
 * to the raw client-supplied id.
 */
export function preAuthWorkspaceContext() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      // A presented widget/call token is handled by the limiter's own
      // cryptographic path — don't do pre-auth DB work for those requests.
      if (req.headers?.['x-widget-token'] || req.headers?.['x-cc-session']) return next();

      const route = matchPreAuthWorkspaceRoute(req);
      if (!route) return next();

      const config = (req as any).serverConfig as ServerConfig | undefined;
      if (!config) return next();

      const workspaceId = await route.resolve(req, config);
      if (workspaceId) (req as any)._rateLimitTrustedWorkspaceId = workspaceId;
    } catch (err: any) {
      // Fail-safe, not fail-open: no trusted workspace => IP-only limiting.
      console.warn('[pre-auth-workspace] validation failed:', err?.message);
    }
    next();
  };
}
