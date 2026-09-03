/**
 * Shared skeleton kit.
 *
 * Project rule: every panel surface loads as a skeleton — avatars, workspace
 * logos, icons, cards, tables, forms. Never a bare spinner, never an empty
 * area, never a "loading..." string for a whole page. Compose these primitives
 * so each loading state has the same geometry as the content that replaces it.
 */
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Round avatar placeholder. */
export function SkeletonAvatar({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Skeleton
      className={cn('shrink-0 rounded-full', className)}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    />
  );
}

/** Square-ish placeholder for logos, workspace marks and icon tiles. */
export function SkeletonIcon({
  size = 24,
  rounded = 'rounded-lg',
  className,
}: {
  size?: number;
  rounded?: string;
  className?: string;
}) {
  return (
    <Skeleton
      className={cn('shrink-0', rounded, className)}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    />
  );
}

/** One or more text lines, last line shortened like real copy. */
export function SkeletonText({
  lines = 3,
  className,
  lineClassName = 'h-3',
}: {
  lines?: number;
  className?: string;
  lineClassName?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn(lineClassName, i === lines - 1 ? 'w-2/5' : i % 2 ? 'w-4/5' : 'w-full')}
        />
      ))}
    </div>
  );
}

/** Card shell with a title row and body lines. */
export function SkeletonCard({
  lines = 3,
  withHeader = true,
  className,
}: {
  lines?: number;
  withHeader?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-border/60 bg-card p-5', className)}>
      {withHeader && (
        <div className="mb-4 flex items-center gap-3">
          <SkeletonIcon size={32} />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        </div>
      )}
      <SkeletonText lines={lines} />
    </div>
  );
}

/** Compact stat tiles (dashboard-style counters). */
export function SkeletonStats({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
          <SkeletonIcon size={34} rounded="rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Table placeholder with header row and body rows. */
export function SkeletonTable({
  rows = 6,
  columns = 4,
  withHeader = true,
  className,
}: {
  rows?: number;
  columns?: number;
  withHeader?: boolean;
  className?: string;
}) {
  const grid = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border/60', className)}>
      {withHeader && (
        <div className="grid gap-4 border-b border-border/60 bg-muted/40 px-4 py-3" style={grid}>
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton key={i} className="h-2.5 w-2/3" />
          ))}
        </div>
      )}
      <div className="divide-y divide-border/60">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="grid gap-4 px-4 py-3.5" style={grid}>
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={c} className={cn('h-3', c === 0 ? 'w-4/5' : 'w-3/5')} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Form placeholder: label + control pairs inside a card. */
export function SkeletonForm({
  fields = 4,
  withCard = true,
  className,
}: {
  fields?: number;
  withCard?: boolean;
  className?: string;
}) {
  const body = (
    <div className="space-y-4">
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      ))}
      <Skeleton className="h-9 w-28 rounded-md" />
    </div>
  );
  if (!withCard) return <div className={className}>{body}</div>;
  return (
    <div className={cn('rounded-xl border border-border/60 bg-card p-5', className)}>{body}</div>
  );
}

/** Generic page shell: title, subtitle and a stack of cards. */
export function SkeletonPage({
  cards = 2,
  withHeader = true,
  className,
}: {
  cards?: number;
  withHeader?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('space-y-5', className)}>
      {withHeader && (
        <div className="space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-72" />
        </div>
      )}
      {Array.from({ length: cards }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export { Skeleton };
