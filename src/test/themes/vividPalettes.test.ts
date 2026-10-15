/**
 * Vivid's colour schemes (src/themes/vivid/theme.css, palettes.css,
 * palettes.ts).
 *
 * The promises this checks, for every scheme in light and in dark, on the
 * colours the panel really wears (theme.css's tokens, then the scheme's own
 * block):
 *   - Contrast (WCAG 2.x): text on the scheme's colour, the colour as text on
 *     the cards, the canvas, its own 10% tint and the hero tint, muted text on
 *     every surface it sits on, and the status colours at least 4.5:1; the
 *     focus ring and every chart series at least 3:1 against the cards.
 *   - A scheme sets exactly the scheme tokens, in light and dark, as plain
 *     HSL triplets; series 1 is its main colour.
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
const MODES: Mode[] = ['light', 'dark'];
const TRIPLET = /^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/;
const SERIES = [1, 2, 3, 4].map((n) => `--vivid-chart-${n}`);
/** What a scheme sets (palettes.css's header); everything else is shared or derived. */
const SCHEME_TOKENS = [
  '--primary',
  '--primary-foreground',
  '--ring',
  '--accent',
  '--accent-foreground',
  '--background',
  '--sidebar-background',
  '--vivid-from',
  '--vivid-to',
  '--vivid-tint',
  ...SERIES,
];

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

const themeCss = read('src/themes/vivid/theme.css');
const palettesCss = read('src/themes/vivid/palettes.css');
const LIGHT_BASE = tokensOf(themeCss, ROOT);
const DARK_BASE = { ...LIGHT_BASE, ...tokensOf(themeCss, `${ROOT}.dark`) };
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
      expect(TRIPLET.test(LIGHT_BASE[name] ?? ''), `light ${name}`).toBe(true);
      expect(TRIPLET.test(tokensOf(themeCss, `${ROOT}.dark`)[name] ?? ''), `dark ${name}`).toBe(true);
    }
  });

  it('draws the shared gradients from tokens a scheme repaints', () => {
    for (const name of ['--vivid-strip', '--vivid-panel', '--gradient-primary', '--gradient-brand', '--gradient-soft']) {
      expect(LIGHT_BASE[name], name).toBeDefined();
      expect(LIGHT_BASE[name], name).not.toMatch(/hsl\(\s*\d/);
    }
  });
});

describe.each(CASES)('%s in %s mode', (id, mode) => {
  const all = tokens(id, mode);
  const rgb = (name: string) => hslToRgb(triplet(all, name));
  const card = rgb('--card');
  const tint = rgb('--vivid-tint');

  it('makes series 1 the scheme’s main colour', () => {
    expect(triplet(all, '--vivid-chart-1')).toBe(triplet(all, '--primary'));
  });

  it('keeps text on the scheme’s colour and the colour as text at 4.5:1', () => {
    expect(contrast(rgb('--primary-foreground'), rgb('--primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--primary'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--primary'), rgb('--background'))).toBeGreaterThanOrEqual(4.5);
    // Active pills, selected rows and links on `bg-primary/10` over a card.
    expect(contrast(rgb('--primary'), over(rgb('--primary'), card, 0.1))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the figure on its tinted panel at 4.5:1, like the receipt’s total', () => {
    expect(contrast(rgb('--primary'), tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--accent-foreground'), rgb('--accent'))).toBeGreaterThanOrEqual(4.5);
    // The sidebar's current item: its text on the tint.
    expect(contrast(rgb('--sidebar-accent-foreground'), rgb('--sidebar-accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps body and muted text readable on every surface', () => {
    expect(contrast(rgb('--foreground'), rgb('--background'))).toBeGreaterThanOrEqual(7);
    expect(contrast(rgb('--foreground'), tint)).toBeGreaterThanOrEqual(7);
    for (const surface of ['--background', '--card', '--muted', '--secondary', '--vivid-tint']) {
      expect(contrast(rgb('--muted-foreground'), rgb(surface)), surface).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(rgb('--sidebar-muted-foreground'), rgb('--sidebar-background'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('--sidebar-foreground'), rgb('--sidebar-background'))).toBeGreaterThanOrEqual(7);
    // The group labels: the scheme's colour on the sidebar.
    expect(contrast(rgb('--primary'), rgb('--sidebar-background'))).toBeGreaterThanOrEqual(4.5);
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

  it('is what the Super Admin’s swatch shows', () => {
    const hsl = (name: string) => `hsl(${triplet(all, name)})`;
    expect(VIVID_PALETTE_SWATCHES[id][mode]).toEqual({
      primary: hsl('--primary'),
      primaryInk: hsl('--primary-foreground'),
      canvas: hsl('--background'),
      sidebar: hsl('--sidebar-background'),
      tint: hsl('--vivid-tint'),
      strip: [hsl('--vivid-from'), hsl('--vivid-to')],
      series: SERIES.map(hsl),
    });
  });
});
