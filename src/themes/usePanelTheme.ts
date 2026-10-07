/**
 * The workspace panel's theme ("قالب").
 *
 * The Super Admin picks one for the whole platform (Super Admin → Panel theme);
 * every member reads it from the public config
 * (`branding.workspace_panel_theme`). The last value seen is kept in
 * localStorage so the panel's first paint already wears it.
 *
 * A Super Admin can also preview a theme before activating it: the preview
 * lives in this tab's sessionStorage only and is never sent anywhere.
 *
 * AppLayout applies the result as `<html data-panel-theme="...">` while the
 * panel is open and removes it on leaving, so the Super Admin panel, sign-in
 * and help center keep their own look. Portalled dialogs, menus and toasts
 * sit under <html> too, so they follow the theme.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { usePlatformPublicConfig } from '@/lib/platformPublicConfig';
import { isPanelThemeId, resolvePanelTheme, type PanelThemeId } from '../../shared/panelThemes';

const CACHE_KEY = 'wy-panel-theme';
const PREVIEW_KEY = 'wy-panel-theme-preview';

function readStorage(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    /* storage unavailable: the theme still applies, it just isn't remembered */
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

/** The theme this browser last saw for the platform. */
export function cachedPanelTheme(): PanelThemeId {
  return resolvePanelTheme(readStorage(local, CACHE_KEY));
}

function readPreview(): PanelThemeId | null {
  const value = readStorage(session, PREVIEW_KEY);
  return isPanelThemeId(value) ? value : null;
}

/** Wear `theme` in this tab's workspace panel until the preview is ended. */
export function startPanelThemePreview(theme: PanelThemeId) {
  writeStorage(session, PREVIEW_KEY, theme);
}

export function usePanelTheme() {
  const { data } = usePlatformPublicConfig();
  const platformTheme = data ? resolvePanelTheme(data.branding?.workspace_panel_theme) : cachedPanelTheme();
  const [preview, setPreview] = useState<PanelThemeId | null>(readPreview);

  useEffect(() => {
    if (data) writeStorage(local, CACHE_KEY, platformTheme);
  }, [data, platformTheme]);

  const endPreview = useCallback(() => {
    writeStorage(session, PREVIEW_KEY, null);
    setPreview(null);
  }, []);

  return {
    /** What the panel wears now. */
    theme: preview ?? platformTheme,
    /** What the Super Admin activated for everyone. */
    platformTheme,
    /** A theme this tab is previewing, if any. */
    preview,
    endPreview,
  };
}

/** Puts `theme` on <html> while the calling component is mounted. */
export function useApplyPanelTheme(theme: PanelThemeId) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.panelTheme = theme;
    return () => {
      delete root.dataset.panelTheme;
    };
  }, [theme]);
}
