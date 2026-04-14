import { Outlet, Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useI18n } from '@/i18n';
import { useRuntimeConfig } from '@/features/config/RuntimeConfigContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { Button } from '@/components/ui/button';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';

export function PublicLayout() {
  const { t } = useTranslation();
  const { locale, setLocale } = useI18n();
  const { config } = useRuntimeConfig();
  const [menuOpen, setMenuOpen] = useState(false);

  const platformName = config?.identity.platformName || 'Platform';
  const logoUrl = config?.branding.logoUrl;
  const footerText = config?.identity.footerCompanyText;
  const siteMode = config?.siteMode.siteMode || 'multi_language';
  const activeLocales = config?.siteMode.activeLocales || ['en', 'fa', 'tr'];

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
            {logoUrl && (
              <img src={logoUrl} alt={platformName} className="h-8 w-auto" />
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
            {/* Only show language switcher in multi-language mode */}
            {siteMode === 'multi_language' && activeLocales.length > 1 && (
              <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
                <SelectTrigger className="w-28 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {activeLocales.map(l => (
                    <SelectItem key={l} value={l}>
                      {LOCALE_CONFIG[l as Locale]?.nativeLabel || l}
                    </SelectItem>
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
          {footerText || `© ${new Date().getFullYear()} ${platformName}`}
        </div>
      </footer>
    </div>
  );
}
