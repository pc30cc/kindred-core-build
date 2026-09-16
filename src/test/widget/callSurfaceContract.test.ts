import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Call-surface markup/stylesheet parity.
 *
 * `renderCallSurface` in runtime.js builds the entire in-panel call UI as a
 * string. Nothing links that string to the stylesheet, so a class can be
 * emitted for months with no rule behind it — which is exactly what happened:
 * the call UI shipped with 29 of its 31 classes unstyled, and a visitor whose
 * operator started a call saw default square buttons on a white background.
 *
 * The same failure has now happened three times in this widget (`.wy-chat-body`
 * in the skeleton, `.rec-dot` in the recorder, and this), so it gets the same
 * generic guard the skeleton has: whatever the renderer names, the stylesheet
 * must be able to style.
 */
const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
const CSS = readFileSync('public/widget/presentation-web-yar.css', 'utf8');

/** `renderCallSurface` plus the two helpers it builds markup with. */
function callRendererSource(): string {
  const start = RUNTIME.indexOf('function renderCallSurface(container, s) {');
  expect(start, 'renderCallSurface must exist').toBeGreaterThan(-1);
  const end = RUNTIME.indexOf('\n    function updateCallSurfaceLive(', start);
  expect(end, 'renderCallSurface must be followed by updateCallSurfaceLive').toBeGreaterThan(start);
  // `renderControlButton` and `renderTerminalControls` sit in between, and
  // they emit call markup too, so the slice deliberately covers them.
  return RUNTIME.slice(start, end);
}

const emittedClasses = () => {
  const src = callRendererSource();
  const found = new Set<string>();
  for (const m of src.matchAll(/class="([^"]+)"/g)) {
    // The markup is built by string concatenation, so a class attribute can
    // end mid-token (`class="gs-call-btn gs-call-btn-toggle' + (isOff ...`).
    // Only whole, well-formed class names are real.
    for (const cls of m[1].split(/\s+/)) {
      if (cls.startsWith('gs-call') && /^[\w-]+$/.test(cls)) found.add(cls);
    }
  }
  return Array.from(found).sort();
};

/** Classes that appear anywhere in a selector in the stylesheet. */
const styledClasses = () => {
  const found = new Set<string>();
  for (const m of CSS.matchAll(/\.(gs-call-[\w-]+)/g)) found.add(m[1]);
  return found;
};

describe('call surface — every class the renderer emits is styled', () => {
  it('emits the classes this guard is meant to cover', () => {
    // A sanity floor: if renderCallSurface is ever refactored into the
    // presentation layer this test would silently pass on an empty set.
    const emitted = emittedClasses();
    expect(emitted.length).toBeGreaterThanOrEqual(15);
    expect(emitted).toContain('gs-call-surface');
    expect(emitted).toContain('gs-call-controls');
  });

  it('leaves no emitted class without a stylesheet rule', () => {
    const styled = styledClasses();
    const orphans = emittedClasses().filter((c) => !styled.has(c));
    expect(orphans).toEqual([]);
  });

  it('gives the call surface the whole body, without the reserved gutter', () => {
    // The body is `.wy-scroll`, which keeps `scrollbar-gutter: stable
    // both-edges` so a scrolling surface stays symmetric. The body itself
    // never scrolls under a call, and those reserved 10px showed up as a
    // light strip down both edges of a dark video.
    expect(CSS).toMatch(/\.body:has\(> \.gs-call-surface\)[^}]*\{[^}]*padding:\s*0/);
    expect(CSS).toMatch(/\.body:has\(> \.gs-call-surface\)\s*\{\s*scrollbar-gutter:\s*auto/);
  });

  it('keeps the stage and the control bar as the only two rows', () => {
    // Both stages claim the leftover space; the control bar never shrinks.
    expect(CSS).toMatch(/\.gs-call-stage\s*\{[^}]*flex:\s*1/);
    expect(CSS).toMatch(/\.gs-call-voice-stage\s*\{[^}]*flex:\s*1/);
    expect(CSS).toMatch(/\.gs-call-controls\s*\{[^}]*flex:\s*none/);
  });

  it('positions the picture-in-picture by writing direction, not by side', () => {
    // Persian is the widget's first language; a hardcoded `right` would put
    // the self-view on the wrong edge for every RTL visitor.
    expect(CSS).toMatch(/\.gs-call-pip\s*\{[^}]*inset-inline-end/);
    expect(CSS).not.toMatch(/\.gs-call-pip\s*\{[^}]*[^-]right:/);
  });

  it('gives the equaliser bars a resting height, not just an animated one', () => {
    // They animate `height`, so without a base height they are 0px tall
    // whenever the animation is off — including under reduced motion.
    expect(CSS).toMatch(/\.gs-call-eq-bar\s*\{[^}]*height:\s*\d/);
    expect(CSS).toMatch(/prefers-reduced-motion[^}]*\}[^}]*\.gs-call-eq-bar[^}]*height:\s*\d/s);
  });
});

describe('call surface — the renderer keeps its side of the contract', () => {
  it('marks the phase on the surface so the stylesheet can react to it', () => {
    expect(callRendererSource()).toContain("data-phase=\"' + phase + '\"");
    expect(CSS).toMatch(/\[data-phase='connecting'\]/);
  });

  it('gives each channel one control bar, and a way out of a dead call', () => {
    const src = callRendererSource();
    // One bar for the video branch, one for the audio branch.
    expect(src.match(/class="gs-call-controls"/g)).toHaveLength(2);
    expect(src.match(/gs-call-btn-hangup/g)).toHaveLength(2);
    // A call that ended or failed has nothing left to toggle, so both
    // branches swap the live controls for the terminal card instead.
    expect(src.match(/html \+= renderTerminalControls\(s\)/g)).toHaveLength(2);
    expect(src.match(/phase === 'failed' \|\| phase === 'ended'/g)).toHaveLength(2);
  });

  it('exposes the call surface to tests through the gated test-only hook', () => {
    // A hermetic test can never reach a LiveKit server, so the phases the
    // engine would drive have to be set on the store directly. This must
    // stay behind the same opt-in gate as the rest of __test.
    expect(RUNTIME).toContain('callSurface: function (patch) { callSurfaceStore.set(patch); }');
    const hookStart = RUNTIME.indexOf('__test: (typeof window');
    expect(RUNTIME.indexOf('callSurface: function (patch)')).toBeGreaterThan(hookStart);
  });
});
