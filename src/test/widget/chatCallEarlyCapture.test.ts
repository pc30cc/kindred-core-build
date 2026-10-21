/**
 * The chat widget's call engine (public/widget/runtime-call.js) opens the
 * microphone and the camera while the room connects, in one request, and
 * publishes both together. A refusal falls back to the original
 * setMicrophoneEnabled / setCameraEnabled, so its error codes are unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(resolve(process.cwd(), 'public/widget/runtime-call.js'), 'utf8');
const doms: JSDOM[] = [];

/** The loose shapes the fake LiveKit and the engine pass around. */
type Obj = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;
interface Track { kind: string; stop(): void; mediaStreamTrack: Obj }
interface Win { LivekitClient: unknown; eval(src: string): void; __gs_call: { engine: Engine } }
interface Engine {
  connect(o: Obj): Promise<void>;
  disconnect(): unknown;
  getState(): { state: string } & Obj;
  on(e: string, fn: (e: Obj) => void): void;
}
afterEach(() => { while (doms.length) doms.pop()!.window.close(); });

interface Ctl { createDenied?: boolean; micDenied?: boolean; connectError?: string | null; slowConnect?: boolean }

function boot(ctl: Ctl = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://customer.example/', runScripts: 'outside-only' });
  doms.push(dom);
  const win = dom.window as unknown as Win;
  const log = { created: [] as Obj[], published: [] as Obj[], mic: [] as boolean[], cam: [] as unknown[], stopped: 0, roomOptions: null as unknown, order: [] as string[] };
  let finishConnect: () => void = () => {};

  const pubs = () => new Map<string, unknown>();
  class Room {
    remoteParticipants = new Map();
    handlers: Record<string, Fn[]> = {};
    localParticipant: Obj;
    constructor(o: unknown) {
      log.roomOptions = o;
      const lp = {
        trackPublications: pubs(), videoTrackPublications: pubs(),
        isMicrophoneEnabled: false, isCameraEnabled: false,
        createTracks(o2: Obj) {
          log.order.push('createTracks');
          log.created.push(o2);
          if (ctl.createDenied) return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
          const out: Track[] = [];
          for (const kind of ['audio', 'video']) {
            if (!o2[kind]) continue;
            out.push({ kind, stop() { log.stopped += 1; }, mediaStreamTrack: { readyState: 'live', getSettings: () => ({}) } });
          }
          return Promise.resolve(out);
        },
        publishTrack(t: Track, o3: { source: string }) {
          log.order.push('publish:' + o3.source);
          log.published.push({ kind: t.kind, source: o3.source });
          if (t.kind === 'audio') lp.isMicrophoneEnabled = true; else lp.isCameraEnabled = true;
          return Promise.resolve({ track: t, kind: t.kind });
        },
        setMicrophoneEnabled(on: boolean) {
          log.mic.push(on);
          if (ctl.micDenied) return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
          lp.isMicrophoneEnabled = on; return Promise.resolve({});
        },
        setCameraEnabled(on: boolean, c?: unknown) { log.cam.push(c); lp.isCameraEnabled = on; return Promise.resolve({}); },
      };
      this.localParticipant = lp;
    }
    on(e: string, fn: Fn) { (this.handlers[e] ||= []).push(fn); return this; }
    connect() {
      log.order.push('connect');
      if (ctl.connectError) return Promise.reject(new Error(ctl.connectError));
      if (ctl.slowConnect) return new Promise<void>((r) => { finishConnect = r; });
      return Promise.resolve();
    }
    disconnect() {}
  }
  const E = new Proxy({}, { get: (_t, k) => String(k) });
  win.LivekitClient = {
    Room, RoomEvent: E,
    Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Microphone: 'microphone', Camera: 'camera' } },
  };
  win.eval(SRC);
  return { engine: win.__gs_call.engine, log, finish: () => finishConnect() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const opts = (over: object = {}) => ({ wsUrl: 'wss://lk.example', token: 't', publishMic: true, publishCamera: false, ...over });

describe('chat widget call engine: early capture', () => {
  it('opens the devices BEFORE the room finishes connecting, then publishes both', async () => {
    const { engine, log, finish } = boot({ slowConnect: true });
    const done = engine.connect(opts({ publishCamera: true }));
    await flush();
    // the capture has started and the handshake has not finished
    expect(log.order).toEqual(['createTracks', 'connect']);
    expect(log.created).toEqual([{
      audio: true,
      video: { facingMode: 'user', resolution: { width: 1280, height: 720, frameRate: 30 } },
    }]);
    finish();
    await done;
    expect(log.published).toEqual([{ kind: 'audio', source: 'microphone' }, { kind: 'video', source: 'camera' }]);
    expect(log.mic).toEqual([]);
    expect(log.cam).toEqual([]);
    expect(engine.getState().state).toBe('connected');
  });

  it('a voice call asks for the microphone only', async () => {
    const { engine, log } = boot();
    await engine.connect(opts());
    expect(log.created).toEqual([{ audio: true, video: false }]);
    expect(log.published).toEqual([{ kind: 'audio', source: 'microphone' }]);
  });

  it('builds the room with the shared tuning', async () => {
    const { engine, log } = boot();
    await engine.connect(opts());
    expect(log.roomOptions).toMatchObject({
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      publishDefaults: { videoCodec: 'vp8', dtx: true, red: true, audioPreset: { maxBitrate: 32000 } },
    });
  });

  it('a refused request falls back to the original calls and keeps their error code', async () => {
    const { engine, log } = boot({ createDenied: true, micDenied: true });
    const errors: Obj[] = [];
    engine.on('error', (e: Obj) => errors.push(e));
    await engine.connect(opts({ publishCamera: true }));
    expect(log.mic).toEqual([true]);
    expect(log.cam.length).toBe(1);
    expect(log.published).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(['permission_denied_microphone']);
  });

  it('a failed connect stops the devices that were opened', async () => {
    const { engine, log } = boot({ connectError: 'boom' });
    await expect(engine.connect(opts({ publishCamera: true }))).rejects.toBeTruthy();
    expect(log.stopped).toBe(2);
    expect(log.published).toEqual([]);
  });

  it('hanging up while connecting stops the devices that were opened', async () => {
    const { engine, log, finish } = boot({ slowConnect: true });
    const done = engine.connect(opts({ publishCamera: true })).catch(() => {});
    await flush();
    await engine.disconnect();
    finish();
    await done;
    expect(log.stopped).toBe(2);
    expect(log.published).toEqual([]);
  });
});
