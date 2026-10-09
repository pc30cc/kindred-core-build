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
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { INTL_BRAND, useInternationalMode } from '@/lib/internationalMode';
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
  useBrandVersion();
  return (
    <img
      src={international ? INTL_BRAND.appIcon : src || webyarLogo}
      // Default text: the WebYar mark's own in Iran, the platform's name abroad.
      alt={alt ?? (international ? brandName('en') : 'WEBYAR')}
      className={cn('rounded-xl object-cover', className)}
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
 * The brand at the head of the sign-in pages: the app mark and the platform's
 * name, or in international mode the kit's horizontal logo (mark and wordmark
 * in one). Without a name it keeps the mark's room empty, unless `keepMark`
 * (sign-up shows its mark either way), as before.
 */
export function BrandLockup({ name, keepMark = false }: { name?: string | null; keepMark?: boolean }) {
  const international = useInternationalMode();
  if (international) {
    return (
      <div className="flex items-center" dir="ltr">
        <IntlBrandImage variant="horizontal" alt={name || brandName('en')} className="h-8" />
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
