// @vitest-environment node
/**
 * The relay's settings: Super Admin → Voice & Video → network, saved through
 * saveRtcEndpoints (server/services/calls/rtcResolver.ts).
 *
 *   - the shared secret is write-only and stored encrypted under
 *     PLUGIN_SECRETS_MASTER_KEY: left out it is kept (the encrypted one, or
 *     the plain text production carries today, which the save seals), ''
 *     removes it, a new one replaces it, and without the key a new one is
 *     refused rather than stored in clear;
 *   - whether a secret is stored is worked out by the save, never taken from
 *     the form (the form has always sent `static_secret_present: false`);
 *   - the save merges onto the row as stored: keys it does not know survive,
 *     and a save of the relay alone leaves the signalling URL (which must
 *     never change, deploy/livekit/README.md §4.1) as it is;
 *   - the admin's GET shows whether a secret is set and its fingerprint,
 *     never the secret, and every change is audited by field name only;
 *   - the generic runtime-config route cannot write the row raw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Json = any;

const h = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  audit: [] as Array<Record<string, unknown>>,
  failRead: false,
  writes: 0,
}));

/** `app_runtime_config` and `audit_logs`, as these modules read and write them. */
function fakeClient() {
  return {
    from: (table: string) => {
      let key: string | null = null;
      const b = {
        select: () => b,
        order: () => b,
        eq: (_col: string, v: string) => { key = v; return b; },
        maybeSingle: async () => {
          if (h.failRead) return { data: null, error: { message: 'connection reset' } };
          if (table !== 'app_runtime_config' || key === null || !h.rows.has(key)) return { data: null, error: null };
          return { data: { key, value: structuredClone(h.rows.get(key)) }, error: null };
        },
        upsert: async (payload: { key: string; value: unknown }) => {
          h.writes += 1;
          h.rows.set(payload.key, structuredClone(payload.value));
          return { data: null, error: null };
        },
        insert: async (payload: Record<string, unknown>) => {
          if (table === 'audit_logs') h.audit.push(structuredClone(payload));
          return { data: null, error: null };
        },
        delete: () => { h.writes += 1; return b; },
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({ requirePlatformAdmin: async () => '00000000-0000-4000-8000-0000000000aa' }));
vi.mock('../../../server/services/operatorLocale.js', () => ({ operatorLocale: async () => 'en' }));
vi.mock('../../../server/services/calls/controlPlane.js', () => ({
  loadCallControlPlane: async () => ({ enabled: true, primary_provider: 'livekit' }),
  saveCallControlPlane: async () => ({}),
}));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  getCallProvider: () => null,
  resolveCallProvider: () => null,
  resolveCallProviderOrder: async () => ['livekit'],
}));
vi.mock('../../../server/services/calls/providers/livekitProvider.js', () => ({
  getLiveKitReadinessState: async () => ({ ready: true }),
  probeLiveKitProvisioning: async () => ({}),
  invalidateLiveKitReadinessCache: () => {},
}));

const {
  saveRtcEndpoints,
  getTurnSharedSecret,
  turnSecretFingerprint,
  getCallNetworkBundle,
  invalidateRtcCache,
} = await import('../../../server/services/calls/rtcResolver.js');
const { encryptPluginSecret, decryptPluginSecret } = await import('../../../server/lib/pluginCrypto.js');
const { adminCallsRouter } = await import('../../../server/routes/adminCalls.js');
const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');

const KEY = 'call_rtc_endpoints';
const MASTER = 'd'.repeat(64);
const SECRET = 'old-relay-secret-48-characters-long-0123456789ab';
const NEW_SECRET = 'new-relay-secret-48-characters-long-0123456789ab';
const RELAY = 'turn:203.0.113.7:3478?transport=udp';
const ADMIN = '00000000-0000-4000-8000-0000000000aa';
const withKey = { pluginSecretsMasterKey: MASTER, complianceAuditLoggingEnabled: true } as never;
const withoutKey = { complianceAuditLoggingEnabled: true } as never;

function sealed(secret = SECRET): Row {
  const { algorithm, key_version, nonce, ciphertext, auth_tag } = encryptPluginSecret(secret, MASTER);
  return { algorithm, key_version, nonce, ciphertext, auth_tag };
}

/** WebYar's row on 2026-11-04: the relay, its secret in clear, put there by hand. */
function production(turn: Row = {}): Row {
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
      shared_secret: SECRET,
      ...turn,
    },
  };
}

