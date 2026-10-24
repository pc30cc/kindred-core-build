/**
 * The call widget's launchers (contract §2.11, boards 01–03, D4, D6, D14,
 * D15, D17, D37): the nine styles of `config.launcher_style` and their
 * fallbacks, the ready/hover/logo/offline states (Sa–Sd), the booked
 * callback on the button (Sh) and its expiry, the offline and unstaffed
 * compositions, `card` and `operator_face` from the presence the bootstrap
 * names, the split halves, the placements, and the stack above a chat
 * launcher in the same corner. On phones: the phone corner (P7), the bottom
 * bar (P8) and its pill beside a chat launcher, a rotation redrawing the
 * launcher, and the panel fetched at idle on touch screens without hover. Plus the static rules of the launcher CSS
 * and of the International skin (presentation-intl.css).
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeCallWidgets, flush, mountCallWidget, widgetSource, type Locale, type Mounted } from './mountCallWidget';
import { avatarFace, avatarFaces } from '../widget/avatarFace';

afterEach(() => closeCallWidgets());

type Dict = Record<string, unknown>;
const NOW = Date.parse('2026-10-22T11:00:00+03:30');
const TEAM = [
  { name: 'Sara Mohammadi', initial: 'S', avatar_url: null },
  { name: 'Mehdi Karimi', initial: 'M', avatar_url: 'https://cdn.example/m.png' },
  { name: 'Reza Ahmadi', initial: 'R', avatar_url: null },
  { name: 'Nobody Fourth', initial: 'N', avatar_url: null },
];
const OFF = { capabilities: { voice: false, video: false, callback: true } };

function launcher(style: string, bootstrap: Dict = {}, locale: Locale = 'en'): Mounted {
  const config = { ...((bootstrap.config as Dict) || {}), launcher_style: style };
  return mountCallWidget({ now: NOW, locale, bootstrap: { ...bootstrap, config } });
}
/** The launcher's own element: the one child of the wrap. */
const top = (m: Mounted) => m.q('.ccw-launcher-wrap')!.firstElementChild as HTMLElement;
const text = (el: Element | null) => (el?.textContent || '').trim();
/** The name of an icon an svg draws: phone (one path) or phone-in (two). */
const icon = (svg: Element | null) => (svg ? (svg.querySelectorAll('path').length === 2 ? 'phone-in' : 'phone') : null);

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the nine styles (board 01) and what they draw', () => {
  it('round (L1, Sa): the round button alone with its dot, wave and wiggling phone; its label shows on hover, without a close x (D6)', () => {
    const m = launcher('round');
    const btn = m.q('.ccw-launcher-wrap .ln.ln-c.ccw-launcher-btn')!;
    expect(btn.getAttribute('data-action')).toBe('open');
    expect(btn.getAttribute('aria-label')).toBe('Open the call widget');
    expect(btn.querySelector('svg.wig')).not.toBeNull();
    expect(btn.querySelector('.ls:not(.off)')).not.toBeNull();
    expect(btn.querySelector('.wv')).not.toBeNull();
    // Not a round_label: no .ln-cl, and the label is the hover one.
    expect(m.q('.ccw-launcher-wrap .ln-cl')).toBeNull();
    const hover = m.q('.ccw-launcher-wrap .ln-h > .lbl')!;
    expect(text(hover.querySelector('b'))).toBe('Talk now');
    expect(hover.querySelector('.x')).toBeNull();
    expect(hover.getAttribute('aria-hidden')).toBe('true');
    // Keyboard focus shows it (the label follows the button, for `:focus-visible + .lbl`), a mouse's leftover focus does not.
    expect(btn.nextElementSibling).toBe(hover);
    const css = widgetSource('runtime.css');
    expect(css).toMatch(/\.ln-h:hover \.lbl, \.ln-h \.ln-c:focus-visible \+ \.lbl \{[^}]*opacity: 1; visibility: visible;/);
    expect(css).not.toMatch(/\.ln-h:focus-within/);
    // Following the button in the markup, it is still painted under it (its shadow never lies over the button's dot).
    expect(css).toMatch(/\.ln-h \.lbl \{ position: absolute; z-index: -1;/);
  });

  it('hover and keyboard focus lift the buttons alike (Sb: hover/focus)', () => {
    const css = widgetSource('runtime.css');
    for (const [sel, lift] of [['.ln-c', 'translateY(-3px) scale(1.05)'], ['.ln-p', 'translateY(-3px)'], ['.ln-r', 'translateY(-3px)'], ['.ln-t', 'translateX(-4px)'], ['.ln-t.at-l', 'translateX(4px)'], ['.ln-q', 'translateY(-3px)']]) {
      const s = sel.replace(/\./g, '\\.');
      expect(css, sel).toMatch(new RegExp(`(^|\\n)${s}:hover, ${s}:focus-visible \\{ transform: ${lift.replace(/[().]/g, '\\$&')}; \\}`));
    }
    // The press still wins over the lift (it comes after).
    expect(css.indexOf('.ln-c:active')).toBeGreaterThan(css.indexOf('.ln-c:hover, .ln-c:focus-visible'));
  });

  it('round_label (L2, the default; an unknown style too): the label with its close x and the round button', () => {
    for (const style of ['round_label', 'sparkly', '']) {
      const m = launcher(style);
      expect(top(m).className).toBe('ln-cl');
      expect(text(m.q('.ln-cl .lbl b'))).toBe('Talk now');
      expect(text(m.q('.ln-cl .lbl small'))).toBe('Live support');
      expect(m.q('.ln-cl .lbl .x[data-action="label-close"]')).not.toBeNull();
      expect(m.q('.ln-cl > button.ln.ln-c.ccw-launcher-btn')).not.toBeNull();
    }
  });

  it('a dismissed label: the round button with the hover label from then on (D6)', () => {
    const m = launcher('round_label');
    m.click('.lbl .x');
    expect(m.q('.ln-cl')).toBeNull();
    expect(m.q('.ln-h > .ln-c.ccw-launcher-btn')).not.toBeNull();
    const engine = launcher('round_label');
    engine.set({ labelDismissed: true });
    expect(engine.q('.ln-cl')).toBeNull();
    expect(engine.q('.ln-h .ln-c')).not.toBeNull();
  });

  it('card leaves out an available operator with neither a name nor a photo (an empty face says nothing)', () => {
    const m = launcher('card', { presence: { any_available: true, operators: [TEAM[0], { name: null, initial: '', avatar_url: null }, TEAM[1]] } });
    expect(m.qa('.ln-r .avs .av').map((a) => a.className)).toEqual(['av c1 sil', 'av c2']);
    expect(avatarFace(m.q('.ln-r .avs .av.c1'))).toBe('person');
    expect(m.q('.ln-r .avs .av.c2 img')!.getAttribute('src')).toBe(TEAM[1].avatar_url);
  });

  it('pill (L3): disc with the phone, the call-support text, the live dot and the wave; named by its own text', () => {
    const m = launcher('pill', {}, 'fa');
    const btn = top(m);
    expect(btn.matches('button.ln.ln-p.ccw-launcher-btn')).toBe(true);
    expect(icon(btn.querySelector('.pi svg'))).toBe('phone');
    expect(text(btn)).toBe('تماس با پشتیبانی');
    expect(btn.querySelector('.ld:not(.off)')).not.toBeNull();
    expect(btn.querySelector('.wv')).not.toBeNull();
    expect(btn.hasAttribute('aria-label')).toBe(false);
    expect(btn.getAttribute('aria-controls')).toBe('ccw-panel');
  });

  it('card (L4): up to three operators from presence (.c1 .c2 .c3, a photo when they have one), the team line and the go tile', () => {
    const m = launcher('card', { presence: { any_available: true, operators: TEAM } });
    const btn = top(m);
    expect(btn.matches('button.ln.ln-r.ccw-launcher-btn')).toBe(true);
    const avs = m.qa('.ln-r .avs .av');
    // Without a photo, the person silhouette (.sil), never the initial (owner, 2026-10-24).
    expect(avs.map((a) => a.className)).toEqual(['av c1 sil', 'av c2', 'av c3 sil']);
    expect(avatarFaces(avs)).toEqual(['person', 'photo', 'person']);
    expect(avs[1].querySelector('img')!.getAttribute('src')).toBe('https://cdn.example/m.png');
    expect(m.q('.ln-r .avs')!.getAttribute('aria-hidden')).toBe('true');
    expect(text(m.q('.ln-r .tx b'))).toBe('Talk to our team');
    expect(text(m.q('.ln-r .tx small'))).toBe('Operators available');
    expect(m.q('.ln-r .tx small .dot:not(.off)')).not.toBeNull();
    expect(icon(m.q('.ln-r .go2 svg'))).toBe('phone');
  });

  it('card: fewer operators draw those present, none draws no avatars, a 6f8af41 bootstrap too', () => {
    expect(launcher('card', { presence: { any_available: true, operators: TEAM.slice(0, 1) } }).qa('.ln-r .avs .av')).toHaveLength(1);
    expect(launcher('card', { presence: { any_available: true } }).q('.ln-r .avs')).toBeNull();
    const legacy = mountCallWidget({ now: NOW, locale: 'en', legacy: true, bootstrap: { config: { launcher_style: 'card' } } });
    expect(legacy.q('.ln-r .avs')).toBeNull();
    expect(text(legacy.q('.ln-r .tx b'))).toBe('Talk to our team');
  });

  it('split (L5): two halves, each starts its call in the click and opens the panel; no video half without video', () => {
    const m = launcher('split');
    const group = top(m);
    expect(group.matches('div.ln.ln-s[role="group"]')).toBe(true);
    expect(group.getAttribute('aria-label')).toBe('Call us');
    expect(m.q('.ccw-launcher-btn')).toBeNull();
    const halves = m.qa('.ln-s > button.hf');
    expect(halves.map((b) => [b.getAttribute('data-action'), text(b), b.classList.contains('pri')])).toEqual([['voice', 'Voice call', true], ['video', 'Video', false]]);
    expect(m.q('.ln-s > .dv')).not.toBeNull();
    const calls: string[] = [];
    const real = m.ctrl.startCall.bind(m.ctrl);
    m.ctrl.startCall = (kind: string) => { calls.push(`${kind}:${m.ctrl.open}`); real(kind); };
    halves[1].click();
    expect(calls).toEqual(['video:true']);
    expect(m.ctrl.open).toBe(true);
    const voiceOnly = launcher('split', { capabilities: { video: false } });
    expect(voiceOnly.qa('.ln-s > button.hf').map((b) => b.getAttribute('data-action'))).toEqual(['voice']);
    expect(voiceOnly.q('.ln-s > .dv')).toBeNull();
  });

  it('edge_tab (L6): the tab with its vertical words on the right or left edge; `edge` placement classes', () => {
    const m = launcher('edge_tab', {}, 'fa');
    const tab = top(m);
    expect(tab.matches('button.ln.ln-t.ccw-launcher-btn')).toBe(true);
    expect(tab.classList.contains('at-l')).toBe(false);
    expect(text(tab.querySelector('.vt'))).toBe('تماس با ما');
    expect(tab.querySelector('.ld')).not.toBeNull();
    expect(m.q('.ccw-launcher-wrap')!.className).toBe('ccw-launcher-wrap right edge');
    expect(m.q('#ccw-panel')!.className).toBe('ccw-panel cp lv right edge');
    const left = launcher('edge_tab', { config: { widget_position: 'top_left' } });
    expect(left.q('.ccw-launcher-wrap')!.className).toBe('ccw-launcher-wrap left edge');
    expect(top(left).classList.contains('at-l')).toBe(true);
    expect(launcher('edge_tab', { config: { widget_position: 'bottom_center' } }).q('.ccw-launcher-wrap')!.className).toBe('ccw-launcher-wrap right edge');
  });

  it('dark_square (L7): the square with the phone and its glowing dot, no wave', () => {
    const m = launcher('dark_square');
    const btn = top(m);
    expect(btn.matches('button.ln.ln-q.ccw-launcher-btn')).toBe(true);
    expect(icon(btn.querySelector('svg'))).toBe('phone');
    expect(btn.querySelector('.ls:not(.off)')).not.toBeNull();
    expect(btn.querySelector('.wv')).toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Open the call widget');
  });

  it('operator_face (L8): the first operator\'s photo (or silhouette), the pulse ring, the phone badge; the label names them, no x', () => {
    const photo = launcher('operator_face', { presence: { any_available: true, operators: [TEAM[1], TEAM[0]] } });
    expect(top(photo).className).toBe('ln-f');
    expect(photo.q('.ln-f .fp.ccw-launcher-btn .pic img')!.getAttribute('src')).toBe('https://cdn.example/m.png');
    expect(photo.q('.ln-f .fp .ring2')).not.toBeNull();
    expect(icon(photo.q('.ln-f .fp .pb svg'))).toBe('phone');
    expect(text(photo.q('.ln-f .lbl b'))).toBe('Talk now');
    expect(text(photo.q('.ln-f .lbl small'))).toBe('Mehdi Karimi');
    expect(photo.q('.ln-f .lbl .x')).toBeNull();
    expect(photo.q('.ln-f .fp')!.getAttribute('aria-label')).toBe('Open the call widget');
    const silhouette = launcher('operator_face', { presence: { any_available: true, operators: [TEAM[0]] } });
    expect(silhouette.q('.ln-f .pic .av.c1.sil')).not.toBeNull();
    expect(avatarFace(silhouette.q('.ln-f .pic .av.c1'))).toBe('person');
    expect(silhouette.q('.ln-f .pic img')).toBeNull();
  });

  it('operator_face without a named operator is round_label; so is a 6f8af41 bootstrap', () => {
    expect(top(launcher('operator_face', { presence: { any_available: true, operators: [{ name: null, initial: '', avatar_url: 'https://cdn.example/x.png' }] } })).className).toBe('ln-cl');
    expect(top(launcher('operator_face', { presence: { any_available: true } })).className).toBe('ln-cl');
    expect(top(mountCallWidget({ legacy: true, locale: 'en', bootstrap: { config: { launcher_style: 'operator_face' } } })).className).toBe('ln-cl');
  });

  it('mobile_bar (L9) exists on phones only: round_label on a desktop; on a phone the two buttons, each in its click', () => {
    expect(top(launcher('mobile_bar')).className).toBe('ln-cl');
    const m = launcher('mobile_bar');
    (m.win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
    m.ctrl.render();
    expect(top(m).className).toBe('mbar');
    const [voice, cb] = m.qa('.mbar > button.btn');
    expect([voice.className, voice.getAttribute('data-action'), text(voice)]).toEqual(['btn pri', 'voice', 'Voice call']);
    expect([cb.className, cb.getAttribute('data-action'), text(cb)]).toEqual(['btn sec', 'callback', 'Callback']);
    cb.click();
    expect(m.ctrl.state).toBe('callback_form');
    expect(m.ctrl.open).toBe(true);
  });

  it('a rotation re-draws the launcher without waiting for the engine: a phone\'s pill, a desktop\'s label, a phone turned to landscape still the pill', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
    expect(top(m).matches('button.ln.ln-p')).toBe(true);
    m.device('desktop');
    expect(top(m).className).toBe('ln-cl');
    m.device('landscape');
    expect(top(m).matches('button.ln.ln-p')).toBe(true);
    // A touch tablet is no phone.
    m.device('tablet');
    expect(top(m).className).toBe('ln-cl');
  });

  it('mobile_bar spans the bottom of the screen in its own wrap (it leaves and returns with the launcher); a minimised call keeps the corner', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone', bootstrap: { config: { launcher_style: 'mobile_bar' } } });
    const wrap = m.q('.ccw-launcher-wrap')!;
    expect(wrap.className).toBe('ccw-launcher-wrap right bar');
    m.ctrl.toggleOpen();
    m.loadLinks();
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueStartedAt: NOW - 47_000 });
    m.click('.scr.on [data-action="minimize"]');
    expect(wrap.querySelector('.mc')).not.toBeNull();
    expect(wrap.className).toBe('ccw-launcher-wrap right');
    const css = widgetSource('runtime.css');
    expect(css).toMatch(/\.ccw-launcher-wrap\.bar \{ inset-inline: 0; bottom: 0; width: auto; margin: 0; \}/);
    expect(css).not.toMatch(/\.mbar \{[^}]*position: fixed/);
  });

  it('on a phone the launcher keeps to the phone corner: 18px from the side, 18px above the home bar (P7)', () => {
    const css = widgetSource('runtime.css');
    expect(css).toMatch(/\.ccw-root\.is-mobile \{ --ccw-offset-x: 18px; --ccw-offset-y: calc\(18px \+ env\(safe-area-inset-bottom\)\); \}/);
    // The stack reads the resolved offset (a custom property keeps its calc() unresolved).
    expect(css).toMatch(/\.ccw-launcher-wrap \{[^}]*scroll-margin-bottom: var\(--ccw-offset-y\);/);
  });

  it('round_label on a phone is the 56px pill (D14)', () => {
    const m = launcher('round_label');
    (m.win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
    m.ctrl.render();
    expect(top(m).matches('button.ln.ln-p')).toBe(true);
  });
});

