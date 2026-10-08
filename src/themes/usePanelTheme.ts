/**
 * The workspace panel's theme ("قالب") and its options.
 *
 * The Super Admin picks one for the whole platform (Super Admin → Panel theme),
 * with the theme's options (Art: its layout, top menu or side menu, and its
 * colour scheme); every member reads them from the public config
 * (`branding.workspace_panel_theme` / `workspace_panel_theme_options`). The
 * last values seen are kept in localStorage so the panel's first paint (and
 * its loading skeleton) already wears them.
 *
 * A Super Admin can also preview a theme and options before activating them:
 * the preview lives in this tab's sessionStorage only and is never sent
 * anywhere. Every caller reads the same value (a small store below), so ending
 * it anywhere ends it everywhere; it is honoured only for platform admins, so
 * whoever signs in next on the tab never sees it.
 *
 * AppLayout applies the result as `<html data-panel-theme="...">` (plus
 * `data-panel-layout` / `data-panel-palette` for Art) while the panel is open
 * and removes them on leaving, so the Super Admin panel, sign-in and help
 * center keep their own look. Portalled dialogs, menus and toasts sit under
 * <html> too, so they follow the theme.
 *
 * A colour scheme for international mode only (Art's `respok`) is worn only
 * in international mode (src/lib/internationalMode.ts): in Persian, or on a
 * single-language site, the panel, its preview and its preview bar wear the
 * default scheme instead, whatever is stored or previewed.
 */
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { usePlatformPublicConfig } from '@/lib/platformPublicConfig';
import { useInternationalMode } from '@/lib/internationalMode';
import {
  PANEL_THEME_OPTION_KEYS,
  artPaletteFor,
  isPanelThemeId,
  resolvePanelTheme,
  resolvePanelThemeOptions,
  resolvePanelThemeSelection,
  type PanelThemeId,
  type PanelThemeSelection,
} from '../../shared/panelThemes';

const CACHE_KEY = 'wy-panel-theme';
const OPTIONS_CACHE_KEY = 'wy-panel-theme-options';
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

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

/** The theme this browser last saw for the platform. */
export function cachedPanelTheme(): PanelThemeId {
  return resolvePanelTheme(readStorage(local, CACHE_KEY));
}

/** The theme and options this browser last saw for the platform. */
export function cachedPanelThemeSelection(): PanelThemeSelection {
  const theme = cachedPanelTheme();
  return resolvePanelThemeSelection(theme, { [theme]: parseJson(readStorage(local, OPTIONS_CACHE_KEY)) });
}

// ── The preview store ──────────────────────────────────────────────────
// sessionStorage holds `{"theme":"art","options":{...}}` (a bare theme id
// from before options is still read). The snapshot is the raw string, so it
// stays the same value between reads (useSyncExternalStore's rule).

function readPreviewRaw(): string | null {
  return readStorage(session, PREVIEW_KEY);
}

function parsePreview(raw: string | null): { theme: PanelThemeId; options: Record<string, unknown> } | null {
  if (!raw) return null;
  if (isPanelThemeId(raw)) return { theme: raw, options: {} };
  const value = asObject(parseJson(raw));
  return isPanelThemeId(value.theme) ? { theme: value.theme, options: asObject(value.options) } : null;
}

const previewListeners = new Set<() => void>();

