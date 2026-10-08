/**
 * The launch loader, the same one the iOS app opens on (LaunchView in
 * ios/Webyar/Sources/App/WebyarApp.swift): two arcs turning against each
 * other, and "WEBYAR AI" set small at the foot of the screen.
 *
 * The styles live in index.html (the `.wy-*` classes) so the static
 * #boot-splash can draw the identical loader on the very first paint, before
 * this bundle loads; these components only reuse them.
 *
 * In international mode (src/lib/internationalMode.ts) the arcs turn in the
 * RESPOK kit's Signal (`.wy-intl`) and the foot carries the kit's horizontal
 * logo instead of "WEBYAR AI"; index.html's boot splash does the same from
 * the cached site mode. Persian never shows them.
 */
import { cn } from '@/lib/utils';
import { INTL_BRAND, useInternationalMode } from '@/lib/internationalMode';
import { IntlBrandImage } from './BrandLogo';

/** The two turning arcs on their own. */
export function BrandLoader({ className }: { className?: string; size?: string; logoUrl?: string | null; label?: string; showLabel?: boolean }) {
  const international = useInternationalMode();
  return (
    <div className={cn('wy-loader', international && 'wy-intl', className)} role="status" aria-label="Loading">
      <span className="wy-track" aria-hidden />
      <span className="wy-comet" aria-hidden />
      <span className="wy-inner" aria-hidden>
        <svg viewBox="0 0 26 26">
          <circle
            cx="13" cy="13" r="12" fill="none"
            stroke="#2ed6ff" strokeOpacity={0.55} strokeWidth={2} strokeLinecap="round"
            strokeDasharray="16.59 100" transform="rotate(-90 13 13)"
          />
        </svg>
      </span>
    </div>
  );
}

/** "WEBYAR AI" — always Latin and left-to-right: it is the mark, not prose. */
export function BrandFooter() {
  const international = useInternationalMode();
  if (international) {
    return (
      <div className="wy-footer wy-intl-footer" aria-hidden>
        <img className="wy-intl-light" src={INTL_BRAND.horizontal.light} alt="" draggable={false} />
        <img className="wy-intl-dark" src={INTL_BRAND.horizontal.dark} alt="" draggable={false} />
      </div>
    );
  }
  return (
    <div className="wy-footer" aria-hidden>
      <span className="wy-name">WEBYAR</span>
      <span className="wy-ai">AI</span>
    </div>
  );
}

/** The same "WEBYAR AI" mark, in normal flow (e.g. under the auth cards). */
export function BrandWordmark({ className }: { className?: string }) {
  const international = useInternationalMode();
  if (international) {
    return (
      <div dir="ltr" aria-hidden className={cn('flex justify-center opacity-70 select-none', className)}>
        <IntlBrandImage variant="wordmark" className="h-3.5" />
      </div>
    );
  }
  return (
    <div
      dir="ltr"
      aria-hidden
      className={cn('flex justify-center gap-[4.8px] pl-[3px] text-xs font-semibold leading-none tracking-[3px] select-none', className)}
      style={{ fontFamily: "ui-rounded, 'SF Pro Rounded', -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif" }}
    >
      <span className="text-muted-foreground">WEBYAR</span>
      <span className="bg-clip-text text-transparent" style={{ backgroundImage: 'linear-gradient(90deg, #0c50e9, #2ed6ff)' }}>AI</span>
    </div>
  );
}

/** Full-viewport loading screen: identical to the iOS launch screen. */
export function BrandLoaderScreen(_props: { logoUrl?: string | null } = {}) {
  return (
    <div className="wy-launch wy-inline" aria-label="WEBYAR AI">
      <BrandLoader />
      <BrandFooter />
    </div>
  );
}
