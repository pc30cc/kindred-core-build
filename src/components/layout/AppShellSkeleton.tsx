/**
 * The dashboard shell, drawn as skeleton.
 *
 * Shown only while the three things the whole panel depends on are still
 * resolving: the signed-in user, the active workspace, and its plan
 * entitlements. Everything else (lists, counters, charts) is NOT waited on —
 * those surfaces carry their own skeletons, per the project rule.
 *
 * It mirrors the real chrome (sidebar rail + top bar + content) instead of a
 * bare spinner so the layout does not jump when the real shell replaces it.
 */
import { Skeleton } from '@/components/ui/skeleton';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { useI18n } from '@/i18n';
import { useIsMobile } from '@/hooks/use-mobile';

export function AppShellSkeleton() {
  const { dir } = useI18n();
  const isMobile = useIsMobile();

  return (
    <div
      dir={dir}
      className="app-scope flex h-screen h-dvh overflow-hidden bg-background text-foreground"
      role="status"
      aria-busy="true"
    >
      {!isMobile && (
        <aside className="flex w-[220px] shrink-0 flex-col gap-4 border-e border-border bg-[image:var(--gradient-sidebar)] p-3">
          <div className="flex items-center gap-2 px-1 pt-1">
            <BrandLogo className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-9 w-full rounded-xl" />
          <div className="space-y-2 pt-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-lg" style={{ opacity: 1 - i * 0.07 }} />
            ))}
          </div>
          <div className="mt-auto space-y-2">
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        </aside>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
          {isMobile && <BrandLogo className="h-7 w-7 rounded-md" />}
          <Skeleton className="h-8 w-48 rounded-lg" />
          <div className="ms-auto flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </header>

        <main className="flex-1 overflow-hidden px-4 pt-5 sm:px-6 lg:px-8">
          <Skeleton className="h-7 w-56 rounded-lg" />
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Skeleton className="h-72 rounded-2xl lg:col-span-2" />
            <Skeleton className="h-72 rounded-2xl" />
          </div>
        </main>
      </div>
    </div>
  );
}
