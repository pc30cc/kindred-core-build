import { Outlet } from 'react-router-dom';
import { AdminSidebar } from './AdminSidebar';
import { useI18n, useTranslation } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useState } from 'react';
import { Menu, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AdminLayout() {
  const { locale, dir, setLocale } = useI18n();
  const { t } = useTranslation();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div dir={dir} className="app-scope relative flex h-dvh overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-40 start-1/4 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-48 end-0 h-[30rem] w-[30rem] rounded-full bg-violet-500/10 blur-3xl" />
      </div>
      <AdminSidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-20 flex h-16 shrink-0 items-center justify-between border-b border-border/70 bg-background/80 px-3 backdrop-blur-xl sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label={t('admin.nav.openMenu' as any)}>
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
              <ShieldCheck className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{t('admin.nav.controlCenter' as any)}</span>
                <span className="hidden items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary sm:inline-flex">
                  <Sparkles className="h-3 w-3" />{t('admin.nav.superAdmin' as any)}
                </span>
              </div>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">{t('admin.nav.controlCenterSubtitle' as any)}</p>
            </div>
          </div>
          {canSwitchLanguage && (
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="h-9 w-[7.5rem] border-border/70 bg-card/70 shadow-sm sm:w-36" aria-label={t('admin.nav.language' as any)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowedLocales.map(l => (
                <SelectItem key={l} value={l}>{LOCALE_CONFIG[l].nativeLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
        </header>
        <main className="admin-main flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] p-3 sm:p-6 lg:p-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
