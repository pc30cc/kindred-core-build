/**
 * Telephony Control Service → Core internal API.
 *
 * Authenticated in BOTH directions: the gateway presents
 * TELEPHONY_INTERNAL_SECRET here, and Core presents the same secret when it
 * calls the gateway. With the secret unset every route answers 401 — there is
 * no unauthenticated mode, not even in development.
 *
 * Nothing on this router is reachable from a browser session, and no route
 * accepts a caller-supplied workspace_id: the workspace is always resolved
 * from the registered installation.
 */

import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import { handleIncomingCall } from '../services/telephony/ingress.js';
import { endTelephonyCall } from '../services/telephony/lifecycle.js';
import { setRegistrationState } from '../services/telephony/registrations.js';
import { telephonyEvent } from '../services/telephony/observability.js';
import { getServiceClient } from '../supabase.js';
import type { RegistrationState, TelephonyErrorCode } from '../services/telephony/types.js';

const REGISTRATION_STATES: RegistrationState[] = [
  'not_configured', 'configured', 'registering', 'registered', 'failed', 'disabled',
];

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function presentedSecret(req: Request): string | null {
  const header = req.header('x-telephony-internal-secret');
  if (header) return header;
  const auth = req.header('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

export function createInternalTelephonyRouter(config: ServerConfig): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    const expected = config.telephonyInternalSecret;
    if (!expected) {
      return res.status(401).json({ error: 'telephony_internal_secret_not_configured' });
    }
    const presented = presentedSecret(req);
    if (!presented || !safeEqual(presented, expected)) {
      telephonyEvent('telephony.gateway.error', { errorCode: 'internal_auth_rejected', detail: req.path });
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  });

  /** Liveness for the gateway's own startup checks. */
  router.get('/health', (_req, res) => res.json({ ok: true, service: 'webyar-core-telephony' }));

  /**
   * Registration state reported by Asterisk. Core stores it; it never guesses
   * it from the presence of a saved password.
   */
  router.post('/registrations/:installationId/state', async (req, res) => {
    const installationId = String(req.params.installationId || '');
    const state = String(req.body?.state || '') as RegistrationState;
    if (!installationId || !REGISTRATION_STATES.includes(state)) {
      return res.status(400).json({ error: 'invalid_state' });
    }
    const errorCode = req.body?.error_code ? (String(req.body.error_code) as TelephonyErrorCode) : null;
    try {
      await setRegistrationState(config, installationId, state, errorCode);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'state_write_failed', message: (err as Error).message });
    }
  });

  /**
   * Inbound INVITE notification. Idempotent by (installation, provider,
   * sip_call_id): repeated deliveries return the same room and session.
   */
  router.post('/calls/incoming', async (req, res) => {
    const body = req.body ?? {};
    const installationId = String(body.installation_id || '');
    const sipCallId = String(body.sip_call_id || '');
    if (!installationId || !sipCallId) return res.status(400).json({ error: 'missing_identifiers' });

    try {
      const result = await handleIncomingCall(config, {
        installationId,
        provider: String(body.provider || 'daftareshoma'),
        sipCallId,
        externalCallId: body.external_call_id ? String(body.external_call_id) : null,
        callerNumber: body.caller_number ? String(body.caller_number) : null,
        calledNumber: body.called_number ? String(body.called_number) : null,
        asteriskChannelId: body.channel_id ? String(body.channel_id) : null,
      });
      if (!result.ok) {
        const status = result.reason === 'unknown_installation' ? 404
          : result.reason === 'voice_not_entitled' ? 403
            : result.reason === 'installation_disabled' ? 409
              : 500;
        return res.status(status).json({ error: result.reason });
      }
      return res.json({
        ok: true,
        call_session_id: result.callSessionId,
        room_name: result.roomName,
        duplicate: result.duplicate,
      });
    } catch (err) {
      return res.status(500).json({ error: 'incoming_failed', message: (err as Error).message });
    }
  });

  /**
   * Provider-side termination (caller hung up, SIP failure, LiveKit teardown).
   * Converges on the same idempotent ended lifecycle as an operator hangup.
   */
  router.post('/calls/ended', async (req, res) => {
    const body = req.body ?? {};
    const installationId = String(body.installation_id || '');
    const sipCallId = String(body.sip_call_id || '');
    if (!installationId || !sipCallId) return res.status(400).json({ error: 'missing_identifiers' });

    try {
      const sb = getServiceClient(config);
      const { data } = await sb
        .from('telephony_calls')
        .select('workspace_id,call_session_id')
        .eq('installation_id', installationId)
        .eq('sip_call_id', sipCallId)
        .maybeSingle();
      if (!data?.call_session_id) return res.json({ ok: true, unknown: true });

      await endTelephonyCall(config, {
        workspaceId: data.workspace_id as string,
        callSessionId: data.call_session_id as string,
        endedBy: 'visitor',
        reason: body.reason ? String(body.reason).slice(0, 80) : null,
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'end_failed', message: (err as Error).message });
    }
  });

  return router;
}
