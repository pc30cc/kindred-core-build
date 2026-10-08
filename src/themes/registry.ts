/**
 * The workspace panel themes as the Super Admin sees them (Super Admin →
 * Panel theme): the colours each theme's preview card is drawn with. Names
 * and descriptions are translated under `admin.panelThemes.themes.<id>`;
 * Art's layouts and colour schemes under `admin.panelThemes.layouts.<id>`
 * and `admin.panelThemes.palettes.<id>` (their colours: art/palettes.ts).
 *
 * A new theme: its id in shared/panelThemes.ts, its stylesheet in
 * src/themes/<id>/theme.css (imported in src/main.tsx), optionally a palette
 * in src/themes/palette.ts, its entry here and its texts in the locales.
 */
import type { TranslationKey } from '@/i18n';
import { ART_PALETTE_SWATCHES } from './art/palettes';
import {
  PANEL_THEME_IDS,
  type ArtLayout,
  type ArtPalette,
  type PanelThemeId,
  type PanelThemeSelection,
} from '../../shared/panelThemes';

/** The colours a preview card paints, as CSS colours. */
export interface PanelThemeSwatches {
  /** Behind everything (in an inset layout: around the content panel). */
  canvas: string;
  sidebar: string;
  /** The page itself. */
  surface: string;
  card: string;
  ink: string;
  muted: string;
  line: string;
  primary: string;
  primaryInk: string;
  /** Chart and accent colours, in order. */
  accents: [string, string, string, string];
  /** The brand mark. */
  mark: string;
}

export interface PanelThemeInfo {
  id: PanelThemeId;
  /** How the panel is framed: a sidebar rail, or a top bar with navigation pills. */
  layout: 'sidebar' | 'topnav';
  light: PanelThemeSwatches;
  dark: PanelThemeSwatches;
}

const PANEL_THEMES: Record<PanelThemeId, PanelThemeInfo> = {
  classic: {
    id: 'classic',
    layout: 'sidebar',
    light: {
      canvas: 'hsl(45 33% 98%)',
      sidebar: 'hsl(45 30% 99%)',
      surface: 'hsl(45 33% 98%)',
      card: 'hsl(0 0% 100%)',
      ink: 'hsl(232 35% 14%)',
      muted: 'hsl(232 12% 42%)',
      line: 'hsl(232 20% 90%)',
      primary: 'hsl(178 84% 30%)',
      primaryInk: 'hsl(180 40% 99%)',
      accents: ['hsl(178 84% 34%)', 'hsl(214 80% 52%)', 'hsl(266 72% 58%)', 'hsl(14 85% 60%)'],
      mark: 'linear-gradient(120deg, hsl(178 84% 34%), hsl(214 80% 52%) 45%, hsl(266 72% 58%) 80%, hsl(14 85% 60%))',
    },
    dark: {
      canvas: 'hsl(232 32% 8%)',
      sidebar: 'hsl(232 32% 9%)',
      surface: 'hsl(232 32% 8%)',
      card: 'hsl(232 26% 12%)',
      ink: 'hsl(230 20% 96%)',
      muted: 'hsl(230 15% 70%)',
      line: 'hsl(232 20% 20%)',
      primary: 'hsl(170 65% 52%)',
      primaryInk: 'hsl(200 50% 8%)',
      accents: ['hsl(170 65% 56%)', 'hsl(210 85% 62%)', 'hsl(272 80% 68%)', 'hsl(18 90% 66%)'],
      mark: 'linear-gradient(120deg, hsl(170 65% 56%), hsl(210 85% 62%) 45%, hsl(272 80% 68%))',
    },
  },
  art: {
    id: 'art',
    layout: 'topnav',
    light: {
      canvas: 'hsl(37 42% 95.4%)',
      sidebar: 'hsl(37 42% 95.4%)',
      surface: 'hsl(40 50% 97.5%)',
      card: 'hsl(40 69% 99.1%)',
      ink: 'hsl(221 26% 10.5%)',
      muted: 'hsl(31 8% 38.3%)',
      line: 'hsl(34 20% 87%)',
      primary: 'hsl(17 57% 41%)',
      primaryInk: 'hsl(40 50% 98.4%)',
      accents: ['hsl(16 63% 46.5%)', 'hsl(175 100% 26.8%)', 'hsl(39 94% 40%)', 'hsl(338 49% 54.9%)'],
      mark: 'linear-gradient(135deg, hsl(17 57% 46%), hsl(338 49% 55%))',
    },
    dark: {
      canvas: 'hsl(221 29% 5.8%)',
      sidebar: 'hsl(221 29% 5.8%)',
      surface: 'hsl(221 23% 8%)',
      card: 'hsl(221 19% 11.7%)',
      ink: 'hsl(40 23% 92.8%)',
      muted: 'hsl(37 7% 63.7%)',
      line: 'hsl(221 13% 17.5%)',
      primary: 'hsl(19 69% 60.9%)',
      primaryInk: 'hsl(15 33% 8.9%)',
      accents: ['hsl(16 69% 56.9%)', 'hsl(175 80% 35.2%)', 'hsl(38 69% 45.3%)', 'hsl(340 57% 63.2%)'],
      mark: 'linear-gradient(135deg, hsl(19 69% 58%), hsl(340 57% 63%))',
    },
  },
};

/** Every theme, in the order the admin page lists them. */
export const panelThemes: PanelThemeInfo[] = PANEL_THEME_IDS.map((id) => PANEL_THEMES[id]);

/**
 * A theme and its options in words, for the preview bar and the Super Admin
 * page: "Art · Side menu · Sage".
 */
export function panelThemeLabel(t: (key: TranslationKey) => string, selection: PanelThemeSelection) {
  const parts = [t(`admin.panelThemes.themes.${selection.theme}.name` as TranslationKey)];
  if (selection.theme === 'art') {
    parts.push(
      t(`admin.panelThemes.layouts.${selection.options.layout}.name` as TranslationKey),
      t(`admin.panelThemes.palettes.${selection.options.palette}` as TranslationKey),
    );
  }
  return parts.join(' · ');
}

const mix = (color: string, percent: number, base: string) => `color-mix(in srgb, ${color} ${percent}%, ${base})`;

/** Art's options as the preview draws them (the Super Admin page's draft). */
export interface ArtPreviewOptions {
  layout: ArtLayout;
  palette: ArtPalette;
}

/**
 * A theme's preview colours, with Art's colour scheme laid over its base:
 * the scheme's main colour, papers and chart series (art/palettes.ts). A
 * scheme without swatches yet keeps the base colours.
 */
export function previewSwatches(theme: PanelThemeInfo, mode: 'light' | 'dark', palette?: ArtPalette): PanelThemeSwatches {
  const base = theme[mode];
  const swatch = theme.id === 'art' && palette ? ART_PALETTE_SWATCHES[palette]?.[mode] : null;
  if (!swatch) return base;
  return {
    ...base,
    canvas: swatch.canvas,
    sidebar: mix(base.ink, mode === 'dark' ? 6 : 4, swatch.canvas),
    surface: swatch.canvas,
    card: swatch.surface,
    primary: swatch.primary,
    primaryInk: swatch.primaryInk,
    accents: swatch.series,
    mark: `linear-gradient(135deg, ${swatch.primary}, ${mix(swatch.series[1], 55, swatch.primary)})`,
  };
}
