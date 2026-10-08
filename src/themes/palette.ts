/**
 * Tailwind's colour palette, routed through CSS variables so a workspace
 * panel theme can repaint every hue the pages hard-code (`bg-sky-500`,
 * `from-indigo-500 to-violet-500`, `text-emerald-600`, ...).
 *
 * Build-time only: tailwind.config.ts maps every shade of PALETTE_FAMILIES to
 * `rgb(var(--palette-<family>-<shade>) / <alpha-value>)`, and `palettePlugin`
 * defines those variables:
 *   - on `:root` with Tailwind's own values, so with no theme (classic) every
 *     class renders exactly as it always has;
 *   - on `:root[data-panel-theme="<id>"]` for each theme in THEME_PALETTES,
 *     computed here in OKLCH from Tailwind's values by the theme's transform.
 * The attribute is on <html> only while the workspace panel is open
 * (src/themes/usePanelTheme.ts), so other surfaces never change.
 */
import tailwindColors from 'tailwindcss/colors';
import plugin from 'tailwindcss/plugin';
import type { PanelThemeId } from '../../shared/panelThemes';
import { artPalette } from './art/palette';

export const PALETTE_FAMILIES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const;
export type PaletteFamily = (typeof PALETTE_FAMILIES)[number];

export const PALETTE_SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const;
export type PaletteShade = (typeof PALETTE_SHADES)[number];

/** OKLCH: lightness 0..1, chroma, hue in degrees. */
export interface Lch {
  l: number;
  c: number;
  h: number;
}

/** A theme's palette: each Tailwind colour in, the theme's colour out. */
export type PaletteTransform = (family: PaletteFamily, shade: PaletteShade, color: Lch) => Lch;

const THEME_PALETTES: Partial<Record<PanelThemeId, PaletteTransform>> = {
  art: artPalette,
};

// ── sRGB ⇄ OKLCH (Björn Ottosson's OKLab) ──────────────────────────────

type Rgb = [number, number, number];

const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const fromLinear = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

export function hexToRgb(hex: string): Rgb {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((ch) => ch + ch).join('') : v;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
}

export function rgbToLch([r, g, b]: Rgb): Lch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** Linear (unclamped) sRGB of an OKLCH colour. */
function lchToLinear({ l: L, c, h }: Lch): Rgb {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((x) => x >= -0.0001 && x <= 1.0001);

/** OKLCH → sRGB; out-of-gamut colours keep their lightness and hue and lose chroma. */
export function lchToRgb(color: Lch): Rgb {
  let c = color.c;
  let linear = lchToLinear({ ...color, c });
  while (!inGamut(linear) && c > 0) {
    c = Math.max(0, c - 0.002);
    linear = lchToLinear({ ...color, c });
  }
  return linear.map((x) => fromLinear(Math.min(1, Math.max(0, x)))) as Rgb;
}

/** "r g b" (0–255), the form `rgb(var(--x) / <alpha-value>)` needs. */
const channels = (rgb: Rgb) => rgb.map((x) => Math.round(x * 255)).join(' ');

const varName = (family: PaletteFamily, shade: PaletteShade) => `--palette-${family}-${shade}`;

function tailwindHex(family: PaletteFamily, shade: PaletteShade): string {
  return (tailwindColors as unknown as Record<PaletteFamily, Record<PaletteShade, string>>)[family][shade];
}

/** The variables of one palette: Tailwind's own, or a theme's. */
export function paletteVariables(transform?: PaletteTransform): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const family of PALETTE_FAMILIES) {
    for (const shade of PALETTE_SHADES) {
      const rgb = hexToRgb(tailwindHex(family, shade));
      vars[varName(family, shade)] = channels(transform ? lchToRgb(transform(family, shade, rgbToLch(rgb))) : rgb);
    }
  }
  return vars;
}

/** For tailwind.config.ts `theme.extend.colors`. */
export const paletteColors: Record<PaletteFamily, Record<PaletteShade, string>> = Object.fromEntries(
  PALETTE_FAMILIES.map((family) => [
    family,
    Object.fromEntries(PALETTE_SHADES.map((shade) => [shade, `rgb(var(${varName(family, shade)}) / <alpha-value>)`])),
  ]),
) as Record<PaletteFamily, Record<PaletteShade, string>>;

/** For tailwind.config.ts `plugins`: the variables, classic on :root and one block per theme. */
export const palettePlugin = plugin(({ addBase }) => {
  addBase({ ':root': paletteVariables() });
  for (const [id, transform] of Object.entries(THEME_PALETTES)) {
    addBase({ [`:root[data-panel-theme="${id}"]`]: paletteVariables(transform) });
  }
});
