/**
 * A colleague's video call from a computer without a working camera
 * (TEAM_CALLS.md: "A video call may be answered with the camera off"; "Web
 * panel": camera for video, answerable with it off).
 *
 * A connect that fails leaves the LiveKit room, and the webhook then ends a
 * colleague call for both members. So the call window asks the call stack
 * for a camera that is optional (`cameraOptional`): no camera on this
 * computer, one in use by another app, or one refused, and the call still
 * connects with the microphone, the camera off. The microphone still fails
 * the connect, and the visitor call (no `cameraOptional`) is unchanged.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const lk = vi.hoisted(() => ({
  cameraError: null as unknown,
  micError: null as unknown,
  rooms: [] as Array<{ disconnect: ReturnType<typeof vi.fn> }>,
}));

vi.mock('livekit-client', () => {
  class FakeRoom {
    localParticipant = {
      // The one combined capture fails as a whole when the camera does.
      createTracks: vi.fn(async () => { throw lk.cameraError ?? lk.micError ?? new Error('no devices in a test'); }),
      publishTrack: vi.fn(async () => ({})),
      setMicrophoneEnabled: vi.fn(async () => { if (lk.micError) throw lk.micError; }),
      setCameraEnabled: vi.fn(async () => { if (lk.cameraError) throw lk.cameraError; }),
      videoTrackPublications: new Map(),
      isCameraEnabled: false,
      isMicrophoneEnabled: true,
    };
    remoteParticipants = new Map();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
    constructor() { lk.rooms.push(this); }
    on() { return this; }
  }
  return {
    Room: FakeRoom,
    RoomEvent: new Proxy({}, { get: (_t, key) => String(key) }),
    Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Camera: 'camera', Microphone: 'microphone' } },
    VideoPresets: { h360: {}, h540: {}, h720: { resolution: { width: 1280, height: 720 } }, h1080: {} },
    createLocalVideoTrack: vi.fn(),
  };
});
vi.mock('@/features/calls/cameraFacing', () => ({
  enumerateCameras: async () => [],
  computeCanSwitchCamera: () => false,
}));

const { useLiveKitCall } = await import('@/hooks/useLiveKitCall');

const INPUT = { wsUrl: 'wss://lk.example.test', token: 'lk-token' };
const noCamera = () => new DOMException('Requested device not found', 'NotFoundError');

describe('a video call whose camera cannot open', () => {
  it('connects with the microphone and the camera off when the camera is optional (a colleague call)', async () => {
    lk.cameraError = noCamera();
    lk.micError = null;
    lk.rooms = [];
    const { result } = renderHook(() => useLiveKitCall({ publishMic: true, publishCamera: true, cameraOptional: true }));
    await act(async () => { await result.current.connect(INPUT); });
    expect(result.current.state).toBe('connected');
    expect(result.current.cameraEnabled).toBe(false);
    expect(result.current.micEnabled).toBe(true);
    // The room was never left: leaving it would end the call for both.
    expect(lk.rooms[0].disconnect).not.toHaveBeenCalled();
  });

  it('still fails on the microphone', async () => {
    lk.cameraError = null;
    lk.micError = new DOMException('Permission denied', 'NotAllowedError');
    lk.rooms = [];
    const { result } = renderHook(() => useLiveKitCall({ publishMic: true, publishCamera: true, cameraOptional: true }));
    await act(async () => {
      await expect(result.current.connect(INPUT)).rejects.toMatchObject({ name: 'NotAllowedError' });
    });
    expect(result.current.state).toBe('failed');
  });

  it('fails as before without it (the visitor call is unchanged)', async () => {
    lk.cameraError = noCamera();
    lk.micError = null;
    lk.rooms = [];
    const { result } = renderHook(() => useLiveKitCall({ publishMic: true, publishCamera: true }));
    await act(async () => {
      await expect(result.current.connect(INPUT)).rejects.toMatchObject({ name: 'NotFoundError' });
    });
    expect(result.current.state).toBe('failed');
    expect(lk.rooms[0].disconnect).toHaveBeenCalled();
  });
});