const stored = () => h.rows.get(KEY) as Row;
const storedTurn = () => stored().turn as Row;
const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

beforeEach(() => {
  h.rows.clear();
  h.audit.length = 0;
  h.failRead = false;
  h.writes = 0;
  invalidateRtcCache();
});
afterEach(() => vi.restoreAllMocks());

// ═══ The secret ════════════════════════════════════════════════════

describe('saveRtcEndpoints and the shared secret', () => {
  it('keeps an encrypted secret the save leaves out, envelope untouched', async () => {
    const envelope = sealed();
    h.rows.set(KEY, production({ shared_secret: undefined, shared_secret_enc: envelope }));
    await saveRtcEndpoints(withKey, { turn: { urls: [RELAY, 'turn:203.0.113.7:3478?transport=tcp'] } });
    expect(storedTurn().shared_secret_enc).toEqual(envelope);
    expect(storedTurn().static_secret_present).toBe(true);
    expect(await getTurnSharedSecret(withKey)).toBe(SECRET);
  });

  /** Today's production row: the first save of anything seals it. */
  it('keeps a plain secret the save leaves out, encrypted from now on', async () => {
    h.rows.set(KEY, production());
    const { changed_fields } = await saveRtcEndpoints(withKey, { ice_policy: 'all' });
    expect(storedTurn()).not.toHaveProperty('shared_secret');
    expect(decryptPluginSecret(storedTurn().shared_secret_enc as never, MASTER)).toBe(SECRET);
    expect(JSON.stringify(stored())).not.toContain(SECRET);
    expect(await getTurnSharedSecret(withKey)).toBe(SECRET);
    expect(changed_fields).toContain('turn.shared_secret_encrypted');
    expect(changed_fields).not.toContain('turn.shared_secret');
  });

  /** An unrelated save is no reason to lose the relay. */
  it('keeps a plain secret as it is when there is no key to seal it with', async () => {
    h.rows.set(KEY, production());
    await saveRtcEndpoints(withoutKey, { ice_policy: 'all' });
    expect(storedTurn().shared_secret).toBe(SECRET);
    expect(storedTurn().static_secret_present).toBe(true);
    expect(await getTurnSharedSecret(withoutKey)).toBe(SECRET);
  });

  it('drops a plain copy beside an envelope, which every read prefers anyway', async () => {
    h.rows.set(KEY, production({ shared_secret_enc: sealed(NEW_SECRET) }));
    await saveRtcEndpoints(withKey, {});
    expect(storedTurn()).not.toHaveProperty('shared_secret');
    expect(await getTurnSharedSecret(withKey)).toBe(NEW_SECRET);
  });

  it('removes both forms for \'\'', async () => {
    h.rows.set(KEY, production({ shared_secret_enc: sealed() }));
    const { changed_fields } = await saveRtcEndpoints(withKey, { turn: { urls: [], shared_secret: '' } });
    expect(storedTurn()).not.toHaveProperty('shared_secret');
    expect(storedTurn()).not.toHaveProperty('shared_secret_enc');
    expect(storedTurn().static_secret_present).toBe(false);
    expect(await getTurnSharedSecret(withKey)).toBeNull();
    expect(changed_fields).toContain('turn.shared_secret');
  });

  /** A turn: URL left with nothing to sign in with would make every browser refuse the call. */
  it('refuses to remove the secret from under a turn: URL that needs it', async () => {
    h.rows.set(KEY, production());
    await expect(saveRtcEndpoints(withKey, { turn: { shared_secret: '' } })).rejects.toThrow(/needs a username and credential/);
    expect(h.writes).toBe(0);
    expect(storedTurn().shared_secret).toBe(SECRET);
  });

  it('stores a new secret encrypted and drops the plain one', async () => {
    h.rows.set(KEY, production());
    const { changed_fields } = await saveRtcEndpoints(withKey, { turn: { shared_secret: NEW_SECRET } });
    expect(storedTurn()).not.toHaveProperty('shared_secret');
    const envelope = storedTurn().shared_secret_enc as Row;
    expect(Object.keys(envelope).sort()).toEqual(['algorithm', 'auth_tag', 'ciphertext', 'key_version', 'nonce']);
    expect(decryptPluginSecret(envelope as never, MASTER)).toBe(NEW_SECRET);
    const raw = JSON.stringify(stored());
    expect(raw).not.toContain(NEW_SECRET);
    expect(raw).not.toContain(SECRET);
    expect(await getTurnSharedSecret(withKey)).toBe(NEW_SECRET);
    expect(changed_fields).toContain('turn.shared_secret');
  });

  it('refuses a new secret without PLUGIN_SECRETS_MASTER_KEY, writing nothing', async () => {
    h.rows.set(KEY, production());
    await expect(saveRtcEndpoints(withoutKey, { turn: { shared_secret: NEW_SECRET } }))
      .rejects.toThrow('TURN shared secret needs PLUGIN_SECRETS_MASTER_KEY');
    expect(h.writes).toBe(0);
    expect(storedTurn().shared_secret).toBe(SECRET);
  });

  it('works out static_secret_present, whatever the form says', async () => {
    h.rows.set(KEY, production({ shared_secret_enc: sealed(), shared_secret: undefined }));
    await saveRtcEndpoints(withKey, { turn: { static_secret_present: false } });
    expect(storedTurn().static_secret_present).toBe(true);

    h.rows.set(KEY, { ws_url: 'wss://rt.example', turn: { urls: [] } });
    await saveRtcEndpoints(withKey, { turn: { static_secret_present: true } });
    expect(storedTurn().static_secret_present).toBe(false);
    // ... so a turn: URL cannot be passed off as covered by a secret that is not there.
    await expect(saveRtcEndpoints(withKey, { turn: { urls: [RELAY], static_secret_present: true } }))
      .rejects.toThrow(/needs a username and credential/);
  });

  it('accepts a relay URL saved together with its first secret', async () => {
    h.rows.set(KEY, { ws_url: 'wss://rt.example', turn: { urls: [] } });
    await saveRtcEndpoints(withKey, { turn: { urls: [RELAY], shared_secret: NEW_SECRET } });
    expect(storedTurn().urls).toEqual([RELAY]);
    expect(storedTurn().static_secret_present).toBe(true);
  });
});

