/**
 * SINGLE SOURCE OF TRUTH for the Core ↔ Channels internal route contract.
 *
 * PURE module (no I/O, no framework imports) so both deployables can import
 * it without coupling: Core mounts these routes and advertises them on
 * `/ready`, and the Channels Worker checks the advertised list BEFORE it
 * claims a job. A drift between the two used to pause the worker forever.
 */

export const CORE_INTERNAL_SERVICE_NAME = 'core-internal-channels';

/** Every internal route this Core build serves. Handler names only. */
export const INTERNAL_CHANNEL_ROUTES = [
  'POST /ingest',
  'POST /process-inbound',
  'POST /outbound-result',
  'POST /heartbeat',
  'GET /operations/:id',
  'POST /connect-preflight',
  'POST /webhook-contract',
  'POST /operation-result',
  'POST /media-ingest',
  'GET /health',
  'GET /ready',
] as const;

/**
 * The subset the Channels Worker actually calls. Kept narrower than the full
 * contract on purpose: a Core that gains new routes must never pause the
 * worker, only a Core that LOST one the worker depends on.
 */
export const CHANNELS_WORKER_REQUIRED_CORE_ROUTES = [
  'POST /process-inbound',
  'POST /outbound-result',
  'GET /operations/:id',
  'POST /connect-preflight',
  'POST /webhook-contract',
  'POST /operation-result',
  'POST /media-ingest',
] as const;

export type CoreReadinessPayload = {
  service?: string;
  build?: string | null;
  routes?: unknown;
};

export type CoreReadinessVerdict = {
  ready: boolean;
  /** Operator-facing explanation, present only when `ready` is false. */
  reason?: string;
  build: string | null;
};

/** Routes the worker needs that a given Core build does not advertise. */
export function missingWorkerRoutes(advertised: unknown): string[] {
  const routes = Array.isArray(advertised) ? advertised.map(String) : [];
  return CHANNELS_WORKER_REQUIRED_CORE_ROUTES.filter((route) => !routes.includes(route));
}

/**
 * Decides whether a Core `/ready` payload satisfies the worker's contract.
 * Pure, so the readiness handshake is testable without a network.
 */
export function evaluateCoreReadiness(payload: CoreReadinessPayload | null | undefined): CoreReadinessVerdict {
  const build = payload?.build ?? null;
  if (payload?.service !== CORE_INTERNAL_SERVICE_NAME) {
    return {
      ready: false,
      build,
      reason: `CORE_INTERNAL_BASE_URL does not point at the Channels Core service (service=${payload?.service ?? 'unknown'})`,
    };
  }
  const routes = Array.isArray(payload.routes) ? payload.routes.map(String) : [];
  if (routes.length === 0) {
    return {
      ready: false,
      build,
      reason: 'Core readiness response has no route contract; redeploy Core with the current build',
    };
  }
  const missing = missingWorkerRoutes(routes);
  if (missing.length > 0) {
    return {
      ready: false,
      build,
      reason: `Core is missing required routes: ${missing.join(', ')}; redeploy Core with the current build`,
    };
  }
  return { ready: true, build };
}
