/**
 * src/themes/usePanelTheme.ts: which theme the workspace panel wears, and that
 * it is on <html> only while the panel is mounted.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('@/lib/platformPublicConfig', () => ({
  usePlatformPublicConfig: () => ({ data: config.data }),
}));

import {
  cachedPanelTheme,
  startPanelThemePreview,
  useApplyPanelTheme,
  usePanelTheme,
} from '@/themes/usePanelTheme';

beforeEach(() => {
  config.data = undefined;
  localStorage.clear();
  sessionStorage.clear();
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
