/**
 * Art's palette: every Tailwind hue the pages use, repainted in the warm,
 * muted tones of the Lart design (ivory paper, ink, clay). Lightness is kept,
 * so contrast and the role of each shade stay as the page intended; chroma is
 * lowered (pigment rather than neon) and a few hues lean towards Lart's
 * colours. The cool grays become a warm stone gray, like Lart's paper.
 * Used at build time by src/themes/palette.ts.
 */
import type { Lch, PaletteFamily, PaletteTransform } from '../palette';

const COOL_GRAYS = new Set<PaletteFamily>(['slate', 'gray', 'zinc', 'neutral']);

// [chroma factor, hue] per family: each family's strongest shade lands near
// Lart's own pigments (chroma about 0.12-0.15); status hues (red, green,
// amber) keep a little more so they still read as status.
const PIGMENT: Partial<Record<PaletteFamily, [number, number?]>> = {
  red: [0.78],
  orange: [0.72, 42],
  amber: [0.74, 68],
  yellow: [0.7],
  lime: [0.62, 128],
  green: [0.66, 152],
  emerald: [0.68, 160],
  teal: [0.8],
  cyan: [0.72, 205],
  sky: [0.66, 232],
  blue: [0.6, 256],
  indigo: [0.56, 272],
  violet: [0.52, 302],
  purple: [0.5, 316],
  fuchsia: [0.5, 340],
  pink: [0.62, 355],
  rose: [0.68, 12],
};

export const artPalette: PaletteTransform = (family, _shade, color): Lch => {
  if (COOL_GRAYS.has(family)) return { l: color.l, c: Math.min(color.c * 0.35, 0.016), h: 70 };
  const pigment = PIGMENT[family];
  if (!pigment) return color;
  const [chroma, hue] = pigment;
  return { l: color.l, c: color.c * chroma, h: hue ?? color.h };
};
