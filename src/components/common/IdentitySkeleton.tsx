/**
 * Shared identity placeholders.
 *
 * Identity (avatar + display name + location) is frequently derived from data
 * that arrives in a second wave (visitor network / geo / presence). Rendering
 * a provisional identity first makes names and avatars visibly swap on every
 * load. Every list that shows a person renders these skeletons until the
 * identity data it depends on has settled, so the identity is painted once.
 */
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Avatar + one or two text lines — matches a typical list row. */
export function IdentityRowSkeleton({
  lines = 2,
  avatarClassName = 'h-9 w-9',
  className,
}: {
  lines?: 1 | 2;
  avatarClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <Skeleton className={cn('shrink-0 rounded-full', avatarClassName)} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-2/5" />
        {lines === 2 && <Skeleton className="h-2.5 w-1/4" />}
      </div>
    </div>
  );
}

/** Several identity rows, for the initial load of a list. */
export function IdentityListSkeleton({
  rows = 5,
  lines = 2,
  avatarClassName,
  className,
  rowClassName = 'px-5 py-3',
}: {
  rows?: number;
  lines?: 1 | 2;
  avatarClassName?: string;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <div className={cn('divide-y divide-border/60', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <IdentityRowSkeleton
          key={i}
          lines={lines}
          avatarClassName={avatarClassName}
          className={rowClassName}
        />
      ))}
    </div>
  );
}
