/**
 * Standalone, idempotent LiveKit SIP bootstrap.
 *
 * Creates (or reuses) the ONE long-lived inbound trunk and the ONE reusable
 * callee-based dispatch rule. Safe to run repeatedly — running it twice makes
 * no second trunk and no second rule.
 *
 * Usage inside the deployment: `node dist/bootstrapCli.js`
 */

import { createLiveKitSipClient } from './livekitSip.js';

async function main(): Promise<void> {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    process.stderr.write('missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET\n');
    process.exit(2);
    return;
  }

  const client = createLiveKitSipClient({
    url,
    apiKey,
    apiSecret,
    trunkName: process.env.LIVEKIT_SIP_TRUNK_NAME ?? 'webyar-inbound-trunk',
    dispatchRuleName: process.env.LIVEKIT_SIP_DISPATCH_NAME ?? 'webyar-callee-dispatch',
    authUsername: process.env.LIVEKIT_SIP_AUTH_USERNAME ?? 'webyar-telephony',
    authPassword: process.env.LIVEKIT_SIP_AUTH_PASSWORD,
    allowedAddresses: (process.env.LIVEKIT_SIP_ALLOWED_ADDRESSES ?? '')
      .split(',').map((v) => v.trim()).filter(Boolean),
  });

  const ready = await client.ready();
  if (!ready.ok) {
    process.stderr.write(`livekit_sip_unavailable: ${ready.error ?? 'unknown'}\n`);
    process.exit(1);
    return;
  }

  const result = await client.bootstrap();
  process.stdout.write(`${JSON.stringify({
    event: 'telephony.livekit.bootstrap',
    trunk_id: result.trunkId,
    dispatch_rule_id: result.dispatchRuleId,
    created: result.created,
    idempotent: result.created.length === 0,
  })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
