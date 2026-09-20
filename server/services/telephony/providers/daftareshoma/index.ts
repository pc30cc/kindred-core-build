/**
 * DaftareShoma adapter — the first implementation of the provider-neutral
 * WEBYAR Telephony layer.
 *
 * SIP is the authoritative path for live calling: registration and media are
 * handled by Asterisk/PJSIP + LiveKit SIP, not by any REST endpoint. The REST
 * surface below is therefore DEFERRED on purpose.
 *
 * Deferred until the published DaftareShoma API documentation can be read and
 * confirmed (portal.daftareshoma.com/openAPIHelp, coreapi.daftareshoma.com):
 *   - getCallHistory()     — call reporting/history reconciliation
 *   - startOutgoingCall()  — click-to-call / outbound
 *   - getRecording()       — provider-side recording retrieval
 *   - reconcileCall()      — post-call reconciliation of a single dialog
 *
 * No endpoint path, schema or auth header is guessed here. The interface
 * exists so future work slots in without touching the Call Center.
 */

import type { TelephonySipSettings } from '../../types.js';
import { accountIdentity } from '../../settings.js';

export const DAFTARESHOMA_PROVIDER_ID = 'daftareshoma';
export const DAFTARESHOMA_HELP_URL =
  'https://daftareshoma.com/help/docs/kb/portal-setting/SIPphone-setting/';

export interface TelephonyProviderAdapter {
  readonly id: string;
  /** Stable, non-secret account identity used for diagnostics and logs. */
  accountId(settings: TelephonySipSettings): string | null;
  /** Documented REST capabilities. All false for the SIP MVP. */
  readonly rest: {
    callHistory: boolean;
    outboundCalls: boolean;
    recordings: boolean;
    reconciliation: boolean;
  };
}

export const daftareshomaAdapter: TelephonyProviderAdapter = {
  id: DAFTARESHOMA_PROVIDER_ID,
  accountId: (settings) => accountIdentity(settings),
  rest: {
    callHistory: false,
    outboundCalls: false,
    recordings: false,
    reconciliation: false,
  },
};

export function getTelephonyProvider(id: string): TelephonyProviderAdapter | null {
  return id === DAFTARESHOMA_PROVIDER_ID ? daftareshomaAdapter : null;
}
