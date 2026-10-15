/**
 * Swatches of Vivid's colour schemes, for the scheme picker on Super Admin →
 * Panel theme and the theme card's preview. The real colours live in
 * theme.css (coral, the default) and palettes.css; these mirror them as CSS
 * colours, and src/test/themes/vividPalettes.test.ts checks they match.
 */
import type { VividPalette } from '../../../shared/panelThemes';

export interface VividPaletteSwatch {
  /** The scheme's main colour (buttons, figures, the current item, series 1). */
  primary: string;
  /** Text on `primary`. */
  primaryInk: string;
  /** The canvas behind the cards. */
  canvas: string;
  sidebar: string;
  /** The hero and figure panels' tint. */
  tint: string;
  /** The strip across the top of every card: its two stops. */
  strip: [string, string];
  /** Chart series 1-4. */
  series: [string, string, string, string];
}

export const VIVID_PALETTE_SWATCHES: Record<VividPalette, { light: VividPaletteSwatch; dark: VividPaletteSwatch }> = {
  coral: {
    light: { primary: 'hsl(4 70% 46%)', primaryInk: 'hsl(0 0% 100%)', canvas: 'hsl(20 45% 97.6%)', sidebar: 'hsl(10 60% 98.2%)', tint: 'hsl(8 85% 96.5%)', strip: ['hsl(4 86% 60%)', 'hsl(26 95% 56%)'], series: ['hsl(4 70% 46%)', 'hsl(26 90% 42%)', 'hsl(199 80% 38%)', 'hsl(262 50% 52%)'] },
    dark: { primary: 'hsl(6 88% 67%)', primaryInk: 'hsl(4 45% 10%)', canvas: 'hsl(225 16% 7.5%)', sidebar: 'hsl(225 16% 9%)', tint: 'hsl(6 32% 15%)', strip: ['hsl(6 90% 64%)', 'hsl(28 95% 60%)'], series: ['hsl(6 88% 67%)', 'hsl(30 92% 60%)', 'hsl(195 75% 58%)', 'hsl(262 70% 74%)'] },
  },
  ocean: {
    light: { primary: 'hsl(205 88% 34%)', primaryInk: 'hsl(0 0% 100%)', canvas: 'hsl(204 40% 97.6%)', sidebar: 'hsl(204 55% 98.2%)', tint: 'hsl(204 85% 96.3%)', strip: ['hsl(205 90% 48%)', 'hsl(178 72% 42%)'], series: ['hsl(205 88% 34%)', 'hsl(178 75% 30%)', 'hsl(14 75% 50%)', 'hsl(262 50% 52%)'] },
    dark: { primary: 'hsl(200 90% 64%)', primaryInk: 'hsl(205 60% 9%)', canvas: 'hsl(215 22% 7.5%)', sidebar: 'hsl(215 22% 9%)', tint: 'hsl(204 40% 15%)', strip: ['hsl(200 92% 60%)', 'hsl(174 70% 50%)'], series: ['hsl(200 90% 64%)', 'hsl(172 60% 52%)', 'hsl(16 85% 66%)', 'hsl(262 70% 74%)'] },
  },
  violet: {
    light: { primary: 'hsl(262 58% 50%)', primaryInk: 'hsl(0 0% 100%)', canvas: 'hsl(262 35% 97.8%)', sidebar: 'hsl(262 50% 98.4%)', tint: 'hsl(262 85% 97%)', strip: ['hsl(262 80% 62%)', 'hsl(312 70% 60%)'], series: ['hsl(262 58% 50%)', 'hsl(322 62% 46%)', 'hsl(199 80% 36%)', 'hsl(30 85% 40%)'] },
    dark: { primary: 'hsl(262 85% 76%)', primaryInk: 'hsl(262 45% 12%)', canvas: 'hsl(250 18% 7.5%)', sidebar: 'hsl(250 18% 9%)', tint: 'hsl(262 30% 17%)', strip: ['hsl(262 85% 70%)', 'hsl(314 75% 68%)'], series: ['hsl(262 85% 76%)', 'hsl(320 75% 70%)', 'hsl(195 75% 58%)', 'hsl(34 90% 60%)'] },
  },
  emerald: {
    light: { primary: 'hsl(160 84% 25%)', primaryInk: 'hsl(0 0% 100%)', canvas: 'hsl(150 30% 97.5%)', sidebar: 'hsl(150 45% 98.2%)', tint: 'hsl(152 60% 95.5%)', strip: ['hsl(152 68% 40%)', 'hsl(178 72% 38%)'], series: ['hsl(160 84% 25%)', 'hsl(199 80% 36%)', 'hsl(30 85% 40%)', 'hsl(262 50% 52%)'] },
    dark: { primary: 'hsl(156 60% 52%)', primaryInk: 'hsl(160 60% 7%)', canvas: 'hsl(190 18% 7.5%)', sidebar: 'hsl(190 18% 9%)', tint: 'hsl(156 30% 14%)', strip: ['hsl(152 60% 48%)', 'hsl(176 65% 46%)'], series: ['hsl(156 60% 52%)', 'hsl(195 75% 58%)', 'hsl(30 92% 60%)', 'hsl(262 70% 74%)'] },
  },
  amber: {
    light: { primary: 'hsl(28 92% 34%)', primaryInk: 'hsl(0 0% 100%)', canvas: 'hsl(40 50% 97.4%)', sidebar: 'hsl(40 70% 98%)', tint: 'hsl(40 95% 95%)', strip: ['hsl(40 96% 52%)', 'hsl(18 92% 56%)'], series: ['hsl(28 92% 34%)', 'hsl(350 60% 46%)', 'hsl(199 80% 34%)', 'hsl(160 84% 25%)'] },
    dark: { primary: 'hsl(38 95% 60%)', primaryInk: 'hsl(30 60% 8%)', canvas: 'hsl(30 14% 7.5%)', sidebar: 'hsl(30 14% 9%)', tint: 'hsl(36 35% 14%)', strip: ['hsl(42 96% 56%)', 'hsl(20 92% 60%)'], series: ['hsl(38 95% 60%)', 'hsl(350 75% 70%)', 'hsl(195 75% 58%)', 'hsl(156 60% 52%)'] },
  },
};
