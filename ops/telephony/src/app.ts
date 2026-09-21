/**
 * WEBYAR Telephony Control Service — HTTP surface.
 *
 * Exactly the routes Core's gatewayClient.ts calls, all behind
 * TELEPHONY_INTERNAL_SECRET. Never returns a SIP password, and never echoes
 * one into an error message or a log line.
 */

import express, { type Express } from 'express';
import { internalAuth } from './auth.js';
import { collectHealth } from './health.js';
import {
  parseProvisionRequest,
  provisionRegistration,
  removeRegistration,
  testRegistration,
  type RegistrationDeps,
} from './registrations.js';
import type { AsteriskControl } from './asteriskAri.js';
import type { RealtimeStore } from './database.js';
import type { LiveKitSipClient } from './livekitSip.js';
import type { CoreClient } from './coreClient.js';
import type { CallOrchestrator } from './incomingCalls.js';

export interface AppDeps {
  internalSecret: string;
  store: RealtimeStore;
  asterisk: AsteriskControl;
  livekit: LiveKitSipClient;
  core: CoreClient;
  orchestrator: CallOrchestrator;
  publicSipHost: string;
  registrationTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const log = deps.log ?? (() => undefined);
  const regDeps: RegistrationDeps = {
    store: deps.store,
    asterisk: deps.asterisk,
    publicSipHost: deps.publicSipHost,
    timeoutMs: deps.registrationTimeoutMs,
    sleep: deps.sleep,
  };

  const router = express.Router();
  router.use(internalAuth(deps.internalSecret));

  router.get('/health', async (_req, res) => {
    const report = await collectHealth(deps);
    res.status(report.gateway_healthy ? 200 : 503).json(report);
  });

  /** Idempotent, tenant-scoped provisioning + real REGISTER. */
  router.put('/registrations/:installationId', async (req, res) => {
    const parsed = parseProvisionRequest(String(req.params.installationId || ''), req.body ?? {});
    if (!parsed.ok) {
      // Field names only — never the offending value (it may be the password).
      return res.status(400).json({ error: 'invalid_request', error_code: 'not_configured', fields: 'errors' in parsed ? parsed.errors : [] });
    }
    try {
      log('telephony.registration.started', { installationId: parsed.value.installationId });
      const result = await provisionRegistration(regDeps, parsed.value);
      log(result.state === 'registered' ? 'telephony.registration.succeeded' : 'telephony.registration.failed', {
        installationId: parsed.value.installationId,
        state: result.state,
        errorCode: result.errorCode,
      });
      void deps.core.reportRegistrationState(parsed.value.installationId, result.state, result.errorCode);
      return res.json({ state: result.state, error_code: result.errorCode ?? undefined });
    } catch (err) {
      const message = (err as Error).message;
      const code = /ECONNREFUSED|timeout|pool|database|pg/i.test(message)
        ? 'gateway_unavailable'
        : 'unknown_error';
      log('telephony.registration.failed', { installationId: parsed.value.installationId, errorCode: code });
      return res.status(503).json({ error: 'provisioning_failed', error_code: code });
    }
  });

  router.delete('/registrations/:installationId', async (req, res) => {
    const installationId = String(req.params.installationId || '');
    try {
      const removed = await removeRegistration(regDeps, installationId);
      void deps.core.reportRegistrationState(installationId, 'disabled', null);
      return res.json({ removed });
    } catch {
      return res.status(503).json({ error: 'remove_failed', error_code: 'gateway_unavailable' });
    }
  });

  /**
   * Real Test Connection: kicks a fresh REGISTER and reports what Asterisk
   * actually observed. Database rows alone never produce `registered`.
   */
  router.post('/registrations/:installationId/test', async (req, res) => {
    const installationId = String(req.params.installationId || '');
    try {
      const [result, livekit] = await Promise.all([
        testRegistration(regDeps, installationId),
        deps.livekit.ready(),
      ]);
      return res.json({
        state: result.state,
        error_code: result.errorCode ?? undefined,
        livekit_sip_ready: livekit.ok,
      });
    } catch (err) {
      const message = (err as Error).message;
      const code = /ENOTFOUND|EAI_AGAIN|dns/i.test(message) ? 'dns_failure' : 'gateway_unavailable';
      return res.status(503).json({ error: 'test_failed', error_code: code });
    }
  });

  /** Call control from Core (answer carries the room Core chose). */
  router.post('/calls/control', async (req, res) => {
    const body = req.body ?? {};
    const sipCallId = String(body.sip_call_id || '');
    const action = String(body.action || '');
    if (!sipCallId || !['answer', 'reject', 'hangup'].includes(action)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      if (action === 'answer') {
        await deps.orchestrator.answer(sipCallId, body.room_name ? String(body.room_name) : null);
      } else if (action === 'reject') {
        await deps.orchestrator.reject(sipCallId);
      } else {
        await deps.orchestrator.hangup(sipCallId);
      }
      return res.json({ ok: true });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'unknown_call') return res.status(404).json({ error: 'unknown_call' });
      if (message === 'missing_room') return res.status(400).json({ error: 'missing_room' });
      return res.status(503).json({ error: 'control_failed', error_code: 'gateway_unavailable' });
    }
  });

  app.use('/internal/telephony', router);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}