describe('touch devices without hover: the panel at idle (§2.3)', () => {
  const linked = (m: Mounted) => m.qa('link').some((l) => /presentation-default-panel\.css/.test(l.getAttribute('href') || ''));
  it('asks for the panel when the page is idle (requestIdleCallback, 2 s at most), before any intent', () => {
    const idle: Array<{ cb: () => void; opts: unknown }> = [];
    const m = mountCallWidget({
      now: NOW, locale: 'en', device: 'tablet',
      setup: (w) => { (w as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: () => void, opts: unknown) => { idle.push({ cb, opts }); return 1; }; },
    });
    expect(idle).toHaveLength(1);
    expect(idle[0].opts).toEqual({ timeout: 2000 });
    expect(linked(m)).toBe(false);
    idle[0].cb();
    expect(linked(m)).toBe(true);
    expect(m.H()).not.toBeNull();
  });

  it('the idle prefetch brings the script and stylesheet only; the faces of the first paint come with the first intent, and the panel shows once they are in', async () => {
    const idle: Array<() => void> = [];
    const loads: string[] = [];
    let release: () => void = () => undefined;
    const faces = new Promise<void>((r) => { release = r; });
    const m = mountCallWidget({
      now: NOW, locale: 'fa', device: 'phone',
      setup: (w) => {
        (w as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: () => void) => { idle.push(cb); return 1; };
        // The page's font loader, and the root's stack as the skin sets it (jsdom applies no shadow stylesheet).
        Object.defineProperty(w.document, 'fonts', { configurable: true, value: { load: (font: string, text: string) => { loads.push(`${font}|${text}`); return faces; } } });
        const real = w.getComputedStyle.bind(w);
        (w as unknown as { getComputedStyle: unknown }).getComputedStyle = (el: Element, p?: string | null) => (
          el.classList && el.classList.contains('ccw-root') ? { fontFamily: "'IRANSans', 'InterWY', sans-serif" } : real(el, p));
      },
    });
    idle[0]();
    expect(linked(m)).toBe(true);
    expect(m.H()).not.toBeNull();
    // Every phone page view would pay IRANSans 500 (≈27 KB) for a panel most visitors never open.
    expect(loads).toEqual([]);
    // Nor through the page's layout: a closed panel is laid out (only invisible), so a browser fetches the faces of
    // any text drawn in it. Nothing of it is drawn before an intent.
    expect(m.qa('#ccw-panel .scr')).toHaveLength(0);
    // The tap: its touchstart is the intent, as a desktop's pointer is.
    m.q('.ccw-launcher-wrap')!.dispatchEvent(new m.win.Event('touchstart'));
    expect(loads).toEqual(['400 16px \'IRANSans\'|سلام', '500 16px \'IRANSans\'|سلام', '700 16px \'IRANSans\'|سلام']);
    m.open();
    await flush(m.win);
    // No visible swap: the panel waits for its faces (at most 500 ms), the launcher says it is busy.
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    expect(m.q('.ccw-launcher-btn')!.getAttribute('aria-busy')).toBe('true');
    release();
    await flush(m.win);
    expect(m.root.classList.contains('ccw-is-open')).toBe(true);
    expect(m.q('#ccw-panel .scr.on[data-screen="home"]')).not.toBeNull();
  });

  it('without requestIdleCallback, 1.2 s after mount; a mouse device waits for an intent', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const touch = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
      const mouse = mountCallWidget({ now: NOW, locale: 'en' });
      // Nor for a widget the workspace hides while offline.
      const hidden = mountCallWidget({ now: NOW, locale: 'en', device: 'phone', bootstrap: { ...OFF, config: { offline_behavior: 'hide' } } });
      vi.advanceTimersByTime(1199);
      expect(linked(touch)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(linked(touch)).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(linked(mouse)).toBe(false);
      expect(linked(hidden)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the business logo (Sc, D37)', () => {
  const logo = { config: { avatar_url: 'https://cdn.example/logo.png' } };
  it('round and round_label wear the logo face, flipping to the call face; no wave', () => {
    for (const style of ['round', 'round_label']) {
      const m = launcher(style, logo);
      const btn = m.q('.ccw-launcher-wrap .ln-c.logo.ccw-launcher-btn')!;
      expect(btn.querySelector('.fc > .f1 > img')!.getAttribute('src')).toBe('https://cdn.example/logo.png');
      expect(icon(btn.querySelector('.fc > .f2 > svg'))).toBe('phone');
      expect(btn.querySelector('.ls')).not.toBeNull();
      expect(btn.querySelector('.wv')).toBeNull();
      expect(btn.querySelector('.wig')).toBeNull();
    }
  });
  it('offline wins (the Sd look, no logo); the other styles ignore it', () => {
    const off = launcher('round', { ...logo, ...OFF });
    expect(off.q('.ln-c.logo')).toBeNull();
    expect(off.q('.ln-c.off')).not.toBeNull();
    expect(launcher('pill', logo).q('.logo')).toBeNull();
    expect(launcher('dark_square', logo).q('.logo')).toBeNull();
  });
  it('the flip follows hover and keyboard focus only (no loop), with the spring', () => {
    const css = widgetSource('runtime.css');
    expect(css).toMatch(/\.fc \{[^}]*transform-style: preserve-3d;[^}]*transition: transform \.52s var\(--spring\)/);
    expect(css).toMatch(/:hover \.ln-c\.logo \.fc, \.ln-c\.logo:focus-visible \.fc, \.fc\.flipped \{ transform: rotateY\(180deg\); \}/);
    expect(css).not.toMatch(/cc-flip/);
  });
});

describe('offline and unstaffed compositions (§2.11, D17)', () => {
  it.each([['round', 'ln-h'], ['pill', 'ln-p'], ['card', 'ln-r'], ['edge_tab', 'ln-t'], ['dark_square', 'ln-q']])('%s offline (show_callback): its shape, the callback icon and words, an off dot, no wave or wiggle', (style, shape) => {
    const m = launcher(style, OFF);
    const root = top(m);
    expect(root.classList.contains(shape)).toBe(true);
    const btn = m.q('.ccw-launcher-btn')!;
    // Named "Callback": by its label (icon-only buttons) or by its own words.
    expect(btn.getAttribute('aria-label') ?? text(btn)).toMatch(/^Callback/);
    expect(root.querySelector('.wv, .wig, .ring2')).toBeNull();
    expect(root.querySelector('.ls.off, .ld.off, .dot.off')).not.toBeNull();
    expect(root.querySelector('.ls:not(.off), .ld:not(.off), .dot:not(.off)')).toBeNull();
    expect(root.querySelectorAll('svg').length).toBeGreaterThan(0);
    for (const svg of root.querySelectorAll('svg')) expect(icon(svg)).toBe('phone-in');
  });

  it('card offline: the callback title and the leave-details line', () => {
    const m = launcher('card', OFF);
    expect(text(m.q('.ln-r .tx b'))).toBe('Callback');
    expect(text(m.q('.ln-r .tx small'))).toBe('Leave details');
  });

  it('split offline is one callback button: the callback form opens', () => {
    const m = launcher('split', OFF);
    const halves = m.qa('.ln-s > button.hf');
    expect(halves.map((b) => [b.getAttribute('data-action'), text(b)])).toEqual([['callback', 'Callback']]);
    expect(icon(halves[0].querySelector('svg'))).toBe('phone-in');
    halves[0].click();
    expect(m.ctrl.state).toBe('callback_form');
    expect(m.ctrl.open).toBe(true);
  });

  it('mobile_bar offline keeps only its callback button', () => {
    const m = launcher('mobile_bar', OFF);
    (m.win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
    m.ctrl.render();
    expect(m.qa('.mbar > button').map((b) => b.getAttribute('data-action'))).toEqual(['callback']);
  });

  it('show_message: the same look with the offline words; the split button only opens the panel', () => {
    const msg = { ...OFF, config: { offline_behavior: 'show_message' } };
    expect(text(launcher('pill', msg).q('.ln-p'))).toBe('Support');
    const tab = launcher('edge_tab', msg);
    expect(text(tab.q('.ln-t .vt'))).toBe('Support');
    const split = launcher('split', msg);
    const [only] = split.qa('.ln-s > button.hf');
    expect([only.getAttribute('data-action'), text(only)]).toEqual(['open', 'Support']);
    only.click();
    expect([split.ctrl.open, split.ctrl.state]).toEqual([true, 'offline']);
  });

  it('hide: no launcher of any style while offline', () => {
    for (const style of ['pill', 'card', 'split']) {
      expect((launcher(style, { ...OFF, config: { offline_behavior: 'hide' } }).q('.ccw-launcher-wrap') as HTMLElement).hidden).toBe(true);
    }
  });

  it('channels on but nobody available: every launcher is the offline one (owner 2026-10-21), no call buttons', () => {
    const none = { presence: { any_available: false } };
    for (const style of ['round', 'round_label', 'dark_square']) {
      expect(launcher(style, none).q('.ccw-launcher-btn .ls')!.classList.contains('off')).toBe(true);
    }
    for (const style of ['pill', 'edge_tab']) expect(launcher(style, none).q('.ld')!.classList.contains('off')).toBe(true);
    const card = launcher('card', none);
    expect(card.q('.ccw-launcher-btn')!.classList.contains('off')).toBe(true);
    expect(icon(card.q('.ln-r .go2 svg'))).toBe('phone-in');
    expect(launcher('split', none).qa('.ln-s > button[data-action="voice"], .ln-s > button[data-action="video"]')).toHaveLength(0);
  });
});

/**
 * The `transform` the cascade gives an element of the panel stylesheet's top-level rules (no `@media`/`@supports`),
 * from its own classes and those of its ancestors (the root's state classes): the rules that matter there are chains
 * of class selectors, so specificity is the number of classes and the later rule wins a tie. Null when none sets it.
 */
function cascadeTransform(css: string, ancestors: string[], own: string[]): string | null {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let best: { spec: number; value: string } | null = null;
  for (let i = 0; i < src.length; ) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    for (; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0;
    const head = src.slice(i, open).trim();
    const value = /(?:^|;)\s*transform\s*:\s*([^;]+?)\s*(?:;|$)/.exec(src.slice(open + 1, j - 1))?.[1];
    i = j;
    if (head.startsWith('@') || !value) continue;
    for (const sel of head.split(',').map((s) => s.trim())) {
      const parts = sel.split(/\s+/);
      if (!parts.every((p) => /^(\.[\w-]+)+$/.test(p))) continue;
      const classes = (p: string) => p.slice(1).split('.');
      const last = classes(parts[parts.length - 1]);
      if (!last.every((c) => own.includes(c)) || !parts.slice(0, -1).every((p) => classes(p).every((c) => ancestors.includes(c)))) continue;
      const spec = parts.reduce((n, p) => n + classes(p).length, 0);
      if (!best || spec >= best.spec) best = { spec, value };
    }
  }
  return best ? best.value : null;
}

describe('placements (§2.11, P1–P6) and the label corners', () => {
  it.each(['right', 'left', 'top_right', 'top_left', 'bottom_center'])('%s: the open panel stands upright for every style, the edge tab on either side too (no closed-state rule outranks the open one)', (position) => {
    const css = widgetSource('presentation-default-panel.css');
    for (const style of ['round_label', 'edge_tab']) {
      const m = launcher(style, { config: { widget_position: position } });
      const panel = () => [...m.q('#ccw-panel')!.classList];
      const root = () => [...m.root.classList];
      expect(cascadeTransform(css, root(), panel()), `${style} closed`).not.toBe('none');
      m.open();
      expect(root()).toContain('ccw-is-open');
      expect(cascadeTransform(css, root(), panel()), `${style} open (${panel().join(' ')})`).toBe('none');
    }
  });

  it.each([
    ['right', 'ccw-launcher-wrap right', false],
    ['left', 'ccw-launcher-wrap left', true],
    ['top_right', 'ccw-launcher-wrap right top', false],
    ['top_left', 'ccw-launcher-wrap left top', true],
    ['bottom_center', 'ccw-launcher-wrap center', false],
  ])('%s: wrap classes, the labels turn to the page on the left', (position, cls, atL) => {
    for (const style of ['round_label', 'operator_face', 'round']) {
      const m = launcher(style, { config: { widget_position: position }, presence: { any_available: true, operators: [TEAM[0]] } });
      expect(m.q('.ccw-launcher-wrap')!.className).toBe(cls);
      expect(top(m).classList.contains('at-l')).toBe(atL);
    }
  });

  it('the wrap CSS: corners by custom offsets, the edge tab at the middle, the centre without translate, leaving per side', () => {
    const css = widgetSource('runtime.css');
    expect(css).toMatch(/\.ccw-launcher-wrap\.edge \{ top: 50%; bottom: auto; margin-top: -80px; \}/);
    expect(css).toMatch(/\.ccw-launcher-wrap\.edge\.right \{ right: 0; \}/);
    expect(css).toMatch(/\.ccw-launcher-wrap\.edge\.left \{ left: 0; \}/);
    expect(css).toMatch(/\.ccw-launcher-wrap\.center \{ inset-inline: 0; margin-inline: auto; width: max-content; \}/);
    expect(css).not.toMatch(/translate\(-50%|translateX\(-50%\)/);
    expect(css).toMatch(/\.ccw-is-open \.ccw-launcher-wrap\.edge\.right \{ transform: translateX\(80px\); \}/);
    expect(css).toMatch(/\.ccw-is-open \.ccw-launcher-wrap\.edge\.left \{ transform: translateX\(-80px\); \}/);
    expect(css).toMatch(/\.ccw-launcher-wrap \{[^}]*z-index: 2147483000;[^}]*bottom: calc\(var\(--ccw-offset-y\) \+ var\(--ccw-stack\)\)/);
    // The return (cc's .lwp): shown again only when it starts to come back, 200ms after the fold, never peeking from
    // below the page edge while it waits (a stacked launcher sits less than 150px from the bottom).
    expect(css).toMatch(/\.ccw-launcher-wrap \{[^}]*transition: transform \.55s var\(--spring\) \.2s, opacity \.3s ease \.2s, visibility 0s linear \.2s, bottom \.55s var\(--spring\);/);
    expect(css).toMatch(/\.top \.lbl \{ border-radius: 16px 6px 16px 16px; \}/);
    expect(css).toMatch(/\.top \.at-l \.lbl \{ border-radius: 6px 16px 16px 16px; \}/);
  });
});

describe('the booked callback on the button (Sh, D15)', () => {
  const tomorrow1630 = Date.parse('2026-10-23T16:30:00+03:30');
  const booking = (at: number | null) => ({ callbackId: 'a1b2c3d4-5e6f', scheduled_for: at === null ? null : new Date(at).toISOString(), channel: 'video', urgency: 'urgent' });

  it('idle with a booking ahead: the scheduled pill with the day and time, in Persian digits in fa', () => {
    const fa = launcher('round_label', {}, 'fa');
    fa.set({ callbackBooking: booking(tomorrow1630) });
    const sched = top(fa);
    expect(sched.matches('button.sched.ccw-launcher-btn[data-action="open"]')).toBe(true);
    expect(sched.querySelector('.si svg')).not.toBeNull();
    expect(text(sched.querySelector('.tx b'))).toBe('درخواست تماس ثبت شد');
    expect(text(sched.querySelector('.tx small'))).toBe('فردا ۱۶:۳۰');
    const en = launcher('pill');
    en.set({ callbackBooking: booking(tomorrow1630) });
    expect(text(en.q('.sched .tx small'))).toMatch(/^Tomorrow 4:30\sPM$/);
  });

  it('offline too; never during a call, never for a time gone or an ASAP request', () => {
    const off = launcher('round_label', OFF);
    off.set({ callbackBooking: booking(tomorrow1630) });
    expect(off.q('.sched')).not.toBeNull();
    const call = launcher('round_label');
    call.set({ callbackBooking: booking(tomorrow1630), state: 'queue_waiting' });
    expect(call.q('.sched')).toBeNull();
    const past = launcher('round_label');
    past.set({ callbackBooking: booking(NOW - 1) });
    expect(past.q('.sched')).toBeNull();
    const asap = launcher('round_label');
    asap.set({ callbackBooking: booking(null) });
    expect(asap.q('.sched')).toBeNull();
  });

  it('a click opens the panel on the booking (screen 19), and says so', () => {
    const m = launcher('round_label');
    m.set({ callbackBooking: booking(tomorrow1630) });
    const sched = m.q<HTMLButtonElement>('.sched')!;
    expect(sched.getAttribute('aria-expanded')).toBe('false');
    sched.click();
    m.loadLinks();
    expect(m.ctrl.open).toBe(true);
    expect(m.screenId()).toBe('scheduled');
  });

  it('only Sh\'s own press shows the booking: a press that never reached the screen leaves no booking view behind', async () => {
    const m = launcher('round_label');
    m.set({ callbackBooking: booking(NOW + 30) });
    // Sh pressed, the panel's files never come (no load), the open is put back.
    m.q<HTMLButtonElement>('.sched')!.click();
    m.ctrl.toggleOpen();
    m.setNow(NOW + 31);
    await until(() => !m.q('.sched'));
    // The booking is still on the controller (RT drops it at the next mount); the round_label press opens home.
    m.open();
    expect(m.ctrl.open).toBe(true);
    expect(m.screenId()).toBe('home');
  });

  it('leaves the button at its time (one timer, capped at 2^31−1 ms)', async () => {
    const m = launcher('round_label');
    const delays: number[] = [];
    const real = m.win.setTimeout.bind(m.win);
    (m.win as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms?: number) => { delays.push(ms ?? 0); return real(fn, ms); };
    m.set({ callbackBooking: booking(NOW + 40 * 86_400_000) });
    expect(m.q('.sched')).not.toBeNull();
    expect(Math.max(...delays)).toBe(2 ** 31 - 1);
    m.set({ callbackBooking: booking(NOW + 30) });
    m.setNow(NOW + 31);
    await until(() => !m.q('.sched'));
    expect(top(m).className).toBe('ln-cl');
  });
});

describe('two widgets: the call launcher stacks above a chat launcher in its corner (D4)', () => {
  /** A chat widget as public/widget/loader.js builds it: <gs-widget> › shadow › .shell › button.launcher. */
  function chat(m: Mounted, side: 'right' | 'left', cls = 'launcher revealed') {
    const doc = m.win.document;
    const host = doc.createElement('gs-widget');
    const sr = host.attachShadow({ mode: 'open' });
    const shell = doc.createElement('div');
    shell.className = `shell pos-bottom-${side}`;
    const btn = doc.createElement('button');
    btn.className = `${cls} bottom-${side}`;
    shell.appendChild(btn);
    sr.appendChild(shell);
    // Layout jsdom does not do: the zero-size shell 24px from the corner, the 56px launcher on its bottom edge.
    const w = m.win.innerWidth, h = m.win.innerHeight;
    const sx = side === 'right' ? w - 24 : 24;
    Object.defineProperty(shell, 'getBoundingClientRect', { value: () => ({ left: sx, right: sx, top: h - 24, bottom: h - 24, width: 0, height: 0, x: sx, y: h - 24 }) });
    for (const [k, v] of Object.entries({ offsetLeft: side === 'right' ? -56 : 0, offsetTop: -56, offsetWidth: 56, offsetHeight: 56, offsetParent: shell })) {
      Object.defineProperty(btn, k, { configurable: true, get: () => v });
    }
    doc.body.appendChild(host);
    return { host, btn };
  }
  function wrapAt(m: Mounted, left: number, width: number) {
    Object.defineProperty(m.q('.ccw-launcher-wrap')!, 'getBoundingClientRect', { configurable: true, value: () => ({ left, right: left + width, width, top: 700, bottom: 746, height: 46, x: left, y: 700 }) });
  }
  const stack = (m: Mounted) => (m.q('.ccw-launcher-wrap') as HTMLElement).style.getPropertyValue('--ccw-stack');

  it('same corner: bottom = chat top − 16px, whichever loads first; re-measured when the chat launcher changes', async () => {
    const m = launcher('round_label');
    wrapAt(m, m.win.innerWidth - 22 - 160, 160);
    const { btn } = chat(m, 'right');
    // innerHeight − (innerHeight − 24 − 56) + 16 − 22 = 74
    await until(() => stack(m) === '74px');
    btn.className = 'launcher revealed open bottom-right';
    await until(() => stack(m) === '0px');
    btn.className = 'launcher revealed bottom-right';
    await until(() => stack(m) === '74px');
  });

  it('a hidden chat launcher (pending, open, or gone) and another corner do not stack', async () => {
    const pending = launcher('round_label');
    wrapAt(pending, pending.win.innerWidth - 182, 160);
    chat(pending, 'right', 'launcher pending');
    await new Promise((r) => setTimeout(r, 60));
    expect(['', '0px']).toContain(stack(pending));
    const other = launcher('round_label', { config: { widget_position: 'left' } });
    wrapAt(other, 22, 160);
    chat(other, 'right');
    await new Promise((r) => setTimeout(r, 60));
    expect(['', '0px']).toContain(stack(other));
    const gone = launcher('round_label');
    wrapAt(gone, gone.win.innerWidth - 182, 160);
    const { host } = chat(gone, 'right');
    await until(() => stack(gone) === '74px');
    host.remove();
    await until(() => stack(gone) === '0px');
  });

  it('top and edge placements never stack; a centred launcher that reaches the chat corner does', async () => {
    for (const config of [{ widget_position: 'top_right' }, { launcher_style: 'edge_tab' }]) {
      const m = launcher((config as Dict).launcher_style as string || 'round_label', { config });
      wrapAt(m, m.win.innerWidth - 182, 160);
      chat(m, 'right');
      await new Promise((r) => setTimeout(r, 60));
      expect(['', '0px']).toContain(stack(m));
    }
    const centre = launcher('split', { config: { widget_position: 'bottom_center' } });
    wrapAt(centre, centre.win.innerWidth - 80 - 231, 231);
    chat(centre, 'right');
    await until(() => stack(centre) === '74px');
  });

  it('a phone: mobile_bar beside a chat launcher is the pill, stacked like a corner launcher; a phone turned to landscape too', async () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone', bootstrap: { config: { launcher_style: 'mobile_bar' } } });
    expect(top(m).className).toBe('mbar');
    wrapAt(m, m.win.innerWidth - 18 - 180, 180);
    chat(m, 'right');
    await until(() => top(m).matches('button.ln.ln-p'));
    expect(m.q('.ccw-launcher-wrap')!.classList.contains('bar')).toBe(false);
    await until(() => stack(m) === '74px');
  });

  it('only the launcher stacks: the open panel keeps its corner, above the chat (z-order)', () => {
    const css = widgetSource('runtime.css');
    expect(css).not.toMatch(/\.ccw-panel[^{]*\{[^}]*--ccw-stack/);
    expect(css).toMatch(/\.ccw-launcher-wrap \{[^}]*transition:[^}]*bottom \.55s var\(--spring\)/);
  });
});

describe('the International skin (presentation-intl.css)', () => {
  const intl = widgetSource('presentation-intl.css');
  const cc = readFileSync(resolve(process.cwd(), 'docs/call-widget-handoff/respok/template-1-call-center/reference/css/cc.css'), 'utf8');

  it('carries every non-chrome .b-rp rule of the design, re-keyed to .ccw-presentation-intl', () => {
    // Board chrome (cards, mock pages, captions, the system sheet) and the
    // static stand-ins never ship; DM Mono is replaced by the system mono (D3);
    // the home's trust strip is not drawn (owner, 2026-10-21; §8.3 #13).
    const CHROME = /\.(kick|cc-h|cc-d|caret|lgc|stc|frm|pmk|pm|site2 \.sbar|bp|mn|curve|sc|sw-i|code|trust)\b|\.fr\.fo|\.inp\.fo/;
    // A selector list split on its top-level commas (not those inside :is()).
    const list = (sel: string) => sel.split(/,(?![^(]*\))/).map((s) => s.trim().replace(/^\.b-rp /, ''));
    const wanted = [...cc.matchAll(/^\.b-rp ([^{]+)\{/gm)]
      .flatMap((x) => list(x[1]))
      .filter((s) => !CHROME.test(s))
      // The prototype's per-corner label rule is the placement rule here (.at-l / .top).
      .map((s) => s.replace(/^\.site2\.pos-(bl|tl) \.lbl$/, '.at-l .lbl').replace(/^\.cp\.stage$/, '.stage-bg')
        // The focus ring: production's focusable set (select and roving radios too).
        .replace(/^:is\(button,a,\[role=textbox\]\):focus-visible$/, ':is(button, a, select, [tabindex="0"]):focus-visible'));
    expect(wanted.length).toBeGreaterThan(55);
    const missing = wanted.filter((s) => !intl.includes(`.ccw-presentation-intl ${s}`));
    expect(missing).toEqual([]);
  });

  it('Signal is one token: every Signal colour reads --signal (pixel-identical at the default)', () => {
    expect(intl).toMatch(/--signal: #FF5A3C;/);
    const outsideFallback = intl.replace(/@supports not[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    expect(outsideFallback.match(/#FF5A3C/gi)).toHaveLength(1);
    expect(outsideFallback).not.toMatch(/255,\s*90,\s*60/);
    expect(intl).toMatch(/@keyframes cc-lnwave-rp \{/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.ln \.wv \{ animation-name: cc-lnwave-rp; \}/);
  });

  it('the panel tail sits on the physical anchor corner, none for the edge tab or the centre (§2.6)', () => {
    expect(intl).not.toMatch(/\.ccw-panel[^{]*\{[^}]*border-(end|start)-(end|start)-radius/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.ccw-panel\.right \{ border-bottom-right-radius: var\(--tail\); \}/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.ccw-panel\.left \{ border-bottom-left-radius: var\(--tail\); \}/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.ccw-panel\.right\.top \{ border-bottom-right-radius: var\(--r-panel\); border-top-right-radius: var\(--tail\); \}/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.ccw-panel\.left\.top \{ border-bottom-left-radius: var\(--r-panel\); border-top-left-radius: var\(--tail\); \}/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.ccw-panel\.edge \{ border-radius: var\(--r-panel\); \}/);
    expect(intl).not.toMatch(/\.ccw-panel\.center[^{]*\{[^}]*--tail/);
  });

  it('the launchers keep the design\'s own tails: logical on the pill, card, go tile and split (a Persian page mirrors them), physical on the dark square and the edge tab', () => {
    const rule = (sel: string) => intl.match(new RegExp(`\\.ccw-presentation-intl ${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))![1];
    expect(rule('.ln-p')).toMatch(/border-end-end-radius: 10px;/);
    expect(rule('.ln-r')).toMatch(/border-end-end-radius: 6px;/);
    expect(rule('.ln-r .go2')).toMatch(/border-end-end-radius: 5px;/);
    expect(rule('.ln-s')).toMatch(/border-end-end-radius: 7px;/);
    expect(rule('.ln-q')).toMatch(/border-bottom-right-radius: 6px;/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.ln-t:not\(\.at-l\) \{ border-bottom-left-radius: 6px; \}/);
    for (const sel of ['.ln-p', '.ln-r', '.ln-r .go2', '.ln-s']) expect(rule(sel), sel).not.toMatch(/border-bottom-(right|left)-radius/);
  });

  it('on the accent: --on-a, never a white literal; the selected slot keeps white text on Ink', () => {
    for (const sel of ['.opt.voice', '.okc .in', '.ln-c.logo .f2', '.ln-p', '.ln-r .go2', '.ln-s', '.ln-t', '.ln-f .pb']) {
      const rule = intl.match(new RegExp(`\\.ccw-presentation-intl ${sel.replace(/\./g, '\\.')}(?::not\\([^)]*\\))* \\{([^}]*)\\}`));
      expect(rule, sel).not.toBeNull();
      expect(rule![1], sel).toMatch(/color: var\(--on-a\)/);
    }
    expect(intl).toMatch(/\.ccw-presentation-intl \.slots \.chip\.on \{ background: var\(--ink\); color: #fff; \}/);
    // The offline button is a surface cc paints white: the theme's surface colour (§2.7), white by default.
    expect(intl).toMatch(/\.ccw-presentation-intl \.ln-c\.off \{ background: var\(--panel\); color: var\(--ink\); \}/);
  });

  it('the Thread and Open lockups at their sizes, one shown by logoDirection', () => {
    expect(intl).toMatch(/\.ccw-presentation-intl \.pw \.lk \{ width: 53px; height: 13px; color: var\(--ink\); \}/);
    expect(intl).toMatch(/\.ccw-presentation-intl \.pw \.lk\.g-o \{ width: 50px; \}/);
    expect(intl).toMatch(/\.lg-open \.g-t, \.lg-thread \.g-o \{ display: none !important; \}/);
  });

  it('text-bearing surfaces keep a colour on browsers without color-mix (D25): the stage background reads tokens the fallback block redefines', () => {
    const stage = intl.match(/\.ccw-presentation-intl \.stage-bg \{([^}]*)\}/)![1];
    expect(stage).not.toMatch(/color-mix/);
    const fallback = intl.match(/@supports not \(color: color-mix\(in oklab, red, red\)\) \{([\s\S]*?)\n\}/)![1];
    for (const token of stage.match(/var\((--[a-z0-9-]+)\)/g)!.map((v) => v.slice(4, -1))) {
      if (/^--s[123]$/.test(token)) continue;
      expect(fallback, token).toContain(`${token}:`);
    }
  });

  it('the fields\' Signal focus ring survives without color-mix (D25): one declaration with an inline color-mix() would drop the whole ring there', () => {
    const fallback = intl.match(/@supports not \(color: color-mix\(in oklab, red, red\)\) \{([\s\S]*?)\n\}/)![1];
    const ring = intl.match(/\.ccw-presentation-intl \.fr:focus-within[^{]*\{([^}]*)\}/)![1];
    expect(ring).toMatch(/box-shadow: 0 0 0 2px var\(--signal\)/);
    expect(ring).not.toMatch(/color-mix/);
    for (const token of ring.match(/var\((--[a-z0-9-]+)\)/g)!.map((v) => v.slice(4, -1))) {
      if (token === '--signal') continue;
      expect(fallback, token).toContain(`${token}:`);
    }
    // The Signal tints the skin reads outside keyframes are tokens with a fallback too.
    const rules = intl.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').replace(/@supports not[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    // Declarations of properties (not the token definitions themselves) that mix Signal inline.
    const inline = [...rules.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{])\s*([a-z][a-z-]*):([^;}]*color-mix\(in oklab, var\(--signal\)[^;}]*)/g)].map((m) => m[1]);
    expect(inline).toEqual([]);
  });
});
