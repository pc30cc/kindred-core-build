// @vitest-environment node
/**
 * WebYar's Iran relay in a call token (deploy/iran-relay/README.md): who gets
 * it, with which credentials, and that the secret never leaves the server.
 *
 * Why the gate matters: every client hands a non-empty `turn.urls` to
 * LiveKit as its ICE servers, which REPLACES LiveKit's own (its TURN
 * included), and leaves them alone for an empty list. A caller outside Iran
 * handed the Iranian relay would lose LiveKit's TURN for a relay that only
 * forwards to LiveKit anyway; a caller in Iran without it gets no media at
 * all on mobile data.
 *
 * The resolver, the secret reader and the token builder run for real against
 * one stored row; the country comes from the request as Cloudflare sends it
 * through Traefik in production (server/utils/clientIp.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  reads: 0,
  ownRelay: true,
}));

/** `app_runtime_config` as the resolver reads it: select('value').eq('key', k).maybeSingle(). */
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let key: string | null = null;
      const b = {
        select: () => b,
        eq: (_col: string, v: string) => { key = v; return b; },
        maybeSingle: async () => {
          h.reads += 1;
          if (table !== 'app_runtime_config' || key === null || !h.rows.has(key)) return { data: null, error: null };
          return { data: { value: structuredClone(h.rows.get(key)) }, error: null };
        },
      };
      return b;
    },
  }),
}));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  resolveCallProvider: () => ({
    createParticipantToken: async () => ({ token: 'lk-token', expiresAt: 1_900_000_000, identity: 'internal:0123456789abcdef' }),
  }),
}));
vi.mock('../../../server/services/calls/livekitConfig.js', () => ({
  loadLiveKitConfig: async () => ({}),
  providesOwnRelay: () => h.ownRelay,
}));
vi.mock('../../../server/services/calls/metrics.js', () => ({ emitCallMetric: () => {} }));

const { mintTurnCreds } = await import('../../../server/services/calls/turnAuth.js');
const { invalidateRtcCache } = await import('../../../server/services/calls/rtcResolver.js');
const { buildTokenNetworkBundle, issueParticipantToken } = await import('../../../server/services/calls/participantToken.js');
const { encryptPluginSecret } = await import('../../../server/lib/pluginCrypto.js');
const { resetTrustedProxyCache } = await import('../../../server/utils/clientIp.js');

const MASTER = 'b'.repeat(64);
const SECRET = 'webyar-test-secret-48-characters-long-0123456789';
const CALL_ID = '6f1c2d3e-4b5a-4978-8c6d-0e1f2a3b4c5d';
const RELAY = 'turn:203.0.113.7:3478?transport=udp';
const config = { pluginSecretsMasterKey: MASTER } as never;
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function sealed(secret = SECRET, key = MASTER): Row {
  const { algorithm, key_version, nonce, ciphertext, auth_tag } = encryptPluginSecret(secret, key);
  return { algorithm, key_version, nonce, ciphertext, auth_tag };
}

/** WebYar's row once a save has encrypted the secret, the relay for Iran only. */
function relayRow(turn: Row = {}): Row {
  return {
    rtc_url: 'wss://livekit.example',
    ws_url: 'wss://rt.example',
    ice_policy: 'all',
    turn: {
      urls: [RELAY],
      username: null,
      credential: null,
      credential_type: 'password',
      static_secret_present: true,
      shared_secret_enc: sealed(),
      countries: ['IR'],
      ...turn,
    },
  };
}

/**
 * A request as the backend sees one in production: Traefik (a private
 * address) is the socket peer, Cloudflare's edge is the last hop in
 * X-Forwarded-For, and cf-ipcountry names the caller's country.
 */
function viaCloudflare(country: string | null): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': '198.51.100.20, 162.158.1.20' };
  if (country !== null) headers['cf-ipcountry'] = country;
  return { socket: { remoteAddress: '10.0.1.5' }, headers } as unknown as Request;
}

/** The same header, sent straight to the origin by someone who is not Cloudflare. */
function spoofed(country: string): Request {
  return { socket: { remoteAddress: '198.51.100.99' }, headers: { 'cf-ipcountry': country } } as unknown as Request;
}

function hmac(secret: string, username: string): string {
  return createHmac('sha1', secret).update(username).digest('base64');
}

