/**
 * Branded loading indicator: a light band sweeps around the app mark while the
 * wordmark sits beneath it. Used instead of a generic spinner wherever a whole
 * screen or section is waiting.
 */
import { cn } from '@/lib/utils';
import { BrandLogo } from './BrandLogo';

const SIZES = {
  sm: { box: 48, pad: 8, label: 'text-[10px] tracking-[0.34em]' },
  md: { box: 72, pad: 11, label: 'text-xs tracking-[0.38em]' },
  lg: { box: 104, pad: 16, label: 'text-sm tracking-[0.42em]' },
} as const;

export function BrandLoader({
  size = 'md',
  logoUrl,
  label = 'webyar',
  showLabel = true,
  className,
}: {
  size?: keyof typeof SIZES;
  logoUrl?: string | null;
  label?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const s = SIZES[size];

  return (
    <div className={cn('flex flex-col items-center gap-3', className)} role="status" aria-live="polite">
      <div className="relative" style={{ width: s.box, height: s.box }}>
        {/* Rotating ring — a conic sweep masked into a thin circular band.
            Circular (not rounded-square) on purpose: a radial mask on a square
            leaves the corners unmasked, which shows up as four colour blobs. */}
        <span
          className="absolute inset-0 rounded-full motion-safe:animate-brand-spin"
          style={{
            background:
              'conic-gradient(from 0deg, transparent 0deg, transparent 180deg, hsl(var(--primary) / 0.25) 250deg, hsl(var(--primary)) 352deg, transparent 360deg)',
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
          }}
          aria-hidden
        />
        <span className="absolute inset-0 rounded-full border border-primary/15" aria-hidden />
        {/* Inset so the ring reads as orbiting the mark, not touching it. */}
        <BrandLogo
          src={logoUrl}
          className="absolute rounded-[24%] shadow-[var(--shadow-card)]"
          style={{ inset: s.pad }}
        />
      </div>
      {showLabel && (
        <span className={cn('font-display font-semibold uppercase text-muted-foreground', s.label)}>
          {label}
        </span>
      )}
      <span className="sr-only">Loading</span>
    </div>
  );
}

/** Full-viewport branded loading screen. */
export function BrandLoaderScreen({ logoUrl }: { logoUrl?: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <BrandLoader size="lg" logoUrl={logoUrl} />
    </div>
  );
}
