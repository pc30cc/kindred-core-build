/**
 * The call widget's visitor and the Iran relay (2026-11-04): the join token
 * carries `turn` (gated on the server by the visitor's country) and the
 * engine hands it to LiveKit at connect, as `rtcConfig.iceServers`.
 *
 * Only a non-empty list goes in. ICE servers given at connect REPLACE the
 * ones LiveKit sends over signalling, its own TURN among them, so an empty
 * list (no relay configured, or a visitor outside the relay's countries) or
 * an older server's answer without `turn` must leave connect as it was:
 * two arguments' worth, LiveKit's servers kept.
 *
 * Run on the source and on each brand's shipped build (minified, kits
 * stripped), because that is what a customer's page runs.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callRoutes, closeCallWidgets, fakeApi, mountCallWidget, settle,
  type Brand, type CallServerState,
} from '../callWidget/mountCallWidget';

type Dict = Record<string, unknown>;

const NOW = Date.parse('2026-11-04T09:30:00Z');
const iso = (t: number) => new Date(t).toISOString();
const RELAY = {
  urls: ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp'],
  username: '1762300000:r0123456789abcdef',
  credential: 'bWludGVkLWNyZWRlbnRpYWw=',
};

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
afterEach(() => { closeCallWidgets(); vi.useRealTimers(); });

/** A live call whose join token answers `extra` beside the token and connect block; what room.connect() was given. */
async function joinWith(extra: Dict, shipped?: Brand) {
  const s: CallServerState = { state: 'active', agent: 'A', name: 'Sara', startedAt: iso(NOW - 30_000) };
  const api = fakeApi(callRoutes(s, (req) => (/\/calls\/[^/]+\/join-token$/.test(req.path)
    ? { body: { token: 'tok', provider: 'livekit', connect: { supported: true, server_url: 'wss://media.example', provider: 'livekit' }, ...extra } }
    : undefined)));
  const m = mountCallWidget({
    locale: 'en', now: NOW, shipped, liveKit: { early: true, present: ['op-a'] }, fetch: api.fetch,
    bootstrap: {
      active_call: { call_id: 'c1', state: 'active', session: 'S1', call_type: 'audio', created_at: iso(NOW - 60_000), queue_position: null },
    },
  });
  // The fake room records only the URL; this keeps every argument.
  const Room = (m.win as unknown as { LivekitClient: { Room: { prototype: { connect(...a: unknown[]): Promise<void> } } } }).LivekitClient.Room;
  const calls: unknown[][] = [];
  const original = Room.prototype.connect;
  Room.prototype.connect = function (this: unknown, ...args: unknown[]) { calls.push(args); return original.apply(this, args as [string]); };
  await settle();
  m.loadLinks();
  await settle();
  expect(calls.length).toBe(1);
  expect(calls[0][0]).toBe('wss://media.example');
  expect(calls[0][1]).toBe('tok');
  return { args: calls[0], api, m };
}

for (const shipped of [undefined, 'iran', 'respok'] as const) {
  describe(`the engine's connect (${shipped ? `${shipped} build` : 'source'})`, () => {
    it('a relay in the join token goes to LiveKit as its ICE servers, with the policy the server named', async () => {
      const { args } = await joinWith({ turn: RELAY, ice_policy: 'all' }, shipped);
      expect(args[2]).toEqual({
        rtcConfig: {
          iceServers: [{ urls: RELAY.urls, username: RELAY.username, credential: RELAY.credential }],
          iceTransportPolicy: 'all',
        },
      });
    });

    it('ice_policy relay is passed on; anything else is all', async () => {
      expect((await joinWith({ turn: RELAY, ice_policy: 'relay' }, shipped)).args[2])
        .toMatchObject({ rtcConfig: { iceTransportPolicy: 'relay' } });
      closeCallWidgets();
      expect((await joinWith({ turn: RELAY, ice_policy: 'nonsense' }, shipped)).args[2])
        .toMatchObject({ rtcConfig: { iceTransportPolicy: 'all' } });
    });

    it('a relay with no static pair (none minted) still goes in, without a username or credential', async () => {
      const { args } = await joinWith({ turn: { urls: RELAY.urls, username: null, credential: null }, ice_policy: 'all' }, shipped);
      const server = (args[2] as { rtcConfig: { iceServers: Dict[] } }).rtcConfig.iceServers[0];
      expect(server.urls).toEqual(RELAY.urls);
      expect(server.username).toBeUndefined();
      expect(server.credential).toBeUndefined();
    });

    it('urls [] (no relay, or a visitor outside its countries): no ICE servers handed over, so LiveKit keeps its own TURN', async () => {
      const { args, m } = await joinWith({ turn: { urls: [], username: null, credential: null }, ice_policy: 'relay' }, shipped);
      expect(args[2]).toBeUndefined();
      // The call goes on as it always did.
      expect((m.ctrl as unknown as { connectStatus: string }).connectStatus).toBe('in_call');
    });

    it('an older server\'s join token without turn: connect as before', async () => {
      const { args } = await joinWith({}, shipped);
      expect(args[2]).toBeUndefined();
    });
  });
}
