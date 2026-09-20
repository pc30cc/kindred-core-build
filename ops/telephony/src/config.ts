/**
 * WEBYAR Telephony Control Service — configuration.
 *
 * Every value comes from the environment. No production domain, no database
 * credential and no SIP credential is ever hardcoded here.
 */

export interface TelephonyServiceConfig {
  port: number;
  /** Shared secret for Core <-> control service in BOTH directions. */
  internalSecret: string;
  coreBaseUrl: string;
  /** Public SIP identity used for Contact/registration URIs behind NAT. */
  publicSipHost: string;
  rtpPortMin: number;
  rtpPortMax: number;
  ari: {
    url: string;
    user: string;
    password: string;
    appName: string;
  };
  /** Least-privilege login scoped to the restricted `asterisk` schema. */
  databaseUrl: string;
  databaseSchema: string;
  livekit: {
    url: string;
    apiKey: string;
    apiSecret: string;
    /** host[:port] of the self-hosted livekit-sip service (REQUIRED). */
    sipUri: string;
    /** Static PJSIP endpoint name used to hand a call to LiveKit SIP. */
    sipEndpoint: string;
    trunkName: string;
    dispatchRuleName: string;
  };
  registrationTimeoutMs: number;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing_required_env:${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const v = env(name);
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Builds the database URL. `ASTERISK_DB_URL` wins; otherwise the decomposed
 * variables are assembled so operators can use Docker/Coolify secrets per
 * field. Credentials are never logged by any caller.
 */
export function resolveDatabaseUrl(): string {
  const direct = env('ASTERISK_DB_URL');
  if (direct) return direct;
  const host = env('ASTERISK_DB_HOST');
  const user = env('ASTERISK_DB_USER');
  const password = env('ASTERISK_DB_PASSWORD');
  const name = env('ASTERISK_DB_NAME');
  if (!host || !user || !password || !name) throw new Error('missing_required_env:ASTERISK_DB_URL');
  const port = int('ASTERISK_DB_PORT', 5432);
  const sslmode = env('ASTERISK_DB_SSLMODE') ?? 'require';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=${sslmode}`;
}

export function loadConfig(): TelephonyServiceConfig {
  const rtpMin = int('TELEPHONY_RTP_PORT_MIN', 16384);
  const rtpMax = int('TELEPHONY_RTP_PORT_MAX', 16584);
  if (rtpMax <= rtpMin) throw new Error('invalid_rtp_port_range');

  return {
    port: int('TELEPHONY_SERVICE_PORT', 8089),
    internalSecret: required('TELEPHONY_INTERNAL_SECRET'),
    coreBaseUrl: required('TELEPHONY_CORE_BASE_URL').replace(/\/+$/, ''),
    publicSipHost: required('TELEPHONY_PUBLIC_SIP_HOST'),
    rtpPortMin: rtpMin,
    rtpPortMax: rtpMax,
    ari: {
      url: (env('ASTERISK_ARI_URL') ?? 'http://127.0.0.1:8088/ari').replace(/\/+$/, ''),
      user: required('ASTERISK_ARI_USER'),
      password: required('ASTERISK_ARI_PASSWORD'),
      appName: env('ASTERISK_ARI_APP') ?? 'webyar',
    },
    databaseUrl: resolveDatabaseUrl(),
    databaseSchema: env('ASTERISK_DB_SCHEMA') ?? 'asterisk',
    livekit: {
      url: required('LIVEKIT_URL').replace(/\/+$/, ''),
      apiKey: required('LIVEKIT_API_KEY'),
      apiSecret: required('LIVEKIT_API_SECRET'),
      sipUri: required('LIVEKIT_SIP_URI'),
      sipEndpoint: env('LIVEKIT_SIP_ENDPOINT') ?? 'livekit_sip',
      trunkName: env('LIVEKIT_SIP_TRUNK_NAME') ?? 'webyar-inbound-trunk',
      dispatchRuleName: env('LIVEKIT_SIP_DISPATCH_NAME') ?? 'webyar-callee-dispatch',
    },
    registrationTimeoutMs: int('TELEPHONY_REGISTRATION_TIMEOUT_MS', 15000),
  };
}