function subscribePreview(listener: () => void) {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

function setPreview(value: string | null) {
  writeStorage(session, PREVIEW_KEY, value);
  for (const listener of previewListeners) listener();
}

/**
 * Wear `theme` (with `options`, else the platform's own for it) in this
 * tab's workspace panel until the preview is ended.
 */
export function startPanelThemePreview(theme: PanelThemeId, options?: Record<string, string>) {
  setPreview(JSON.stringify({ theme, options: options ?? {} }));
}

export function endPanelThemePreview() {
  setPreview(null);
}

function sameOptions(a: object, b: object) {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((key) => x[key] === y[key]);
}

/** `selection` as it may be worn: an international-only scheme outside international mode is the default. */
export function wearablePanelTheme<S extends PanelThemeSelection>(selection: S, international: boolean): S {
  if (selection.theme !== 'art') return selection;
  const palette = artPaletteFor(selection.options.palette, international);
  return palette === selection.options.palette ? selection : { ...selection, options: { ...selection.options, palette } };
}

type PanelThemeState = PanelThemeSelection & {
  /** What the Super Admin activated for everyone. */
  platformTheme: PanelThemeId;
  /** The options of `platformTheme`, resolved. */
  platformOptions: PanelThemeSelection['options'];
  /** A theme and options this tab is previewing, if any. */
  preview: PanelThemeSelection | null;
  endPreview: () => void;
};

export function usePanelTheme(): PanelThemeState {
  const { data } = usePlatformPublicConfig();
  const { data: isAdmin } = useIsGlobalAdmin();
  const international = useInternationalMode();

  // The platform's choice: the public config once it has arrived, the cache
  // before. Kept as JSON strings so the objects stay the same between renders.
  const storedOptionsKey = JSON.stringify(data ? asObject(data.branding?.workspace_panel_theme_options) : {});
  const platformKey = JSON.stringify(
    data
      ? resolvePanelThemeSelection(resolvePanelTheme(data.branding?.workspace_panel_theme), JSON.parse(storedOptionsKey))
      : cachedPanelThemeSelection(),
  );
  const platform = useMemo(() => JSON.parse(platformKey) as PanelThemeSelection, [platformKey]);

  // The preview: its options laid over the platform's own for that theme.
  const storedPreview = useSyncExternalStore(subscribePreview, readPreviewRaw, () => null);
  const preview = useMemo(() => {
    const stored = isAdmin ? parsePreview(storedPreview) : null;
    if (!stored) return null;
    const base =
      stored.theme === platform.theme ? platform.options : asObject(asObject(JSON.parse(storedOptionsKey))[stored.theme]);
    const selection = resolvePanelThemeSelection(stored.theme, { [stored.theme]: { ...base, ...stored.options } });
    // Previewing exactly what everyone already has is no preview.
    if (selection.theme === platform.theme && sameOptions(selection.options, platform.options)) return null;
    return selection;
  }, [isAdmin, storedPreview, platform, storedOptionsKey]);

  useEffect(() => {
    if (!data) return;
    writeStorage(local, CACHE_KEY, platform.theme);
    writeStorage(local, OPTIONS_CACHE_KEY, JSON.stringify(platform.options));
  }, [data, platform]);

  // What is remembered above is what is stored; what is worn may differ.
  const worn = wearablePanelTheme(platform, international);
  const wornPreview = preview && wearablePanelTheme(preview, international);
  const current = wornPreview ?? worn;
  return {
    ...current,
    platformTheme: worn.theme,
    platformOptions: worn.options,
    preview: wornPreview,
    endPreview: endPanelThemePreview,
  } as PanelThemeState;
}

/** `<html>` dataset name of an option: `layout` → `panelLayout` (data-panel-layout). */
const datasetName = (key: string) => `panel${key.charAt(0).toUpperCase()}${key.slice(1)}`;

/**
 * Puts `theme` on <html> while the calling component is mounted, with its
 * options (`data-panel-layout`, `data-panel-palette`, ...; resolved, so a
 * missing one is its default). A theme without options carries none.
 */
export function useApplyPanelTheme(theme: PanelThemeId, options?: object) {
  const key = JSON.stringify(resolvePanelThemeOptions(theme, { [theme]: options ?? {} }));
  useLayoutEffect(() => {
    const root = document.documentElement;
    const values = JSON.parse(key) as Record<string, string>;
    root.dataset.panelTheme = theme;
    for (const option of PANEL_THEME_OPTION_KEYS) {
      if (option in values) root.dataset[datasetName(option)] = values[option];
      else delete root.dataset[datasetName(option)];
    }
    return () => {
      delete root.dataset.panelTheme;
      for (const option of PANEL_THEME_OPTION_KEYS) delete root.dataset[datasetName(option)];
    };
  }, [theme, key]);
}
