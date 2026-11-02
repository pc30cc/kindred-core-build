/**
 * The small picture on the iPhone's video calls (`VideoStage`,
 * ios/Webyar/Sources/Features/Calls/CallScreen.swift, and its arithmetic in
 * CallPicture.swift), on a visitor's call and a colleague's alike. The owner,
 * 2026-11-02, after a colleague video call between two iPhones: the small
 * picture could not be moved, and a tap on it did not show one's own picture
 * large and back again.
 *
 * What is pinned here is what still builds when it is undone, and is only
 * noticed on a phone in a call:
 *
 * - the corners are the glass's (left/right), laid out left to right whatever
 *   the app's language, so Persian and Arabic do not flip them;
 * - one gesture decides tap or drag, and a drag is never a tap: only a touch
 *   that never travelled past the slop swaps the pictures;
 * - the swap belongs to the own camera's track and is undone when it goes;
 * - the picture settles in the room below the header and above the
 *   controls actually on screen, measured in both call screens, and the
 *   stage's own tap (the controls) is left as it was;
 * - VoiceOver gets one element with a label saying what is large, a default
 *   action that swaps and named actions to swap and to move it;
 * - no letters where a face is missing, and no animation under Reduce Motion.
 *
 * There is no Xcode here: what can be read from the sources is read; the
 * arithmetic itself is pinned by ios/Webyar/Tests/Core/CallPictureTests.swift.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SOURCES = join(ROOT, 'ios', 'Webyar', 'Sources');

/** Swift (or Kotlin) with its comments removed: the reasons written beside the code name what it must not do. */
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

const read = (path: string) => code(readFileSync(join(ROOT, path), 'utf8'));
const swift = (path: string) => read(join('ios', 'Webyar', 'Sources', path));

/** From `signature` to the first line that closes it at its own indentation. */
function body(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const indent = /\n( *)[^\n]*$/.exec(text.slice(0, start))?.[1] ?? '';
  const end = text.indexOf(`\n${indent}}\n`, start);
  return text.slice(start, end === -1 ? undefined : end);
}

/** A `static func name(_ l: Language) -> String` of Strings.swift, language → text. */
function strings(name: string): Record<string, string> {
  const source = readFileSync(join(SOURCES, 'Localization', 'Strings.swift'), 'utf8');
  const fn = source.match(new RegExp(`static func ${name}\\(_ l: Language\\) -> String \\{([\\s\\S]*?)\\n {4}\\}`));
  expect(fn, name).not.toBeNull();
  const cases: Record<string, string> = {};
  for (const m of fn![1].matchAll(/case \.(\w+): "(.*)"/g)) cases[m[1]] = m[2];
  return cases;
}

const PICTURE = swift('Features/Calls/CallPicture.swift');
const CALL_SCREEN = swift('Features/Calls/CallScreen.swift');
const TEAM_CALL_SCREEN = swift('Features/Calls/TeamCalls/TeamCallScreen.swift');
const STAGE = body(CALL_SCREEN, 'struct VideoStage: View {');
const XCTEST = readFileSync(join(ROOT, 'ios/Webyar/Tests/Core/CallPictureTests.swift'), 'utf8');

/** A corner as `left,top`. */
type Corner = `${boolean},${boolean}`;

