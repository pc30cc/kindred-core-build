/**
 * Swatches of Vivid's colour schemes, for the scheme picker on Super Admin →
 * Panel theme and the theme card's preview. A scheme is one accent over Art's
 * paper (Art's clay swatches give the paper). The real colours live in
 * theme.css (coral, the default) and palettes.css; these mirror them as CSS
 * colours, and src/test/themes/vividPalettes.test.ts checks they match.
 */
import type { VividPalette } from '../../../shared/panelThemes';

export interface VividPaletteSwatch {
  /** The accent (buttons, the current item, the key figure, series 1). */
  primary: string;
  /** Text on `primary`. */
  primaryInk: string;
  /** The key figure's tinted panel. */
  tint: string;
  /** The strip across the top of a main card: its two stops. */
  strip: [string, string];
  /** Chart series 1-4. */
  series: [string, string, string, string];
}

export const VIVID_PALETTE_SWATCHES: Record<VividPalette, { light: VividPaletteSwatch; dark: VividPaletteSwatch }> = {
  coral: {
    light: { primary: 'hsl(4 70% 46%)', primaryInk: 'hsl(0 0% 100%)', tint: 'hsl(10 75% 96%)', strip: ['hsl(4 70% 46%)', 'hsl(16 82% 58%)'], series: ['hsl(4 58% 54%)', 'hsl(250 41% 28%)', 'hsl(174 72% 34%)', 'hsl(48 70% 38%)'] },
    dark: { primary: 'hsl(6 80% 66%)', primaryInk: 'hsl(4 45% 10%)', tint: 'hsl(6 28% 14%)', strip: ['hsl(6 80% 66%)', 'hsl(18 85% 64%)'], series: ['hsl(6 80% 66%)', 'hsl(246 60% 72%)', 'hsl(187 59% 44%)', 'hsl(39 81% 58%)'] },
  },
  ocean: {
    light: { primary: 'hsl(205 80% 36%)', primaryInk: 'hsl(0 0% 100%)', tint: 'hsl(205 70% 96%)', strip: ['hsl(205 80% 36%)', 'hsl(195 75% 48%)'], series: ['hsl(205 55% 46%)', 'hsl(8 48% 50.5%)', 'hsl(43 70% 41.4%)', 'hsl(262 40% 45%)'] },
    dark: { primary: 'hsl(202 80% 66%)', primaryInk: 'hsl(205 60% 9%)', tint: 'hsl(205 32% 14%)', strip: ['hsl(202 80% 66%)', 'hsl(192 70% 62%)'], series: ['hsl(202 80% 66%)', 'hsl(10 62% 61.6%)', 'hsl(44 61% 58.8%)', 'hsl(300 35% 66%)'] },
  },
  violet: {
    light: { primary: 'hsl(262 52% 50%)', primaryInk: 'hsl(0 0% 100%)', tint: 'hsl(262 70% 97%)', strip: ['hsl(262 52% 50%)', 'hsl(275 60% 62%)'], series: ['hsl(262 42% 58%)', 'hsl(183 63% 38.6%)', 'hsl(40 66% 42.1%)', 'hsl(219 56% 37.7%)'] },
    dark: { primary: 'hsl(262 80% 76%)', primaryInk: 'hsl(262 45% 12%)', tint: 'hsl(262 28% 16%)', strip: ['hsl(262 80% 76%)', 'hsl(275 70% 72%)'], series: ['hsl(262 80% 76%)', 'hsl(172 40% 46.1%)', 'hsl(38 74% 60.9%)', 'hsl(40 30% 80%)'] },
  },
  emerald: {
    light: { primary: 'hsl(160 75% 26%)', primaryInk: 'hsl(0 0% 100%)', tint: 'hsl(152 50% 95.5%)', strip: ['hsl(160 75% 26%)', 'hsl(168 60% 38%)'], series: ['hsl(160 50% 34%)', 'hsl(8 48% 50.5%)', 'hsl(43 70% 41.4%)', 'hsl(226 48% 34%)'] },
    dark: { primary: 'hsl(156 55% 54%)', primaryInk: 'hsl(160 60% 7%)', tint: 'hsl(156 28% 13%)', strip: ['hsl(156 55% 54%)', 'hsl(168 55% 50%)'], series: ['hsl(156 55% 54%)', 'hsl(10 62% 61.6%)', 'hsl(44 61% 58.8%)', 'hsl(226 50% 63.7%)'] },
  },
  amber: {
    light: { primary: 'hsl(28 88% 34%)', primaryInk: 'hsl(0 0% 100%)', tint: 'hsl(38 85% 94.5%)', strip: ['hsl(28 88% 34%)', 'hsl(38 90% 48%)'], series: ['hsl(30 70% 42%)', 'hsl(250 41% 28%)', 'hsl(174 72% 34%)', 'hsl(350 45% 48%)'] },
    dark: { primary: 'hsl(38 90% 60%)', primaryInk: 'hsl(30 60% 8%)', tint: 'hsl(36 32% 13%)', strip: ['hsl(38 90% 60%)', 'hsl(30 90% 64%)'], series: ['hsl(38 90% 60%)', 'hsl(226 47% 61.3%)', 'hsl(180 50% 57.4%)', 'hsl(10 57% 61.6%)'] },
  },
};
