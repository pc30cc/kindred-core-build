import { describe, it, expect, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Room } from 'livekit-client';
import {
  CALL_AUDIO_MAX_BITRATE,
  callRoomOptions,
  precaptureLocalMedia,
  publishPrecaptured,
} from '@/lib/livekit-tuning';

type Source = Parameters<typeof publishPrecaptured>[3];

function fakeTrack(kind: 'audio' | 'video') {
  return { kind, stop: vi.fn() };
}

function fakeRoom(createTracks: (o: unknown) => Promise<unknown[]>, publishTrack = vi.fn(async () => ({ ok: true }))) {
  return {
    room: { localParticipant: { createTracks: vi.fn(createTracks), publishTrack } } as unknown as Room,
    publishTrack,
  };
}

describe('callRoomOptions', () => {
  it('sizes adaptive video from the screen, not from CSS pixels', () => {
    expect(callRoomOptions().adaptiveStream).toEqual({ pixelDensity: 'screen' });
  });

  it('states the publish defaults instead of inheriting them', () => {
    const o = callRoomOptions();
    expect(o.dynacast).toBe(true);
    expect(o.publishDefaults).toMatchObject({
      videoCodec: 'vp8',
      dtx: true,
      red: true,
      audioPreset: { maxBitrate: CALL_AUDIO_MAX_BITRATE },
    });
  });
});

describe('precaptureLocalMedia', () => {
  it('asks for the microphone and the camera in ONE request', async () => {
    const a = fakeTrack('audio');
    const v = fakeTrack('video');
    const { room } = fakeRoom(async () => [a, v]);
    const media = precaptureLocalMedia(room, { audio: true, video: { facingMode: 'user' } });
    await media.ready;
    expect((room.localParticipant.createTracks as unknown as Mock).mock.calls).toHaveLength(1);
    expect((room.localParticipant.createTracks as unknown as Mock).mock.calls[0][0]).toEqual({
      audio: true,
      video: { facingMode: 'user' },
    });
    expect(media.take('audio')).toBe(a);
    expect(media.take('audio')).toBeNull();
    expect(media.take('video')).toBe(v);
  });

  it('opens nothing when nothing is wanted', async () => {
    const { room } = fakeRoom(async () => []);
    const media = precaptureLocalMedia(room, { audio: false, video: false });
    await media.ready;
    expect((room.localParticipant.createTracks as unknown as Mock).mock.calls).toHaveLength(0);
  });

  it('never rejects: a refused device just leaves nothing to publish', async () => {
    const { room } = fakeRoom(async () => { throw new DOMException('no', 'NotAllowedError'); });
    const media = precaptureLocalMedia(room, { audio: true, video: false });
    await expect(media.ready).resolves.toBeUndefined();
    expect(media.audio).toBeNull();
    expect(media.video).toBeNull();
  });

  it('dispose stops every track nobody took, and only those', async () => {
    const a = fakeTrack('audio');
    const v = fakeTrack('video');
    const { room } = fakeRoom(async () => [a, v]);
    const media = precaptureLocalMedia(room, { audio: true, video: true });
    await media.ready;
    const taken = media.take('audio');
    media.dispose();
    media.dispose();
    expect(taken).toBe(a);
    expect(a.stop).not.toHaveBeenCalled();
    expect(v.stop).toHaveBeenCalledTimes(1);
  });

  it('stops a track that arrives after dispose (a call cancelled mid-prompt)', async () => {
    const a = fakeTrack('audio');
    let release!: (t: unknown[]) => void;
    const { room } = fakeRoom(() => new Promise((r) => { release = r; }));
    const media = precaptureLocalMedia(room, { audio: true });
    media.dispose();
    release([a]);
    await media.ready;
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(media.audio).toBeNull();
  });
});

describe('publishPrecaptured', () => {
  it('publishes the captured track with its source', async () => {
    const a = fakeTrack('audio');
    const { room, publishTrack } = fakeRoom(async () => [a]);
    const media = precaptureLocalMedia(room, { audio: true });
    const pub = await publishPrecaptured(room, media, 'audio', 'microphone' as Source);
    expect(pub).toEqual({ ok: true });
    expect(publishTrack).toHaveBeenCalledWith(a, { source: 'microphone' });
  });

  it('returns null when there is nothing captured, so the caller runs its original path', async () => {
    const { room, publishTrack } = fakeRoom(async () => { throw new Error('denied'); });
    const media = precaptureLocalMedia(room, { audio: true });
    expect(await publishPrecaptured(room, media, 'audio', 'microphone' as Source)).toBeNull();
    expect(publishTrack).not.toHaveBeenCalled();
  });

  it('stops the track and returns null when publishing fails', async () => {
    const v = fakeTrack('video');
    const failing = vi.fn(async () => { throw new Error('closed'); });
    const { room } = fakeRoom(async () => [v], failing as unknown as ReturnType<typeof vi.fn>);
    const media = precaptureLocalMedia(room, { video: true });
    expect(await publishPrecaptured(room, media, 'video', 'camera' as Source)).toBeNull();
    expect(v.stop).toHaveBeenCalledTimes(1);
  });
});

describe('the website widgets carry the same room tuning', () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
  const widgets = ['public/widget/runtime-call.js', 'public/call-widget/runtime.js'];

  it.each(widgets)('%s uses screen pixel density and the shared publish defaults', (file) => {
    const src = read(file);
    expect(src).toContain("adaptiveStream: { pixelDensity: 'screen' }");
    expect(src).toContain("videoCodec: 'vp8'");
    expect(src).toContain(`audioPreset: { maxBitrate: ${CALL_AUDIO_MAX_BITRATE} }`);
    expect(src).not.toMatch(/new LK\.Room\(\{\s*adaptiveStream: true/);
  });

  it.each(widgets)('%s opens its devices while the room connects', (file) => {
    const src = read(file);
    expect(src).toContain('precaptureMedia(');
    expect(src).toContain('publishEarlyOr(');
    expect(src).toContain('createTracks(');
  });

  it('the operator surfaces build their room from callRoomOptions', () => {
    expect(read('src/hooks/useLiveKitCall.ts')).toContain('new Room(callRoomOptions())');
    expect(read('src/components/call-center/OperatorMediaConsole.tsx')).toContain('new LK.Room(callRoomOptions())');
  });
});