describe('the small picture: corners of the glass', () => {
  const corner = body(PICTURE, 'struct CallPictureCorner');

  it('is a left/right and top/bottom corner, never a leading/trailing one', () => {
    expect(corner).toMatch(/var left: Bool/);
    expect(corner).toMatch(/var top: Bool/);
    expect(PICTURE).not.toMatch(/leading|trailing|layoutDirection/i);
  });

  it('is laid out left to right in every language, with what is inside it in the app’s own direction', () => {
    const layer = body(STAGE, 'private var pictureLayer: some View {');
    expect(layer).toContain('.environment(\\.layoutDirection, .leftToRight)');
    const tile = body(STAGE, 'private func smallPicture(size: CGSize) -> some View {');
    expect(tile).toContain('.environment(\\.layoutDirection, layoutDirection)');
    // The old picture was pinned with an alignment, which a right-to-left
    // screen mirrors; the corner is a position now.
    expect(STAGE).not.toMatch(/alignment: \.(top|bottom)?(Leading|Trailing)/);
    expect(layer).toMatch(/\.position\(dragCenter \?\? settled\)/);
  });

  it('opens bottom right and goes round in the same order as on Android', () => {
    expect(corner).toMatch(/static let standard = CallPictureCorner\(left: false, top: false\)/);

    // Swift: `case (left, top): CallPictureCorner(left: …, top: …)`.
    const ios = new Map<Corner, Corner>();
    for (const m of body(corner, 'var next: CallPictureCorner {').matchAll(
      /case \((true|false), (true|false)\): CallPictureCorner\(left: (true|false), top: (true|false)\)/g,
    )) {
      ios.set(`${m[1]},${m[2]}` as Corner, `${m[3]},${m[4]}` as Corner);
    }
    expect(ios.size).toBe(4);

    // Kotlin: `top && !left -> SelfViewCorner(left = …, top = …)`, `else -> …`.
    const kotlin = read('android/app/src/main/kotlin/com/platform/app/feature/call/SelfView.kt');
    expect(kotlin).toMatch(/val DEFAULT = SelfViewCorner\(left = false, top = false\)/);
    const next = body(kotlin, 'fun next(): SelfViewCorner = when {');
    const android = new Map<Corner, Corner>();
    const all: Corner[] = ['true,true', 'true,false', 'false,true', 'false,false'];
    for (const m of next.matchAll(/^\s*(.+?) -> SelfViewCorner\(left = (true|false), top = (true|false)\)/gm)) {
      const to = `${m[2]},${m[3]}` as Corner;
      if (m[1].trim() === 'else') {
        for (const from of all) if (!android.has(from)) android.set(from, to);
        continue;
      }
      const terms = m[1].split('&&').map((t) => t.trim());
      const left = !terms.includes('!left') && terms.includes('left');
      const top = !terms.includes('!top') && terms.includes('top');
      android.set(`${left},${top}` as Corner, to);
    }
    expect(android.size).toBe(4);
    expect(Object.fromEntries(ios)).toEqual(Object.fromEntries(android));
  });

  it('is remembered on the phone and springs into place, without motion under Reduce Motion', () => {
    expect(STAGE).toMatch(/@State private var corner = CallPicturePlacement\.corner\(\)/);
    const settle = body(STAGE, 'private func settle(in next: CallPictureCorner) {');
    expect(settle).toContain('withAnimation(motion)');
    expect(settle).toContain('CallPicturePlacement.remember(next)');
    expect(STAGE).toMatch(/private var motion: Animation\? \{ reduceMotion \? nil : /);
    expect(STAGE).toContain('@Environment(\\.accessibilityReduceMotion) private var reduceMotion');
    // It follows its room when the controls fade or the header grows —
    // springing, but not from before the screen was first measured.
    expect(STAGE).toContain('.onChange(of: freeArea) { old, new in follow(old, new) }');
    const follow = body(STAGE, 'private func follow(_ old: CGRect?, _ new: CGRect?) {');
    expect(follow).toMatch(/guard old != nil, new != nil else \{\s*shownArea = new\s*return\s*\}/);
    expect(follow).toContain('withAnimation(motion) { shownArea = new }');
    expect(body(STAGE, 'private var pictureLayer: some View {')).toContain(
      'CallPictureLayout.room(free: shownArea ?? freeArea, fallback: fallback)',
    );
  });
});

describe('the small picture: a tap swaps, a drag moves, and a drag is never a tap', () => {
  const drag = body(STAGE, 'private func drag(');

  it('takes the touch with one gesture from the first moment, and has no tap gesture of its own', () => {
    expect(drag).toContain('DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.pictureSpace))');
    expect(STAGE).not.toMatch(/onTapGesture|TapGesture\(/);
    // The renderer is a UIKit view: it must not take the touch from the card.
    const tile = body(STAGE, 'private func smallPicture(size: CGSize) -> some View {');
    expect(tile).toMatch(/SwiftUIVideoView\(track, layoutMode: \.fill, mirrorMode: smallMirror\)\s*\.allowsHitTesting\(false\)/);
    expect(tile).toContain('.contentShape(shape)');
  });

  it('swaps only when the touch never became a drag, and settles a drag (a flick included) into a corner', () => {
    const ended = body(drag, '.onEnded { value in');
    expect(ended).toMatch(/guard ended\.isDrag else \{\s*swapPictures\(\)\s*return\s*\}/);
    expect(ended).toContain('CallPictureLayout.corner(releasedAt: released, velocity: value.velocity, in: room)');
    expect(body(drag, '.onChanged { value in')).toMatch(/guard touch\.isDrag else \{ return \}/);
  });

  it('turns a touch into a drag for good once it passes the slop', () => {
    const track = body(PICTURE, 'mutating func track(start: CGPoint, translation: CGSize, origin: CGPoint) {');
    // Reset only by a new touch…
    expect(track).toMatch(/if self\.start != start \{[^}]*isDrag = false\s*\}/);
    expect(track.match(/isDrag = false/g)).toHaveLength(1);
    // …and set past the slop, never unset by coming back.
    expect(track).toMatch(/if !isDrag, travelled > CallPictureLayout\.tapSlop \{\s*isDrag = true\s*\}/);
  });

  it('settles a drag the system took away, without swapping', () => {
    expect(STAGE).toContain('@GestureState private var touching = false');
    const layer = body(STAGE, 'private var pictureLayer: some View {');
    expect(layer).toMatch(/\.onChange\(of: touching\) \{[\s\S]*?guard !isTouching, let center = dragCenter else \{ return \}\s*settle\(in: \.nearest\(to: center, in: room\)\)/);
  });

  it('shows the own camera large after a swap, each track keeping its own mirroring', () => {
    expect(STAGE).toMatch(/private var largeTrack: VideoTrack\? \{ swapped \? local : remote \}/);
    expect(STAGE).toMatch(/private var largeMirror: VideoView\.MirrorMode \{ swapped \? localMirror : \.auto \}/);
    expect(STAGE).toMatch(/private var smallTrack: VideoTrack\? \{ swapped \? remote : local \}/);
    expect(STAGE).toMatch(/private var smallMirror: VideoView\.MirrorMode \{ swapped \? \.auto : localMirror \}/);
    // A colleague call's own camera may be the back one: `.auto` there.
    expect(TEAM_CALL_SCREEN).toMatch(/VideoStage\([\s\S]*?localMirror: \.auto/);
  });

  it('undoes the swap when the own camera goes off or its track changes, and shows no small picture without it', () => {
    const swap = body(PICTURE, 'struct CallPictureSwap');
    expect(swap).toMatch(/func isSwapped\(local: ObjectIdentifier\?\) -> Bool \{\s*local != nil && swappedWith == local\s*\}/);
    expect(swap).toMatch(/mutating func localChanged\(to local: ObjectIdentifier\?\) \{\s*if swappedWith != local \{\s*swappedWith = nil/);
    expect(STAGE).toMatch(/\.onChange\(of: localID\) \{ _, id in[\s\S]*?pictures\.localChanged\(to: id\)/);
    expect(STAGE).toMatch(/private var localID: ObjectIdentifier\? \{\s*local\.map \{ ObjectIdentifier\(\$0\) \}/);
    expect(body(STAGE, 'private var pictureLayer: some View {')).toMatch(/if local != nil \{/);
  });

  it('draws the other side’s face, never a letter, when they have no video', () => {
    const face = body(STAGE, 'private func face(size: CGFloat) -> some View {');
    expect(face).toMatch(/Avatar\(/);
    expect(face).toContain('subject: subject');
    const tile = body(STAGE, 'private func smallPicture(size: CGSize) -> some View {');
    expect(tile).toMatch(/face\(size: /);
    expect(STAGE).not.toMatch(/Text\(contactName|\.prefix\(1\)|initials/i);
  });
});

describe('the small picture keeps clear of the header and the controls', () => {
  const screens = { 'CallScreen.swift': CALL_SCREEN, 'TeamCallScreen.swift': TEAM_CALL_SCREEN };

  for (const [name, screen] of Object.entries(screens)) {
    it(`${name} measures the stage, the safe area, the header and the controls, and hands the stage the room between`, () => {
      expect(screen).toContain('@State private var frames = CallScreenFrames()');
      expect(screen).toContain('.coordinateSpace(.named(CallScreenFrames.space))');
      for (const part of ['stage', 'safeArea', 'header', 'controls']) {
        expect(screen, part).toContain(`.callScreenFrame { frames.${part} = $0 }`);
      }
      expect(screen).toMatch(/VideoStage\([\s\S]*?language: language,[\s\S]*?freeArea: frames\.free\(chromeVisible: chromeVisible\)\s*\)/);
      // The stage's own tap still brings the controls back…
      expect(screen).toMatch(/\.callScreenFrame \{ frames\.stage = \$0 \}\s*\.onTapGesture \{ revealChrome\(\) \}/);
      // …and the controls take touches only while they show.
      expect(screen).toContain('.allowsHitTesting(chromeVisible)');

      // The header and the controls are measured with their shading: the
      // gradient takes touches, and the picture must not sit under it.
      const chrome = body(screen, 'private var chrome: some View {');
      const headerShade = chrome.indexOf('.black.opacity(0.6)');
      const headerFrame = chrome.indexOf('.callScreenFrame { frames.header = $0 }');
      const controlsShade = chrome.indexOf('.black.opacity(0.65)');
      const controlsFrame = chrome.indexOf('.callScreenFrame { frames.controls = $0 }');
      expect(headerShade).toBeGreaterThan(-1);
      expect(headerFrame).toBeGreaterThan(headerShade);
      expect(controlsShade).toBeGreaterThan(headerFrame);
      expect(controlsFrame).toBeGreaterThan(controlsShade);
    });
  }

  it('uses the room between them only while they are on screen, and the safe area otherwise', () => {
    const free = body(PICTURE, 'func free(chromeVisible: Bool) -> CGRect? {');
    expect(free).toMatch(/var top = safeArea\.minY/);
    expect(free).toMatch(/var bottom = safeArea\.maxY/);
    expect(free).toMatch(/if chromeVisible \{[\s\S]*?top = max\(top, header\.maxY\)[\s\S]*?bottom = min\(bottom, controls\.minY\)/);
  });
});

describe('the small picture to VoiceOver', () => {
  const tile = body(STAGE, 'private func smallPicture(size: CGSize) -> some View {');

  it('is one element that says what is large, swaps on a double-tap and moves corner by corner', () => {
    expect(tile).toContain('.accessibilityElement(children: .ignore)');
    expect(tile).toContain(
      '.accessibilityLabel(swapped ? Str.callPictureTheirsSmall(language) : Str.callPictureYoursSmall(language))',
    );
    expect(tile).toContain('.accessibilityHint(Str.callPictureSwapHint(language))');
    expect(tile).toContain('.accessibilityAddTraits(.isButton)');
    expect(tile).toContain('.accessibilityAction { swapPictures() }');
    expect(tile).toContain('.accessibilityAction(named: Text(Str.callPictureSwap(language))) { swapPictures() }');
    expect(tile).toContain('.accessibilityAction(named: Text(Str.callPictureMove(language))) { settle(in: corner.next) }');
  });

  it('speaks every language the app speaks', () => {
    for (const name of ['callPictureYoursSmall', 'callPictureTheirsSmall', 'callPictureSwapHint', 'callPictureSwap', 'callPictureMove']) {
      const cases = strings(name);
      expect(Object.keys(cases).sort(), name).toEqual(['ar', 'en', 'fa', 'tr']);
      for (const [lang, text] of Object.entries(cases)) expect(text.trim(), `${name}.${lang}`).not.toBe('');
    }
    expect(strings('callPictureSwap')).toEqual({
      en: 'Swap pictures',
      fa: 'جابه‌جایی تصویرها',
      tr: 'Görüntüleri değiştir',
      ar: 'تبديل الصورتين',
    });
  });
});

describe('the small picture’s unit tests', () => {
  it('cover the corners, the room, tap and drag, the swap and the memory', () => {
    for (const test of [
      'testNextGoesRoundTheScreenClockwise',
      'testTheNearestCornerIsTheQuarterOfTheRoomThePointIsIn',
      'testEachCornerSitsAgainstItsEdgesOfTheRoomAndInsideIt',
      'testAFlickCarriesItTowardsTheCornerItWasThrownAt',
      'testWhileTheControlsShowTheAreaIsBetweenTheHeaderAndTheControls',
      'testWithTheControlsAwayTheAreaIsTheSafeArea',
      'testPastTheSlopItIsADragAndNeverATapAgain',
      'testTheOwnCameraGoingOffPutsTheirsBackAndItComesBackUnswapped',
      'testAReplacedTrackStartsUnswapped',
      'testTheCornerIsRememberedForTheNextCall',
    ]) {
      expect(XCTEST, test).toContain(`func ${test}()`);
    }
  });
});
