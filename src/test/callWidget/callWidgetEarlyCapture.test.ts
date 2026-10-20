/**
 * The call widget opens the microphone and the camera while the room
 * connects (one request, one prompt) and publishes what it got; a refusal
 * falls back to the original setMicrophoneEnabled / setCameraEnabled, so the
 * microphone screen and its retry (E13) behave as before.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callRoutes, closeCallWidgets, fakeApi, mountCallWidget, settle,
  type CallServerState, type Engine, type MountOptions,
} from './mountCallWidget';

const NOW = Date.parse('2026-10-22T07:30:00Z');
const iso = (t: number) => new Date(t).toISOString();

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
afterEach(() => { closeCallWidgets(); vi.useRealTimers(); });

async function liveCall(over: Partial<CallServerState> = {}, opts: MountOptions = {}) {
  const s: CallServerState = { state: 'active', agent: 'A', name: 'Sara', startedAt: iso(NOW - 134_000), ...over };
  const api = fakeApi(callRoutes(s));
  const m = mountCallWidget({
    locale: 'en', now: NOW, liveKit: { early: true, present: ['op-a'] }, ...opts, fetch: api.fetch,
    bootstrap: {
      active_call: { call_id: 'c1', state: s.state, session: 'S1', call_type: s.type ?? 'audio', created_at: iso(NOW - 60_000), queue_position: null },
    },
  });
  await settle();
  m.loadLinks();
  return { m, c: m.ctrl as unknown as Engine, lk: m.lk!, room: m.lk!.room() };
}

describe('early capture', () => {
  it('a voice call asks for the microphone only, publishes it, and never takes the slow path', async () => {
    const { c, room } = await liveCall();
    const lp = room.localParticipant;
    expect(lp.created).toEqual([{ audio: true, video: false }]);
    expect(lp.published).toEqual([{ kind: 'audio', source: 'microphone' }]);
    expect(lp.micCalls).toEqual([]);
    expect(lp.camCalls).toEqual([]);
    expect(c.micOn).toBe(true);
    expect(c.connectStatus).toBe('in_call');
  });

  it('a video call asks for both in ONE request and publishes both', async () => {
    const { c, room } = await liveCall({ type: 'video' });
    const lp = room.localParticipant;
    expect(lp.created).toEqual([{ audio: true, video: true }]);
    expect(lp.published.map((p) => p.source)).toEqual(['microphone', 'camera']);
    expect(lp.micCalls).toEqual([]);
    expect(lp.camCalls).toEqual([]);
    expect(c.micOn).toBe(true);
    expect(c.camOn).toBe(true);
  });

  it('the room is made with the shared tuning', async () => {
    const { room } = await liveCall();
    expect(room.options).toMatchObject({
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      publishDefaults: { videoCodec: 'vp8', dtx: true, red: true, audioPreset: { maxBitrate: 32000 } },
    });
  });

  it('a refused request falls back to the original calls: the microphone screen and its retry work', async () => {
    const { m, c, lk, room } = await liveCall({ type: 'video' }, { liveKit: { early: true, earlyDenials: 1, micDenials: 1, present: ['op-a'] } });
    const lp = room.localParticipant;
    expect(c.connectStatus).toBe('microphone_permission_denied');
    expect(m.screenId()).toBe('mic');
    expect(lp.micCalls).toEqual([true]);
    expect(lp.published).toEqual([]);
    expect(lp.camCalls).toEqual([]);
    expect(lk.earlyTracks ?? []).toEqual([]);
    await c.retryMicrophone!();
    await settle();
    expect(c.micOn).toBe(true);
    expect(c.camOn).toBe(true);
    expect(c.connectStatus).toBe('in_call');
  });

  it('a refused request but a working fallback still ends in a call', async () => {
    const { c, room } = await liveCall({ type: 'video' }, { liveKit: { early: true, earlyDenials: 1, present: ['op-a'] } });
    expect(room.localParticipant.micCalls).toEqual([true]);
    expect(room.localParticipant.camCalls).toEqual([true]);
    expect(c.micOn).toBe(true);
    expect(c.camOn).toBe(true);
    expect(c.connectStatus).toBe('in_call');
  });

  it('a call that fails to connect stops the devices it opened', async () => {
    const { lk } = await liveCall({ type: 'video' }, { liveKit: { early: true, connectError: 'boom', present: [] } });
    const tracks = lk.earlyTracks ?? [];
    expect(tracks.length).toBe(2);
    expect(tracks.every((t) => t.stopped === 1)).toBe(true);
  });

  it('hanging up leaves the tracks that were published alone', async () => {
    const { c, lk } = await liveCall({ type: 'video' }, { liveKit: { early: true, micDenials: 0, present: ['op-a'] } });
    // everything was published; leaving must not stop (or double-stop) published tracks
    c.disconnectRoom!();
    const tracks = lk.earlyTracks ?? [];
    expect(tracks.every((t) => (t.stopped ?? 0) === 0)).toBe(true);
  });
});
