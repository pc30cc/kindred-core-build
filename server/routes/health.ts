import { Router } from 'express';
import { getManifestDiagnostics } from '../services/widget/manifest.js';
import { getInvitationWorkerStatus } from '../services/invitations/worker.js';
import { databaseStatus } from '../db/status.js';
import { clusterRole, clusterWorkerIndex, clusterWorkerReady } from '../cluster/role.js';
import { sharedCall } from '../cluster/client.js';
import type { ClusterStatus } from '../cluster/protocol.js';

export const healthRouter = Router();

/**
 * The container's liveness probe (Coolify's health check). In cluster mode
 * (BACKEND_PROCESSES, docs/operations/BACKEND_PROCESSES.md) a worker answers
 * 503 `starting` until the primary reports every worker listening, so a new
 * container counts as healthy only once the whole cluster is up, and the old
 * one keeps serving until then; after that, 200 for the worker's whole life.
 * The single process answers as it always did.
 */
healthRouter.get('/', (_req, res) => {
  if (!clusterWorkerReady()) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ status: 'starting', timestamp: new Date().toISOString() });
  }
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Cluster mode only (not mounted otherwise): how many workers run, listen
 * and were restarted. Counts only, no pid.
 */
if (clusterRole() !== 'single') {
  healthRouter.get('/cluster', async (_req, res) => {
    const status = await sharedCall<ClusterStatus | null>('cluster.status', null, () => null, { fallback: () => null });
    res.set('Cache-Control', 'no-store');
    if (!status) return res.status(503).json({ status: 'unavailable' });
    return res.status(status.ready && status.listening === status.processes ? 200 : 503).json({
      status: status.ready ? 'ok' : 'starting',
      ...status,
    });
  });
}

/**
 * Database reachability: which driver is in use and, for a direct
 * DATABASE_URL connection, the server's major version, the role queries run
 * as and the round-trip time. Leaks no host, user or password. It checks the
 * pool of the process that answered: in cluster mode (BACKEND_PROCESSES) the
 * answer names that worker's index (`worker`), never its pid.
 */
healthRouter.get('/database', async (_req, res) => {
  const status = await databaseStatus();
  const worker = clusterRole() === 'single' ? {} : { worker: clusterWorkerIndex() };
  res.set('Cache-Control', 'no-store');
  res.status(status.ok ? 200 : 503).json({ status: status.ok ? 'ok' : 'unavailable', ...status, ...worker, error: status.ok ? undefined : 'database_unreachable' });
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
  const config = (req as unknown as { serverConfig?: { corsOrigins: string[] } }).serverConfig;
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
