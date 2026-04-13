import { Outlet } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { useI18n } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES, LOCALE_CONFIG } from '@/i18n/config';

export function AppLayout() {
  const { locale, setLocale } = useI18n();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-end gap-4 border-b px-6">
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
