/**
 * Presence indicator — a precise, professional online/idle/offline glyph.
 *
 * Visual language (deliberately distinguishable without relying on color):
 *   online  → solid filled dot + soft pulsing halo
 *   idle    → filled dot with a "clock notch" (crescent) cut out
 *   offline → hollow ring (no fill)
 *
 * All colors come from semantic tokens (success / warning / muted-foreground)
 * so both light and dark themes stay in contrast.
 */
import { cn } from '@/lib/utils';

export type PresenceState = 'online' | 'idle' | 'offline';

const TONE: Record<PresenceState, { fg: string; bg: string; ring: string }> = {
  online:  { fg: 'text-success',          bg: 'bg-success',          ring: 'ring-success/30' },
  idle:    { fg: 'text-warning',          bg: 'bg-warning',          ring: 'ring-warning/30' },
  offline: { fg: 'text-muted-foreground', bg: 'bg-muted-foreground', ring: 'ring-border' },
};

export interface PresenceDotProps {
  state: PresenceState;
  /** Diameter in px. */
  size?: number;
  /** Draw a card-colored border so the dot reads on top of an avatar. */
  bordered?: boolean;
  className?: string;
  title?: string;
}

export function PresenceDot({ state, size = 12, bordered = false, className, title }: PresenceDotProps) {
  const tone = TONE[state];
  return (
    <span
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
      title={title}
      role="img"
      aria-label={state}
    >
      {state === 'online' && (
        <span
          className={cn('absolute inset-0 rounded-full opacity-60 animate-ping', tone.bg)}
          style={{ animationDuration: '2.2s' }}
          aria-hidden
        />
      )}
      <span
        className={cn(
          'relative rounded-full w-full h-full',
          bordered && 'border-2 border-card',
          state === 'offline'
            ? cn('bg-card border-2', bordered ? 'shadow-[0_0_0_2px_hsl(var(--card))]' : '', 'border-current', tone.fg)
            : tone.bg,
        )}
        aria-hidden
      >
        {state === 'idle' && (
          // Crescent cut-out: a card-colored disc offset to the top-right
          // turns the solid dot into an unmistakable "away" glyph.
          <span
            className="absolute rounded-full bg-card"
            style={{ width: '58%', height: '58%', top: '-14%', insetInlineEnd: '-14%' }}
          />
        )}
      </span>
    </span>
  );
}

export interface PresenceBadgeProps {
  state: PresenceState;
  label: string;
  /** Optional secondary text (e.g. the page the visitor is on). */
  title?: string;
  className?: string;
}

/** Compact labelled pill — dot + localized text in the matching tone. */
export function PresenceBadge({ state, label, title, className }: PresenceBadgeProps) {
  const tone = TONE[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full ps-1.5 pe-2 py-0.5 text-[11px] font-semibold',
        'ring-1 bg-background/60 backdrop-blur-sm',
        tone.fg,
        tone.ring,
        className,
      )}
      title={title}
    >
      <PresenceDot state={state} size={8} />
      <span className="leading-none">{label}</span>
    </span>
  );
}
