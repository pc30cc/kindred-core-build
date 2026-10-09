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
 *
 * In the Iranian edition (src/lib/webyarBrand.ts, `region_mode = 'iran'`
 * only) they are WebYar's brand kit instead: its loader (the bubble whose
 * three dots arrive one by one; `.wy-kit-loader`, styled in index.html like
 * the rest) and its Persian logotype at the foot. An edition not known yet
 * keeps the arcs and "WEBYAR AI".
 */
import { cn } from '@/lib/utils';
import { INTL_BRAND, useInternationalMode } from '@/lib/internationalMode';
import { IntlBrandImage, WebyarBrandImage } from './BrandLogo';
import { WEBYAR_BRAND, useWebyarKit } from '@/lib/webyarBrand';

/** The kit's loader (loader/web/webyar-loader.html), drawn by index.html's `.wy-kit-*` styles. */
function WebyarKitLoader({ className }: { className?: string }) {
  return (
    <svg className={cn('wy-kit-loader', className)} viewBox="0 0 100 100" role="status" aria-label="Loading">
      <path className="wy-kit-body" d="M79.71 44.57A30 30 0 0 0 29.93 18.1A30 30 0 0 0 51.05 70.37A18.75 18.75 0 0 0 32.97 88.57A1.05 1.05 0 0 1 32 89.58A52.5 52.5 0 0 0 79.71 44.57Z" />
      <path className="wy-kit-dot wy-kit-d1" d="M62.6 35.29L67.7 40.39L62.6 45.49L57.5 40.39Z" />
      <path className="wy-kit-dot wy-kit-d2" d="M50 35.29L55.1 40.39L50 45.49L44.9 40.39Z" />
      <path className="wy-kit-dot wy-kit-d3" d="M37.4 35.29L42.5 40.39L37.4 45.49L32.3 40.39Z" />
    </svg>
  );
}
import { brandName, useBrandVersion } from '@/lib/brand';

/** The two turning arcs on their own. */
export function BrandLoader({ className }: { className?: string; size?: string; logoUrl?: string | null; label?: string; showLabel?: boolean }) {
  const international = useInternationalMode();
  const kit = useWebyarKit();
  if (kit && !international) return <WebyarKitLoader className={className} />;
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
  const kit = useWebyarKit();
  if (kit && !international) {
    return (
      <div className="wy-footer wy-kit-footer" aria-hidden>
        <img className="wy-kit-light" src={WEBYAR_BRAND.logo.light} alt="" draggable={false} />
        <img className="wy-kit-dark" src={WEBYAR_BRAND.logo.dark} alt="" draggable={false} />
      </div>
    );
  }
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
  const kit = useWebyarKit();
  if (kit && !international) {
    return (
      <div aria-hidden className={cn('flex justify-center opacity-70 select-none', className)}>
        <WebyarBrandImage className="h-8" />
      </div>
    );
  }
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
  const international = useInternationalMode();
  const kit = useWebyarKit() && !international;
  useBrandVersion();
  // "WEBYAR AI" is the mark before the edition is known; abroad it is the
  // platform's name; in the Iranian edition the kit's «وب‌یار».
  return (
    <div className="wy-launch wy-inline" aria-label={international ? brandName('en') : kit ? WEBYAR_BRAND.name : 'WEBYAR AI'}>
      <BrandLoader />
      <BrandFooter />
    </div>
  );
}
