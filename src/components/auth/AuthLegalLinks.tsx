/**
 * The legal links at the foot of the sign-in pages, International edition
 * only: Terms of Use, Privacy Policy, Refund Policy and Service Level
 * Agreement, on the platform's own site. The site address is the one Super
 * Admin sets (platform_domains, read through the brand tokens), so a new
 * address moves the links with it. The Iranian edition shows nothing here.
 */
import { useTranslation, type TranslationKey } from '@/i18n';
import { useBrandTokens } from '@/lib/brand';
import { useInternationalMode } from '@/lib/internationalMode';
import { cn } from '@/lib/utils';

const LINKS: Array<{ path: string; key: TranslationKey }> = [
  { path: '/terms', key: 'auth.legalLinks.terms' },
  { path: '/privacy', key: 'auth.legalLinks.privacy' },
  { path: '/refund', key: 'auth.legalLinks.refund' },
  { path: '/sla', key: 'auth.legalLinks.sla' },
];

export function AuthLegalLinks({ className }: { className?: string }) {
  const { t, locale } = useTranslation();
  const { siteUrl } = useBrandTokens(locale);
  const international = useInternationalMode();
  const base = (siteUrl || '').replace(/\/+$/, '');
  if (!international || !/^https?:\/\//i.test(base)) return null;
  return (
    <nav aria-label={t('auth.legalLinks.label')} className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground', className)}>
      {LINKS.map(({ path, key }) => (
        <a key={path} href={`${base}${path}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">
          {t(key)}
        </a>
      ))}
    </nav>
  );
}
