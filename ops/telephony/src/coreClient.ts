/**
 * Control service → WEBYAR Core internal API.
 *
 * Every request is authenticated with TELEPHONY_INTERNAL_SECRET. Core resolves
 * the workspace itself from the installation id — this service never sends a
 * workspace id it read from a SIP header.
 */

import { timeoutSignal } from './timeout.js';
import { coreAuthHeaders } from './auth.js';

export interface IncomingCallPayload {
  installation_id: string;
  provider: string;
  sip_call_id: string;
  external_call_id?: string | null;
  caller_number?: string | null;
  called_number?: string | null;
  channel_id?: string | null;
}

export interface IncomingCallResult {
  ok: boolean;
  call_session_id?: string;
  room_name?: string;
  duplicate?: boolean;
  error?: string;
  status?: number;
}

export interface CoreClient {
  health(): Promise<boolean>;
  reportRegistrationState(
    installationId: string,
    state: string,
    errorCode?: string | null,
  ): Promise<void>;
  incomingCall(payload: IncomingCallPayload): Promise<IncomingCallResult>;
  callEnded(installationId: string, sipCallId: string, reason?: string): Promise<void>;
}

export function createCoreClient(
  baseUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): CoreClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function post(path: string, body: unknown, timeoutMs = 10_000): Promise<{ status: number; json: any }> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: coreAuthHeaders(secret),
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  return {
    async health() {
      try {
        const res = await fetchImpl(`${base}/internal/telephony/health`, {
          headers: coreAuthHeaders(secret),
          signal: timeoutSignal(6_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async reportRegistrationState(installationId, state, errorCode) {
      await post(`/internal/telephony/registrations/${encodeURIComponent(installationId)}/state`, {
        state,
        error_code: errorCode ?? null,
      }).catch(() => undefined);
    },

    async incomingCall(payload) {
      try {
        const { status, json } = await post('/internal/telephony/calls/incoming', payload, 15_000);
        if (status >= 400) return { ok: false, error: json?.error ?? `http_${status}`, status };
        return {
          ok: true,
          call_session_id: json?.call_session_id,
          room_name: json?.room_name,
          duplicate: Boolean(json?.duplicate),
          status,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    async callEnded(installationId, sipCallId, reason) {
      await post('/internal/telephony/calls/ended', {
        installation_id: installationId,
        sip_call_id: sipCallId,
        reason: reason ?? null,
      }).catch(() => undefined);
    },
  };
}
