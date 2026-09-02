import { Router } from 'express';
import { getManifestDiagnostics } from '../services/widget/manifest.js';
import { getInvitationWorkerStatus } from '../services/invitations/worker.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Invitation outbox worker readiness (Section G).
 *
 * Distinguishes running / draining / stopped so an orchestrator can stop
 * routing to a pod that is draining. Leaks nothing: phase + worker id only.
 */
healthRouter.get('/invitation-worker', (_req, res) => {
  const status = getInvitationWorkerStatus();
  res.set('Cache-Control', 'no-store');
  res.status(status.phase === 'running' ? 200 : 503).json({
    status: status.phase === 'running' ? 'ok' : status.phase,
    ...status,
  });
});

/**
 * CORS deployment diagnostic.
 *
 * Cross-origin login/reset failures are almost always a deployment-env
 * problem (CORS_ORIGINS unset, or the container not restarted after it was
 * set) rather than a code problem: the server answers 403/200 correctly but
 * the browser drops the response because no Access-Control-Allow-Origin
 * header is present. This endpoint makes that state observable without
 * shell access to the container.
 *
 * Leaks nothing: booleans + origin count only, never the configured values.
 */
healthRouter.get('/cors', (req, res) => {
  const config = (req as any).serverConfig as { corsOrigins: string[] } | undefined;
  const origins = config?.corsOrigins ?? [];
  const wildcard = origins.length === 1 && origins[0] === '*';
  const requestOrigin = req.headers.origin;
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    corsConfigured: !wildcard && origins.length > 0,
    originCount: wildcard ? 0 : origins.length,
    requestOriginAllowed: typeof requestOrigin === 'string' && !wildcard && origins.includes(requestOrigin),
  });
});


/**
 * Widget asset diagnostics.
 *
 * Exposes which widget-manifest source the backend resolved (local FS,
 * remote HTTP, or fallback). Use this to verify deploys when the live
 * widget shows `runtime.js?v=dev` / `?v=unresolved`.
 *
 * Safe to expose publicly: it only returns asset filenames + the cache
 * source string, no secrets.
 */
healthRouter.get('/widget', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    manifest: getManifestDiagnostics(),
  });
});
