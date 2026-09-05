/**
 * Minimal settings screen for the native app: identity, language, sign out.
 */
import { useI18n, useTranslation } from '@/i18n';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/features/auth/AuthContext';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { LogOut, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const LANGUAGES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'fa', label: 'فارسی' },
];

export default function MobileSettingsPage() {
  const { t } = useTranslation();
  const { locale, setLocale } = useI18n();
  const { user, signOut } = useAuth();
  const { workspace } = useActiveWorkspace();

  const initial = (user?.email || '?').charAt(0).toUpperCase();

  return (
    <div className="px-4 pb-8 pt-4 space-y-6">
      <h1 className="text-[28px] font-bold tracking-tight text-foreground px-1">
        {t('nav.settings')}
      </h1>

      <div className="rounded-2xl border border-border bg-card p-4 flex items-center gap-4">
        <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
          <span className="text-xl font-bold text-primary">{initial}</span>
        </div>
        <div className="min-w-0">
          <p className="text-[17px] font-semibold text-foreground truncate">
            {workspace?.name || t('nav.profile')}
          </p>
          <p className="text-[14px] text-muted-foreground truncate" dir="ltr">
            {user?.email}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="px-1 text-[13px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('settings.language')}
        </p>
        <div className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => setLocale(lang.code)}
              className="w-full flex items-center justify-between px-4 h-14 text-[17px] text-foreground active:bg-muted"
            >
              <span>{lang.label}</span>
              {locale === lang.code && <Check className="h-5 w-5 text-primary" />}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => void signOut()}
        className={cn(
          'w-full h-14 rounded-2xl border border-border bg-card text-[17px] font-medium',
          'text-destructive flex items-center justify-center gap-2 active:bg-muted',
        )}
      >
        <LogOut className="h-5 w-5" />
        {t('auth.logout')}
      </button>
    </div>
  );
}
