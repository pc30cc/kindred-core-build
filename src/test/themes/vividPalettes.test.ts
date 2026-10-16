/**
 * Vivid's colour schemes (src/themes/vivid/theme.css, palettes.css,
 * palettes.ts): one accent each, over Art's own paper and ink.
 *
 * The promises this checks, for every scheme in light and in dark, on the
 * colours the panel really wears (Art's shared stylesheets, which Vivid
 * wears as Art's family, then Vivid's layer, then the scheme's own block):
 *   - Contrast (WCAG 2.x): text on the accent, the accent as text on Art's
 *     cards, paper and side menu, on its own 10% tint and on the key figure's
 *     panel, and muted text on that panel at least 4.5:1; the focus ring and
 *     every chart series at least 3:1 against the cards.
 *   - The six chart series stay apart, also for colour-blind eyes; series 1
 *     is the accent's hue.
 *   - A scheme sets exactly the scheme tokens, as plain HSL triplets, and
 *     never Art's paper or ink.
 *   - The Super Admin's swatches show exactly the colours the panel wears.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIVID_PALETTE_SWATCHES } from '@/themes/vivid/palettes';
import { VIVID_PALETTES, type VividPalette } from '../../../shared/panelThemes';

type Mode = 'light' | 'dark';
type Rgb = [number, number, number];
type Tokens = Record<string, string>;

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const ROOT = ':root[data-panel-theme="vivid"]';
const FAMILY = ':root[data-panel-family="art"]';
// Art's shared stylesheets in the order src/main.tsx loads them (Art's own
// schemes, palettes.css, are Art's alone), then Vivid's layer.
const ART_FILES = ['theme', 'components', 'pages', 'inbox', 'sidebar', 'charts'].map((name) => `src/themes/art/${name}.css`);
const MODES: Mode[] = ['light', 'dark'];
const TRIPLET = /^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/;
const SERIES = [1, 2, 3, 4, 5, 6].map((n) => `--art-chart-${n}`);
/** What a scheme sets (palettes.css's header); everything else is shared or derived. */
const SCHEME_TOKENS = [
  '--primary',
  '--primary-foreground',
  '--gold',
  '--gold-foreground',
  '--ring',
  '--accent',
  '--accent-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-ring',
  '--vivid-from',
  '--vivid-to',
  '--vivid-tint',
  ...SERIES,
];
/** Art's paper and ink: a scheme never sets them. */
const PAPER_TOKENS = ['--background', '--foreground', '--card', '--muted', '--muted-foreground', '--secondary', '--border', '--sidebar-background'];

/** Every top-level rule of a stylesheet (rules inside @media and other at-rules are left out). */
function topLevelRules(css: string): { selector: string; body: string }[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: { selector: string; body: string }[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open < 0) break;
    const selector = source.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth += 1;
      if (source[j] === '}') depth -= 1;
      j += 1;
    }
    if (!selector.startsWith('@')) rules.push({ selector, body: source.slice(open + 1, j - 1) });
    i = j;
  }
  return rules;
}

/** The custom properties set by the rules whose selector list holds `selector` (or one of them), later ones winning. */
function tokensOf(css: string, selector: string | string[]): Tokens {
  const wanted = Array.isArray(selector) ? selector : [selector];
  const out: Tokens = {};
  for (const rule of topLevelRules(css)) {
    if (!rule.selector.split(',').some((one) => wanted.includes(one.trim()))) continue;
    for (const declaration of rule.body.split(';')) {
      const colon = declaration.indexOf(':');
      const name = declaration.slice(0, colon).trim();
      if (colon > 0 && name.startsWith('--')) out[name] = declaration.slice(colon + 1).trim();
    }
  }
  return out;
}

