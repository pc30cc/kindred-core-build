/**
 * The chat widget's two visitor token answers and the Iran relay
 * (2026-11-04): `POST /api/widget/calls/:id/visitor-token` (a call accepted
 * over the polling fallback) and `POST /api/widget/call-invitations/:id/join`
 * (the visitor accepts an operator's invitation). Each used to carry its own
 * copy of the TURN mint (reading the plaintext secret itself, credentials
 * named after the call, ten minutes long); both now take the relay from
 * buildTokenNetworkBundle, given THIS request, so the countries gate decides
 * on the visitor's own country, and answer the same shape as before.
 *
 * `turn_missing` keeps LiveKit's own-relay exemption for a visitor the gate
 * leaves out: they get `urls: []` and keep LiveKit's TURN, so they are told
 * nothing is missing when LiveKit has a TURN domain of its own, and only
 * then. With no relay stored at all (RESPOK) the warning is what these
 * routes have always answered.
 *
 * The builder is a stand-in that records what it was asked (its gate, mint
 * and secret have their own tests). The widget's token, origin and
 * conversation checks are passed through; the database is the call-widget
 * tests' in-memory one.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fakeClient } from '../callWidget/fakeDb';

type Dict = Record<string, unknown>;
type Turn = { urls: string[]; username: string | null; credential: string | null };

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => ({
  asked: [] as Array<{ callId: string; ttl: number; probe: string | null; hasReq: boolean }>,
  turn: { urls: [] as string[], username: null as string | null, credential: null as string | null },
  icePolicy: 'all',
  /** The builder's word that a relay is stored but this visitor is not handed it. */
  withheld: false,
  minted: [] as Array<{ callSessionId: string; participantType: string }>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/services/widget/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (req: { _widgetWorkspaceId?: string }, _res: unknown, next: () => void) => { req._widgetWorkspaceId = '11111111-1111-4111-8111-111111111111'; next(); },
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: () => '11111111-1111-4111-8111-111111111111',
  verifyConversationOwnership: async () => ({ valid: true }),
}));
const fakeProvider = vi.hoisted(() => ({
  createRoom: async (_c: unknown, input: { callSessionId: string }) => ({ providerRoomId: `room-${input.callSessionId}` }),
  createParticipantToken: async (_c: unknown, input: { callSessionId: string; participantType: string }) => {
    h.minted.push({ callSessionId: input.callSessionId, participantType: input.participantType });
    return { token: `tok-${input.callSessionId}`, expiresAt: '2026-11-04T10:00:00.000Z', identity: `visitor:${input.callSessionId}` };
  },
}));
vi.mock('../../../server/services/calls/providerResolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/providerResolver.js')>()),
  resolveCallProvider: () => fakeProvider,
  resolveEffectiveCallProvider: async () => ({ id: 'livekit', provider: fakeProvider }),
}));
vi.mock('../../../server/services/calls/controlPlane.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/controlPlane.js')>()),
  loadCallControlPlane: async () => ({ enabled: true, max_participants: 2 }),
  loadWorkspaceCallOverrides: async () => ({ allow_voice: true, allow_video: true }),
}));
vi.mock('../../../server/services/calls/invitations.js', async (importOriginal) => {
  const invitation = {
    id: 'inv-1', workspace_id: '11111111-1111-4111-8111-111111111111', conversation_id: '44444444-4444-4444-8444-444444444444',
    visitor_session_id: '55555555-5555-4555-8555-555555555555', channel: 'audio', status: 'pending', created_by_user_id: 'op-1',
  };
  return {
    ...(await importOriginal<typeof import('../../../server/services/calls/invitations.js')>()),
    getInvitationById: async () => invitation,
    validateInvitationForJoin: async () => ({ ok: true, invitation }),
    markInvitationJoined: async () => {},
  };
});
vi.mock('../../../server/services/calls/participantToken.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/participantToken.js')>()),
  buildTokenNetworkBundle: async (_config: unknown, callId: string, ttl: number, req?: { headers?: Dict } | null) => {
    h.asked.push({ callId, ttl, probe: (req?.headers?.['x-relay-probe'] as string | undefined) ?? null, hasReq: !!req });
    const turn = {
      ...h.turn,
      credential_type: 'password',
      static_secret_present: h.turn.urls.length > 0,
      countries: ['IR'],
      credential_ttl_seconds: 21_600,
    };
    return { network: { rtc_url: 'wss://livekit.example', ws_url: 'wss://rt.example', ice_policy: h.icePolicy, turn }, turn, withheld: h.withheld };
  },
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { widgetCallInvitationsRouter } = await import('../../../server/routes/widgetCallInvitations.js');
const { invalidateLiveKitConfigCache } = await import('../../../server/services/calls/livekitConfig.js');

