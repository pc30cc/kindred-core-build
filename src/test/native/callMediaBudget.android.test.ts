// @vitest-environment node
/**
 * What the Android app's camera sends on a call, read from its Kotlin.
 *
 * On 2026-11-03 colleague video calls between an iPhone and an Android phone
 * on Iranian mobile data carried about 4 Mbps through that link (the phone
 * uploaded all three of LiveKit's default layers, 2.3-2.4 Mbps, and
 * downloaded the iPhone's 720p at 1.7 Mbps), which clogged it until the
 * signalling timed out and the call ended. The fix halves it: a 720p top
 * layer at 1 Mbps and 24 fps, layers of 320x180 at 120 kbps and 15 fps and
 * 640x360 at 400 kbps and 20 fps, VP8 with simulcast, adaptive stream and
 * dynacast as before, set as the room's defaults so every call the app makes
 * or answers (colleague or visitor) sends them. The SDK is 2.29.2, which
 * stops a layer dynacast paused from uploading again after a renegotiation.
 *
 * The Gradle build is not run here (no Android SDK on this box); CI's
 * android.yml runs CallVideoEncodingTest.kt against the SDK's own types. This
 * holds the source to the same numbers, and to the one place a room is built,
 * so a change to either fails before a phone is ever built. The iPhone's copy
 * is held by callMediaBudget.ios.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(path, 'utf8');

const CALL_DIR = 'android/app/src/main/kotlin/com/platform/app/feature/call';
const VERSIONS = read('android/gradle/libs.versions.toml');
const ENCODING = code(read(`${CALL_DIR}/CallVideoEncoding.kt`));
const ROOM = code(read(`${CALL_DIR}/LiveKitRoom.kt`));

/** Kotlin with its comments taken out, so a comment quoting a number is not the code using it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The text between the parentheses that open right after `marker`, balanced. */
function argsOf(source: string, marker: string, from = 0): string {
  const at = source.indexOf(marker, from);
  expect(at, `${marker} not found`).toBeGreaterThanOrEqual(0);
  const open = at + marker.length - 1;
  expect(source[open], `${marker} must end with "("`).toBe('(');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${marker}`);
}

/** Named arguments as name -> text, for a flat argument list (nested calls kept whole). */
function namedArgs(args: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  for (const part of parts) {
    const m = part.trim().match(/^(\w+)\s*=\s*([\s\S]+)$/);
    if (m) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return out;
}

/**
 * Every `const val NAME = 1_000_000` of the encoding object, as numbers. A
 * value that is not a plain number on its own (`1_000_000 * 2`, another
 * constant) reads as NaN, so it can never pass for the number it starts with.
 */
function constants(source: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of source.matchAll(/^[ \t]*const val (\w+)\s*=\s*(.*?)\s*$/gm)) {
    out[m[1]] = /^\d[\d_]*$/.test(m[2]) ? Number(m[2].replace(/_/g, '')) : Number.NaN;
  }
  return out;
}

/** One entry per occurrence of `re` (global) in `files`, as the file's path. */
function occurrences(files: { path: string; text: string }[], re: RegExp): string[] {
  return files.flatMap((f) => (f.text.match(re) ?? []).map(() => f.path));
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

const N = constants(ENCODING);

describe('Android call media budget', () => {
  it('builds against LiveKit Android SDK 2.29.2', () => {
    expect(VERSIONS).toMatch(/^livekit = "2\.29\.2"$/m);
    expect(VERSIONS).toMatch(
      /^livekit-android = \{ group = "io\.livekit", name = "livekit-android", version\.ref = "livekit" \}$/m,
    );
    // One version only: no other LiveKit coordinate or version in the build.
    expect(VERSIONS.match(/^livekit[\w-]*\s*=/gm)).toEqual(['livekit =', 'livekit-android =']);
    for (const build of ['android/app/build.gradle.kts', 'android/build.gradle.kts']) {
      expect(read(build)).not.toMatch(/io\.livekit:/);
    }
  });

  it('names the numbers: 1280x720 capture, a 1 Mbps / 24 fps top layer, 120 kbps / 15 and 400 kbps / 20 below', () => {
    expect(N).toEqual({
      CAPTURE_WIDTH: 1280,
      CAPTURE_HEIGHT: 720,
      CAPTURE_FPS: 30,
      TOP_MAX_BITRATE_BPS: 1_000_000,
      TOP_MAX_FPS: 24,
      LOW_WIDTH: 320,
      LOW_HEIGHT: 180,
      LOW_MAX_BITRATE_BPS: 120_000,
      LOW_MAX_FPS: 15,
      MID_WIDTH: 640,
      MID_HEIGHT: 360,
      MID_MAX_BITRATE_BPS: 400_000,
      MID_MAX_FPS: 20,
    });
  });

  it('never sends more than 1.52 Mbps, nor a layer faster than the top', () => {
    expect(N.TOP_MAX_BITRATE_BPS + N.MID_MAX_BITRATE_BPS + N.LOW_MAX_BITRATE_BPS).toBeLessThanOrEqual(1_520_000);
    expect(N.MID_MAX_FPS).toBeLessThanOrEqual(N.TOP_MAX_FPS);
    expect(N.LOW_MAX_FPS).toBeLessThanOrEqual(N.TOP_MAX_FPS);
    // The SDK scales a layer down by the capture's long side over the
    // layer's: whole numbers keep each layer exactly the size named.
    expect(N.CAPTURE_WIDTH / N.LOW_WIDTH).toBe(4);
    expect(N.CAPTURE_WIDTH / N.MID_WIDTH).toBe(2);
    expect(N.CAPTURE_HEIGHT / N.LOW_HEIGHT).toBe(4);
    expect(N.CAPTURE_HEIGHT / N.MID_HEIGHT).toBe(2);
  });

  it('captures from the front camera at the named size', () => {
    const capture = namedArgs(argsOf(ENCODING, 'val captureDefaults = LocalVideoTrackOptions('));
    expect(capture.position).toBe('CameraPosition.FRONT');
    expect(capture.isScreencast).toBeUndefined();
    expect(namedArgs(argsOf(capture.captureParams, 'VideoCaptureParameter('))).toEqual({
      width: 'CAPTURE_WIDTH',
      height: 'CAPTURE_HEIGHT',
      maxFps: 'CAPTURE_FPS',
    });
  });

  it('publishes the camera with those numbers: VP8, simulcast on, the two layers smallest first', () => {
    const publishArgs = argsOf(ENCODING, 'val publishDefaults = VideoTrackPublishDefaults(');
    const publish = namedArgs(publishArgs);
    expect(Object.keys(publish).sort()).toEqual(['simulcast', 'simulcastLayers', 'videoCodec', 'videoEncoding']);
    expect(publish.videoEncoding).toBe('VideoEncoding(maxBitrate = TOP_MAX_BITRATE_BPS, maxFps = TOP_MAX_FPS)');
    expect(publish.simulcast).toBe('true');
    expect(publish.videoCodec).toBe('VideoCodec.VP8.codecName');

    const layers = argsOf(publish.simulcastLayers, 'listOf(');
    const low = argsOf(layers, 'CustomVideoPreset(');
    const mid = argsOf(layers, 'CustomVideoPreset(', layers.indexOf(low) + low.length);
    expect(namedArgs(low)).toEqual({
      capture: 'VideoCaptureParameter(width = LOW_WIDTH, height = LOW_HEIGHT, maxFps = LOW_MAX_FPS)',
      encoding: 'VideoEncoding(maxBitrate = LOW_MAX_BITRATE_BPS, maxFps = LOW_MAX_FPS)',
    });
    expect(namedArgs(mid)).toEqual({
      capture: 'VideoCaptureParameter(width = MID_WIDTH, height = MID_HEIGHT, maxFps = MID_MAX_FPS)',
      encoding: 'VideoEncoding(maxBitrate = MID_MAX_BITRATE_BPS, maxFps = MID_MAX_FPS)',
    });
    expect(layers.match(/CustomVideoPreset\(/g)).toHaveLength(2);
  });

  it('gives every room those defaults, with adaptive stream and dynacast on', () => {
    const create = namedArgs(argsOf(ROOM, 'LiveKit.create('));
    expect(create.options.startsWith('RoomOptions(')).toBe(true);
    expect(namedArgs(argsOf(create.options, 'RoomOptions('))).toEqual({
      adaptiveStream: 'true',
      dynacast: 'true',
      videoTrackCaptureDefaults: 'CallVideoEncoding.captureDefaults',
      videoTrackPublishDefaults: 'CallVideoEncoding.publishDefaults',
    });
    // The camera goes up through the room's defaults, never with options of its own.
    expect(ROOM).toMatch(/setCameraEnabled\(true\)/);
  });

  it('builds a room nowhere else, and publishes no video with options of its own', () => {
    const app = files('android/app/src/main/kotlin', /\.kt$/).map((path) => ({ path, text: code(read(path)) }));
    const where = (re: RegExp) => app.filter((f) => re.test(f.text)).map((f) => f.path);
    // Once each, in the whole app: the one room, built with the one set of options.
    expect(occurrences(app, /\bLiveKit\.create\(/g)).toEqual([`${CALL_DIR}/LiveKitRoom.kt`]);
    expect(occurrences(app, /\bRoomOptions\(/g)).toEqual([`${CALL_DIR}/LiveKitRoom.kt`]);
    expect(where(/\bVideoTrackPublishDefaults\(/)).toEqual([`${CALL_DIR}/CallVideoEncoding.kt`]);
    // The room's camera defaults are named only as those two arguments: never
    // set on the room or its participant afterwards, nor copied with changes.
    expect(occurrences(app, /\bvideoTrackCaptureDefaults\b/g)).toEqual([`${CALL_DIR}/LiveKitRoom.kt`]);
    expect(occurrences(app, /\bvideoTrackPublishDefaults\b/g)).toEqual([`${CALL_DIR}/LiveKitRoom.kt`]);
    expect(where(/\bCallVideoEncoding\.\w+\s*\.\s*copy\(|\bsetRoomOptions\(/)).toEqual([]);
    expect(where(/\bpublishVideoTrack\(|\bVideoTrackPublishOptions\(/)).toEqual([]);
    // No LiveKit preset as an encoding: each is above this budget.
    expect(where(/\bVideoPreset(169|43)\.\w+\.encoding\b/)).toEqual([]);
  });
});
