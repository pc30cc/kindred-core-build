import { useState, type ReactNode } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import DegradedModeBanner from '@/components/realtime/DegradedModeBanner';
import { MobileBottomNav } from '@/components/layout/MobileBottomNav';
import { PlanStatusBanner } from '@/components/layout/PlanStatusBanner';
import { ArtHeader } from './ArtHeader';
import { ArtContextBar } from './ArtContextBar';
import { ArtDrawer } from './ArtDrawer';
import { useArtNav } from './useArtNav';
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
  // Strips (the inbox's views, a side list, a phone's row of pills) always
  // show where the member is, and fade the edge that hides more.
  useRevealCurrentInStrips(locale);
  useStripFades();

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
