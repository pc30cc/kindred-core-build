/**
 * The theme pipeline (contract §2.7): a workspace's stored colours win and
 * only unset ones take the design's (D24). The primary is the accent `--a`
 * exactly as stored, the text on it white or Ink by contrast, the other
 * colours mapped to the design's tokens; the production HSL channels stay.
 * Browsers without color-mix() or linear() get the default accent's tints
 * and a plain curve (D25).
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeCallWidgets, mountCallWidget } from './mountCallWidget';

afterEach(() => closeCallWidgets());

const css = (name: string) => readFileSync(resolve(process.cwd(), 'public/call-widget', name), 'utf8');
const prop = (root: HTMLElement, name: string) => root.style.getPropertyValue(name).trim();
const intl = { bootstrap: { config: { widget_template_id: 'intl' } }, edition: 'international' as const };

describe('theme', () => {
  it('unset: the design\'s accent from the skin, white text on it, md and comfortable', () => {
    const { root } = mountCallWidget();
    expect(prop(root, '--a')).toBe('');
    expect(prop(root, '--on-a')).toBe('#FFFFFF');
    expect(prop(root, '--a-ink')).toBe('');
    expect(root.dataset.radius).toBe('md');
    expect(root.dataset.density).toBe('comfortable');
  });

  it.each(['#0B7D6C', '#2563EB', '#7C3AED', '#DB2777', '#D9480F', '#111827', '#16142B', '#2F5BFF', '#0F766E', '#C2410C'])(
    'preset %s: --a as stored, white on it',
    (hex) => {
      const { root } = mountCallWidget({ bootstrap: { config: { widget_theme: { primary: hex } } } });
      expect(prop(root, '--a')).toBe(hex);
      expect(prop(root, '--on-a')).toBe('#FFFFFF');
      expect(prop(root, '--a-ink')).toBe('');
    },
  );

  it('a light accent takes Ink text, and Ink for its links and icon tiles', () => {
    const variants: Array<{ bootstrap?: { config?: Record<string, unknown> }; edition?: 'international' }> = [{}, intl];
    for (const opts of variants) {
      const m = mountCallWidget({ ...opts, bootstrap: { config: { ...(opts.bootstrap?.config ?? {}), widget_theme: { primary: '#F5D90A' } } } });
      expect(prop(m.root, '--a')).toBe('#F5D90A');
      expect(prop(m.root, '--on-a')).toBe('#16142B');
      expect(prop(m.root, '--a-ink')).toBe('var(--ink)');
    }
  });

  it('keeps the production HSL channels, radius and density', () => {
    const { root } = mountCallWidget({ bootstrap: { config: { widget_theme: { primary: '#ff0000', radius: 'lg', density: 'compact' } } } });
    expect(prop(root, '--ccw-primary')).toBe('0 100% 50%');
    expect(root.dataset.radius).toBe('lg');
    expect(root.dataset.density).toBe('compact');
  });

  it('accent, danger, text, muted and surface map to the design\'s tokens', () => {
    const theme = { accent: '#22AA55', danger: '#CC0000', text: '#101010', muted: '#555555', surface: '#FAFAFA' };
    const wy = mountCallWidget({ bootstrap: { config: { widget_theme: theme } } }).root;
    expect(prop(wy, '--live')).toBe('#22AA55');
    expect(prop(wy, '--live-hi')).toBe('color-mix(in oklab,#22AA55 75%,#fff)');
    expect(prop(wy, '--signal')).toBe('');
    expect(prop(wy, '--end')).toBe('#CC0000');
    expect(prop(wy, '--bad')).toBe('#CC0000');
    expect(prop(wy, '--ink')).toBe('#101010');
    expect(prop(wy, '--ink-3')).toBe('#555555');
    expect(prop(wy, '--panel')).toBe('#FAFAFA');
    // Respok's accent is its Signal (live dots, stars, rings), never --live directly.
    const rp = mountCallWidget({ ...intl, bootstrap: { config: { widget_template_id: 'intl', widget_theme: theme } } }).root;
    expect(prop(rp, '--signal')).toBe('#22AA55');
    expect(prop(rp, '--live')).toBe('');
  });

  it('rejects anything but #rrggbb', () => {
    const { root } = mountCallWidget({ bootstrap: { config: { widget_theme: { primary: 'red', accent: 'url(x)', text: '#12345' } } } });
    expect(prop(root, '--a')).toBe('');
    expect(prop(root, '--live')).toBe('');
    expect(prop(root, '--ink')).toBe('');
  });

  it('the brands\' defaults live in their stylesheets: WebYar teal, Respok Ink (not the old coral)', () => {
    expect(css('runtime.css')).toMatch(/\.ccw-root \{[^}]*--ccw-primary: 171 84% 27%;[^}]*--a: #0B7D6C;/);
    const skin = css('presentation-intl.css');
    expect(skin).toMatch(/\.ccw-root\.ccw-presentation-intl \{[^}]*--ccw-primary: 245 37% 12%;[^}]*--a: #16142B;[^}]*--signal: #FF5A3C;/);
    expect(skin).not.toContain('9 100% 62%');
  });

  it('an intl root wears its logo direction (thread by default)', () => {
    expect(mountCallWidget(intl).root.classList.contains('lg-thread')).toBe(true);
    const open = mountCallWidget({ ...intl, bootstrap: { config: { widget_template_id: 'intl', logoDirection: 'open' } } }).root;
    expect(open.classList.contains('lg-open')).toBe(true);
    expect(open.classList.contains('lg-thread')).toBe(false);
    expect(mountCallWidget().root.className).not.toMatch(/lg-/);
  });
});

/** The custom properties a rule block declares, by name. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
function block(source: string, start: RegExp): string {
  const at = source.search(start);
  expect(at, String(start)).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error('unclosed block');
}

describe('D25: old browsers keep a whole look', () => {
  const rcss = css('runtime.css');
  const base = tokens(block(rcss, /\.ccw-root \{/));
  const mixed = Object.keys(base).filter((k) => /color-mix\(/.test(base[k]));

  it('every color-mix() token has a plain value where color-mix() is unknown', () => {
    expect(mixed.length).toBeGreaterThan(10);
    const fallback = tokens(block(rcss, /@supports not \(color: color-mix\(in oklab, red, red\)\)/));
    for (const k of mixed) {
      expect(fallback[k], k).toBeDefined();
      expect(fallback[k], k).not.toMatch(/var\(|color-mix\(/);
    }
  });

  it('the springs have a plain curve where linear() is unknown', () => {
    expect(base['--spring']).toMatch(/^linear\(/);
    const fallback = tokens(block(rcss, /@supports not \(transition-timing-function: linear\(0, 1\)\)/));
    expect(fallback['--spring']).toBe('cubic-bezier(.2,.9,.25,1)');
    expect(fallback['--bounce']).toBe('cubic-bezier(.2,.9,.25,1)');
  });

  it('Respok\'s own tints of its Ink for the tokens it still derives', () => {
    const skin = css('presentation-intl.css');
    const own = tokens(block(skin, /\.ccw-root\.ccw-presentation-intl \{/));
    const derived = mixed.filter((k) => !(k in own));
    const fallback = tokens(block(skin, /@supports not \(color: color-mix\(in oklab, red, red\)\)/));
    for (const k of derived) {
      expect(fallback[k], k).toBeDefined();
      expect(fallback[k], k).not.toMatch(/var\(|color-mix\(/);
    }
  });

  it('a text-bearing surface takes its colour from a covered token, not a rule-level mix', () => {
    const panel = css('presentation-default-panel.css');
    expect(panel).toMatch(/\.cons\.err \{ background: var\(--bad-1\);/);
    expect(panel).toMatch(/\.ei \{[^}]*background: var\(--bad-2\);/);
  });

  it('the stage ground (the stage layer and the Se/Sf bars, white text) keeps its dark gradient where color-mix() is unknown', () => {
    const panel = css('presentation-default-panel.css');
    const fallback = block(panel, /@supports not \(color: color-mix\(in oklab, red, red\)\)/);
    const ground = /(?:^|[\s,{}])\.stage-bg \{[^}]*background: ([^;]+);/.exec(fallback);
    expect(ground, '.stage-bg in the color-mix fallback').not.toBeNull();
    expect(ground![1]).not.toMatch(/color-mix\(/);
    expect(ground![1]).toMatch(/linear-gradient\(180deg, var\(--s1\) 0%, var\(--s2\) 52%, var\(--s3\) 100%\)/);
  });
});

// ─── Respok's stage in the workspace colour (owner, 2026-10-19; board 12-02) ──
//
// A primary other than Ink tints Respok's stage (the stage layer, the Se/Sf
// bars) as board 12-02 draws it, held dark enough for every colour: the
// numbers below are computed from the real stylesheets (the skin's tint
// block and the stage's own text colours) with the luminance cap the
// renderer writes, the way a browser composes them.

type Rgb = [number, number, number];
interface Paint { c: Rgb; a: number }
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toOklab([r, g, b]: Rgb): Rgb {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return rgb.map((c) => Math.min(1, Math.max(0, gam(c)))) as Rgb;
}
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (x: Rgb, y: Rgb) => {
  const [a, b] = [luminance(x), luminance(y)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
/** `colour` at `alpha` drawn over an opaque `base` (browsers composite in sRGB). */
const over = (colour: Rgb, alpha: number, base: Rgb) => colour.map((v, i) => v * alpha + base[i] * (1 - alpha)) as Rgb;
const WHITE: Rgb = [1, 1, 1];
function hexRgb(h: string): Rgb {
  const v = h.length === 4 ? h.slice(1).split('').map((x) => x + x).join('') : h.slice(1);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as Rgb;
}
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** Splits at the top-level occurrences of `sep` (outside parentheses). */
function splitTop(s: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const inner = (s: string, fn: string) => {
  expect(s.startsWith(`${fn}(`) && s.endsWith(')'), `${s} is ${fn}()`).toBe(true);
  return s.slice(fn.length + 1, -1);
};
/** var(--x[, fallback]) → its text; anything else as it is. */
function resolveVar(text: string, vars: Record<string, string>): string {
  const t = text.trim();
  if (!t.startsWith('var(')) return t;
  const [name, ...fb] = splitTop(inner(t, 'var'), ',');
  if (name in vars) return resolveVar(vars[name], vars);
  expect(fb.length, `${name} has a value or a fallback`).toBeGreaterThan(0);
  return resolveVar(fb.join(','), vars);
}
/** A colour of the skin, as a browser computes it: #hex, var(), `transparent`, color-mix(in oklab, …) (premultiplied). */
function paint(text: string, vars: Record<string, string>): Paint {
  const t = resolveVar(text, vars);
  if (t === 'transparent') return { c: [0, 0, 0], a: 0 };
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t)) return { c: hexRgb(t), a: 1 };
  const [space, x, y] = splitTop(inner(t, 'color-mix'), ',');
  expect(space).toBe('in oklab');
  const side = (part: string) => {
    const [colour, pct] = splitTop(part, ' ');
    return { p: pct === undefined ? null : parseFloat(resolveVar(pct, vars)) / 100, paint: paint(colour, vars) };
  };
  const A = side(x);
  const B = side(y);
  const p = A.p ?? (B.p === null ? 0.5 : 1 - B.p);
  const q = B.p ?? 1 - p;
  const a = p * A.paint.a + q * B.paint.a;
  if (a === 0) return { c: [0, 0, 0], a: 0 };
  const [la, lb] = [toOklab(A.paint.c), toOklab(B.paint.c)];
  return { c: fromOklab(la.map((v, i) => (v * p * A.paint.a + lb[i] * q * B.paint.a) / a) as Rgb), a };
}
const opaque = (text: string, vars: Record<string, string>) => {
  const p = paint(text, vars);
  expect(p.a, text).toBe(1);
  return p.c;
};

