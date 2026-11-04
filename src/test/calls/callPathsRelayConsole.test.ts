/**
 * The call centre operator's console and the Iran relay (2026-11-04): the
 * accept answers the relay (gated on the server by the operator's country)
 * inside `connect`, the one object the queue page hands the console, and the
 * console gives it to LiveKit at room.connect as `rtcConfig.iceServers`.
 *
 * Only a non-empty list goes in. ICE servers given at connect REPLACE the
 * ones LiveKit sends over signalling, its own TURN among them, so `urls: []`
 * (no relay, or an operator outside its countries) and an older server's
 * `connect` without `turn` leave room.connect as it was. The console's
 * Reconnect accepts again and joins with the relay of that new answer.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';

const lk = vi.hoisted(() => ({
  /** Every room.connect() argument list, in order. */
  connects: [] as unknown[][],
  /** room.connect() rejects with this message (then is cleared). */
  failNext: null as string | null,
}));

vi.mock('@/lib/livekit-loader', () => ({
  loadLiveKitClient: async () => {
    class Room {
      state = 'connected';
      localParticipant = {
        identity: 'operator:0000000000000000',
        audioTrackPublications: new Map(),
        videoTrackPublications: new Map(),
        createTracks: async () => [],
        setMicrophoneEnabled: async () => undefined,
        setCameraEnabled: async () => undefined,
      };
      remoteParticipants = new Map();
      on() { return this; }
      async connect(...args: unknown[]) {
        lk.connects.push(args);
        if (lk.failNext) { const m = lk.failNext; lk.failNext = null; throw new Error(m); }
      }
      disconnect() { /* left */ }
    }
    const RoomEvent = new Proxy({}, { get: (_t, key) => String(key) });
    return { Room, RoomEvent, Track: { Source: { Microphone: 'microphone', Camera: 'camera' } } };
  },
}));

const { OperatorMediaConsole } = await import('@/components/call-center/OperatorMediaConsole');
type ConnectInfo = import('@/components/call-center/OperatorMediaConsole').OperatorConnectInfo;
const { I18nProvider } = await import('@/i18n');
const { default: en } = await import('@/i18n/locales/en');

const RELAY = {
  urls: ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp'],
  username: '1762321600:r0123456789abcdef',
  credential: 'bWludGVkLWZvci10aGUtY2FsbA==',
};
const base: ConnectInfo = { supported: true, provider: 'livekit', server_url: 'wss://lk.test', room_id: 'room-1' };

afterEach(() => { cleanup(); lk.connects = []; lk.failNext = null; });

function mount(connect: ConnectInfo, onReconnect?: () => Promise<{ token: string; connect: ConnectInfo } | null>) {
  const consoleNode = createElement(OperatorMediaConsole, {
    callId: 'call-1', callType: 'audio', connect, token: 'token-1', visitorName: 'Visitor',
    onEnd: async () => {}, onReconnect,
  });
  return render(createElement(I18nProvider, { initialLocale: 'en', initialTranslations: en, children: consoleNode }));
}

async function firstConnect(connect: ConnectInfo): Promise<unknown[]> {
  mount(connect);
  await waitFor(() => expect(lk.connects.length).toBe(1));
  expect(lk.connects[0][0]).toBe('wss://lk.test');
  expect(lk.connects[0][1]).toBe('token-1');
  return lk.connects[0];
}

describe('the operator console hands the accept\'s relay to LiveKit', () => {
  it('a relay in connect goes in as the ICE servers, with the policy the server named', async () => {
    const args = await firstConnect({ ...base, turn: RELAY, ice_policy: 'all' });
    expect(args[2]).toEqual({
      rtcConfig: {
        iceServers: [{ urls: RELAY.urls, username: RELAY.username, credential: RELAY.credential }],
        iceTransportPolicy: 'all',
      },
    });
  });

  it('ice_policy relay is passed on', async () => {
    const args = await firstConnect({ ...base, turn: RELAY, ice_policy: 'relay' });
    expect(args[2]).toMatchObject({ rtcConfig: { iceTransportPolicy: 'relay' } });
  });

  it('a relay without a static pair goes in without a username or credential', async () => {
    const args = await firstConnect({ ...base, turn: { urls: RELAY.urls, username: null, credential: null }, ice_policy: 'all' });
    const server = (args[2] as { rtcConfig: { iceServers: RTCIceServer[] } }).rtcConfig.iceServers[0];
    expect(server.urls).toEqual(RELAY.urls);
    expect(server.username).toBeUndefined();
    expect(server.credential).toBeUndefined();
  });

  it('urls [] (no relay, or an operator outside its countries): no ICE servers handed over, LiveKit keeps its own TURN', async () => {
    const args = await firstConnect({ ...base, turn: { urls: [], username: null, credential: null }, ice_policy: 'relay' });
    expect(args[2]).toBeUndefined();
  });

  it('an older server\'s connect without turn: connect as before', async () => {
    const args = await firstConnect(base);
    expect(args[2]).toBeUndefined();
  });

  it('Reconnect joins with the relay of the new accept, not the first one', async () => {
    lk.failNext = 'token expired';
    const onReconnect = vi.fn(async () => ({
      token: 'token-2',
      connect: { ...base, turn: RELAY, ice_policy: 'all' } as ConnectInfo,
    }));
    mount({ ...base, turn: { urls: [], username: null, credential: null } }, onReconnect);
    await waitFor(() => expect(lk.connects.length).toBe(1));
    expect(lk.connects[0][2]).toBeUndefined();
    fireEvent.click(await screen.findByRole('button', { name: /Reconnect/ }));
    await waitFor(() => expect(lk.connects.length).toBe(2));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(lk.connects[1][1]).toBe('token-2');
    expect(lk.connects[1][2]).toMatchObject({ rtcConfig: { iceServers: [{ urls: RELAY.urls }] } });
  });
});