const themeCss = read('src/themes/vivid/theme.css');
const palettesCss = read('src/themes/vivid/palettes.css');
const artSheets = ART_FILES.map(read);
const ART_LIGHT = Object.assign({}, ...artSheets.map((css) => tokensOf(css, FAMILY))) as Tokens;
const ART_DARK = { ...ART_LIGHT, ...Object.assign({}, ...artSheets.map((css) => tokensOf(css, `${FAMILY}.dark`))) } as Tokens;
const LIGHT_BASE = { ...ART_LIGHT, ...tokensOf(themeCss, ROOT) };
const DARK_BASE = { ...ART_DARK, ...tokensOf(themeCss, [ROOT, `${ROOT}.dark`]) };
const schemeSelector = (id: VividPalette, mode: Mode) =>
  `${ROOT}[data-panel-palette="${id}"]${mode === 'light' ? ':not(.dark)' : '.dark'}`;

/** The panel's tokens under a scheme and a mode (coral, the default, has no block of its own). */
function tokens(id: VividPalette, mode: Mode): Tokens {
  const own = id === 'coral' ? {} : tokensOf(palettesCss, schemeSelector(id, mode));
  return { ...(mode === 'light' ? LIGHT_BASE : DARK_BASE), ...own };
}

/** A token's HSL triplet, following `var(--other)` references. */
function triplet(all: Tokens, name: string, seen: string[] = []): string {
  const value = all[name];
  if (value === undefined) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) {
    if (seen.includes(name)) throw new Error(`${name} refers to itself`);
    return triplet(all, ref[1], [...seen, name]);
  }
  if (!TRIPLET.test(value)) throw new Error(`${name} is not an HSL triplet: ${value}`);
  return value;
}

function hslToRgb(value: string): Rgb {
  const [, hs, ss, ls] = TRIPLET.exec(value)!;
  const h = (((Number(hs) % 360) + 360) % 360) / 30;
  const s = Number(ss) / 100;
  const l = Number(ls) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `top` at `alpha` over `bottom`, blended the way the browser paints `hsl(... / alpha)`. */
const over = (top: Rgb, bottom: Rgb, alpha: number): Rgb => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha)) as Rgb;

/** WCAG 2.x contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

/** Colour-vision deficiency, full severity (Machado, Oliveira and Fernandes 2009), on linear RGB. */
const CVD: Record<string, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

function simulate(rgb: Rgb, matrix: number[][] | null): Rgb {
  if (!matrix) return rgb;
  const lin = rgb.map(toLinear);
  return matrix.map((row) => clamp(fromLinear(clamp(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])))) as Rgb;
}

