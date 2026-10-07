/**
 * The workspace panel's theme ("قالب").
 *
 * The Super Admin picks one for the whole platform (Super Admin → Panel theme);
 * every member reads it from the public config
 * (`branding.workspace_panel_theme`). The last value seen is kept in
 * localStorage so the panel's first paint already wears it.
 *
 * A Super Admin can also preview a theme before activating it: the preview
 * lives in this tab's sessionStorage only and is never sent anywhere. Every
 * caller reads the same value (a small store below), so ending it anywhere
 * ends it everywhere; it is honoured only for platform admins, so whoever
 * signs in next on the tab never sees it.
 *
 * AppLayout applies the result as `<html data-panel-theme="...">` while the
 * panel is open and removes it on leaving, so the Super Admin panel, sign-in
 * and help center keep their own look. Portalled dialogs, menus and toasts
 * sit under <html> too, so they follow the theme.
 */
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
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

const previewListeners = new Set<() => void>();

function subscribePreview(listener: () => void) {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

function setPreview(theme: PanelThemeId | null) {
  writeStorage(session, PREVIEW_KEY, theme);
  for (const listener of previewListeners) listener();
}

/** Wear `theme` in this tab's workspace panel until the preview is ended. */
export function startPanelThemePreview(theme: PanelThemeId) {
  setPreview(theme);
}

export function endPanelThemePreview() {
  setPreview(null);
}

export function usePanelTheme() {
  const { data } = usePlatformPublicConfig();
  const { data: isAdmin } = useIsGlobalAdmin();
  const platformTheme = data ? resolvePanelTheme(data.branding?.workspace_panel_theme) : cachedPanelTheme();
  const stored = useSyncExternalStore(subscribePreview, readPreview, () => null);
  // Previewing the theme everyone already has is no preview.
  const preview = isAdmin && stored && stored !== platformTheme ? stored : null;

  useEffect(() => {
    if (data) writeStorage(local, CACHE_KEY, platformTheme);
  }, [data, platformTheme]);

  return {
    /** What the panel wears now. */
    theme: preview ?? platformTheme,
    /** What the Super Admin activated for everyone. */
    platformTheme,
    /** A theme this tab is previewing, if any. */
    preview,
    endPreview: endPanelThemePreview,
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
