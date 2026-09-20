/**
 * Structured telephony events. Phone numbers are masked, credentials can
 * never be passed (the type forbids free-form payloads carrying them), and
 * every string goes through the shared redactor before printing.
 */

import { redactSecrets } from '../../lib/redactSecrets.js';
import { maskNumberForLog } from '../../../shared/telephony/phoneNumber.js';

export type TelephonyEventName =
  | 'telephony.registration.started'
  | 'telephony.registration.succeeded'
  | 'telephony.registration.failed'
  | 'telephony.call.incoming'
  | 'telephony.call.ringing'
  | 'telephony.call.answered'
  | 'telephony.call.rejected'
  | 'telephony.call.ended'
  | 'telephony.gateway.error';

export interface TelephonyEventFields {
  workspaceId?: string | null;
  installationId?: string | null;
  callSessionId?: string | null;
  provider?: string | null;
  sipCallId?: string | null;
  callerNumber?: string | null;
  calledNumber?: string | null;
  latencyMs?: number | null;
  errorCode?: string | null;
  detail?: string | null;
}

export function telephonyEvent(name: TelephonyEventName, fields: TelephonyEventFields = {}): void {
  const line = {
    event: name,
    at: new Date().toISOString(),
    workspace_id: fields.workspaceId ?? null,
    installation_id: fields.installationId ?? null,
    call_session_id: fields.callSessionId ?? null,
    provider: fields.provider ?? null,
    sip_call_id: fields.sipCallId ? String(fields.sipCallId).slice(0, 64) : null,
    caller: maskNumberForLog(fields.callerNumber),
    called: maskNumberForLog(fields.calledNumber),
    latency_ms: fields.latencyMs ?? null,
    error_code: fields.errorCode ?? null,
    detail: fields.detail ? redactSecrets(String(fields.detail)).slice(0, 300) : null,
  };
  const serialized = redactSecrets(JSON.stringify(line));
  if (name.endsWith('.failed') || name === 'telephony.gateway.error') console.warn('[telephony]', serialized);
  else console.log('[telephony]', serialized);
}
