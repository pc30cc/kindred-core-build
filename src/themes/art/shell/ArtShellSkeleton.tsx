import { Skeleton } from '@/components/ui/skeleton';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { useI18n } from '@/i18n';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * The Art frame drawn as skeleton, shown while the user, the workspace and its
 * plan resolve (see AppShellSkeleton for the rule). It has the real frame's
 * shape, top bar and centred column, so nothing jumps when the panel arrives.
 */
export function ArtShellSkeleton() {
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
      <header data-shell="header" className="flex h-14 shrink-0 items-center gap-2.5 px-3 md:h-16 lg:px-5">
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
          {!isMobile && <Skeleton className="me-1.5 hidden h-10 w-52 rounded-full xl:block" />}
          {Array.from({ length: isMobile ? 2 : 4 }).map((_, i) => (
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
