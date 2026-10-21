/**
 * How the web clients configure their LiveKit room, kept in one place so the
 * operator panel and the call center console open a call the same way.
 *
 * Two things make a call look bad in its first seconds, and both are fixed
 * here rather than at each call site:
 *
 *  1. The room's defaults. `adaptiveStream` sizes the video it asks for from
 *     the element's CSS pixels, so on a 2x phone it asked for a layer a
 *     quarter of what the screen can show; `pixelDensity: 'screen'` asks for
 *     what the display can use. The publish defaults are stated rather than
 *     inherited, so an SDK upgrade cannot change a call's codec or audio
 *     bitrate by itself.
 *  2. The order of the steps. The camera and the microphone used to be opened
 *     one after the other AFTER the room had connected, so their permission
 *     prompts and device start-up were added to the connect time.
 *     `precaptureLocalMedia` opens them while the room connects, in one
 *     request, and `publishPrecaptured` publishes what it got.
 *
 * The website widgets (`public/widget`, `public/call-widget`) carry the same
 * values in plain JS, because they cannot import this file: keep the numbers
 * in step.
 */
import type {
  CreateLocalTracksOptions,
  LocalTrack,
  LocalTrackPublication,
  Room,
  RoomOptions,
  TrackPublishOptions,
} from 'livekit-client';

/** Opus for speech. Matches the admin default (`default_audio_bitrate_kbps`: 32). */
export const CALL_AUDIO_MAX_BITRATE = 32_000;

export function callRoomOptions(): RoomOptions {
  return {
    adaptiveStream: { pixelDensity: 'screen' },
    dynacast: true,
    publishDefaults: {
      videoCodec: 'vp8',
      dtx: true,
      red: true,
      audioPreset: { maxBitrate: CALL_AUDIO_MAX_BITRATE },
    },
  };
}

export interface PrecapturedMedia {
  /** Resolves once the capture attempt is over. Never rejects. */
  ready: Promise<void>;
  audio: LocalTrack | null;
  video: LocalTrack | null;
  /** Hands a track over to the room, so `dispose` leaves it alone. */
  take(kind: 'audio' | 'video'): LocalTrack | null;
  /** Stops every track nobody took. Safe to call at any time, any number of times. */
  dispose(): void;
}

export interface PrecaptureWant {
  audio?: CreateLocalTracksOptions['audio'];
  /** `false` or absent: no camera. Otherwise the capture options. */
  video?: CreateLocalTracksOptions['video'];
}

/**
 * Opens the requested devices now, for a room that has not connected yet.
 *
 * It asks for the microphone and the camera in ONE request, so the browser
 * shows one prompt. A refusal is not an error here: the caller falls back to
 * the old `setMicrophoneEnabled` / `setCameraEnabled`, which fail the way they
 * always did and so keep their error handling.
 */
export function precaptureLocalMedia(room: Room, want: PrecaptureWant): PrecapturedMedia {
  let disposed = false;
  const held: { audio: LocalTrack | null; video: LocalTrack | null } = { audio: null, video: null };
  const stop = (t: LocalTrack | null) => {
    if (!t) return;
    try { t.stop(); } catch { /* already stopped */ }
  };

  const wantAudio = !!want.audio;
  const wantVideo = !!want.video;
  const ready: Promise<void> = (!wantAudio && !wantVideo
    ? Promise.resolve()
    : room.localParticipant
        .createTracks({
          audio: wantAudio ? want.audio : false,
          video: wantVideo ? want.video : false,
        })
        .then((tracks) => {
          for (const t of tracks) {
            if (disposed) { stop(t); continue; }
            if (t.kind === 'audio') held.audio = t;
            else if (t.kind === 'video') held.video = t;
          }
        })
  ).catch(() => { /* the fallback at publish time reports it */ });

  const media: PrecapturedMedia = {
    ready,
    get audio() { return held.audio; },
    get video() { return held.video; },
    take(kind) {
      const t = held[kind];
      held[kind] = null;
      return t;
    },
    dispose() {
      disposed = true;
      stop(held.audio); held.audio = null;
      stop(held.video); held.video = null;
    },
  };
  return media;
}

/**
 * Publishes the pre-captured track of `kind` and returns its publication, or
 * returns `null` when there was none, so the caller runs its original path.
 * A failed publish gives the track back to be stopped and is reported as `null`
 * too, for the same reason.
 */
export async function publishPrecaptured(
  room: Room,
  media: PrecapturedMedia,
  kind: 'audio' | 'video',
  source: TrackPublishOptions['source'],
): Promise<LocalTrackPublication | null> {
  await media.ready;
  const track = media.take(kind);
  if (!track) return null;
  try {
    return await room.localParticipant.publishTrack(track, { source });
  } catch {
    try { track.stop(); } catch { /* already stopped */ }
    return null;
  }
}
