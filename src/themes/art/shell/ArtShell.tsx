import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import DegradedModeBanner from '@/components/realtime/DegradedModeBanner';
import { MobileBottomNav } from '@/components/layout/MobileBottomNav';
import { PlanStatusBanner } from '@/components/layout/PlanStatusBanner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ArtHeader } from './ArtHeader';
import { ArtContextBar } from './ArtContextBar';
import { ArtDrawer } from './ArtDrawer';
import { useArtNav } from './useArtNav';
import { ArtSidebar, ArtSideViewsBar } from './ArtSidebar';
import { artSubPath } from './layout';
import { useRevealCurrentInStrips, useStripFades } from './strips';

/**
 * The Art panel's frame (AppLayout renders it while the panel wears "art").
 * No sidebar: a top bar with the navigation as pills, a slim plan notice and
 * the inbox's views under it, then the page. A normal page is centred in a
 * 1280px column (theme.css, `[data-layout="page"]`); a full-bleed one
 * (inbox, email, settings, ...: layout.ts) fills everything under the bars
 * without scrolling. Notices (email / phone verification) sit under the page
 * as slim strips (theme.css, `[data-shell="notice"]`).
 *
 * Phones get a compact top bar, the classic bottom tab bar and a drawer with
 * the whole menu behind its "Menu" tab.
 */
const LAYOUT_KEY = 'wy-art-layout';
const COLLAPSED_KEY = 'wy-art-sidebar-collapsed';

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Whether the window is at least `px` wide (the side menu is for desktops). */
function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function ArtShell({
  fullBleed,
  edgeToEdge,
  notices,
  children,
}: {
  fullBleed: boolean;
  /** The page's app runs edge to edge: the header's row spans the window too. */
  edgeToEdge: boolean;
  notices: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const { locale } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const nav = useArtNav();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The phone drawer closes on every navigation, including the ones its
  // workspace switcher, invite link and upgrade button make (as Classic's).
  const { pathname, search } = useLocation();
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname, search]);
  // Strips (the inbox's views, a side list, a phone's row of pills) always
  // show where the member is, and fade the edge that hides more.
  useRevealCurrentInStrips(locale);
  useStripFades();

  // Prototype: the side-menu frame, chosen once per load by
  // localStorage "wy-art-layout" = "sidebar". Desktops only: phones and
  // tablets keep the header, the drawer and the bottom bar.
  const [sideLayout] = useState(() => readStorage(LAYOUT_KEY) === 'sidebar');
  const isDesktop = useMinWidth(1024);
  // Folded or not: the member's own choice once made (saved); until then a
  // rail under 1280px, where the full menu would take a quarter of the
  // window. Settings has its own side list, so there the menu is a rail
  // (unless the member unfolds it, for that visit) and never two lists of
  // navigation stand side by side.
  const isWide = useMinWidth(1280);
  const wsPath = useWorkspacePath();
  const ownSideList = /^\/settings(\/|$)/.test(artSubPath(pathname, wsPath('')));
  const [choice, setChoice] = useState<boolean | null>(() => {
    const stored = readStorage(COLLAPSED_KEY);
    return stored === '1' ? true : stored === '0' ? false : null;
  });
  const [listOverride, setListOverride] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ownSideList) setListOverride(null);
  }, [ownSideList]);
  const collapsed = ownSideList ? (listOverride ?? true) : (choice ?? !isWide);
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    if (ownSideList) {
      setListOverride(next);
      return;
    }
    setChoice(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* the rail still folds for this visit */
    }
  }, [collapsed, ownSideList]);

  if (sideLayout && isDesktop) {
    // The inbox's views go over the inbox only while the menu is a rail.
    const viewsBar = collapsed && nav.onInbox;
    return (
      <div data-shell="side-layout" data-collapsed={collapsed} className="relative flex min-h-0 flex-1">
        <TooltipProvider delayDuration={250}>
          <ArtSidebar nav={nav} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </TooltipProvider>
        <div data-shell="side-content" data-views-bar={viewsBar} className="flex min-w-0 flex-1 flex-col">
          {viewsBar && <ArtSideViewsBar nav={nav} />}
          {/* InboxPage portals its tabs here. Every one of them is a view in
              the side menu (or the strip above), so the slot stays hidden. */}
          <div id="topbar-page-slot" hidden />
          <DegradedModeBanner />
          <div data-shell="frame" className="relative flex min-h-0 flex-1 flex-col">
            <main
              data-shell="main"
              data-layout={fullBleed ? 'full-bleed' : 'page'}
              className={fullBleed ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-y-auto'}
            >
              {children}
            </main>
            {notices}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <ArtHeader nav={nav} compact={isMobile} wide={edgeToEdge} />
      {/* The trial / free-plan notice, as a slim strip (theme.css). */}
      <div data-shell="plan-strip">
        <PlanStatusBanner workspaceId={workspace?.id} />
      </div>
      <ArtContextBar nav={nav} compact={isMobile} />
      <DegradedModeBanner />

      <div data-shell="frame" className="relative flex min-h-0 flex-1 flex-col">
        <main
          data-shell="main"
          data-layout={fullBleed ? 'full-bleed' : 'page'}
          className={fullBleed ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-y-auto'}
        >
          {children}
        </main>
        {notices}
        {isMobile && (
          <div aria-hidden className="shrink-0" style={{ height: 'calc(60px + env(safe-area-inset-bottom))' }} />
        )}
      </div>

      {/* `fixed`: see MobileBottomNav.tsx; the spacer above keeps pages clear of it. */}
      {isMobile && (
        <>
          <MobileBottomNav onMenuClick={() => setDrawerOpen(true)} />
          <ArtDrawer nav={nav} open={drawerOpen} onOpenChange={setDrawerOpen} />
        </>
      )}
    </>
  );
}
