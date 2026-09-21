/**
 * Startup/readiness checks.
 *
 * Every dependency is probed for real. A saved SIP password, an existing
 * database row or a running container NEVER counts as "healthy" on its own.
 */

import type { AsteriskControl } from './asteriskAri.js';
import type { RealtimeStore } from './database.js';
import type { LiveKitSipClient } from './livekitSip.js';
import type { CoreClient } from './coreClient.js';

export interface HealthReport {
  gateway_healthy: boolean;
  asterisk_ari: boolean;
  asterisk_sip: boolean;
  realtime_db: boolean;
  livekit_sip_ready: boolean;
  core_reachable: boolean;
  version: string | null;
  error: string | null;
  service: 'webyar-telephony';
}

export async function collectHealth(deps: {
  asterisk: AsteriskControl;
  store: RealtimeStore;
  livekit: LiveKitSipClient;
  core: CoreClient;
}): Promise<HealthReport> {
  const errors: string[] = [];

  const [info, sipUp, storeUp, asteriskDbUp, livekit, coreUp] = await Promise.all([
    deps.asterisk.info(),
    deps.asterisk.sipStackUp().catch(() => false),
    deps.store.ping().then(() => true).catch((e) => { errors.push(`db:${(e as Error).message}`); return false; }),
    deps.asterisk.realtimeBackendUp().catch(() => false),
    deps.livekit.ready(),
    deps.core.health(),
  ]);

  // BOTH connections must be up. The control service pool being healthy says
  // nothing about res_config_pgsql, and a realtime backend that is silently
  // down presents exactly like a workspace that was never configured.
  const dbUp = storeUp && asteriskDbUp;
  if (storeUp && !asteriskDbUp) {
    errors.push('db:asterisk realtime backend not connected (check res_pgsql.conf)');
  }

  if (!info.ok && info.error) errors.push(`ari:${info.error}`);
  if (!livekit.ok && livekit.error) errors.push(`livekit_sip:${livekit.error}`);

  // LiveKit SIP is REQUIRED — without it there is no media path at all, so the
  // gateway must not advertise itself as healthy.
  const gatewayHealthy = info.ok && sipUp && dbUp && livekit.ok;

  return {
    gateway_healthy: gatewayHealthy,
    asterisk_ari: info.ok,
    asterisk_sip: sipUp,
    realtime_db: dbUp,
    livekit_sip_ready: livekit.ok,
    core_reachable: coreUp,
    version: info.version ?? null,
    error: errors.length ? errors.join('; ').slice(0, 300) : null,
    service: 'webyar-telephony',
  };
}