// ═══ The rest of the row ═══════════════════════════════════════════

describe('saveRtcEndpoints and the rest of the row', () => {
  it('leaves ws_url alone on a save of the relay alone', async () => {
    h.rows.set(KEY, production());
    await saveRtcEndpoints(withKey, { turn: { countries: ['IR'] } });
    expect(stored().ws_url).toBe('wss://rt.example');
    expect(stored().rtc_url).toBe('wss://livekit.example');
  });

  it('keeps keys it does not know, at the top and in turn', async () => {
    h.rows.set(KEY, production({ relay_note: 'Tehran DC' }));
    (stored() as Row).future_setting = { a: 1 };
    await saveRtcEndpoints(withKey, { turn: { countries: ['IR'] } });
    expect(stored().future_setting).toEqual({ a: 1 });
    expect(storedTurn().relay_note).toBe('Tehran DC');
  });

  it('tidies the country list: trimmed, upper case, once each, codes and * only', async () => {
    h.rows.set(KEY, production());
    await saveRtcEndpoints(withKey, { turn: { countries: [' ir', 'IR', 'tr', 'IRN', '*', 5 as never] } });
    expect(storedTurn().countries).toEqual(['IR', 'TR', '*']);
  });

  it('clamps the credential lifetime to 600..86400 s', async () => {
    h.rows.set(KEY, production());
    await saveRtcEndpoints(withKey, { turn: { credential_ttl_seconds: 100 } });
    expect(storedTurn().credential_ttl_seconds).toBe(600);
    await saveRtcEndpoints(withKey, { turn: { credential_ttl_seconds: 10 ** 6 } });
    expect(storedTurn().credential_ttl_seconds).toBe(86400);
  });

  /** RESPOK's row, and WebYar's before the relay: the new keys are not invented. */
  it('writes no country list or lifetime nobody set', async () => {
    h.rows.set(KEY, { ws_url: 'wss://rt.example', turn: { urls: [] } });
    await saveRtcEndpoints(withKey, { ice_policy: 'all' });
    expect(storedTurn()).not.toHaveProperty('countries');
    expect(storedTurn()).not.toHaveProperty('credential_ttl_seconds');
  });

  /** Writing defaults over an unread row would take the relay and the signalling URL with it. */
  it('writes nothing when the stored row cannot be read', async () => {
    h.rows.set(KEY, production());
    h.failRead = true;
    await expect(saveRtcEndpoints(withKey, { ice_policy: 'relay' })).rejects.toThrow(/could not be read/);
    expect(h.writes).toBe(0);
  });

  it('is what the next token reads, past the 15 s cache', async () => {
    h.rows.set(KEY, production());
    expect((await getCallNetworkBundle(withKey)).turn.countries).toEqual([]);
    await saveRtcEndpoints(withKey, { turn: { countries: ['IR'], credential_ttl_seconds: 7200 } });
    const { turn } = await getCallNetworkBundle(withKey);
    expect(turn.countries).toEqual(['IR']);
    expect(turn.credential_ttl_seconds).toBe(7200);
    expect(JSON.stringify(turn)).not.toContain('shared_secret');
  });
});

