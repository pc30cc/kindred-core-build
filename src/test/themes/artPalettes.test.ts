/**
 * Art's colour schemes (src/themes/art/palettes.css, palettes.ts).
 *
 * The promises this checks, for every scheme in light and in dark, on the
 * colours the panel really wears (Art's stylesheets cascaded the way
 * src/main.tsx loads them, then the scheme's own block):
 *   - Contrast (WCAG 2.x): text on the accent, the accent as text or a link
 *     (also on its own pale tint), muted text and the status colours at least
 *     4.5:1; the focus ring and every chart series at least 3:1 against the
 *     cards (1.4.11); white text on every plan colour (Billing → Plans) at
 *     least 3:1.
 *   - The chart series stay apart: no two of the six look alike, also under a
 *     simulation of protanopia, deuteranopia and tritanopia.
 *   - Every scheme exists in both modes and only as a scheme of Art, series 1
 *     is its main colour, its tokens are plain HSL triplets, and the Super
 *     Admin's swatches show exactly the colours the panel wears.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ART_PALETTE_SWATCHES } from '@/themes/art/palettes';
import { ART_PALETTES, type ArtPalette } from '../../../shared/panelThemes';

type Mode = 'light' | 'dark';
type Rgb = [number, number, number];
type Tokens = Record<string, string>;

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const ROOT = ':root[data-panel-theme="art"]';
// Art's stylesheets in the order src/main.tsx loads them: of two rules with the same selector, the later wins.
const FILES = ['theme', 'components', 'pages', 'inbox', 'sidebar', 'palettes', 'charts'].map((name) => `src/themes/art/${name}.css`);
const PALETTES_CSS = 'src/themes/art/palettes.css';
const MODES: Mode[] = ['light', 'dark'];
const TRIPLET = /^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/;

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

/** The custom properties set by the rules whose selector is exactly `selector`, later ones winning. */
function tokensOf(css: string, selector: string): Tokens {
  const out: Tokens = {};
  for (const rule of topLevelRules(css)) {
    if (rule.selector !== selector) continue;
    for (const declaration of rule.body.split(';')) {
      const colon = declaration.indexOf(':');
      const name = declaration.slice(0, colon).trim();
      if (colon > 0 && name.startsWith('--')) out[name] = declaration.slice(colon + 1).trim();
    }
  }
  return out;
}

const sheets = FILES.map(read);
const palettesCss = read(PALETTES_CSS);
const merged = (selector: string): Tokens => Object.assign({}, ...sheets.map((css) => tokensOf(css, selector)));
const LIGHT_BASE = merged(ROOT);
const DARK_BASE = { ...LIGHT_BASE, ...merged(`${ROOT}.dark`) };
const schemeSelector = (id: ArtPalette, mode: Mode) =>
  `${ROOT}[data-panel-palette="${id}"]${mode === 'light' ? ':not(.dark)' : '.dark'}`;

