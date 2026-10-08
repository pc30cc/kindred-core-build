/**
 * src/themes/art/shell/sideMenu.ts: when Art's side menu starts folded into a
 * rail, as ArtShell and its loading skeleton both decide it.
 *
 *   - Settings has a side list of its own: there the menu is a rail.
 *   - Elsewhere the member's own choice, kept per browser, wins.
 *   - Without one: open on a wide window (1280px and up), a rail below.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ART_SIDE_MIN_WIDTH,
  ART_SIDE_WIDE_WIDTH,
  artHasOwnSideList,
  initialArtSideCollapsed,
  readArtSideCollapsed,
  saveArtSideCollapsed,
} from '@/themes/art/shell/sideMenu';

const KEY = 'wy-art-sidebar-collapsed';
const originalMatchMedia = window.matchMedia;

/** A window `width` px wide, as matchMedia sees it. */
function windowWidth(width: number) {
  window.matchMedia = ((query: string) => {
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
    return {
      matches: width >= min,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  }) as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('Art side menu', () => {
  it('is for desktops, and starts open from a wide window', () => {
    expect(ART_SIDE_MIN_WIDTH).toBe(1024);
    expect(ART_SIDE_WIDE_WIDTH).toBe(1280);
  });

  it('knows the pages with a side list of their own', () => {
    expect(artHasOwnSideList('/settings')).toBe(true);
    expect(artHasOwnSideList('/settings/general')).toBe(true);
    expect(artHasOwnSideList('/call-center/settings')).toBe(false);
    expect(artHasOwnSideList('/ai-agent/settings')).toBe(false);
    expect(artHasOwnSideList('/settingsx')).toBe(false);
    expect(artHasOwnSideList('')).toBe(false);
  });

  it('keeps the member’s fold choice per browser', () => {
    expect(readArtSideCollapsed()).toBeNull();
    saveArtSideCollapsed(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(readArtSideCollapsed()).toBe(true);
    saveArtSideCollapsed(false);
    expect(readArtSideCollapsed()).toBe(false);
    localStorage.setItem(KEY, 'yes');
    expect(readArtSideCollapsed()).toBeNull();
  });

  it('starts as a rail on Settings, whatever the member chose elsewhere', () => {
    windowWidth(1600);
    saveArtSideCollapsed(false);
    expect(initialArtSideCollapsed('/settings/general')).toBe(true);
  });

  it('follows the member’s choice elsewhere', () => {
    windowWidth(1100);
    saveArtSideCollapsed(false);
    expect(initialArtSideCollapsed('/inbox')).toBe(false);
    windowWidth(1600);
    saveArtSideCollapsed(true);
    expect(initialArtSideCollapsed('')).toBe(true);
  });

  it('without a choice: open on a wide window, a rail below 1280px', () => {
    windowWidth(1440);
    expect(initialArtSideCollapsed('')).toBe(false);
    windowWidth(1280);
    expect(initialArtSideCollapsed('/contacts')).toBe(false);
    windowWidth(1279);
    expect(initialArtSideCollapsed('/contacts')).toBe(true);
  });
});