// ═══ Reading the secret ════════════════════════════════════════════

describe('getTurnSharedSecret and turnSecretFingerprint', () => {
  it('fingerprint the secret as the first 12 hex digits of its SHA-256', async () => {
    h.rows.set(KEY, production({ shared_secret: undefined, shared_secret_enc: sealed() }));
    expect(await turnSecretFingerprint(withKey)).toBe(fingerprint(SECRET));
    expect(fingerprint('webyar-test-secret')).toBe('54571382f398');
  });

  it('are null when no secret is stored', async () => {
    h.rows.set(KEY, { ws_url: 'wss://rt.example', turn: { urls: [] } });
    expect(await getTurnSharedSecret(withKey)).toBeNull();
    expect(await turnSecretFingerprint(withKey)).toBeNull();
    h.rows.clear();
    expect(await getTurnSharedSecret(withKey)).toBeNull();
  });

  it('say so, without the secret, when the envelope cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.rows.set(KEY, production({ shared_secret_enc: sealed() }));
    expect(await getTurnSharedSecret(withoutKey)).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it('never throw on a read that fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.failRead = true;
    expect(await getTurnSharedSecret(withKey)).toBeNull();
  });
});

// ═══ Super Admin's routes ══════════════════════════════════════════

function app(config: unknown) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.assign(req, { serverConfig: config, adminUser: { id: ADMIN } });
    next();
  });
  a.use('/api/admin/calls', adminCallsRouter);
  a.use('/api/admin/management', adminManagementRouter);
  return a;
}

describe('GET /api/admin/calls/control-plane', () => {
  it('says the secret is set and gives its fingerprint, and nothing else of it', async () => {
    const envelope = sealed();
    h.rows.set(KEY, production({ shared_secret: undefined, shared_secret_enc: envelope, countries: ['IR'] }));
    const res = await request(app(withKey)).get('/api/admin/calls/control-plane');
    expect(res.status).toBe(200);
    const turn = (res.body as Json).network.turn;
    expect(turn.shared_secret_present).toBe(true);
    expect(turn.shared_secret_fingerprint).toBe(fingerprint(SECRET));
    expect(turn.countries).toEqual(['IR']);
    expect(turn.credential_ttl_seconds).toBe(21600);
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain(String(envelope.ciphertext));
    expect(res.text).not.toContain(String(envelope.auth_tag));
    expect(turn).not.toHaveProperty('shared_secret');
    expect(turn).not.toHaveProperty('shared_secret_enc');
  });

  it('says not set when there is none', async () => {
    h.rows.set(KEY, { ws_url: 'wss://rt.example', turn: { urls: [] } });
    const turn = ((await request(app(withKey)).get('/api/admin/calls/control-plane')).body as Json).network.turn;
    expect(turn.shared_secret_present).toBe(false);
    expect(turn.shared_secret_fingerprint).toBeNull();
  });

  /** The panel reads "stored, no fingerprint" as undecryptable; a flag with nothing behind it is not that. */
  it('says not set for a flag set by hand over no secret, and stored but unreadable for an envelope it cannot open', async () => {
    h.rows.set(KEY, production({ shared_secret: undefined }));
    let turn = ((await request(app(withKey)).get('/api/admin/calls/control-plane')).body as Json).network.turn;
    expect(turn.shared_secret_present).toBe(false);
    expect(turn.shared_secret_fingerprint).toBeNull();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.rows.set(KEY, production({ shared_secret: undefined, shared_secret_enc: sealed() }));
    invalidateRtcCache();
    turn = ((await request(app(withoutKey)).get('/api/admin/calls/control-plane')).body as Json).network.turn;
    expect(turn.shared_secret_present).toBe(true);
    expect(turn.shared_secret_fingerprint).toBeNull();
  });
});