/** The panel's tokens under a scheme and a mode (clay, the default, has no block of its own). */
function tokens(id: ArtPalette, mode: Mode): Tokens {
  const own = id === 'clay' ? {} : tokensOf(palettesCss, schemeSelector(id, mode));
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
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

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

const SERIES = [1, 2, 3, 4, 5, 6].map((n) => `--art-chart-${n}`);
const CASES = ART_PALETTES.flatMap((id) => MODES.map((mode) => [id, mode] as [ArtPalette, Mode]));

describe('the schemes in palettes.css', () => {
  it('has a light and a dark block for every scheme but clay (the default), and nothing else', () => {
    const ids = new Set<string>();
    for (const { selector } of topLevelRules(palettesCss)) {
      for (const one of selector.split(',').map((s) => s.trim())) {
        const id = /\[data-panel-palette="([^"]+)"\]/.exec(one)?.[1];
        if (!id) continue;
        ids.add(id);
        expect([schemeSelector(id as ArtPalette, 'light'), schemeSelector(id as ArtPalette, 'dark')]).toContain(one);
      }
    }
    expect([...ids].sort()).toEqual(ART_PALETTES.filter((id) => id !== 'clay').sort());
    for (const id of ids) {
      for (const mode of MODES) {
        expect(Object.keys(tokensOf(palettesCss, schemeSelector(id as ArtPalette, mode))).length, `${id} ${mode}`).toBeGreaterThan(20);
      }
    }
  });

  it('gives a scheme’s tokens as plain HSL triplets', () => {
    for (const id of ART_PALETTES.filter((p) => p !== 'clay')) {
      for (const mode of MODES) {
        for (const [name, value] of Object.entries(tokensOf(palettesCss, schemeSelector(id, mode)))) {
          expect(TRIPLET.test(value), `${id} ${mode} ${name}: ${value}`).toBe(true);
        }
      }
    }
  });

  it('draws the theme’s gradients from tokens a scheme repaints', () => {
    const theme = read('src/themes/art/theme.css');
    for (const selector of [ROOT, `${ROOT}.dark`]) {
      const own = tokensOf(theme, selector);
      for (const name of ['--gradient-primary', '--gradient-brand', '--gradient-soft', '--gradient-sidebar', '--gradient-card-hover', '--gradient-surface']) {
        const value = own[name] ?? LIGHT_BASE[name];
        expect(value, name).toBeDefined();
        expect(value, `${selector} ${name}`).not.toMatch(/hsl\(\s*\d/);
      }
    }
  });
});

describe.each(CASES)('%s in %s mode', (id, mode) => {
  const all = tokens(id, mode);
  const rgb = (name: string) => hslToRgb(triplet(all, name));
  const card = rgb('--card');

  it('defines every token it is read by', () => {
    for (const name of ['--background', '--foreground', '--card', '--muted', '--muted-foreground', '--primary', '--primary-foreground', '--ring', '--accent', '--accent-foreground', ...SERIES]) {
      expect(() => triplet(all, name), name).not.toThrow();
    }
  });

  it('makes series 1 the scheme’s main colour', () => {
    expect(triplet(all, '--art-chart-1')).toBe(triplet(all, '--primary'));
  });

  it('keeps text on the accent and the accent as text at 4.5:1', () => {
    expect(contrast(rgb('--primary-foreground'), rgb('--primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--primary'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--primary'), rgb('--background'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--accent-foreground'), rgb('--accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the accent readable as text on its own 10% tint', () => {
    // Active pills, selected rows and links on `bg-primary/10` over a card.
    expect(contrast(rgb('--primary'), over(rgb('--primary'), card, 0.1))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps white text on every plan colour at 3:1', () => {
    // Billing → Plans: the "current plan" pill and the Choose button are text-white on hsl(var(--plan-N)).
    for (const n of [1, 2, 3, 4, 5]) {
      expect(contrast([1, 1, 1], rgb(`--plan-${n}`)), `--plan-${n}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps body and muted text readable on the paper', () => {
    expect(contrast(rgb('--foreground'), rgb('--background'))).toBeGreaterThanOrEqual(7);
    for (const surface of ['--background', '--card', '--muted', '--secondary']) {
      expect(contrast(rgb('--muted-foreground'), rgb(surface)), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the status colours readable', () => {
    for (const status of ['success', 'warning', 'info', 'destructive']) {
      expect(contrast(rgb(`--${status}-foreground`), rgb(`--${status}`)), status).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(`--${status}`), card), status).toBeGreaterThanOrEqual(4.5);
    }
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
    const swatch = ART_PALETTE_SWATCHES[id][mode];
    const hsl = (name: string) => `hsl(${triplet(all, name)})`;
    expect(swatch).toEqual({
      primary: hsl('--primary'),
      primaryInk: hsl('--primary-foreground'),
      canvas: hsl('--background'),
      surface: hsl('--card'),
      series: SERIES.slice(0, 4).map(hsl),
    });
  });
});
