/**
 * The WEBYAR app mark.
 *
 * One place owns the logo bitmap, so every surface that shows "the app icon"
 * (auth screens, sidebar fallback, loading screen) stays in sync. Operator
 * branding still wins where it exists — pass `src` to override.
 *
 * In international mode (src/lib/internationalMode.ts) every one of them shows
 * the RESPOK brand kit instead, over any `src`: its app icon for the square
 * mark, its horizontal logo for the lockup. Persian never shows it.
 *
 * In the Iranian edition (src/lib/webyarBrand.ts, `region_mode = 'iran'`
 * only) they show WebYar's own brand kit: its bubble symbol for the square
 * mark (an operator `src` still wins) and its Persian logotype for the
 * lockup. An edition not known yet keeps the bundled WEBYAR bitmap.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { INTL_BRAND, useInternationalMode } from '@/lib/internationalMode';
import { WEBYAR_BRAND, useWebyarKit } from '@/lib/webyarBrand';
import webyarLogo from '@/assets/webyar-logo.png';
import { brandName, useBrandVersion } from '@/lib/brand';

export function BrandLogo({
  src,
  alt,
  className,
  style,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const international = useInternationalMode();
  const kit = useWebyarKit() && !international;
  useBrandVersion();
  // The kit's symbol is a bubble on a transparent ground, not a tile: it is
  // fitted, never cropped. An operator's own `src` keeps the old cover fit.
  const kitSymbol = kit && !src;
  return (
    <img
      src={international ? INTL_BRAND.appIcon : src || (kit ? WEBYAR_BRAND.symbol : webyarLogo)}
      // Default text: the WebYar mark's own in Iran, the platform's name abroad.
      alt={alt ?? (international ? brandName('en') : kit ? WEBYAR_BRAND.name : 'WEBYAR')}
      className={cn('rounded-xl', kitSymbol ? 'object-contain' : 'object-cover', className)}
      data-webyar-brand={kitSymbol ? 'symbol' : undefined}
      style={style}
      draggable={false}
    />
  );
}

/**
 * One of the kit's logos, drawn for the page's light or dark mode ("color" on
 * light, "reversed" on dark; the `.dark` class on <html> picks).
 */
export function IntlBrandImage({
  variant,
  alt = '',
  className,
}: {
  variant: 'horizontal' | 'wordmark';
  alt?: string;
  className?: string;
}) {
  const files = INTL_BRAND[variant];
  return (
    <>
      <img src={files.light} alt={alt} className={cn('w-auto dark:hidden', className)} draggable={false} data-intl-brand={variant} />
      <img src={files.dark} alt={alt} className={cn('hidden w-auto dark:block', className)} draggable={false} data-intl-brand={variant} />
    </>
  );
}

/**
 * WebYar's Persian logotype, drawn for the page's light or dark mode ("color"
 * on light, "on-dark" on dark; the `.dark` class on <html> picks). The kit
 * asks for at least 80px of width: callers size it by height (h-8 = 83px).
 */
export function WebyarBrandImage({ alt = '', className }: { alt?: string; className?: string }) {
  return (
    <>
      <img src={WEBYAR_BRAND.logo.light} alt={alt} className={cn('w-auto dark:hidden', className)} draggable={false} data-webyar-brand="logo" />
      <img src={WEBYAR_BRAND.logo.dark} alt={alt} className={cn('hidden w-auto dark:block', className)} draggable={false} data-webyar-brand="logo" />
    </>
  );
}

/**
 * The brand at the head of the sign-in pages: the app mark and the platform's
 * name, or in international mode the kit's horizontal logo (mark and wordmark
 * in one), or in the Iranian edition WebYar's Persian logotype. Without a name it keeps the mark's room empty, unless `keepMark`
 * (sign-up shows its mark either way), as before.
 */
export function BrandLockup({ name, keepMark = false }: { name?: string | null; keepMark?: boolean }) {
  const international = useInternationalMode();
  const kit = useWebyarKit() && !international;
  if (international) {
    return (
      <div className="flex items-center" dir="ltr">
        <IntlBrandImage variant="horizontal" alt={name || brandName('en')} className="h-8" />
      </div>
    );
  }
  // The Iranian edition: the kit's logotype is mark and name in one.
  if (kit) {
    return (
      <div className="flex items-center">
        <WebyarBrandImage alt={name || WEBYAR_BRAND.name} className="h-9" />
      </div>
    );
  }
  if (!name && !keepMark) return <div className="w-9 h-9" />;
  return (
    <div className="flex items-center gap-3">
      <BrandLogo className="w-9 h-9 rounded-lg" />
      <span className="text-lg font-semibold text-foreground">{name}</span>
    </div>
  );
}

export { webyarLogo };
