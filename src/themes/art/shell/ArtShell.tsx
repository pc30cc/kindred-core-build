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
import {
  ART_SIDE_MIN_WIDTH,
  ART_SIDE_WIDE_WIDTH,
  artHasOwnSideList,
  readArtSideCollapsed,
  saveArtSideCollapsed,
  useMinWidth,
} from './sideMenu';
import { useRevealCurrentInStrips, useStripFades } from './strips';
import type { ArtLayout } from '../../../../shared/panelThemes';

/**
 * The Art panel's frame (AppLayout renders it while the panel wears "art").
 * Two layouts, chosen by the Super Admin (Super Admin → Panel theme → Art →
 * Layout, `layout`):
 *
 *   - `topnav`: no sidebar. A top bar with the navigation as pills, a slim
 *     plan notice and the inbox's views under it, then the page.
 *   - `sidebar`: an inset side menu on the reading-start side (ArtSidebar)
 *     and the page on the paper beside it; desktops only (sideMenu.ts).
 *
 * A normal page is centred in a 1280px column (theme.css,
 * `[data-layout="page"]`); a full-bleed one (inbox, email, settings, ...:
 * layout.ts) fills everything beside or under the frame without scrolling.
 * Notices (email / phone verification) sit under the page as slim strips
 * (theme.css, `[data-shell="notice"]`).
 *
 * Phones and tablets get the top bar whatever the layout: a compact one on
 * phones, with the classic bottom tab bar and a drawer holding the whole menu
 * behind its "Menu" tab.
 */
export function ArtShell({
  layout,
  fullBleed,
  edgeToEdge,
  notices,
  children,
}: {
  /** The Super Admin's choice of frame (shared/panelThemes.ts, ART_LAYOUTS). */
  layout: ArtLayout;
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

  // The side menu, on desktops only (sideMenu.ts).
  const isDesktop = useMinWidth(ART_SIDE_MIN_WIDTH);
  const sideLayout = layout === 'sidebar' && isDesktop;
  // Folded or not: the member's own choice once made (saved); until then a
  // rail under 1280px, where the full menu would take a quarter of the
  // window. Settings has its own side list, so there the menu is a rail
  // (unless the member unfolds it, for that visit).
  const isWide = useMinWidth(ART_SIDE_WIDE_WIDTH);
  const wsPath = useWorkspacePath();
  const ownSideList = artHasOwnSideList(artSubPath(pathname, wsPath('')));
  const [choice, setChoice] = useState<boolean | null>(readArtSideCollapsed);
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
    saveArtSideCollapsed(next);
  }, [collapsed, ownSideList]);

  // The inbox's views go over the inbox only while the menu is a rail.
  const viewsBar = sideLayout && collapsed && nav.onInbox;

  // One tree for both layouts, so the page never remounts when the frame
  // changes: the Super Admin switching the layout reaches every open panel
  // (public config refetch), and a window crossing 1024px switches it too.
  // A remount would drop the page's own state (the open conversation, a
  // half-typed reply). Every element keeps its position in both layouts
  // (a `false` slot for what one of them lacks), and `<main>` sits at the
  // same depth under the same parents; under the top menu the two wrappers
  // are `display: contents`, so the bars and the frame lay out as children
  // of AppLayout's column, exactly as before.
  return (
    <div
      data-shell={sideLayout ? 'side-layout' : 'top-layout'}
      data-collapsed={sideLayout ? collapsed : undefined}
      className={sideLayout ? 'relative flex min-h-0 flex-1' : 'contents'}
    >
      {sideLayout && (
        <TooltipProvider delayDuration={250}>
          <ArtSidebar nav={nav} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </TooltipProvider>
      )}
      <div
        data-shell={sideLayout ? 'side-content' : 'top-content'}
        data-views-bar={sideLayout ? viewsBar : undefined}
        className={sideLayout ? 'flex min-w-0 flex-1 flex-col' : 'contents'}
      >
        {!sideLayout && <ArtHeader nav={nav} compact={isMobile} wide={edgeToEdge} />}
        {/* The trial / free-plan notice, as a slim strip (theme.css); the
            side menu carries its own. */}
        {!sideLayout && (
          <div data-shell="plan-strip">
            <PlanStatusBanner workspaceId={workspace?.id} />
          </div>
        )}
        {!sideLayout && <ArtContextBar nav={nav} compact={isMobile} />}
        {viewsBar && <ArtSideViewsBar nav={nav} />}
        {/* InboxPage portals its tabs into #topbar-page-slot: the context bar
            holds it under the top menu. Beside the side menu every tab is a
            view in the menu (or the strip above), so the slot stays hidden. */}
        {sideLayout && <div id="topbar-page-slot" hidden />}
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
      </div>

      {/* `fixed`: see MobileBottomNav.tsx; the spacer above keeps pages clear of it. */}
      {isMobile && (
        <>
          <MobileBottomNav onMenuClick={() => setDrawerOpen(true)} />
          <ArtDrawer nav={nav} open={drawerOpen} onOpenChange={setDrawerOpen} />
        </>
      )}
    </div>
  );
}