describe('PUT /api/admin/calls/rtc-endpoints', () => {
  const put = (body: unknown, config: unknown = withKey) =>
    request(app(config)).put('/api/admin/calls/rtc-endpoints').send(body as object);

  it.each([
    ['a three-letter country', { turn: { countries: ['IRN'] } }, 'turn.countries.0: A relay country is a two-letter code (IR) or *.'],
    ['a lifetime under 10 minutes', { turn: { credential_ttl_seconds: 60 } }, 'turn.credential_ttl_seconds: The credential lifetime is at least 600 seconds (10 minutes).'],
    ['a lifetime over a day', { turn: { credential_ttl_seconds: 90000 } }, 'turn.credential_ttl_seconds: The credential lifetime is at most 86400 seconds (24 hours).'],
    ['a secret over 256 characters', { turn: { shared_secret: 'x'.repeat(257) } }, 'turn.shared_secret: The TURN shared secret is longer than 256 characters.'],
    ['61 countries', { turn: { countries: Array.from({ length: 61 }, () => 'IR') } }, 'turn.countries: At most 60 relay countries.'],
  ])('refuses %s with a sentence, not zod\'s JSON', async (_what, body, message) => {
    h.rows.set(KEY, production());
    const res = await put(body);
    expect(res.status).toBe(400);
    expect((res.body as Json).error).toBe(message);
    expect(h.writes).toBe(0);
  });

  it('refuses a secret it cannot encrypt, saying why', async () => {
    h.rows.set(KEY, production());
    const res = await put({ turn: { shared_secret: NEW_SECRET } }, withoutKey);
    expect(res.status).toBe(400);
    expect((res.body as Json).error).toBe('TURN shared secret needs PLUGIN_SECRETS_MASTER_KEY');
  });

  it('saves, and audits which fields changed without any value', async () => {
    h.rows.set(KEY, production());
    const res = await put({ turn: { shared_secret: NEW_SECRET, countries: ['ir'], credential_ttl_seconds: 7200 } });
    expect(res.status).toBe(200);
    expect(storedTurn().countries).toEqual(['IR']);
    expect(await getTurnSharedSecret(withKey)).toBe(NEW_SECRET);

    expect(h.audit).toHaveLength(1);
    const row = h.audit[0];
    expect(row.action).toBe('admin.call_rtc_endpoints.changed');
    expect(row.user_id).toBe(ADMIN);
    expect((row.new_value as Json).changed_fields.sort()).toEqual(
      ['turn.countries', 'turn.credential_ttl_seconds', 'turn.shared_secret'].sort(),
    );
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(NEW_SECRET);
    expect(raw).not.toContain(SECRET);
  });

  /**
   * The panel sends back the whole network object its GET gave it, the
   * presence fields and `static_secret_present: false` included. That must
   * change nothing: not the secret, not the signalling URL.
   */
  it('takes back what the GET gave without touching the secret or ws_url', async () => {
    h.rows.set(KEY, production({ shared_secret: undefined, shared_secret_enc: sealed(), countries: ['IR'] }));
    const before = structuredClone(stored());
    const network = ((await request(app(withKey)).get('/api/admin/calls/control-plane')).body as Json).network;
    network.turn.static_secret_present = false;
    const res = await put(network);
    expect(res.status).toBe(200);
    expect(stored().ws_url).toBe('wss://rt.example');
    expect(storedTurn().shared_secret_enc).toEqual((before.turn as Row).shared_secret_enc);
    expect(storedTurn().static_secret_present).toBe(true);
    expect(storedTurn()).not.toHaveProperty('shared_secret_present');
    expect(storedTurn()).not.toHaveProperty('shared_secret_fingerprint');
    expect(await getTurnSharedSecret(withKey)).toBe(SECRET);
  });
});

describe('the generic runtime-config route', () => {
  it.each(['put', 'delete'] as const)('refuses to %s call_rtc_endpoints raw', async (method) => {
    h.rows.set(KEY, production());
    const res = await request(app(withKey))[method](`/api/admin/management/runtime-config/${KEY}`)
      .send({ value: { ws_url: 'wss://elsewhere.example', turn: { urls: [], shared_secret: 'plain' } } });
    expect(res.status).toBe(400);
    expect((res.body as Json).error).toMatch(/use the Voice & Video settings/);
    expect(h.writes).toBe(0);
    expect(stored().ws_url).toBe('wss://rt.example');
  });

  it('reads it back without the secret', async () => {
    h.rows.set(KEY, production({ shared_secret_enc: sealed() }));
    const res = await request(app(withKey)).get(`/api/admin/management/runtime-config/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain('ciphertext');
  });
});
