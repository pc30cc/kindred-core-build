/**
 * The sign-in pages in the colours of an international-only Art scheme
 * (`respok`): only while the platform wears Art in that scheme and the page
 * is in international mode (src/lib/internationalMode.ts). Then AuthLayout
 * puts `<html data-auth-palette="<scheme>">` while it is mounted, and
 * src/themes/authPalette.css repaints the pages' tokens. In Persian, on a
 * single-language site, or under any other theme or scheme, nothing is set
 * and the sign-in pages look exactly as before.
 *
 * The platform's choice is read like the panel reads it (the public config,
 * the cache before it arrives); a Super Admin's preview never reaches these
 * pages.
 */
import { useLayoutEffect } from 'react';
import { usePlatformPublicConfig } from '@/lib/platformPublicConfig';
import { useInternationalMode } from '@/lib/internationalMode';
import { cachedPanelThemeSelection } from './usePanelTheme';
import {
  INTERNATIONAL_ART_PALETTES,
  resolvePanelTheme,
  resolvePanelThemeSelection,
  type ArtPalette,
  type PanelThemeSelection,
} from '../../shared/panelThemes';

/** The scheme the sign-in pages wear, or null for their own colours. */
export function authPaletteFor(selection: PanelThemeSelection, international: boolean): ArtPalette | null {
  if (!international || selection.theme !== 'art') return null;
  return INTERNATIONAL_ART_PALETTES.includes(selection.options.palette) ? selection.options.palette : null;
}

export function useAuthPalette(): ArtPalette | null {
  const { data } = usePlatformPublicConfig();
  const international = useInternationalMode();
  const selection = data
    ? resolvePanelThemeSelection(resolvePanelTheme(data.branding?.workspace_panel_theme), data.branding?.workspace_panel_theme_options)
    : cachedPanelThemeSelection();
  return authPaletteFor(selection, international);
}

/** Puts the sign-in pages' scheme on <html> while the calling component is mounted. */
export function useApplyAuthPalette() {
  const palette = useAuthPalette();
  useLayoutEffect(() => {
    if (!palette) return;
    const root = document.documentElement;
    root.dataset.authPalette = palette;
    return () => {
      delete root.dataset.authPalette;
    };
  }, [palette]);
}
