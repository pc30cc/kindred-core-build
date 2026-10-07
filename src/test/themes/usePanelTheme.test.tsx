/**
 * src/themes/usePanelTheme.ts: which theme the workspace panel wears, and that
 * it is on <html> only while the panel is mounted.
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
    expect(result.current).toMatchObject({ theme: 'art', platformTheme: 'classic', preview: 'art' });
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
});