function serve(mount: string, router: Router) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { serverConfig: Dict }).serverConfig = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };
    next();
  });
  app.use(express.json());
  app.use(mount, router);
  return http.createServer(app).listen(0);
}
const widgetServer = serve('/api/widget', widgetRouter);
const invitationServer = serve('/api/widget/call-invitations', widgetCallInvitationsRouter);
afterAll(() => { widgetServer.close(); invitationServer.close(); });

function post(server: http.Server, path: string, body: Dict, probe: string): Promise<{ status: number; body: Dict & { turn: Turn; warnings: string[] }; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-relay-probe': probe },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : {}, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const RELAY: Turn = {
  urls: ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp'],
  username: '1762321600:r8899aabbccddeeff',
  credential: 'bWludGVkLWJ5LXRoZS1idWlsZGVy',
};
const NONE: Turn = { urls: [], username: null, credential: null };

/** LiveKit as stored: with a TURN domain of its own, or without one. */
function liveKit(ownTurn: boolean) {
  db.app_runtime_config = [
    { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', turn_domain: ownTurn ? 'turn.example' : null } },
  ];
  invalidateLiveKitConfigCache();
}

beforeEach(() => {
  h.asked = [];
  h.minted = [];
  h.turn = { ...RELAY };
  h.icePolicy = 'all';
  h.withheld = false;
  liveKit(true);
  db.call_sessions = [{
    id: 'call-1', workspace_id: WS, provider: 'livekit', provider_room_id: 'room-call-1', call_type: 'audio',
    context_type: 'conversation', context_id: CONV, state: 'active', recording_enabled: false,
  }];
  db.visitor_sessions = [{ id: SESSION, visitor_id: 'v-1' }];
  db.call_events = [];
});

const visitorToken = (probe: string) =>
  post(widgetServer, '/api/widget/calls/call-1/visitor-token', { workspace_id: WS, visitor_id: 'v-1', session_id: SESSION }, probe);
const invitationJoin = (probe: string) =>
  post(invitationServer, '/api/widget/call-invitations/inv-1/join', { workspace_id: WS, visitor_id: 'v-1', session_id: SESSION }, probe);

describe('POST /api/widget/calls/:id/visitor-token', () => {
  it('answers the relay the builder gave for this call and this visitor\'s request, in the same shape', async () => {
    const r = await visitorToken('visitor-in-iran');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      token: 'tok-call-1', ws_url: 'wss://rt.example', rtc_url: 'wss://livekit.example',
      ice_policy: 'all', call_type: 'audio', recording: false, warnings: [],
    });
    expect(r.body.turn).toEqual(RELAY);
    expect(h.asked).toEqual([{ callId: 'call-1', ttl: 600, probe: 'visitor-in-iran', hasReq: true }]);
    expect(h.minted).toEqual([{ callSessionId: 'call-1', participantType: 'visitor' }]);
    expect(r.text).not.toContain('countries');
    expect(r.text).not.toContain('static_secret_present');
  });

  it('a visitor the gate leaves out: urls [], and no turn_missing while LiveKit has its own TURN', async () => {
    h.turn = { ...NONE };
    h.withheld = true;
    const r = await visitorToken('visitor-in-turkey');
    expect(r.status).toBe(200);
    expect(r.body.turn).toEqual(NONE);
    expect(r.body.warnings).toEqual([]);
  });

  it('turn_missing for a visitor left out when LiveKit has no TURN of its own either', async () => {
    h.turn = { ...NONE };
    h.withheld = true;
    liveKit(false);
    const r = await visitorToken('visitor');
    expect(r.body.warnings).toEqual(['turn_missing']);
  });

  it('no relay stored at all (RESPOK): turn_missing as this route has always answered', async () => {
    h.turn = { ...NONE };
    const r = await visitorToken('visitor');
    expect(r.body.turn).toEqual(NONE);
    expect(r.body.warnings).toEqual(['turn_missing']);
  });
});

