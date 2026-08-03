import { Outlet, Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useI18n } from '@/i18n';
import { usePublicBranding } from '@/hooks/usePublicBranding';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { Button } from '@/components/ui/button';
import { Menu, X } from 'lucide-react';
import { useState, useEffect } from 'react';

export function PublicLayout() {
  const { t } = useTranslation();
  const { locale, setLocale } = useI18n();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const { branding, platformName } = usePublicBranding();
  const [menuOpen, setMenuOpen] = useState(false);

  // Drive browser title from branding for public pages
  useEffect(() => {
    if (branding?.meta_title) {
      document.title = branding.meta_title;
    } else if (branding?.platform_name) {
      document.title = branding.platform_name;
    }
  }, [branding]);

  const navLinks = [
    { label: t('public.features'), path: '/features' },
    { label: t('public.pricing'), path: '/pricing' },
    { label: t('public.contact'), path: '/contact' },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="container flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            {branding?.logo_url && (
              <img src={branding.logo_url} alt={platformName} className="h-8 w-auto" />
            )}
            <span className="text-xl font-bold text-foreground">{platformName}</span>
          </Link>

          <nav className="hidden md:flex items-center gap-6">
            {navLinks.map(link => (
              <Link key={link.path} to={link.path} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-3">
            {canSwitchLanguage && (
            <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
              <SelectTrigger className="w-28 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowedLocales.map(l => (
                  <SelectItem key={l} value={l}>{LOCALE_CONFIG[l].nativeLabel}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link to="/auth/login">{t('auth.login')}</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/auth/signup">{t('auth.signup')}</Link>
            </Button>
          </div>

          <button className="md:hidden" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {menuOpen && (
          <div className="md:hidden border-t p-4 space-y-3">
            {navLinks.map(link => (
              <Link key={link.path} to={link.path} onClick={() => setMenuOpen(false)} className="block text-sm text-muted-foreground hover:text-foreground">
                {link.label}
              </Link>
            ))}
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/auth/login">{t('auth.login')}</Link>
              </Button>
              <Button size="sm" asChild>
                <Link to="/auth/signup">{t('auth.signup')}</Link>
              </Button>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t py-8 mt-auto">
        <div className="container text-center text-sm text-muted-foreground">
          {branding?.footer_text || `© ${new Date().getFullYear()} ${platformName}`}
        </div>
      </footer>
    </div>
  );
}
