/**
 * WEBYAR Telephony — provider-neutral types.
 *
 * `daftareshoma` is the first adapter of this layer, never a name the Call
 * Center itself knows about. Provider identity travels in data
 * (`telephony_calls.provider`, `call_sessions.metadata.telephony.provider`),
 * never in the media-provider enum (livekit/jitsi/janus/agora).
 */

export type TelephonyProviderId = 'daftareshoma';

export type TelephonyTransport = 'udp' | 'tcp' | 'tls';

export type RegistrationState =
  | 'not_configured'
  | 'configured'
  | 'registering'
  | 'registered'
  | 'failed'
  | 'disabled';

/** Non-secret SIP configuration. The password NEVER appears here. */
export interface TelephonySipSettings {
  sip_username: string;
  sip_extension: string;
  sip_domain_udp: string;
  sip_domain_tcp: string;
  sip_domain_webrtc: string;
  outgoing_line: string;
  transport: TelephonyTransport;
}

export interface TelephonyRegistrationRow {
  id: string;
  installation_id: string;
  workspace_id: string;
  provider: string;
  sip_username: string | null;
  sip_extension: string | null;
  sip_domain_udp: string | null;
  sip_domain_tcp: string | null;
  sip_domain_webrtc: string | null;
  outgoing_line: string | null;
  transport: TelephonyTransport;
  state: RegistrationState;
  last_registered_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  last_inbound_call_at: string | null;
}

export interface TelephonyCallRow {
  id: string;
  installation_id: string;
  workspace_id: string;
  provider: string;
  external_call_id: string | null;
  sip_call_id: string;
  call_session_id: string | null;
  room_name: string | null;
  asterisk_channel_id: string | null;
  caller_number: string | null;
  called_number: string | null;
  lifecycle: 'incoming' | 'ringing' | 'connected' | 'ended' | 'failed' | 'rejected';
  metadata: Record<string, unknown>;
}

/** Safe, secret-free gateway diagnostics surfaced to the plugin page. */
export interface TelephonyGatewayStatus {
  gateway_healthy: boolean;
  livekit_sip_ready: boolean;
  asterisk_ari: boolean;
  asterisk_sip: boolean;
  version?: string | null;
  error?: string | null;
}

export interface TelephonyTestResult {
  configured: boolean;
  gateway: 'healthy' | 'unavailable' | 'not_configured';
  registration: RegistrationState;
  extension: string | null;
  domain: string | null;
  livekit_sip_ready: boolean;
  error_code?: TelephonyErrorCode | null;
}

export type TelephonyErrorCode =
  | 'not_configured'
  | 'gateway_not_configured'
  | 'gateway_unavailable'
  | 'invalid_credentials'
  | 'dns_failure'
  | 'registration_timeout'
  | 'provider_rejected'
  | 'transport_unsupported'
  | 'livekit_sip_unavailable'
  | 'encryption_not_configured'
  | 'unknown_error';