describe('POST /api/widget/call-invitations/:id/join', () => {
  it('answers the relay the builder gave for the new call and this visitor\'s request, in the same shape', async () => {
    const r = await invitationJoin('visitor-in-iran');
    expect(r.status).toBe(200);
    const callId = String(r.body.call_id);
    expect(callId).toBeTruthy();
    expect(r.body).toMatchObject({
      invitation_id: 'inv-1', call_type: 'audio', token: `tok-${callId}`,
      ws_url: 'wss://rt.example', rtc_url: 'wss://livekit.example', ice_policy: 'all', warnings: [],
    });
    expect(r.body.turn).toEqual(RELAY);
    expect(h.asked).toEqual([{ callId, ttl: 600, probe: 'visitor-in-iran', hasReq: true }]);
    expect(r.text).not.toContain('countries');
    expect(r.text).not.toContain('static_secret_present');
  });

  it('a visitor the gate leaves out: urls [], and no turn_missing while LiveKit has its own TURN', async () => {
    h.turn = { ...NONE };
    h.withheld = true;
    const r = await invitationJoin('visitor-in-turkey');
    expect(r.status).toBe(200);
    expect(r.body.turn).toEqual(NONE);
    expect(r.body.warnings).toEqual([]);
  });

  it('turn_missing for a visitor left out when LiveKit has no TURN of its own either', async () => {
    h.turn = { ...NONE };
    h.withheld = true;
    liveKit(false);
    expect((await invitationJoin('visitor')).body.warnings).toEqual(['turn_missing']);
  });

  it('no relay stored at all (RESPOK): turn_missing as this route has always answered', async () => {
    h.turn = { ...NONE };
    expect((await invitationJoin('visitor')).body.warnings).toEqual(['turn_missing']);
  });
});

/**
 * Neither route mints or reads the secret itself any more: one copy of the
 * relay rule, in the builder, or the next rule (an encrypted secret, a
 * country list, a lifetime) misses a path again.
 */
describe('one relay rule for every visitor path', () => {
  const visitorTokenRoute = (() => {
    const src = readFileSync('server/routes/widget.ts', 'utf8');
    const start = src.indexOf("widgetRouter.post('/calls/:id/visitor-token'");
    return src.slice(start, src.indexOf('widgetRouter.', start + 10));
  })();
  const invitations = readFileSync('server/routes/widgetCallInvitations.ts', 'utf8');
  const callWidget = readFileSync('server/routes/callWidget.ts', 'utf8');
  const callCenter = readFileSync('server/routes/callCenter.ts', 'utf8');

  it.each([
    ['widget visitor-token', visitorTokenRoute],
    ['widget invitation join', invitations],
    ['call-widget join-token', callWidget],
    ['call-center accept', callCenter],
  ])('%s: no mintTurnCreds, no shared_secret read of its own, the builder given the request', (_name, src) => {
    expect(src).not.toContain('mintTurnCreds');
    expect(src).not.toContain('shared_secret');
    expect(src).toMatch(/buildTokenNetworkBundle\([^)]*,\s*req\)/);
  });
});
