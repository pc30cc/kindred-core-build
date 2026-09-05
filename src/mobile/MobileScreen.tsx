/**
 * Shared native (iOS) screen chrome.
 *
 * Every native screen is a fixed-height column: a pinned nav bar that owns the
 * status-bar inset (no stray gap above the title) and a single scrolling body.
 * Nothing outside the body ever scrolls — that is what makes the shell feel
 * like an app instead of a web page.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface MobileScreenProps {
  title: string;
  subtitle?: string;
  /** Trailing controls rendered inside the nav bar. */
  actions?: ReactNode;
  /** Leading control (e.g. back button) rendered inside the nav bar. */
  leading?: ReactNode;
  /** Pinned under the nav bar: search fields, filter chips, segmented controls. */
  toolbar?: ReactNode;
  children: ReactNode;
  /** Disable body padding when the screen renders full-bleed rows. */
  bodyClassName?: string;
  /** Compact nav bar (thread screens) instead of the large title. */
  compact?: boolean;
}

export function MobileScreen({
  title,
  subtitle,
  actions,
  leading,
  toolbar,
  children,
  bodyClassName,
  compact = false,
}: MobileScreenProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border/60 bg-card/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className={cn('flex items-center gap-2 px-4', compact ? 'h-11' : 'h-14')}>
          {leading}
          <div className="min-w-0 flex-1">
            <h1
              className={cn(
                'truncate font-bold tracking-tight text-foreground',
                compact ? 'text-[17px]' : 'text-[22px]',
              )}
            >
              {title}
            </h1>
            {subtitle && (
              <p className="truncate text-[12px] leading-tight text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
        {toolbar && <div className="px-4 pb-3">{toolbar}</div>}
      </header>

      <div className={cn('flex-1 min-h-0 overflow-y-auto overscroll-contain', bodyClassName)}>
        {children}
      </div>
    </div>
  );
}

/** iOS-style grouped list container. */
export function MobileGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="px-4">
      {title && (
        <p className="px-1 pb-1.5 pt-4 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      )}
      <div className="overflow-hidden rounded-2xl border border-border bg-card divide-y divide-border">
        {children}
      </div>
    </section>
  );
}
