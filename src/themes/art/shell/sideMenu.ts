/**
 * Art's side-menu frame (Super Admin → Panel theme → Art → Layout: side
 * menu): when it is used, and whether it is folded into a rail. Shared by
 * ArtShell and its loading skeleton, so the two always agree.
 */
import { useEffect, useState } from 'react';

/**
 * The side menu is for desktops. Under this width (phones, tablets, a narrow
 * window) the frame is the top bar, with the drawer and the bottom tab bar
 * on phones, whatever the layout option says.
 */
export const ART_SIDE_MIN_WIDTH = 1024;

/** Under this width the menu starts as a rail, until the member chooses. */
export const ART_SIDE_WIDE_WIDTH = 1280;

/** The member's own fold choice ('1' folded, '0' open), per browser. */
const COLLAPSED_KEY = 'wy-art-sidebar-collapsed';

function mediaMatches(query: string) {
  try {
    return typeof window !== 'undefined' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Whether the window is at least `px` wide, following resizes. */
export function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** The member's saved choice: folded, open, or none yet (null). */
export function readArtSideCollapsed(): boolean | null {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_KEY);
    return stored === '1' ? true : stored === '0' ? false : null;
  } catch {
    return null;
  }
}

export function saveArtSideCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* the rail still folds for this visit */
  }
}

/**
 * Settings has a side list of its own; there the menu is a rail, so two
 * lists of navigation never stand side by side. `subPath`: the route after
 * the workspace slug (layout.ts, artSubPath).
 */
export function artHasOwnSideList(subPath: string) {
  return /^\/settings(\/|$)/.test(subPath);
}

/** Folded or not before the member touches it, as ArtShell decides it. */
export function initialArtSideCollapsed(subPath: string) {
  if (artHasOwnSideList(subPath)) return true;
  return readArtSideCollapsed() ?? !mediaMatches(`(min-width: ${ART_SIDE_WIDE_WIDTH}px)`);
}
