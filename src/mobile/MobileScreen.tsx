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
  /** iOS navigation-bar style: title centered between leading/trailing slots. */
  centered?: boolean;
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
  centered = false,
}: MobileScreenProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40">
      <header className="relative z-10 shrink-0 bg-card/90 pt-[env(safe-area-inset-top)] shadow-[0_1px_0_0_hsl(var(--border)/0.7)] backdrop-blur-2xl">
        <div className={cn('flex items-center gap-2 px-3', compact ? 'h-12' : 'h-[52px]')}>
          <div className="flex min-w-[44px] shrink-0 items-center justify-start">{leading}</div>

          <div className={cn('min-w-0 flex-1', centered && 'text-center')}>
            <h1
              className={cn(
                'truncate font-bold tracking-tight text-foreground',
                compact ? 'text-[17px]' : 'text-[19px]',
              )}
            >
              {title}
            </h1>
            {subtitle && (
              <p className="truncate text-[12px] leading-tight text-muted-foreground">{subtitle}</p>
            )}
          </div>

          <div className="flex min-w-[44px] shrink-0 items-center justify-end gap-1">{actions}</div>
        </div>
        {toolbar && <div className="px-4 pb-3">{toolbar}</div>}
      </header>

      <div className={cn('flex-1 min-h-0 overflow-y-auto overscroll-contain', bodyClassName)}>
        {children}
      </div>
    </div>
  );
}

/** Circular iOS nav-bar button. */
export function MobileNavButton({
  icon: Icon,
  onClick,
  label,
  tone = 'plain',
}: {
  icon: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  label: string;
  tone?: 'plain' | 'tinted';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full transition-transform active:scale-90',
        tone === 'tinted' ? 'bg-primary/10 text-primary' : 'text-primary active:bg-muted',
      )}
    >
      <Icon className="h-[20px] w-[20px]" />
    </button>
  );
}

/** iOS-style grouped list container. */
export function MobileGroup({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('px-4', className)}>
      {(title || action) && (
        <div className="flex items-center justify-between px-1 pb-1.5 pt-4">
          {title && (
            <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              {title}
            </p>
          )}
          {action}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_hsl(220_40%_20%/0.06),0_8px_24px_-16px_hsl(220_40%_20%/0.35)] divide-y divide-border/70">
        {children}
      </div>
    </section>
  );
}

/** Single row inside a MobileGroup. */
export function MobileRow({
  label,
  value,
  icon: Icon,
  onClick,
  trailing,
}: {
  label: ReactNode;
  value?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-muted/60"
    >
      {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />}
      <span className="truncate text-[15px] text-foreground">{label}</span>
      {value !== undefined && (
        <span className="ms-auto truncate text-[15px] text-muted-foreground">{value}</span>
      )}
      {trailing}
    </Tag>
  );
}
