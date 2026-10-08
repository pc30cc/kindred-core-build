import { Skeleton } from '@/components/ui/skeleton';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { useI18n } from '@/i18n';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ArtLayout } from '../../../../shared/panelThemes';
import { ART_SIDE_MIN_WIDTH, initialArtSideCollapsed, useMinWidth } from './sideMenu';

/**
 * The Art frame drawn as skeleton, shown while the user, the workspace and its
 * plan resolve (see AppShellSkeleton for the rule). It has the real frame's
 * shape, so nothing jumps when the panel arrives: the layout the Super Admin
 * chose (AppLayout passes it; the side menu on desktops only, folded as
 * ArtShell will fold it), or the top bar (spanning the window over an
 * edge-to-edge app, as the real one does) and the centred column.
 */
export function ArtShellSkeleton({
  layout,
  subPath,
  wide = false,
}: {
  layout: ArtLayout;
  /** The route after the workspace slug (layout.ts, artSubPath). */
  subPath: string;
  wide?: boolean;
}) {
  const isDesktop = useMinWidth(ART_SIDE_MIN_WIDTH);
  if (layout === 'sidebar' && isDesktop) return <ArtSideSkeleton subPath={subPath} />;
  return <ArtTopSkeleton wide={wide} />;
}

/** The side-menu frame: the inset panel, and the page beside it. */
function ArtSideSkeleton({ subPath }: { subPath: string }) {
  const { dir } = useI18n();
  const collapsed = initialArtSideCollapsed(subPath);
  return (
    <div
      dir={dir}
      data-shell="app"
      className="app-scope flex h-screen h-dvh flex-col overflow-hidden bg-background text-foreground"
      role="status"
      aria-busy="true"
    >
      <div data-shell="side-layout" className="flex min-h-0 flex-1">
        <div data-shell="side" data-collapsed={collapsed} className={collapsed ? 'flex w-[84px] shrink-0 flex-col py-3 ps-3' : 'flex w-[276px] shrink-0 flex-col py-3 ps-3'}>
          <div data-shell="side-panel" className="flex flex-1 flex-col gap-1 overflow-hidden rounded-[1.375rem] p-2.5">
            <div className="flex items-center gap-2.5 p-1">
              <BrandLogo className="h-9 w-9 rounded-xl" />
              {!collapsed && <Skeleton className="h-4 w-28 rounded-full" />}
            </div>
            <Skeleton className="mt-1.5 h-9 rounded-full" />
            <div className="mt-4 flex flex-col gap-2.5">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-7 rounded-full" style={{ opacity: 1 - i * 0.07 }} />
              ))}
            </div>
            <div className="mt-auto flex items-center gap-2.5 p-1">
              <Skeleton className="h-9 w-9 rounded-full" />
              {!collapsed && <Skeleton className="h-4 w-24 rounded-full" />}
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div data-shell="frame" className="relative min-h-0 flex-1 overflow-hidden">
            <div data-shell="main" data-layout="page">
              <Skeleton className="h-9 w-64 rounded-xl" />
              <Skeleton className="mt-3 h-4 w-80 max-w-full rounded-full" />
              <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-32 rounded-[1.25rem]" />
                ))}
              </div>
              <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
                <Skeleton className="h-80 rounded-[1.25rem] lg:col-span-2" />
                <Skeleton className="h-80 rounded-[1.25rem]" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The top-menu frame: the bar with its pills, and the centred column. */
function ArtTopSkeleton({ wide }: { wide: boolean }) {
  const { dir } = useI18n();
  const isMobile = useIsMobile();

  return (
    <div
      dir={dir}
      data-shell="app"
      className="app-scope flex h-screen h-dvh flex-col overflow-hidden bg-background text-foreground"
      role="status"
      aria-busy="true"
    >
      <header data-shell="header" data-row={wide ? 'wide' : 'page'} className="flex h-14 shrink-0 items-center gap-2.5 px-3 md:h-16 lg:px-5">
        <BrandLogo className="h-9 w-9 rounded-xl" />
        <Skeleton className="h-4 w-28 rounded-full" />
        {!isMobile && (
          <div className="ms-6 flex items-center gap-1.5">
            {[96, 112, 92, 104, 120].map((w, i) => (
              <Skeleton key={i} className="h-9 rounded-full" style={{ width: w, opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        )}
        <div className="ms-auto flex items-center gap-1.5">
          {Array.from({ length: isMobile ? 3 : 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-10 rounded-full" />
          ))}
        </div>
      </header>

      <div data-shell="frame" className="relative min-h-0 flex-1 overflow-hidden">
        <div data-shell="main" data-layout="page">
          <Skeleton className="h-9 w-64 rounded-xl" />
          <Skeleton className="mt-3 h-4 w-80 max-w-full rounded-full" />
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-[1.25rem]" />
            ))}
          </div>
          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Skeleton className="h-80 rounded-[1.25rem] lg:col-span-2" />
            <Skeleton className="h-80 rounded-[1.25rem]" />
          </div>
        </div>
      </div>
    </div>
  );
}