beforeEach(() => {
  h.rows.clear();
  h.reads = 0;
  h.ownRelay = true;
  invalidateRtcCache();
  resetTrustedProxyCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══ The credentials ═══════════════════════════════════════════════

describe('mintTurnCreds (coturn use-auth-secret)', () => {
  /** Worked out apart from the code: `base64(HMAC-SHA1(secret, "<exp>:<sub>"))`. */
  it('matches a known vector', () => {
    vi.setSystemTime(1_800_000_000_000);
    const minted = mintTurnCreds({ sharedSecret: 'webyar-test-secret', identity: 'alice', ttlSeconds: 600 });
    expect(minted.username).toBe('1800000600:alice');
    expect(minted.credential).toBe('BHF+kC2LDpuBSH55keQl+bjV4TM=');
    expect(minted.expiresAt).toBe(1_800_000_600_000);
  });

  it('keeps its own 60..86400 s clamp, and keeps the username to one colon', () => {
    expect(mintTurnCreds({ sharedSecret: 's', ttlSeconds: 1 }).ttlSeconds).toBe(60);
    expect(mintTurnCreds({ sharedSecret: 's', ttlSeconds: 10 ** 9 }).ttlSeconds).toBe(86400);
    expect(mintTurnCreds({ sharedSecret: 's', identity: 'a:b c' }).username).toMatch(/^\d+:a_b_c$/);
  });
});

// ═══ Who gets the relay ════════════════════════════════════════════

describe('the relay goes only to the countries it is for', () => {
  it('a caller in Iran gets it, with credentials minted from the stored secret', async () => {
    h.rows.set('call_rtc_endpoints', relayRow());
    const { turn, network } = await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'));
    expect(turn.urls).toEqual([RELAY]);
    expect(turn.username).toMatch(/^\d+:r[0-9a-f]{16}$/);
    expect(turn.credential).toBe(hmac(SECRET, turn.username as string));
    expect(turn.credential_type).toBe('password');
    // network.turn is what the caller got, not the stored block.
    expect(network.turn).toEqual(turn);
    expect(network.ws_url).toBe('wss://rt.example');
  });

  it.each([
    ['a caller in Turkey', viaCloudflare('TR')],
    ['a country Cloudflare could not tell (XX)', viaCloudflare('XX')],
    ['no country header at all', viaCloudflare(null)],
    ['a cf-ipcountry not sent by Cloudflare', spoofed('IR')],
  ])('%s gets no URLs and keeps LiveKit\'s own TURN', async (_who, req) => {
    h.rows.set('call_rtc_endpoints', relayRow());
    const { turn, network } = await buildTokenNetworkBundle(config, CALL_ID, 600, req);
    expect(turn.urls).toEqual([]);
    expect(turn.username).toBeNull();
    expect(turn.credential).toBeNull();
    expect(turn.static_secret_present).toBe(false);
    expect(network.turn).toEqual(turn);
  });

  it('a route that passes no request withholds a relay limited to some countries', async () => {
    h.rows.set('call_rtc_endpoints', relayRow());
    expect((await buildTokenNetworkBundle(config, CALL_ID, 600)).turn.urls).toEqual([]);
    expect((await buildTokenNetworkBundle(config, CALL_ID, 600, null)).turn.urls).toEqual([]);
  });

  /** Every row written before the list existed, and RESPOK's if it ever has a relay. */
  it.each([
    ['no list', undefined],
    ['an empty list', []],
    ['*', ['*']],
  ])('%s is everyone, a request or not', async (_label, countries) => {
    h.rows.set('call_rtc_endpoints', relayRow({ countries }));
    for (const req of [viaCloudflare('TR'), viaCloudflare(null), undefined]) {
      const { turn } = await buildTokenNetworkBundle(config, CALL_ID, 600, req);
      expect(turn.urls).toEqual([RELAY]);
      expect(turn.credential).toBe(hmac(SECRET, turn.username as string));
    }
  });

  it('reads a list written in lower case or with stray spaces', async () => {
    h.rows.set('call_rtc_endpoints', relayRow({ countries: [' ir '] }));
    expect((await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'))).turn.urls).toEqual([RELAY]);
  });

  it('gates a static username and credential the same way', async () => {
    h.rows.set('call_rtc_endpoints', relayRow({
      username: 'static-user', credential: 'static-pass', static_secret_present: false, shared_secret_enc: undefined,
    }));
    const inIran = (await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'))).turn;
    expect([inIran.username, inIran.credential]).toEqual(['static-user', 'static-pass']);
    const elsewhere = (await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('DE'))).turn;
    expect([elsewhere.urls, elsewhere.username, elsewhere.credential]).toEqual([[], null, null]);
  });

  it('a row with no relay (RESPOK\'s) answers as it always has, without reading any secret', async () => {
    h.rows.set('call_rtc_endpoints', { rtc_url: 'wss://livekit.example', ws_url: 'wss://rt.example', turn: { urls: [] } });
    const { turn, withheld } = await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'));
    expect(turn.urls).toEqual([]);
    expect(withheld).toBe(false);
    expect(h.reads).toBe(1);
  });

  it('says when a stored relay was withheld from this caller, which is what a turn_missing hangs on', async () => {
    h.rows.set('call_rtc_endpoints', relayRow());
    expect((await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('TR'))).withheld).toBe(true);
    expect((await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'))).withheld).toBe(false);
  });

  /**
   * What the call centre's two answers hang on: they had no relay before the
   * list existed, so they carry one only for a relay that names countries.
   */
  it.each([
    ['IR', ['IR'], true],
    ['a list read in lower case', [' ir '], true],
    ['no list (WebYar\'s row until it is saved with one)', undefined, false],
    ['an empty list', [], false],
    ['*', ['*'], false],
    ['* beside a country', ['IR', '*'], false],
  ])('says whether the stored relay names its countries: %s', async (_label, countries, limited) => {
    h.rows.set('call_rtc_endpoints', relayRow({ countries }));
    for (const req of [viaCloudflare('IR'), viaCloudflare('TR'), undefined]) {
      expect((await buildTokenNetworkBundle(config, CALL_ID, 600, req)).countryLimited).toBe(limited);
    }
  });

  it('a row with no relay names no countries either', async () => {
    h.rows.set('call_rtc_endpoints', { rtc_url: 'wss://livekit.example', ws_url: 'wss://rt.example', turn: { urls: [] } });
    expect((await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'))).countryLimited).toBe(false);
  });
});

// ═══ What a client is handed ═══════════════════════════════════════

describe('the token answer', () => {
  const session = { id: CALL_ID, workspace_id: 'ws-1', provider: 'livekit' as const, provider_room_id: `room-${CALL_ID}` };
  const ask = (req?: Request) => issueParticipantToken(config, session, {
    participantType: 'internal', participantId: 'user-1', displayName: 'Sara', req,
  });

  /**
   * RESPOK's row (no relay, none of the new keys): every byte as before the
   * relay settings existed, key order included. Apps parse this answer, and
   * the same code deploys to both brands.
   */
  it('of a row without the new keys is byte for byte what it was', async () => {
    h.rows.set('call_rtc_endpoints', {
      rtc_url: 'wss://livekit.example',
      ws_url: 'wss://rt.example',
      ice_policy: 'all',
      turn: { urls: [], username: null, credential: null, credential_type: 'password', static_secret_present: false },
    });
    for (const req of [undefined, viaCloudflare('IR'), viaCloudflare('TR')]) {
      invalidateRtcCache();
      expect(JSON.stringify((await ask(req)).body)).toBe(
        '{"token":"lk-token","expires_at":1900000000,"provider":"livekit","rtc_url":"wss://livekit.example",' +
        '"ws_url":"wss://rt.example","turn":{"urls":[],"username":null,"credential":null},"ice_policy":"all",' +
        '"network":{"rtc_url":"wss://livekit.example","ws_url":"wss://rt.example","recording_url":null,' +
        '"turn":{"urls":[],"username":null,"credential":null,"credential_type":"password","static_secret_present":false},' +
        '"ice_policy":"all","region":null,"provider":null},"warnings":[]}',
      );
    }
  });

  /** A flag set by hand over no secret reads as it always did; it mints nothing. */
  it('keeps a stored static_secret_present as it reads, a secret behind it or not', async () => {
    h.rows.set('call_rtc_endpoints', { ws_url: 'wss://rt.example', turn: { urls: [], static_secret_present: true } });
    expect(((((await ask()).body.network) as Row).turn as Row).static_secret_present).toBe(true);
  });

  it('carries neither the country list nor the lifetime: those are the server\'s own settings', async () => {
    h.rows.set('call_rtc_endpoints', relayRow({ countries: ['IR', 'AF'], credential_ttl_seconds: 7200 }));
    for (const req of [viaCloudflare('IR'), viaCloudflare('TR')]) {
      const text = JSON.stringify((await ask(req)).body);
      expect(text).not.toContain('countries');
      expect(text).not.toContain('AF');
      expect(text).not.toContain('credential_ttl_seconds');
    }
  });
});

// ═══ The credentials' lifetime and name ════════════════════════════

describe('minted credentials', () => {
  const expiry = (username: string | null) => Number(String(username).split(':')[0]);

  it('last 6 hours when the row does not say, whatever the LiveKit token\'s TTL', async () => {
    h.rows.set('call_rtc_endpoints', relayRow());
    const { turn } = await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'));
    expect(expiry(turn.username)).toBe(NOW / 1000 + 21600);
  });

  it('last credential_ttl_seconds, clamped to 600..86400', async () => {
    for (const [stored, lasts] of [[7200, 7200], [100, 600], [10 ** 7, 86400]] as const) {
      invalidateRtcCache();
      h.rows.set('call_rtc_endpoints', relayRow({ credential_ttl_seconds: stored }));
      const { turn } = await buildTokenNetworkBundle(config, CALL_ID, 3600, viaCloudflare('IR'));
      expect(expiry(turn.username)).toBe(NOW / 1000 + lasts);
    }
  });

  /** The relay's log and any packet capture see the username. */
  it('name neither the call nor anyone in it, and differ on every token', async () => {
    h.rows.set('call_rtc_endpoints', relayRow());
    const a = (await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'))).turn.username as string;
    const b = (await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'))).turn.username as string;
    expect(a).not.toContain(CALL_ID);
    expect(a).not.toContain('call');
    expect(a).not.toBe(b);
  });
});

// ═══ The secret stays on the server ════════════════════════════════

describe('the shared secret', () => {
  it('appears nowhere in what a client receives, nor does its envelope', async () => {
    const row = relayRow();
    h.rows.set('call_rtc_endpoints', row);
    const envelope = (row.turn as Row).shared_secret_enc as Row;
    const { turn, network } = await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'));
    const sent = JSON.stringify({ turn, network });
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain(String(envelope.ciphertext));
    expect(sent).not.toContain('shared_secret');
  });

  /** What production holds today: put there by hand, in clear, before encryption existed. */
  it('still mints from the plain text an older row carries, and never sends it', async () => {
    h.rows.set('call_rtc_endpoints', relayRow({ shared_secret_enc: undefined, shared_secret: SECRET, countries: undefined }));
    const { turn, network } = await buildTokenNetworkBundle(config, CALL_ID, 600);
    expect(turn.credential).toBe(hmac(SECRET, turn.username as string));
    expect(JSON.stringify({ turn, network })).not.toContain(SECRET);
  });

  /**
   * A turn: URL without credentials makes the browser refuse the whole peer
   * connection, so a secret that cannot be decrypted must not hand one out:
   * the caller keeps LiveKit's TURN instead, and the log says why without
   * the secret.
   */
  it('that cannot be decrypted withholds the relay rather than break the call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.rows.set('call_rtc_endpoints', relayRow({ shared_secret_enc: sealed(SECRET, 'c'.repeat(64)) }));
    const { turn } = await buildTokenNetworkBundle(config, CALL_ID, 600, viaCloudflare('IR'));
    expect(turn.urls).toEqual([]);
    expect(turn.username).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });
});

// ═══ The token routes ══════════════════════════════════════════════

describe('issueParticipantToken', () => {
  const session = { id: CALL_ID, workspace_id: 'ws-1', provider: 'livekit' as const, provider_room_id: `room-${CALL_ID}` };
  const ask = (req?: Request) => issueParticipantToken(config, session, {
    participantType: 'internal', participantId: 'user-1', displayName: 'Sara', req,
  });

  it('hands the caller\'s request to the gate', async () => {
    h.rows.set('call_rtc_endpoints', relayRow());
    const inIran = await ask(viaCloudflare('IR'));
    expect(inIran.status).toBe(200);
    expect((inIran.body.turn as Row).urls).toEqual([RELAY]);
    expect(((inIran.body.network as Row).turn as Row).urls).toEqual([RELAY]);

    const elsewhere = await ask(viaCloudflare('TR'));
    expect((elsewhere.body.turn as Row).urls).toEqual([]);
    expect(((elsewhere.body.network as Row).turn as Row).urls).toEqual([]);
  });

  /** A caller the relay is not for is relayed by LiveKit, and is not told otherwise. */
  it('raises no turn_missing for a caller left on LiveKit\'s own TURN', async () => {
    h.rows.set('call_rtc_endpoints', relayRow());
    h.ownRelay = true;
    expect((await ask(viaCloudflare('TR'))).body.warnings).toEqual([]);
    h.ownRelay = false;
    expect((await ask(viaCloudflare('TR'))).body.warnings).toEqual(['turn_missing']);
  });

  it('keeps the routes that pass no request compiling and answering', async () => {
    h.rows.set('call_rtc_endpoints', relayRow({ countries: [] }));
    const answer = await ask();
    expect(answer.status).toBe(200);
    expect((answer.body.turn as Row).urls).toEqual([RELAY]);
  });
});

// ═══ The routes pass their request ═════════════════════════════════

describe('both member token routes pass the request', () => {
  const between = (src: string, start: string, end: string) => {
    const i = src.indexOf(start);
    return src.slice(i, src.indexOf(end, i));
  };

  it.each([
    ['server/routes/calls.ts', "callsRouter.post('/:id/token'"],
    ['server/routes/teamCalls.ts', "teamCallsRouter.post('/:id/token'"],
  ])('%s', (file, route) => {
    const handler = between(readFileSync(file, 'utf8'), route, 'res.status(answer.status)');
    expect(handler).toMatch(/issueParticipantToken\([\s\S]*\breq,\s*\}\);/);
  });
});