/** Distance in OKLab, x100 (about 2 is a just-noticeable difference). */
function deltaE(a: Rgb, b: Rgb): number {
  const lab = (rgb: Rgb) => {
    const [r, g, bl] = rgb.map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

const hueOf = (value: string) => Number(TRIPLET.exec(value)![1]);

const CASES = VIVID_PALETTES.flatMap((id) => MODES.map((mode) => [id, mode] as [VividPalette, Mode]));

describe('the schemes in palettes.css', () => {
  it('has a light and a dark block for every scheme but coral (the default), and nothing else', () => {
    const ids = new Set<string>();
    for (const { selector } of topLevelRules(palettesCss)) {
      for (const one of selector.split(',').map((s) => s.trim())) {
        const id = /\[data-panel-palette="([^"]+)"\]/.exec(one)?.[1];
        expect(id, one).toBeDefined();
        ids.add(id!);
        expect([schemeSelector(id as VividPalette, 'light'), schemeSelector(id as VividPalette, 'dark')]).toContain(one);
      }
    }
    expect([...ids].sort()).toEqual(VIVID_PALETTES.filter((id) => id !== 'coral').sort());
  });

  it('sets exactly the scheme tokens, as plain HSL triplets', () => {
    for (const id of VIVID_PALETTES.filter((p) => p !== 'coral')) {
      for (const mode of MODES) {
        const own = tokensOf(palettesCss, schemeSelector(id, mode));
        expect(Object.keys(own).sort(), `${id} ${mode}`).toEqual([...SCHEME_TOKENS].sort());
        for (const [name, value] of Object.entries(own)) expect(TRIPLET.test(value), `${id} ${mode} ${name}: ${value}`).toBe(true);
      }
    }
  });

  it('defines coral, the default, in theme.css for light and dark', () => {
    for (const name of SCHEME_TOKENS) {
      expect(TRIPLET.test(tokensOf(themeCss, ROOT)[name] ?? ''), `light ${name}`).toBe(true);
      expect(TRIPLET.test(tokensOf(themeCss, `${ROOT}.dark`)[name] ?? ''), `dark ${name}`).toBe(true);
    }
  });

  it('never sets Art’s paper or ink: only the accent changes', () => {
    const sets = (css: string, name: string) => new RegExp(`[\\s{;]${name}:`).test(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    for (const name of PAPER_TOKENS) {
      expect(sets(themeCss, name), `theme.css ${name}`).toBe(false);
      expect(sets(palettesCss, name), `palettes.css ${name}`).toBe(false);
    }
  });

  it('draws Art’s gradients and the strip from the one accent', () => {
    for (const name of ['--brand-teal', '--brand-sky', '--brand-violet', '--brand-coral', '--art-grad-from', '--art-grad-to', '--art-brand-from', '--art-brand-via', '--vivid-strip', '--vivid-panel']) {
      expect(LIGHT_BASE[name], name).toBeDefined();
      expect(LIGHT_BASE[name], name).toMatch(/var\(--vivid-/);
      expect(DARK_BASE[name], name).toBe(LIGHT_BASE[name]);
    }
  });
});

describe.each(CASES)('%s in %s mode', (id, mode) => {
  const all = tokens(id, mode);
  const rgb = (name: string) => hslToRgb(triplet(all, name));
  const card = rgb('--card');
  const tint = rgb('--vivid-tint');

  it('makes series 1 the accent’s own hue', () => {
    expect(Math.abs(hueOf(triplet(all, '--art-chart-1')) - hueOf(triplet(all, '--primary')))).toBeLessThanOrEqual(2);
  });

  it('keeps text on the accent and the accent as text at 4.5:1', () => {
    expect(contrast(rgb('--primary-foreground'), rgb('--primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--primary'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--primary'), rgb('--background'))).toBeGreaterThanOrEqual(4.5);
    // Active pills, selected rows and links on `bg-primary/10` over a card.
    expect(contrast(rgb('--primary'), over(rgb('--primary'), card, 0.1))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--accent-foreground'), rgb('--accent'))).toBeGreaterThanOrEqual(4.5);
    // The side menu's group names, on the side menu (Art: --secondary in light, --card in dark).
    expect(contrast(rgb('--primary'), rgb(mode === 'light' ? '--secondary' : '--card'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the key figure and its caption readable on their tinted panel, like the receipt’s total', () => {
    expect(contrast(rgb('--primary'), tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--muted-foreground'), tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--foreground'), tint)).toBeGreaterThanOrEqual(7);
  });

  it('shows the focus ring at 3:1', () => {
    expect(contrast(rgb('--ring'), card)).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb('--ring'), rgb('--background'))).toBeGreaterThanOrEqual(3);
  });

  it('draws every chart series at 3:1 against the cards', () => {
    for (const name of SERIES) expect(contrast(rgb(name), card), name).toBeGreaterThanOrEqual(3);
  });

  it('keeps the six series apart, also for colour-blind eyes', () => {
    const series = SERIES.map(rgb);
    const vision: [string, number[][] | null, number][] = [
      ['normal vision', null, 7],
      ...Object.entries(CVD).map(([name, matrix]) => [name, matrix, 5] as [string, number[][], number]),
    ];
    for (const [name, matrix, min] of vision) {
      const seen = series.map((c) => simulate(c, matrix));
      for (let a = 0; a < seen.length; a += 1) {
        for (let b = a + 1; b < seen.length; b += 1) {
          expect(deltaE(seen[a], seen[b]), `${name}: series ${a + 1} and ${b + 1}`).toBeGreaterThanOrEqual(min);
        }
      }
    }
  });

  it('is what the Super Admin’s swatch shows', () => {
    const hsl = (name: string) => `hsl(${triplet(all, name)})`;
    expect(VIVID_PALETTE_SWATCHES[id][mode]).toEqual({
      primary: hsl('--primary'),
      primaryInk: hsl('--primary-foreground'),
      tint: hsl('--vivid-tint'),
      strip: [hsl('--vivid-from'), hsl('--vivid-to')],
      series: SERIES.slice(0, 4).map(hsl),
    });
  });
});
