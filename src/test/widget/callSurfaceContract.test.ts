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

  it('overlays the panel instead of renting space inside the body', () => {
    // The body is `.wy-scroll`, which keeps `scrollbar-gutter: stable
    // both-edges` so a scrolling surface stays symmetric — 10px on each
    // edge, invisible under a transparent view but a light strip down both
    // sides of a dark video. The call is a panel-level overlay now, which
    // dodges that and is also what makes minimizing possible at all: the
    // chat stays mounted underneath.
    expect(CSS).toMatch(/\.gs-call-host\s*\{[^}]*position:\s*absolute/);
    expect(CSS).toMatch(/\.gs-call-host\s*\{[^}]*inset:\s*0/);
    expect(CSS).not.toMatch(/\.body:has\(> \.gs-call-surface\)/);
    // Above `.panel-close` (z-index 20), so a full-bleed call cannot be
    // dismissed out from under itself.
    const host = CSS.slice(CSS.indexOf('.gs-call-host {'));
    const z = /z-index:\s*(\d+)/.exec(host.slice(0, host.indexOf('}')))?.[1];
    expect(Number(z)).toBeGreaterThan(20);
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

describe('call surface — a minimized call is one you can chat through', () => {
  it('shrinks by class, never by rebuilding the markup', () => {
    // A rebuild would detach the MediaStreamTrack and drop the picture, so
    // `minimized` must stay OUT of the render signature that decides
    // whether renderCallSurface replaces innerHTML.
    const src = callRendererSource();
    const sig = src.slice(src.indexOf('var sig = ['), src.indexOf("].join('|')"));
    expect(sig).not.toContain('minimized');
    expect(RUNTIME).toContain("host.classList.toggle('is-mini', !!cs.minimized);");
  });

  it('gives the chat back rather than leaving it hidden', () => {
    // `inert` keeps the chat mounted but unreachable under a full-bleed
    // call; minimizing lifts it with no re-render and no lost scroll.
    expect(RUNTIME).toContain('var __callCovers = __cs.phase !== \'idle\' && !__cs.minimized;');
    expect(RUNTIME).toContain('body.inert = __callCovers;');
    // The old approach unmounted the chat to draw the call in its place.
    expect(RUNTIME).not.toContain('renderCallSurface(body, __cs);');
  });

  it('never lets the card cover the composer it was minimized to reach', () => {
    const mini = CSS.slice(CSS.indexOf('.gs-call-host.is-mini {'));
    const block = mini.slice(0, mini.indexOf('}'));
    // Docked to the top, over the message list — a `bottom` anchor would
    // put it exactly where the composer is.
    expect(block).toMatch(/top:\s*\d+px/);
    expect(block).not.toMatch(/[^-]bottom:\s*\d/);
    // And by writing direction, so Persian gets the right corner.
    expect(block).toContain('inset-inline-end');
  });

  it('keeps the way out of the call at card size', () => {
    // Toggles can wait for the expand; hanging up cannot.
    const hidden = CSS.slice(CSS.indexOf('.gs-call-host.is-mini .gs-call-pip'));
    const rule = hidden.slice(0, hidden.indexOf('}'));
    expect(rule).toContain('.gs-call-btn-toggle');
    expect(rule).not.toContain('.gs-call-btn-hangup');
  });

  it('starts every call full size', () => {
    // openCallSurface and closeCallSurface both reset it, so a second call
    // never inherits the first one's size.
    expect(RUNTIME.match(/^\s+minimized: false,$/gm)?.length).toBe(3);
  });

  it('treats the whole card as the way back in', () => {
    // A 168px target beats the 22px button on a phone.
    expect(RUNTIME).toContain('if (!btn && callSurfaceStore.get().minimized) {');
    expect(RUNTIME).toContain('setCallMinimized(false);');
  });

  it('delegates from the surface root, not from the control bar', () => {
    // The size control sits in the topbar so it survives the terminal
    // phases, which puts it outside [data-call-controls].
    expect(RUNTIME).toContain("var surfaceEl = container.querySelector('[data-call-surface]');");
    expect(RUNTIME).toContain("target.closest('[data-call-size]')");
  });

  it('labels the control for both directions of the toggle', () => {
    for (const key of ['csMinimize', 'csExpand']) {
      // One entry per locale (en / fa / tr), plus the two read sites.
      expect(RUNTIME.match(new RegExp(`${key}:`, 'g'))?.length, key).toBe(3);
    }
    // The label flips without a rebuild, so it is refreshed live.
    expect(RUNTIME).toMatch(/updateCallSurfaceLive[\s\S]{0,600}sizeBtn\.setAttribute\('aria-label', sizeLabel\)/);
  });
});
