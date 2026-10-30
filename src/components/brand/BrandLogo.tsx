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
 *
 * A build without the Iranian kit (shared/buildBrand.ts SHIPS_IRAN_KIT: the
 * RESPOK build) is always in international mode: the kit, the bitmap and the
 * WEBYAR words are left out of it.
 *
 * Over all of that, in both editions, the logo and symbol the Super Admin
 * uploaded (Super Admin → Branding → Visual identity; src/lib/brandAssets.ts):
 * one place sets them, every mark here follows. Without an upload each mark
 * draws exactly what it drew before.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { INTL_BRAND, useInternationalMode } from '@/lib/internationalMode';
import { WEBYAR_BRAND, useWebyarKit } from '@/lib/webyarBrand';
import webyarLogo from '@/assets/webyar-logo.png';
import { brandName, useBrandVersion } from '@/lib/brand';
import { useBrandAssets } from '@/lib/brandAssets';
import { SHIPS_IRAN_KIT } from '../../../shared/buildBrand';

/** The bundled app mark shown before the edition is known: the Iranian build's only. */
const LEGACY_MARK = SHIPS_IRAN_KIT ? webyarLogo : INTL_BRAND.appIcon;
const LEGACY_MARK_ALT = SHIPS_IRAN_KIT ? 'WEBYAR' : '';

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
  const intlMode = useInternationalMode();
  const international = !SHIPS_IRAN_KIT || intlMode;
  const kit = useWebyarKit() && !international;
  const assets = useBrandAssets();
  useBrandVersion();
  // The Super Admin's symbol wins over the kit (over a caller's `src` too
  // abroad, as the kit's own icon does; in Iran a `src` still comes first).
  const uploaded = assets.customSymbol ? assets.symbol : null;
  const image = international ? uploaded || INTL_BRAND.appIcon : src || uploaded || (kit ? WEBYAR_BRAND.symbol : LEGACY_MARK);
  // The kit's symbol is a bubble on a transparent ground, not a tile: it is
  // fitted, never cropped; so is an uploaded symbol. An operator's own `src`
  // keeps the old cover fit.
  const kitSymbol = kit && !src && !uploaded;
  const fitted = kitSymbol || (!!uploaded && image === uploaded);
  return (
    <img
      src={image}
      // Default text: the WebYar mark's own in Iran, the platform's name abroad.
      alt={alt ?? (international ? brandName('en') : kit ? WEBYAR_BRAND.name : LEGACY_MARK_ALT)}
      className={cn('rounded-xl', fitted ? 'object-contain' : 'object-cover', className)}
      data-brand-kit={kitSymbol ? 'symbol' : undefined}
      data-brand-upload={uploaded && image === uploaded ? 'symbol' : undefined}
      style={style}
      draggable={false}
    />
  );
}

/**
 * The platform's logo, drawn for the page's light or dark mode (the `.dark`
 * class on <html> picks):
 *   - `lockup`: mark and name. The upload, else RESPOK's horizontal logo
 *     abroad ("color" on light, "reversed" on dark), else WebYar's Persian
 *     logotype in Iran ("color", "on-dark"; the kit asks for at least 80px
 *     of width: callers size it by height, h-8 = 83px);
 *   - `wordmark`: the small mark under the auth cards. The upload, else
 *     RESPOK's wordmark alone, else WebYar's logotype;
 *   - `symbol`: the square mark (BrandLogo).
 * Nothing (null) while the edition is unknown and nothing was uploaded: the
 * caller keeps its old mark.
 */
export function BrandImage({
  variant,
  alt = '',
  className,
}: {
  variant: 'lockup' | 'wordmark' | 'symbol';
  alt?: string;
  className?: string;
}) {
  const assets = useBrandAssets();
  if (variant === 'symbol') return <BrandLogo alt={alt} className={className} />;
  const pair = variant === 'lockup' ? assets.lockup : assets.wordmark;
  if (!pair) return null;
  // Each source keeps its own marker (tests and styles find them by it).
  const marker = assets.source === 'custom'
    ? { 'data-brand-upload': variant }
    : assets.kit === 'international'
      ? { 'data-intl-brand': variant === 'lockup' ? 'horizontal' : 'wordmark' }
      : { 'data-brand-kit': 'logo' };
  return (
    <>
      <img src={pair.light} alt={alt} className={cn('w-auto dark:hidden', className)} draggable={false} {...marker} />
      <img src={pair.dark} alt={alt} className={cn('hidden w-auto dark:block', className)} draggable={false} {...marker} />
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
  const intlMode = useInternationalMode();
  const international = !SHIPS_IRAN_KIT || intlMode;
  const kit = useWebyarKit() && !international;
  const assets = useBrandAssets();
  if (international) {
    return (
      <div className="flex items-center" dir="ltr">
        <BrandImage variant="lockup" alt={name || brandName('en')} className="h-8" />
      </div>
    );
  }
  // The Iranian edition: the kit's logotype is mark and name in one (and so
  // is an uploaded logo, which an edition not known yet shows too).
  if ((SHIPS_IRAN_KIT && kit) || assets.source === 'custom') {
    return (
      <div className="flex items-center">
        <BrandImage variant="lockup" alt={name || WEBYAR_BRAND.name} className="h-9" />
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
