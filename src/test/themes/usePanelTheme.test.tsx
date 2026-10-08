/**
 * src/themes/usePanelTheme.ts: which theme (and which of its options: Art's
 * layout and colour scheme) the workspace panel wears, and that they are on
 * <html> only while the panel is mounted.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ data: undefined as unknown, admin: true }));

vi.mock('@/lib/platformPublicConfig', () => ({
  usePlatformPublicConfig: () => ({ data: config.data }),
}));

vi.mock('@/hooks/useAdmin', () => ({
  useIsGlobalAdmin: () => ({ data: config.admin }),
}));

import {
  cachedPanelTheme,
  cachedPanelThemeSelection,
  endPanelThemePreview,
  startPanelThemePreview,
  useApplyPanelTheme,
  usePanelTheme,
} from '@/themes/usePanelTheme';

beforeEach(() => {
  config.data = undefined;
  config.admin = true;
  localStorage.clear();
  act(() => endPanelThemePreview());
});

afterEach(() => {
  delete document.documentElement.dataset.panelTheme;
  delete document.documentElement.dataset.panelLayout;
  delete document.documentElement.dataset.panelPalette;
});

describe('usePanelTheme', () => {
  it('paints the last theme seen until the platform config arrives', () => {
    localStorage.setItem('wy-panel-theme', 'art');
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current.theme).toBe('art');
  });

  it('follows the platform setting and remembers it for the next first paint', () => {
    config.data = { branding: { workspace_panel_theme: 'art' } };
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current).toMatchObject({ theme: 'art', platformTheme: 'art', preview: null });
    expect(cachedPanelTheme()).toBe('art');
  });

  it('wears Classic when the setting is missing or unknown', () => {
    config.data = { branding: { workspace_panel_theme: 'neon' } };
    expect(renderHook(() => usePanelTheme()).result.current.theme).toBe('classic');
    config.data = { branding: null };
    expect(renderHook(() => usePanelTheme()).result.current.theme).toBe('classic');
  });

  it('a preview wins in this tab only, until it is ended', () => {
    config.data = { branding: { workspace_panel_theme: 'classic' } };
    startPanelThemePreview('art');
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current).toMatchObject({ theme: 'art', platformTheme: 'classic', preview: { theme: 'art' } });
    expect(cachedPanelTheme()).toBe('classic');

    act(() => result.current.endPreview());
    expect(result.current).toMatchObject({ theme: 'classic', preview: null });
    expect(sessionStorage.getItem('wy-panel-theme-preview')).toBeNull();
  });

  it('ending the preview anywhere ends it for every caller (the panel and Settings → Interface)', () => {
    config.data = { branding: { workspace_panel_theme: 'classic' } };
    startPanelThemePreview('art');
    const panel = renderHook(() => usePanelTheme());
    const settings = renderHook(() => usePanelTheme());
    expect(settings.result.current.theme).toBe('art');
    act(() => panel.result.current.endPreview());
    expect(panel.result.current.theme).toBe('classic');
    expect(settings.result.current.theme).toBe('classic');
  });

  it('a stored preview is ignored for anyone but a platform admin', () => {
    config.data = { branding: { workspace_panel_theme: 'classic' } };
    config.admin = false;
    startPanelThemePreview('art');
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({ theme: 'classic', preview: null });
  });

  it('previewing the theme everyone already has is no preview', () => {
    config.data = { branding: { workspace_panel_theme: 'art' } };
    startPanelThemePreview('art');
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({ theme: 'art', preview: null });
  });
});

describe('usePanelTheme — options', () => {
  const art = (options: unknown) => ({ branding: { workspace_panel_theme: 'art', workspace_panel_theme_options: options } });

  it('follows the platform’s options for its theme and remembers them for the next first paint', () => {
    config.data = art({ art: { layout: 'sidebar', palette: 'sage' } });
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current).toMatchObject({
      theme: 'art',
      options: { layout: 'sidebar', palette: 'sage' },
      platformTheme: 'art',
      platformOptions: { layout: 'sidebar', palette: 'sage' },
      preview: null,
    });
    expect(cachedPanelThemeSelection()).toEqual({ theme: 'art', options: { layout: 'sidebar', palette: 'sage' } });

    // Next load, before the config arrives: the cache paints the same frame.
    config.data = undefined;
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({
      theme: 'art',
      options: { layout: 'sidebar', palette: 'sage' },
    });
  });

  it('a missing or unknown option is its default (a database before migration 254 has none)', () => {
    config.data = { branding: { workspace_panel_theme: 'art' } };
    expect(renderHook(() => usePanelTheme()).result.current.options).toEqual({ layout: 'topnav', palette: 'clay' });
    config.data = art({ art: { layout: 'floating', palette: 'neon' } });
    expect(renderHook(() => usePanelTheme()).result.current.options).toEqual({ layout: 'topnav', palette: 'clay' });
    config.data = art('not an object');
    expect(renderHook(() => usePanelTheme()).result.current.options).toEqual({ layout: 'topnav', palette: 'clay' });
  });

  it('Classic has no options', () => {
    config.data = { branding: { workspace_panel_theme: 'classic', workspace_panel_theme_options: { art: { layout: 'sidebar' } } } };
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current.theme).toBe('classic');
    expect(result.current.options).toEqual({});
  });

  it('previews Art’s options over the platform’s, in this tab only', () => {
    config.data = art({ art: { layout: 'topnav', palette: 'clay' } });
    startPanelThemePreview('art', { layout: 'sidebar', palette: 'plum' });
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current).toMatchObject({
      theme: 'art',
      options: { layout: 'sidebar', palette: 'plum' },
      platformOptions: { layout: 'topnav', palette: 'clay' },
      preview: { theme: 'art', options: { layout: 'sidebar', palette: 'plum' } },
    });
    // The cache keeps the platform's choice, never the preview.
    expect(cachedPanelThemeSelection()).toEqual({ theme: 'art', options: { layout: 'topnav', palette: 'clay' } });
    act(() => result.current.endPreview());
    expect(result.current).toMatchObject({ options: { layout: 'topnav', palette: 'clay' }, preview: null });
  });

  it('a partial preview keeps the platform’s other options', () => {
    config.data = art({ art: { layout: 'sidebar', palette: 'ocean' } });
    startPanelThemePreview('art', { palette: 'saffron' });
    expect(renderHook(() => usePanelTheme()).result.current.options).toEqual({ layout: 'sidebar', palette: 'saffron' });
  });

  it('previewing exactly the platform’s options is no preview', () => {
    config.data = art({ art: { layout: 'sidebar', palette: 'ocean' } });
    startPanelThemePreview('art', { layout: 'sidebar', palette: 'ocean' });
    expect(renderHook(() => usePanelTheme()).result.current.preview).toBeNull();
  });

  it('reads a preview stored before options (a bare theme id)', () => {
    config.data = { branding: { workspace_panel_theme: 'classic' } };
    sessionStorage.setItem('wy-panel-theme-preview', 'art');
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({
      theme: 'art',
      options: { layout: 'topnav', palette: 'clay' },
      preview: { theme: 'art' },
    });
  });

  it('ignores a malformed stored preview', () => {
    config.data = { branding: { workspace_panel_theme: 'classic' } };
    sessionStorage.setItem('wy-panel-theme-preview', '{"theme":"neon"}');
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({ theme: 'classic', preview: null });
    sessionStorage.setItem('wy-panel-theme-preview', '{not json');
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({ theme: 'classic', preview: null });
  });
});

describe('useApplyPanelTheme', () => {
  it('puts the theme on <html> while mounted and takes it off on leaving', () => {
    const { rerender, unmount } = renderHook(({ theme }) => useApplyPanelTheme(theme), {
      initialProps: { theme: 'art' as const } as { theme: 'art' | 'classic' },
    });
    expect(document.documentElement.dataset.panelTheme).toBe('art');
    rerender({ theme: 'classic' });
    expect(document.documentElement.dataset.panelTheme).toBe('classic');
    unmount();
    expect(document.documentElement.dataset.panelTheme).toBeUndefined();
  });

  it('puts Art’s layout and colour scheme on <html> too, and only Art’s', () => {
    const root = document.documentElement;
    const { rerender, unmount } = renderHook(({ theme, options }) => useApplyPanelTheme(theme, options), {
      initialProps: { theme: 'art', options: { layout: 'sidebar', palette: 'indigo' } } as {
        theme: 'art' | 'classic';
        options?: object;
      },
    });
    expect(root.getAttribute('data-panel-layout')).toBe('sidebar');
    expect(root.getAttribute('data-panel-palette')).toBe('indigo');

    rerender({ theme: 'art', options: { layout: 'topnav', palette: 'graphite' } });
    expect(root.getAttribute('data-panel-layout')).toBe('topnav');
    expect(root.getAttribute('data-panel-palette')).toBe('graphite');

    // Missing or unknown: the defaults, so the attributes are always there for Art.
    rerender({ theme: 'art', options: { palette: 'neon' } });
    expect(root.getAttribute('data-panel-layout')).toBe('topnav');
    expect(root.getAttribute('data-panel-palette')).toBe('clay');

    rerender({ theme: 'classic', options: undefined });
    expect(root.getAttribute('data-panel-theme')).toBe('classic');
    expect(root.hasAttribute('data-panel-layout')).toBe(false);
    expect(root.hasAttribute('data-panel-palette')).toBe(false);

    rerender({ theme: 'art', options: { layout: 'sidebar', palette: 'sage' } });
    unmount();
    expect(root.hasAttribute('data-panel-theme')).toBe(false);
    expect(root.hasAttribute('data-panel-layout')).toBe(false);
    expect(root.hasAttribute('data-panel-palette')).toBe(false);
  });
});
