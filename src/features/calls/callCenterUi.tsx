/**
 * Call Center — the module's shared visual language.
 *
 * Before this, every page invented its own chips, tiles and section headings
 * out of raw Tailwind palette classes (`emerald-500`, `amber-500`, `zinc-950`).
 * Two costs came with that: the pages drifted apart visually, and the raw
 * palette does not follow the theme, so half the module was unreadable in dark
 * mode and none of it could be re-skinned from the design tokens.
 *
 * Everything here speaks in semantic tokens — `success`, `warning`,
 * `destructive`, `info`, `primary`, `muted` — so one component set renders
 * correctly in the light tabs AND inside the dark `.call-cockpit` scope, with
 * no parallel dark variants to keep in sync.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

/** Semantic status vocabulary shared by every call-center surface. */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/** Soft fill + hairline ring, for chips and tiles. */
const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-muted/60 text-foreground ring-border',
  primary: 'bg-primary/10 text-primary ring-primary/25',
  success: 'bg-success/10 text-success ring-success/25',
  warning: 'bg-warning/10 text-warning ring-warning/25',
  danger: 'bg-destructive/10 text-destructive ring-destructive/25',
  info: 'bg-info/10 text-info ring-info/25',
};

/** Solid dot, for presence and urgency markers. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/50',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
};

/** Foreground only, for numbers that should carry their own state colour. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-info',
};

/**
 * A panel.
 *
 * `flush` drops the padding for panels that own a header/scroll body of their
 * own; `glow` adds the token-driven accent halo used for the surface an
 * operator is meant to look at first.
 */
export function Panel({
  className,
  flush = false,
  glow = false,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { flush?: boolean; glow?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/70 bg-card text-card-foreground',
        'shadow-[var(--shadow-card)]',
        glow && 'border-primary/30 shadow-[var(--shadow-glow)]',
        !flush && 'p-4',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * The heading every panel and page section shares: a tinted icon square, the
 * title, an optional count, and a right-aligned action slot.
 */
export function SectionHeading({
  icon: Icon,
  title,
  hint,
  count,
  tone = 'primary',
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  hint?: React.ReactNode;
  count?: React.ReactNode;
  tone?: Tone;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {Icon && (
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1', TONE_SOFT[tone])}>
          <Icon className="h-4 w-4" />
        </span>
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight">{title}</h3>
          {count !== undefined && count !== null && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </div>
        {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {action && <div className="ms-auto flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
  );
}

/**
 * A wallboard metric.
 *
 * The figure is the loudest thing in the tile and carries the state colour;
 * the label sits above it in small caps. `foot` takes a sparkline, a
 * comparison, or a unit — anything that qualifies the number without
 * competing with it.
 */
export function MetricTile({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  foot,
  size = 'md',
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: Tone;
  foot?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const valueSize = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl';
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-border/70 bg-card p-3.5',
        'shadow-[var(--shadow-card)] transition-colors',
        tone !== 'neutral' && 'border-transparent ring-1',
        tone !== 'neutral' && TONE_SOFT[tone],
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className={cn('mt-1 font-semibold leading-none tabular-nums', valueSize, TONE_TEXT[tone])}>
            {value}
          </div>
          {foot && <div className="mt-1.5 text-[11px] text-muted-foreground">{foot}</div>}
        </div>
        {Icon && <Icon className={cn('h-4 w-4 shrink-0 opacity-70', TONE_TEXT[tone])} />}
      </div>
    </div>
  );
}

/** A status chip: dot + label, or icon + label. */
export function StatusChip({
  tone = 'neutral',
  icon: Icon,
  dot = false,
  pulse = false,
  children,
  className,
}: {
  tone?: Tone;
  icon?: React.ComponentType<{ className?: string }>;
  dot?: boolean;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5',
        'text-[11px] font-medium ring-1',
        TONE_SOFT[tone],
        className,
      )}
    >
      {dot && <LiveDot tone={tone} pulse={pulse} />}
      {Icon && <Icon className={cn('h-3 w-3', pulse && 'animate-pulse')} />}
      {children}
    </span>
  );
}

/** A presence dot; `pulse` adds the expanding ring used for live states. */
export function LiveDot({ tone = 'success', pulse = false, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex h-2 w-2 shrink-0', className)}>
      {pulse && (
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', TONE_DOT[tone])} />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', TONE_DOT[tone])} />
    </span>
  );
}

/**
 * A progress/SLA bar. `value` is 0–100 and is clamped, so a wait that runs
 * past its target fills the track rather than overflowing it.
 */
export function ToneBar({ value, tone = 'primary', className }: { value: number; tone?: Tone; className?: string }) {
  return (
    <div className={cn('h-1 overflow-hidden rounded-full bg-muted', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', TONE_DOT[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/** The module's empty state: icon, one line of what happened, optional actions. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      {Icon && (
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground ring-1 ring-border">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Loading placeholder that matches the panel radius. */
export function PanelSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-muted/50" />
      ))}
    </div>
  );
}
