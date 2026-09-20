/**
 * Self-hosted LiveKit SIP bridge control.
 *
 * LiveKit SIP is REQUIRED: it is the only media path. There is no WebRTC/WSS
 * fallback — when it is unavailable the service reports
 * `livekit_sip_ready: false` and Core surfaces the call as unavailable.
 *
 * Bootstrap creates ONE long-lived inbound trunk and ONE reusable callee-based
 * dispatch rule. Nothing here is created per call: Asterisk dials
 * `PJSIP/<room>@livekit_sip`, the dispatch rule places that SIP participant
 * into the room whose name equals the callee.
 */

import { createHmac } from 'node:crypto';

export interface LiveKitSipConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  trunkName: string;
  dispatchRuleName: string;
  /** Advertised so the trunk only accepts calls from our own Asterisk. */
  allowedAddresses?: string[];
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** HS256 access token with the SIP admin grant (no external dependency). */
export function signLiveKitToken(apiKey: string, apiSecret: string, ttlSeconds = 600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: apiKey,
    sub: apiKey,
    nbf: now - 10,
    exp: now + ttlSeconds,
    video: { roomCreate: true, roomAdmin: true, roomList: true },
    sip: { admin: true, call: true },
  }));
  const sig = base64url(createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function httpBase(url: string): string {
  return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
}

export interface LiveKitSipClient {
  ready(): Promise<{ ok: boolean; error?: string }>;
  bootstrap(): Promise<{ trunkId: string; dispatchRuleId: string; created: string[] }>;
}

export function createLiveKitSipClient(
  cfg: LiveKitSipConfig,
  fetchImpl: typeof fetch = fetch,
): LiveKitSipClient {
  async function twirp<T>(method: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${httpBase(cfg.url)}/twirp/livekit.SIP/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${signLiveKitToken(cfg.apiKey, cfg.apiSecret)}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`livekit_sip_${res.status}:${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async ready() {
      try {
        await twirp('ListSIPInboundTrunk', {});
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    /** Idempotent: repeated runs reuse the existing trunk and dispatch rule. */
    async bootstrap() {
      const created: string[] = [];

      const trunks = await twirp<{ items?: Array<{ sip_trunk_id?: string; sipTrunkId?: string; name?: string }> }>(
        'ListSIPInboundTrunk', {},
      );
      let trunk = (trunks.items ?? []).find((t) => t.name === cfg.trunkName);
      if (!trunk) {
        trunk = await twirp('CreateSIPInboundTrunk', {
          trunk: {
            name: cfg.trunkName,
            metadata: 'webyar-telephony',
            allowed_addresses: cfg.allowedAddresses ?? [],
            krisp_enabled: false,
          },
        });
        created.push('trunk');
      }
      const trunkId = String((trunk as any)?.sip_trunk_id ?? (trunk as any)?.sipTrunkId ?? '');

      const rules = await twirp<{ items?: Array<{ sip_dispatch_rule_id?: string; sipDispatchRuleId?: string; name?: string }> }>(
        'ListSIPDispatchRule', {},
      );
      let rule = (rules.items ?? []).find((r) => r.name === cfg.dispatchRuleName);
      if (!rule) {
        // Callee-based: the SIP user Asterisk dials IS the room name Core chose.
        rule = await twirp('CreateSIPDispatchRule', {
          name: cfg.dispatchRuleName,
          metadata: 'webyar-telephony',
          trunk_ids: trunkId ? [trunkId] : [],
          rule: { dispatch_rule_callee: { room_prefix: '', randomize: false } },
        });
        created.push('dispatch_rule');
      }
      const dispatchRuleId = String(
        (rule as any)?.sip_dispatch_rule_id ?? (rule as any)?.sipDispatchRuleId ?? '',
      );

      return { trunkId, dispatchRuleId, created };
    },
  };
}
