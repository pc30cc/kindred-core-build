/**
 * The head of the platform's own help center in the app (app.<brand>/help is
 * this SPA, not the server-rendered pages): the logo the Super Admin uploaded
 * (Super Admin → Branding → Visual identity; src/lib/brandAssets.ts), for the
 * page's light or dark mode, linked home, as server/routes/kb.ts
 * (helpCenterBrand) draws it. The help center never wore the kit's logo, so
 * without an upload, and on a customer's help center always, there is nothing
 * here and the page is as before.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandImage } from '@/components/brand/BrandLogo';
import { useBrandAssets } from '@/lib/brandAssets';
import { brandName, useBrandVersion } from '@/lib/brand';
import { isPlatformHelpCenter } from '@/lib/kb-api';
import type { Locale } from '@/i18n/config';

export function HelpBrandHead({ locale }: { locale: Locale }) {
  const custom = useBrandAssets().source === 'custom';
  useBrandVersion();
  const [platform, setPlatform] = useState(false);
  useEffect(() => {
    if (!custom) return;
    let alive = true;
    // The same probe the page's reads ask (one request per page).
    isPlatformHelpCenter().then((own) => { if (alive) setPlatform(own); });
    return () => { alive = false; };
  }, [custom]);
  if (!custom || !platform) return null;
  return (
    <Link to={`/help/${locale}`} className="inline-flex mb-6" data-help-brand="">
      <BrandImage variant="lockup" alt={brandName(locale)} className="h-7" />
    </Link>
  );
}
