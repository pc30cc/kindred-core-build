/**
 * Branded loading indicator: a light band sweeps around the app mark while the
 * wordmark sits beneath it. Used instead of a generic spinner wherever a whole
 * screen or section is waiting.
 */
import { cn } from '@/lib/utils';
import { BrandLogo } from './BrandLogo';
import webyarW from '@/assets/webyar-w.png';

const SIZES = {
  sm: { box: 56, mark: 24, label: 'text-[9px] tracking-[0.28em]' },
  md: { box: 84, mark: 36, label: 'text-[11px] tracking-[0.32em]' },
  lg: { box: 120, mark: 52, label: 'text-sm tracking-[0.36em]' },
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
              'conic-gradient(from 0deg, transparent 0deg, transparent 180deg, hsl(var(--brand-teal) / 0.35) 230deg, hsl(var(--brand-sky)) 300deg, hsl(var(--brand-violet)) 352deg, transparent 360deg)',
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
          }}
          aria-hidden
        />
        <span className="absolute inset-0 rounded-full border border-primary/15" aria-hidden />
        {/* Bare W mark inside the ring, painted through a CSS mask so it takes
            the theme's primary colour. Operator branding (logoUrl) wins. */}
        <span className="absolute inset-0 flex items-center justify-center">
          {logoUrl ? (
            <BrandLogo src={logoUrl} className="rounded-[26%]" style={{ width: s.mark, height: s.mark }} />
          ) : (
            <span
              aria-hidden
              className="bg-brand"
              style={{
                width: s.mark,
                height: s.mark,
                WebkitMaskImage: `url(${webyarW})`,
                maskImage: `url(${webyarW})`,
                WebkitMaskRepeat: 'no-repeat',
                maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center',
                maskPosition: 'center',
                WebkitMaskSize: 'contain',
                maskSize: 'contain',
              }}
            />
          )}
        </span>
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
    <div className="auth-aurora flex min-h-screen items-center justify-center">
      <BrandLoader size="lg" logoUrl={logoUrl} />
    </div>
  );
}
