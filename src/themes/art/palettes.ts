/**
 * Swatches of Art's colour schemes, for the scheme picker on Super Admin →
 * Panel theme and the theme card's preview. The real colours live in
 * palettes.css; these mirror them as CSS colours.
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
    light: { primary: 'hsl(17 57% 41%)', primaryInk: 'hsl(40 33% 98%)', canvas: 'hsl(40 30% 97%)', surface: 'hsl(40 33% 99%)', series: ['hsl(17 57% 41%)', 'hsl(36 45% 52%)', 'hsl(160 22% 38%)', 'hsl(220 18% 46%)'] },
    dark: { primary: 'hsl(19 69% 60.9%)', primaryInk: 'hsl(222 18% 9%)', canvas: 'hsl(222 16% 9%)', surface: 'hsl(222 14% 12%)', series: ['hsl(19 69% 61%)', 'hsl(38 55% 62%)', 'hsl(160 28% 55%)', 'hsl(220 25% 66%)'] },
  },
  sage: { light: null!, dark: null! },
  indigo: { light: null!, dark: null! },
  plum: { light: null!, dark: null! },
  ocean: { light: null!, dark: null! },
  saffron: { light: null!, dark: null! },
  graphite: { light: null!, dark: null! },
};