/** The stage's colour down its centre line (top 0 → bottom 1), as `.stage-bg`'s two layers draw it. */
function stageColumn(background: string, vars: Record<string, string>): Rgb[] {
  const [radial, linear] = splitTop(background, ',');
  const [shape, glowStop, fade] = splitTop(inner(radial, 'radial-gradient'), ',');
  const geo = /^(\d+)% (\d+)% at 50% (\d+)%$/.exec(shape);
  expect(geo, shape).not.toBeNull();
  const [ry, cy] = [Number(geo![2]) / 100, Number(geo![3]) / 100];
  const glow = paint(glowStop, vars);
  const end = /^transparent (\d+)%$/.exec(fade);
  expect(end, fade).not.toBeNull();
  const [angle, ...stops] = splitTop(inner(linear, 'linear-gradient'), ',');
  expect(angle).toBe('180deg');
  const ground = stops.map((s) => {
    const [colour, at] = splitTop(s, ' ');
    return { c: toOklab(opaque(colour, vars)), at: parseFloat(at) / 100 };
  });
  const out: Rgb[] = [];
  for (let i = 0; i <= 100; i++) {
    const y = i / 100;
    const k = ground.findIndex((g) => g.at >= y);
    const [g0, g1] = k <= 0 ? [ground[0], ground[0]] : [ground[k - 1], ground[k]];
    const f = g1.at === g0.at ? 0 : (y - g0.at) / (g1.at - g0.at);
    const base = fromOklab(g0.c.map((v, j) => v + (g1.c[j] - v) * f) as Rgb);
    const alpha = glow.a * Math.max(0, 1 - Math.abs(y - cy) / ry / (Number(end![1]) / 100));
    out.push(over(glow.c, alpha, base));
  }
  return out;
}
const whiteAlpha = (rule: string) => {
  const m = /color: rgba\(255,255,255,(\.\d+)\)/.exec(rule);
  expect(m, rule).not.toBeNull();
  return Number(m![1]);
};
const ruleOf = (source: string, sel: string) => {
  const m = new RegExp(`(?:^|\\n)${sel.replace(/[.()[\]*+?^$|\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(source);
  expect(m, sel).not.toBeNull();
  return m![1];
};

describe('Respok\'s stage follows a workspace colour other than Ink, held dark', () => {
  const skin = css('presentation-intl.css');
  const SUPPORTS = '@supports (color: color-mix(in oklab, red, red))';
  const TINT_ROOT = /\.ccw-root\.ccw-presentation-intl\.tint \{/;

  it('the renderer marks a tinted root and caps the colour\'s luminance (--a-k), only for Respok and only off Ink', () => {
    const rp = mountCallWidget(intl);
    const boot = (rp.ctrl as unknown as { bootstrap: { config: Record<string, unknown> } }).bootstrap;
    const paintWith = (primary?: string) => { boot.config.widget_theme = primary ? { primary } : {}; rp.set({}); };
    // No primary, or Respok's own Ink in any case: today's fixed stage.
    for (const p of [undefined, '#16142B', '#16142b']) {
      paintWith(p);
      expect(rp.root.classList.contains('tint'), String(p)).toBe(false);
      expect(prop(rp.root, '--a-k'), String(p)).toBe('');
    }
    // Any other colour: the share of it the stage keeps, so its luminance is at most .15 (oklab mix with black scales linear RGB by k³).
    const want = (hex: string) => Math.min(100, 100 * Math.cbrt(0.15 / luminance(hexRgb(hex))));
    for (const p of ['#2563EB', '#F5D90A', '#FFFFFF', '#000000', '#2f5bff']) {
      paintWith(p);
      expect(rp.root.classList.contains('tint'), p).toBe(true);
      const k = prop(rp.root, '--a-k');
      expect(k, p).toMatch(/^\d+(\.\d+)?%$/);
      expect(Math.abs(parseFloat(k) - want(p)), `${p}: --a-k ${k}`).toBeLessThanOrEqual(0.06);
    }
    expect(parseFloat(prop(rp.root, '--a-k'))).toBeLessThan(100);
    paintWith('#F5D90A');
    expect(parseFloat(prop(rp.root, '--a-k'))).toBeLessThan(65);
    // Back to no colour: the mark goes.
    paintWith(undefined);
    expect(rp.root.classList.contains('tint')).toBe(false);
    expect(prop(rp.root, '--a-k')).toBe('');
    // WebYar's stage follows its accent through runtime.css: never `tint` (a light colour is `hold`, below).
    for (const p of ['#2563EB', '#F5D90A']) {
      expect(mountCallWidget({ bootstrap: { config: { widget_theme: { primary: p } } } }).root.classList.contains('tint'), p).toBe(false);
    }
    expect(prop(mountCallWidget({ bootstrap: { config: { widget_theme: { primary: '#2563EB' } } } }).root, '--a-k')).toBe('');
    // A Respok root is never `hold`.
    paintWith('#F5D90A');
    expect(rp.root.classList.contains('hold')).toBe(false);
  });

  it('the tint lives only inside a color-mix() @supports block: without color-mix() the fixed Ink stage stays', () => {
    const at = skin.indexOf(SUPPORTS);
    expect(at, SUPPORTS).toBeGreaterThanOrEqual(0);
    const supports = block(skin, /@supports \(color: color-mix\(in oklab, red, red\)\)/);
    expect(supports).toMatch(TINT_ROOT);
    expect(supports).toMatch(/\.ccw-presentation-intl\.tint \.stage-bg \{/);
    expect(skin.replace(supports, '').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\.tint\b/);
    // Today's stage, for no colour, Ink, and browsers without color-mix().
    const own = tokens(block(skin, /\.ccw-root\.ccw-presentation-intl \{/));
    expect([own['--s1'], own['--s2'], own['--s3'], own['--glow']]).toEqual(['#2E2A5E', '#1A1838', '#0D0C1C', 'var(--signal)']);
    expect(skin).toMatch(/\.ccw-presentation-intl \.stage-bg \{ background: radial-gradient\(90% 46% at 50% 30%, var\(--signal-20\), transparent 72%\), radial-gradient\(120% 70% at 100% 0%, #3B3576 0%, transparent 58%\), linear-gradient\(180deg, var\(--s1\) 0%, var\(--s2\) 52%, var\(--s3\) 100%\); \}/);
    // The tinted tokens derive from the capped colour, a near-black, Ink's darkest (#0D0C1C) and white for the glow, nothing else.
    const t = tokens(block(supports, TINT_ROOT));
    expect(Object.keys(t).sort()).toEqual(['--a-st', '--glow', '--s1', '--s2', '--s3']);
    expect(t['--a-st']).toBe('color-mix(in oklab, var(--a) var(--a-k, 100%), #000)');
    for (const k of ['--s1', '--s2']) expect(t[k], k).toMatch(/^color-mix\(in oklab, var\(--a-st\) \d+%, #0C0C10\)$/);
    expect(t['--s3']).toMatch(/^color-mix\(in oklab, var\(--a-st\) \d+%, #0D0C1C\)$/);
    expect(t['--glow']).toMatch(/^color-mix\(in oklab, var\(--a-st\) \d+%, #fff\)$/);
  });

  // Every preset, board 12-02's colours, very light and very saturated ones, Signal's own family, and a grid of the cube.
  const ACCENTS = [
    '#2F5BFF', '#0F766E', '#C2410C', '#2563EB', '#7C3AED', '#DB2777', '#D9480F', '#111827',
    '#F5D90A', '#FDE047', '#FFFFFF', '#FFF7AE', '#A7F3D0', '#FBCFE8', '#BFDBFE', '#E9E8F1',
    '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#FF5A3C', '#E5432A', '#000000',
  ];
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    ACCENTS.push(toHex([r / 255, g / 255, b / 255]));
  }

  it(`white text keeps 7:1 at the lightest point, the stage's body text 4.5:1 everywhere, Signal and End stay apart, for ${ACCENTS.length} colours`, () => {
    const panel = css('presentation-default-panel.css');
    const supports = block(skin, /@supports \(color: color-mix\(in oklab, red, red\)\)/);
    const tint = tokens(block(supports, TINT_ROOT));
    const own = tokens(block(skin, /\.ccw-root\.ccw-presentation-intl \{/));
    const ground = /\.ccw-presentation-intl\.tint \.stage-bg \{ background: ([^;]+); \}/.exec(supports);
    expect(ground, 'the tinted .stage-bg').not.toBeNull();
    // The stage's text, as the panel stylesheet colours it.
    const body = whiteAlpha(ruleOf(panel, '.sp'));
    const second = Math.min(whiteAlpha(ruleOf(panel, '.who-c .rl')), whiteAlpha(ruleOf(panel, '.tmr .tl')));
    expect(body).toBeGreaterThanOrEqual(0.6);
    expect(ruleOf(panel, '.stage .dot:not(.off)')).toContain('var(--live-hi)');
    const signal = opaque(own['--signal'], {});
    const end = opaque(own['--end'], {});
    expect(own['--live-hi']).toBe('var(--signal)');

    const rp = mountCallWidget(intl);
    const boot = (rp.ctrl as unknown as { bootstrap: { config: Record<string, unknown> } }).bootstrap;
    const worst = { white: 99, body: 99, second: 99, signal: 99, endDock: 99, endBar: 99 };
    const fails: string[] = [];
    for (const accent of ACCENTS) {
      boot.config.widget_theme = { primary: accent };
      rp.set({});
      const tinted = rp.root.classList.contains('tint');
      if (accent === '#16142B') { expect(tinted).toBe(false); continue; }
      expect(tinted, accent).toBe(true);
      const vars = { ...own, ...tint, '--a': accent, '--a-k': prop(rp.root, '--a-k') };
      const col = stageColumn(ground![1], vars);
      const light = col.reduce((x, y) => (luminance(y) > luminance(x) ? y : x));
      const m = {
        white: contrast(WHITE, light),
        body: Math.min(...col.map((c) => contrast(over(WHITE, body, c), c))),
        second: Math.min(...col.map((c) => contrast(over(WHITE, second, c), c))),
        // The header's live dot (top eighth) and the end-call buttons: the dock (bottom fifth) and the Sf bar's middle.
        signal: Math.min(...col.slice(0, 13).map((c) => contrast(signal, c))),
        endDock: Math.min(...col.slice(80).map((c) => contrast(end, c))),
        endBar: contrast(end, col[50]),
      };
      for (const k of Object.keys(worst) as Array<keyof typeof worst>) worst[k] = Math.min(worst[k], m[k]);
      if (m.white < 7 || m.body < 4.5 || m.second < 4.5 || m.signal < 3 || m.endDock < 3 || m.endBar < 3) {
        fails.push(`${accent}: ${Object.entries(m).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')} (lightest ${toHex(light)})`);
      }
    }
    expect(fails).toEqual([]);
    // Margins, for the record (and so a looser formula shows here first).
    expect(worst.white).toBeGreaterThan(9);
    expect(worst.body).toBeGreaterThan(5);
  });

  it('the stage really takes the colour: board 12-02\'s colours keep their hue on the stage', () => {
    const supports = block(skin, /@supports \(color: color-mix\(in oklab, red, red\)\)/);
    const tint = tokens(block(supports, TINT_ROOT));
    const own = tokens(block(skin, /\.ccw-root\.ccw-presentation-intl \{/));
    const rp = mountCallWidget(intl);
    const boot = (rp.ctrl as unknown as { bootstrap: { config: Record<string, unknown> } }).bootstrap;
    const hue = (c: Rgb) => { const [, a, b] = toOklab(c); return { h: (Math.atan2(b, a) * 180) / Math.PI, C: Math.hypot(a, b) }; };
    for (const accent of ['#2563EB', '#7C3AED', '#DB2777', '#D9480F', '#0F766E', '#2F5BFF', '#C2410C', '#F5D90A']) {
      boot.config.widget_theme = { primary: accent };
      rp.set({});
      const vars = { ...own, ...tint, '--a': accent, '--a-k': prop(rp.root, '--a-k') };
      const s1 = hue(opaque('var(--s1)', vars));
      const want = hue(hexRgb(accent));
      const dh = Math.abs(((s1.h - want.h + 540) % 360) - 180);
      expect(dh, `${accent}: stage hue ${s1.h.toFixed(0)}° vs ${want.h.toFixed(0)}°`).toBeLessThan(25);
      // A real tint, not a grey: a share of the colour's chroma stays (40% of it before the luminance cap).
      expect(s1.C, `${accent}: stage chroma ${s1.C.toFixed(3)} of ${want.C.toFixed(3)}`).toBeGreaterThan(0.2 * want.C);
    }
  });

  it('the reference re-render (Tier A matrix) tints its stage with the same formulas', () => {
    const ref = readFileSync(resolve(process.cwd(), 'e2e/harness/callReferenceOverrides.css'), 'utf8');
    const supports = block(skin, /@supports \(color: color-mix\(in oklab, red, red\)\)/);
    expect(tokens(block(ref, /\.cc\.b-rp\.tint \{/))).toEqual(tokens(block(supports, TINT_ROOT)));
    const bg = (src: string, sel: RegExp) => { const m = new RegExp(`${sel.source}[^{]*\\{ background: ([^;]+); \\}`).exec(src); expect(m, String(sel)).not.toBeNull(); return m![1]; };
    expect(bg(ref, /\.cc\.b-rp\.tint \.stage-bg/)).toBe(bg(supports, /\.ccw-presentation-intl\.tint \.stage-bg/));
  });
});

// ─── WebYar's stage holds a colour lighter than its lightest preset (owner, 2026-10-19) ──
//
// WebYar's stage follows its accent through runtime.css's own formulas. A
// colour lighter than the lightest preset (#D9480F, luminance .1942) is held
// at a luminance of .195 (`hold`, `--a-k`), the glow too, so white text and the
// stage's body copy stay readable for any colour; the default and every preset
// keep runtime.css's tokens exactly. The numbers below are computed from the
// real stylesheets the way the Respok sweep above computes them.

describe('WebYar\'s stage holds a colour lighter than its lightest preset', () => {
  const skin = css('presentation-default.css');
  const rcss = css('runtime.css');
  const base = tokens(block(rcss, /\.ccw-root \{/));
  const SUPPORTS = /@supports \(color: color-mix\(in oklab, red, red\)\)/;
  const HOLD_ROOT = /\.ccw-root\.ccw-presentation-default\.hold \{/;
  const HOLD = 0.195;
  const STAGE = ['--glow', '--s1', '--s2', '--s3'];
  const WY_PRESETS = ['#0B7D6C', '#2563EB', '#7C3AED', '#DB2777', '#D9480F', '#111827'];
  const RP_PRESETS = ['#16142B', '#2F5BFF', '#0F766E', '#C2410C'];
  const LIGHT = ['#F5D90A', '#FFFFFF', '#00FF00', '#FDE047'];
  // The share of the colour the stage keeps: an oklab mix with black at k scales linear RGB by k³.
  const wantK = (hex: string) => 100 * Math.cbrt(HOLD / luminance(hexRgb(hex)));
  const mount = (opts: Parameters<typeof mountCallWidget>[0] = {}) => {
    const m = mountCallWidget(opts);
    const boot = (m.ctrl as unknown as { bootstrap: { config: Record<string, unknown> } }).bootstrap;
    const paintWith = (primary?: string) => { boot.config.widget_theme = primary ? { primary } : {}; m.set({}); };
    return { root: m.root, paintWith };
  };

  it('the renderer holds a colour lighter than .195 (`hold`, --a-k), only for WebYar; Respok keeps its tint', () => {
    // The line sits just above the lightest preset.
    expect(Math.max(...WY_PRESETS.map((p) => luminance(hexRgb(p))))).toBeLessThan(HOLD);
    expect(luminance(hexRgb('#D9480F'))).toBeGreaterThan(0.19);
    const wy = mount();
    // No colour, every preset of both brands, board 12-02's teal: runtime.css's stage as designed.
    for (const p of [undefined, ...WY_PRESETS, ...RP_PRESETS, '#0E7490', '#d9480f']) {
      wy.paintWith(p);
      expect(wy.root.classList.contains('hold'), String(p)).toBe(false);
      expect(prop(wy.root, '--a-k'), String(p)).toBe('');
    }
    // The line itself, from both sides: #0073FF (.1948) is not held, like #D9480F (.1942); #0074FE (.1965) is, just.
    expect(luminance(hexRgb('#0073FF'))).toBeLessThan(HOLD);
    expect(luminance(hexRgb('#0074FE'))).toBeGreaterThan(HOLD);
    wy.paintWith('#0073FF');
    expect(wy.root.classList.contains('hold'), '#0073FF').toBe(false);
    expect(prop(wy.root, '--a-k'), '#0073FF').toBe('');
    wy.paintWith('#0074FE');
    expect(wy.root.classList.contains('hold'), '#0074FE').toBe(true);
    expect(prop(wy.root, '--a-k'), '#0074FE').toBe('99.8%');
    for (const p of [...LIGHT, '#fde047']) {
      wy.paintWith(p);
      expect(wy.root.classList.contains('hold'), p).toBe(true);
      expect(wy.root.classList.contains('tint'), p).toBe(false);
      const k = prop(wy.root, '--a-k');
      expect(k, p).toMatch(/^\d+\.\d%$/);
      expect(Math.abs(parseFloat(k) - wantK(p)), `${p}: --a-k ${k}`).toBeLessThanOrEqual(0.06);
    }
    // Back to no colour: the mark goes.
    wy.paintWith(undefined);
    expect(wy.root.classList.contains('hold')).toBe(false);
    expect(prop(wy.root, '--a-k')).toBe('');
    // Respok: never `hold`; its tint holds .15 as before.
    const rp = mount(intl);
    for (const p of ['#F5D90A', '#FFFFFF', '#2563EB']) {
      rp.paintWith(p);
      expect(rp.root.classList.contains('hold'), p).toBe(false);
      expect(rp.root.classList.contains('tint'), p).toBe(true);
      expect(Math.abs(parseFloat(prop(rp.root, '--a-k')) - Math.min(100, 100 * Math.cbrt(0.15 / luminance(hexRgb(p))))), p).toBeLessThanOrEqual(0.06);
    }
  });

  it('the hold lives only inside a color-mix() @supports block of the skin: runtime.css\'s own formulas on the held colour', () => {
    const supports = block(skin, SUPPORTS);
    expect(supports).toMatch(HOLD_ROOT);
    // One rule, nothing else; nowhere else in the skin, nor in runtime.css or Respok's skin.
    expect(supports.match(/\{/g)).toHaveLength(2);
    expect(skin.replace(supports, '').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\.hold\b|--a-st|--a-k/);
    expect(rcss).not.toMatch(/\.hold\b|--a-st/);
    expect(css('presentation-intl.css')).not.toMatch(/\.hold\b/);
    // runtime.css's stage is the design's, on the accent itself, untouched.
    expect(STAGE.map((k) => base[k])).toEqual([
      'color-mix(in oklab, var(--a) 42%, #5CF2D6)',
      'color-mix(in oklab, var(--a) 60%, #03110F)',
      'color-mix(in oklab, var(--a) 30%, #03100E)',
      'color-mix(in oklab, var(--a) 12%, #020807)',
    ]);
    // The held tokens: the colour mixed with black at --a-k, then runtime.css's own formulas (read from it, so the two stay in step).
    const t = tokens(block(supports, HOLD_ROOT));
    expect(Object.keys(t).sort()).toEqual(['--a-st', ...STAGE].sort());
    expect(t['--a-st']).toBe('color-mix(in oklab, var(--a) var(--a-k, 100%), #000)');
    for (const k of STAGE) expect(t[k], k).toBe(base[k].replace('var(--a)', 'var(--a-st)'));
    // Without color-mix() runtime.css's D25 block (the default teal stage) stays, whatever the colour.
    const fallback = tokens(block(rcss, /@supports not \(color: color-mix\(in oklab, red, red\)\)/));
    expect(STAGE.map((k) => fallback[k])).toEqual(['#3CBFA8', '#0A4E44', '#072D27', '#041411']);
  });

  // Both brands' presets, board 12-02's teal, the pair either side of the line (#0073FF, #0074FE: the cube's worst
  // colours), light, pastel and saturated colours, black and a grid of the cube; each colour once.
  const ACCENTS = [
    ...WY_PRESETS, ...RP_PRESETS, '#0E7490', '#0073FF', '#0074FE',
    '#F5D90A', '#FDE047', '#FFFFFF', '#FFF7AE', '#A7F3D0', '#FBCFE8', '#BFDBFE', '#E9E8F1',
    '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#FF5A3C', '#E5432A', '#000000',
  ];
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const hex = toHex([r / 255, g / 255, b / 255]);
    if (!ACCENTS.includes(hex)) ACCENTS.push(hex);
  }

  it(`white text keeps 7:1 at the lightest point and the body copy 4.3:1 for ${ACCENTS.length} colours; the default and the presets as designed`, () => {
    const panel = css('presentation-default-panel.css');
    const hold = tokens(block(block(skin, SUPPORTS), HOLD_ROOT));
    const ground = /background: ([^;]+);/.exec(ruleOf(panel, '.stage-bg'));
    expect(ground, 'the panel\'s .stage-bg').not.toBeNull();
    const body = whiteAlpha(ruleOf(panel, '.sp'));
    const second = Math.min(whiteAlpha(ruleOf(panel, '.who-c .rl')), whiteAlpha(ruleOf(panel, '.tmr .tl')));
    // The header's status, the Se/Sf bar's time and screen 12's microphone how-to (white .66).
    const mid = Math.min(...['.stage .hd .st', '.mc .tx small', '.dn .how'].map((s) => whiteAlpha(ruleOf(panel, s))));
    const end = opaque(base['--end'], {});
    const wy = mount();
    const designed = new Set([...WY_PRESETS, ...RP_PRESETS]);
    const worst = {
      held: { white: 99, body: 99, mid: 99, second: 99, endBar: 99 },
      unheld: { white: 99, body: 99, mid: 99, second: 99, endBar: 99 },
      designed: { white: 99, body: 99, mid: 99, second: 99, endBar: 99 },
    };
    const fails: string[] = [];
    for (const accent of [undefined, ...ACCENTS]) {
      wy.paintWith(accent);
      const held = wy.root.classList.contains('hold');
      const vars: Record<string, string> = { ...base, ...(accent ? { '--a': accent } : {}) };
      if (held) Object.assign(vars, hold, { '--a-k': prop(wy.root, '--a-k') });
      const name = accent ?? 'default';
      if (!accent || designed.has(accent)) {
        // The default and the presets: runtime.css's tokens on the colour itself, nothing held.
        expect(held, name).toBe(false);
        expect(prop(wy.root, '--a-k'), name).toBe('');
      } else {
        expect(held, name).toBe(luminance(hexRgb(accent)) > HOLD);
      }
      // Held at that luminance: the stage's colour is exactly as light as the line.
      if (held) expect(luminance(opaque('var(--a-st)', vars)), name).toBeCloseTo(HOLD, 2);
      const col = stageColumn(ground![1], vars);
      const light = col.reduce((x, y) => (luminance(y) > luminance(x) ? y : x));
      const m = {
        white: contrast(WHITE, light),
        body: Math.min(...col.map((c) => contrast(over(WHITE, body, c), c))),
        mid: Math.min(...col.map((c) => contrast(over(WHITE, mid, c), c))),
        second: Math.min(...col.map((c) => contrast(over(WHITE, second, c), c))),
        // The end button against the middle of the Sf bar (a stage-bg ground too).
        endBar: contrast(end, col[50]),
      };
      const group = !accent || designed.has(accent) ? worst.designed : held ? worst.held : worst.unheld;
      for (const k of Object.keys(m) as Array<keyof typeof m>) group[k] = Math.min(group[k], m[k]);
      if (m.white < 7 || m.body < 4.3 || (group === worst.designed && m.body < 4.5)) {
        fails.push(`${name}${held ? ' (held)' : ''}: ${Object.entries(m).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')} (lightest ${toHex(light)})`);
      }
    }
    expect(fails).toEqual([]);
    // Margins, for the record (and so a looser formula shows here first). Measured on this sweep (white / body .68 /
    // the .66 lines / the .60 lines / End on the Sf bar): held colours 7.41 / 4.35 / 4.19 / 3.75 / 2.78 (#0074FE),
    // unheld 7.41 / 4.35 / 4.20 / 3.75 / 2.78 (#0073FF), the default and the presets 7.58 / 4.52 / 4.36 / 3.90 / 2.81
    // (#D9480F, the lightest; the default 7.99 / 4.66 / 4.49 / 4.00 / 2.94). The worst colours, held or not, are
    // saturated azure blues exactly as light as #D9480F, i.e. the design's own formula at its lightest preset's
    // luminance (a 32³ sweep of the cube finds nothing lower), so the body copy is held to 4.3, not 4.5; the presets
    // themselves keep 4.5. The .66 and .60 lines and End on the bar (under WCAG 1.4.11's 3:1 at the default too) are
    // the design's own. Before the hold, #F5D90A measured white 3.69 / body 2.57 and #FFFFFF 2.83 / 2.11.
    expect(worst.held.white).toBeGreaterThan(7.4);
    expect(worst.held.body).toBeGreaterThan(4.35);
    expect(worst.held.mid).toBeGreaterThan(4.19);
    expect(worst.held.second).toBeGreaterThan(3.75);
    expect(worst.held.endBar).toBeGreaterThan(2.78);
    expect(worst.unheld.white).toBeGreaterThan(7.4);
    expect(worst.unheld.body).toBeGreaterThan(4.35);
    expect(worst.unheld.mid).toBeGreaterThan(4.19);
    expect(worst.unheld.second).toBeGreaterThan(3.75);
    expect(worst.unheld.endBar).toBeGreaterThan(2.78);
    expect(worst.designed.white).toBeGreaterThan(7.5);
    expect(worst.designed.body).toBeGreaterThanOrEqual(4.5);
    expect(worst.designed.mid).toBeGreaterThan(4.35);
    expect(worst.designed.second).toBeGreaterThan(3.9);
    expect(worst.designed.endBar).toBeGreaterThan(2.8);
  });

  it('the reference re-render (Tier A matrix) holds its stage with the same formulas', () => {
    const ref = readFileSync(resolve(process.cwd(), 'e2e/harness/callReferenceOverrides.css'), 'utf8');
    expect(tokens(block(ref, /\.cc\.b-wy\.hold \{/))).toEqual(tokens(block(block(skin, SUPPORTS), HOLD_ROOT)));
  });
});
