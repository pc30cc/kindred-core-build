import { Outlet } from 'react-router-dom';
import { AdminSidebar } from './AdminSidebar';
import { useI18n, useTranslation } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES, LOCALE_CONFIG } from '@/i18n/config';

export function AdminLayout() {
  const { locale, setLocale } = useI18n();
  const { t } = useTranslation();

  return (
    <div className="panel-scope flex h-screen overflow-hidden bg-background text-foreground">
      <AdminSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b border-border px-6">
          <span className="text-sm text-muted-foreground">{t('admin.nav.controlCenter' as any)}</span>
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map(l => (
                <SelectItem key={l} value={l}>{LOCALE_CONFIG[l].nativeLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
