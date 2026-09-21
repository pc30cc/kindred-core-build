/**
 * WEBYAR Telephony Control Service — entrypoint.
 *
 * Boots in this order: config → realtime store → Asterisk ARI → LiveKit SIP
 * bootstrap (idempotent) → ARI event stream → HTTP API. Failures are loud:
 * there is no degraded mode that silently swaps in another media path.
 */

import { loadConfig } from './config.js';
import { createRealtimeStore } from './database.js';
import { createAsteriskControl } from './asteriskAri.js';
import { createLiveKitSipClient } from './livekitSip.js';
import { createCoreClient } from './coreClient.js';
import { createCallOrchestrator, connectAriEvents } from './incomingCalls.js';
import { createApp } from './app.js';
import { collectHealth } from './health.js';

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Structured, secret-free logging. Passwords are never passed in here.
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = createRealtimeStore(config.databaseUrl, config.databaseSchema);
  const asterisk = createAsteriskControl(config.ari);
  const livekit = createLiveKitSipClient({
    url: config.livekit.url,
    apiKey: config.livekit.apiKey,
    apiSecret: config.livekit.apiSecret,
    trunkName: config.livekit.trunkName,
    dispatchRuleName: config.livekit.dispatchRuleName,
    authUsername: config.livekit.sipAuthUsername,
    authPassword: config.livekit.sipAuthPassword,
    allowedAddresses: config.livekit.sipAllowedAddresses,
  });
  const core = createCoreClient(config.coreBaseUrl, config.internalSecret);

  const orchestrator = createCallOrchestrator({
    asterisk,
    store,
    core,
    livekitSipEndpoint: config.livekit.sipEndpoint,
    log,
  });

  // Idempotent: reuses the long-lived trunk and callee dispatch rule if they
  // already exist. Retried in the background so a late LiveKit start is fine.
  const bootstrap = async (): Promise<void> => {
    try {
      const result = await livekit.bootstrap();
      log('telephony.livekit.bootstrap', { created: result.created, trunkId: Boolean(result.trunkId) });
    } catch (err) {
      log('telephony.gateway.error', { errorCode: 'livekit_sip_unavailable', detail: (err as Error).message });
      setTimeout(() => void bootstrap(), 30_000);
    }
  };
  void bootstrap();

  const events = connectAriEvents({
    ariUrl: config.ari.url,
    user: config.ari.user,
    password: config.ari.password,
    appName: config.ari.appName,
    orchestrator,
    log,
  });

  const app = createApp({
    internalSecret: config.internalSecret,
    store,
    asterisk,
    livekit,
    core,
    orchestrator,
    publicSipHost: config.publicSipHost,
    registrationTimeoutMs: config.registrationTimeoutMs,
    log,
  });

  const server = app.listen(config.port, () => log('telephony.service.listening', { port: config.port }));

  const report = await collectHealth({ asterisk, store, livekit, core });
  log('telephony.service.readiness', { ...report });

  const shutdown = () => {
    events.close();
    server.close(() => void store.close().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log('telephony.service.fatal', { detail: (err as Error).message });
  process.exit(1);
});
