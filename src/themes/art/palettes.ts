/**
 * Swatches of Art's colour schemes, for the scheme picker on Super Admin →
 * Panel theme and the theme card's preview. The real colours live in
 * palettes.css (clay's paper and accent in theme.css); these mirror them as
 * CSS colours, and src/test/themes/artPalettes.test.ts checks they match.
 */
import type { ArtPalette } from '../../../shared/panelThemes';

export interface ArtPaletteSwatch {
  /** The scheme's main colour (buttons, active items, chart series 1). */
  primary: string;
  /** Text on `primary`. */
  primaryInk: string;
  /** Page paper. */
  canvas: string;
  /** Cards and panels. */
  surface: string;
  /** Chart series 1-4, for the preview. */
  series: [string, string, string, string];
}

export const ART_PALETTE_SWATCHES: Record<ArtPalette, { light: ArtPaletteSwatch; dark: ArtPaletteSwatch }> = {
  clay: {
    light: { primary: 'hsl(17 57% 41%)', primaryInk: 'hsl(40 50% 98.4%)', canvas: 'hsl(40 50% 97.5%)', surface: 'hsl(40 69% 99.1%)', series: ['hsl(17 57% 41%)', 'hsl(179 100% 26.2%)', 'hsl(44 69% 40.5%)', 'hsl(225 41% 41.3%)'] },
    dark: { primary: 'hsl(19 69% 60.9%)', primaryInk: 'hsl(15 33% 8.9%)', canvas: 'hsl(221 23% 8%)', surface: 'hsl(221 19% 12.4%)', series: ['hsl(19 69% 60.9%)', 'hsl(182 46% 52.3%)', 'hsl(45 66% 56.8%)', 'hsl(226 60% 69.1%)'] },
  },
  sage: {
    light: { primary: 'hsl(150 22% 34%)', primaryInk: 'hsl(75 30% 98.4%)', canvas: 'hsl(75 30% 97.5%)', surface: 'hsl(75 41% 99.1%)', series: ['hsl(150 22% 34%)', 'hsl(292 31% 33.5%)', 'hsl(40 66% 43.1%)', 'hsl(210 43% 48.2%)'] },
    dark: { primary: 'hsl(145 27% 63%)', primaryInk: 'hsl(145 28% 7.6%)', canvas: 'hsl(179 28% 6.3%)', surface: 'hsl(179 22% 10.3%)', series: ['hsl(145 27% 63%)', 'hsl(318 24% 59.9%)', 'hsl(40 68% 61%)', 'hsl(205 51% 60.9%)'] },
  },
  indigo: {
    light: { primary: 'hsl(230 47% 42%)', primaryInk: 'hsl(224 59% 99%)', canvas: 'hsl(224 59% 98.4%)', surface: 'hsl(224 100% 99.5%)', series: ['hsl(230 47% 42%)', 'hsl(34 70% 44.7%)', 'hsl(179 100% 26.3%)', 'hsl(342 47% 54.2%)'] },
    dark: { primary: 'hsl(228 70% 74%)', primaryInk: 'hsl(227 25% 9.8%)', canvas: 'hsl(223 27% 8.2%)', surface: 'hsl(223 22% 12.7%)', series: ['hsl(228 70% 74%)', 'hsl(33 78% 64.7%)', 'hsl(181 51% 57.7%)', 'hsl(337 50% 67.3%)'] },
  },
  plum: {
    light: { primary: 'hsl(314 35% 34%)', primaryInk: 'hsl(330 44% 98.9%)', canvas: 'hsl(330 44% 98.3%)', surface: 'hsl(330 74% 99.5%)', series: ['hsl(314 35% 34%)', 'hsl(183 63% 38.6%)', 'hsl(40 66% 42.1%)', 'hsl(219 56% 37.7%)'] },
    dark: { primary: 'hsl(318 42% 70%)', primaryInk: 'hsl(319 21% 9.2%)', canvas: 'hsl(266 16% 8%)', surface: 'hsl(266 13% 12.5%)', series: ['hsl(318 42% 70%)', 'hsl(172 40% 46.1%)', 'hsl(38 74% 60.9%)', 'hsl(227 62% 70.3%)'] },
  },
  ocean: {
    light: { primary: 'hsl(186 72% 25%)', primaryInk: 'hsl(186 44% 98.5%)', canvas: 'hsl(186 44% 97.6%)', surface: 'hsl(186 61% 99.1%)', series: ['hsl(186 72% 25%)', 'hsl(8 48% 50.5%)', 'hsl(43 70% 41.4%)', 'hsl(226 48% 34%)'] },
    dark: { primary: 'hsl(184 45% 56%)', primaryInk: 'hsl(184 43% 7.1%)', canvas: 'hsl(202 38% 7.2%)', surface: 'hsl(202 31% 11.3%)', series: ['hsl(184 45% 56%)', 'hsl(10 62% 61.6%)', 'hsl(44 61% 58.8%)', 'hsl(226 50% 63.7%)'] },
  },
  saffron: {
    light: { primary: 'hsl(39 92% 29%)', primaryInk: 'hsl(45 56% 98.2%)', canvas: 'hsl(45 56% 97.2%)', surface: 'hsl(45 74% 99%)', series: ['hsl(39 92% 29%)', 'hsl(225 43% 42.2%)', 'hsl(178 70% 30.2%)', 'hsl(20 65% 54.3%)'] },
    dark: { primary: 'hsl(40 76% 61%)', primaryInk: 'hsl(39 40% 7.4%)', canvas: 'hsl(218 24% 7.9%)', surface: 'hsl(218 20% 12.3%)', series: ['hsl(40 76% 61%)', 'hsl(226 47% 61.3%)', 'hsl(180 50% 57.4%)', 'hsl(10 57% 61.6%)'] },
  },
  graphite: {
    light: { primary: 'hsl(28 8% 21%)', primaryInk: 'hsl(34 22% 98.6%)', canvas: 'hsl(34 22% 97.9%)', surface: 'hsl(34 32% 99.3%)', series: ['hsl(28 8% 21%)', 'hsl(205 40% 52%)', 'hsl(40 55% 42%)', 'hsl(13 50% 45%)'] },
    dark: { primary: 'hsl(34 14% 81%)', primaryInk: 'hsl(35 40% 7.7%)', canvas: 'hsl(31 9% 7.2%)', surface: 'hsl(31 7% 11.4%)', series: ['hsl(34 14% 81%)', 'hsl(205 43% 58%)', 'hsl(38 58% 58%)', 'hsl(13 50% 62%)'] },
  },
  // International mode only (shared/panelThemes.ts, INTERNATIONAL_ART_PALETTES).
  respok: {
    light: { primary: 'hsl(9 78% 44%)', primaryInk: 'hsl(0 0% 100%)', canvas: 'hsl(240 18% 96.7%)', surface: 'hsl(0 0% 100%)', series: ['hsl(9 78% 44%)', 'hsl(250 41% 28%)', 'hsl(174 72% 34%)', 'hsl(50 68% 37%)'] },
    dark: { primary: 'hsl(9 100% 61.8%)', primaryInk: 'hsl(245 37% 12.4%)', canvas: 'hsl(246 38% 7.6%)', surface: 'hsl(245 37% 12.4%)', series: ['hsl(9 100% 61.8%)', 'hsl(246 60% 72%)', 'hsl(187 59% 44%)', 'hsl(39 81% 58%)'] },
  },
};
