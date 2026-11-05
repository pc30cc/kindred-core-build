/**
 * What the iPhone's camera sends on a call (`CallMediaBudget`,
 * ios/Webyar/Sources/Features/Calls/CallMediaBudget.swift), on a visitor's
 * call (CallSession.swift) and a colleague's (TeamCalls/TeamCallMedia.swift)
 * alike, with the same numbers as the Android app's call room.
 *
 * Measured on 2026-11-03: a colleague video call between an iPhone and an
 * Android phone on Iranian mobile data carried about 4 Mbps (LiveKit's
 * default layers for a 1280x720 camera, 1.7 Mbps for the 720p one alone),
 * the link clogged and the call ended. The caps below halve that.
 *
 * Pinned here: the numbers, that both rooms take them from the one shared
 * constant (and keep adaptive stream and dynacast on), that nothing else in
 * the app creates a room or publishes a camera around it, and how LiveKit
 * (client-sdk-swift 2.17.0, `Utils.computeSimulcastPresets`) turns them into
 * the three layers it sends. Plus the build number this change ships in.
 *
 * There is no Xcode here: the sources are read as text; CI's ios.yml builds
 * them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SOURCES = join(ROOT, 'ios', 'Webyar', 'Sources');

/** Swift with its comments removed: the reasons written beside the code name what it must not do. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

const swift = (path: string) => code(readFileSync(join(SOURCES, path), 'utf8'));

/** The call opened by `signature` (which ends in its `(`), up to its matching `)`. */
function call(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start + signature.length - 1; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unclosed ${signature}`);
}

const squash = (text: string) => text.replace(/\s+/g, ' ');
const int = (literal: string) => Number(literal.replace(/_/g, ''));

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return name.endsWith('.swift') ? [path] : [];
  });
}

const BUDGET = swift('Features/Calls/CallMediaBudget.swift');
const ROOMS = {
  'visitor call (CallSession)': swift('Features/Calls/CallSession.swift'),
  'colleague call (TeamCallRoom)': swift('Features/Calls/TeamCalls/TeamCallMedia.swift'),
};
const PROJECT = readFileSync(join(ROOT, 'ios', 'Webyar', 'project.yml'), 'utf8');

type Layer = { width: number; height: number; maxBitrate: number; maxFps: number };

function staticInt(name: string): number {
  const m = BUDGET.match(new RegExp(`static let ${name} = ([\\d_]+)[ \\t]*\\n`));
  expect(m, name).not.toBeNull();
  return int(m![1]);
}

function layer(name: string): Layer {
  const m = squash(BUDGET).match(new RegExp(
    `static let ${name} = VideoParameters\\( dimensions: Dimensions\\(width: (\\d+), height: (\\d+)\\), `
    + 'encoding: VideoEncoding\\(maxBitrate: ([\\d_]+), maxFps: (\\d+)\\) \\)',
  ));
  expect(m, name).not.toBeNull();
  return { width: int(m![1]), height: int(m![2]), maxBitrate: int(m![3]), maxFps: int(m![4]) };
}

const capture = (() => {
  const m = BUDGET.match(/static let captureDimensions = Dimensions\(width: (\d+), height: (\d+)\)[ \t]*\n/);
  expect(m).not.toBeNull();
  return { width: int(m![1]), height: int(m![2]), fps: staticInt('captureFps') };
})();
const top = { maxBitrate: staticInt('topMaxBitrate'), maxFps: staticInt('topMaxFps') };
const low = layer('lowLayer');
const mid = layer('midLayer');

/**
 * client-sdk-swift 2.17.0's `Utils.computeSimulcastPresets` for a camera (the
 * same in 2.19.0, the newest 2.x CI's `from: 2.17.0` resolves to):
 * the requested layers sorted by area (then bitrate, then frame rate), each
 * clamped to the top's frame rate (and to its bitrate only when it does not
 * scale down), three layers from a capture of 960 or more on its long side,
 * two from 480, else the top alone. Low to high: q, h, f.
 */
function sdkLayers(dimensions: { width: number; height: number }, base: typeof top, requested: Layer[]): Layer[] {
  const max = Math.max(dimensions.width, dimensions.height);
  const baseLayer = { width: dimensions.width, height: dimensions.height, ...base };
  const presets = [...requested].sort((a, b) =>
    a.width * a.height - b.width * b.height || a.maxBitrate - b.maxBitrate || a.maxFps - b.maxFps);
  const clamp = (p: Layer): Layer => ({
    ...p,
    maxFps: Math.min(p.maxFps, base.maxFps),
    maxBitrate: max / Math.max(p.width, p.height) <= 1 ? Math.min(p.maxBitrate, base.maxBitrate) : p.maxBitrate,
  });
  if (max >= 960 && presets[1]) return [clamp(presets[0]), clamp(presets[1]), baseLayer];
  if (max >= 480 && presets[0]) return [clamp(presets[0]), baseLayer];
  return [baseLayer];
}

describe('the iPhone call camera budget', () => {
  it('captures 1280x720 at 30 fps, as before, and caps the top layer at 1 Mbps, 24 fps', () => {
    // 30 is what every call captured at before (CameraCaptureOptions' default
    // in the SDK) and what the Android app captures at; only the encoder sends 24.
    expect(capture).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(top).toEqual({ maxBitrate: 1_000_000, maxFps: 24 });
    expect(capture.fps).toBeGreaterThanOrEqual(top.maxFps);
  });

  it('keeps simulcast with 320x180 @ 120 kbps 15 fps and 640x360 @ 400 kbps 20 fps below it', () => {
    expect(low).toEqual({ width: 320, height: 180, maxBitrate: 120_000, maxFps: 15 });
    expect(mid).toEqual({ width: 640, height: 360, maxBitrate: 400_000, maxFps: 20 });
  });

  it('is the front camera and the publish options built from those numbers, codec left as it was', () => {
    expect(squash(call(BUDGET, 'static let cameraCapture = CameraCaptureOptions(')))
      .toBe('static let cameraCapture = CameraCaptureOptions( position: .front, dimensions: captureDimensions, fps: captureFps )');
    expect(squash(call(BUDGET, 'static let videoPublish = VideoPublishOptions(')))
      .toBe('static let videoPublish = VideoPublishOptions( '
        + 'encoding: VideoEncoding(maxBitrate: topMaxBitrate, maxFps: topMaxFps), '
        + 'simulcast: true, simulcastLayers: [lowLayer, midLayer] )');
    expect(BUDGET).not.toMatch(/preferredCodec|preferredBackupCodec|degradationPreference|screenShare/);
  });

  it('comes out of LiveKit as the three layers asked for, none above them', () => {
    // Portrait or landscape: LiveKit scales by the long side either way.
    for (const dimensions of [capture, { width: capture.height, height: capture.width }]) {
      const sent = sdkLayers(dimensions, top, [mid, low]).map(({ maxBitrate, maxFps }) => ({ maxBitrate, maxFps }));
      expect(sent).toEqual([
        { maxBitrate: 120_000, maxFps: 15 },
        { maxBitrate: 400_000, maxFps: 20 },
        { maxBitrate: 1_000_000, maxFps: 24 },
      ]);
    }
    // Each lower layer smaller than the top and under its bitrate and frame
    // rate, so the SDK's clamp leaves it as written.
    for (const l of [low, mid]) {
      expect(Math.max(l.width, l.height)).toBeLessThan(Math.max(capture.width, capture.height));
      expect(l.maxBitrate).toBeLessThan(top.maxBitrate);
      expect(l.maxFps).toBeLessThanOrEqual(top.maxFps);
    }
  });

  describe.each(Object.entries(ROOMS))('the %s room', (_, source) => {
    it('takes the camera from the shared budget and keeps adaptive stream and dynacast on', () => {
      expect(source.match(/\bRoomOptions\(/g)).toHaveLength(1);
      expect(squash(call(source, 'roomOptions: RoomOptions('))).toBe(
        'roomOptions: RoomOptions( defaultCameraCaptureOptions: CallMediaBudget.cameraCapture, '
          + 'defaultVideoPublishOptions: CallMediaBudget.videoPublish, adaptiveStream: true, dynacast: true )',
      );
      expect(source).not.toMatch(/\b(CameraCaptureOptions|VideoPublishOptions|VideoEncoding|VideoParameters)\(/);
      expect(source).not.toMatch(/\.h\d+_(169|43)\b/);
    });

    it('publishes the camera with the room defaults, never with options of its own', () => {
      const calls = [...source.matchAll(/localParticipant\.setCamera\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) expect(args).toMatch(/^enabled: \w+$/);
    });
  });

  it('is the only way a room or a camera track is made in the app', () => {
    const makers: string[] = [];
    for (const file of swiftFiles(SOURCES)) {
      const text = code(readFileSync(file, 'utf8'));
      if (/\bRoom\(\)|\bRoomOptions\(|createCameraTrack|publish\(videoTrack|CameraCaptureOptions\(|VideoPublishOptions\(/.test(text)) {
        makers.push(relative(SOURCES, file));
      }
    }
    expect(makers.sort()).toEqual([
      'Features/Calls/CallMediaBudget.swift',
      'Features/Calls/CallSession.swift',
      'Features/Calls/TeamCalls/TeamCallMedia.swift',
    ]);
  });
});

describe('the iPhone build that carries it', () => {
  it('is 1.0.0 (5) or later: build 4 is on App Store Connect and every upload needs a higher number', () => {
    expect(PROJECT).toContain('MARKETING_VERSION: "1.0.0"');
    // 6 since the ringback for old builds (src/test/teamCalls/teamCallRingbackFallback.test.ts).
    const build = PROJECT.match(/CURRENT_PROJECT_VERSION: "(\d+)"/);
    expect(Number(build?.[1])).toBeGreaterThanOrEqual(5);
    expect(PROJECT.match(/CURRENT_PROJECT_VERSION:/g)).toHaveLength(1);
  });
});
