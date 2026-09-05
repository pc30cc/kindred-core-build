/**
 * Native (iOS) settings screen: identity, language, sign out.
 */
import { useI18n, useTranslation } from '@/i18n';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/features/auth/AuthContext';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { LogOut, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MobileScreen, MobileGroup } from './MobileScreen';

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
    <MobileScreen title={t('nav.settings')} bodyClassName="pb-8">
      <div className="px-4 pt-4">
        <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <span className="text-xl font-bold text-primary">{initial}</span>
          </div>
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold text-foreground">
              {workspace?.name || t('nav.profile')}
            </p>
            <p className="truncate text-[14px] text-muted-foreground" dir="ltr">
              {user?.email}
            </p>
          </div>
        </div>
      </div>

      <MobileGroup title={t('interface.language')}>
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            type="button"
            onClick={() => setLocale(lang.code)}
            className="flex w-full items-center justify-between px-4 py-3.5 text-start active:bg-muted"
          >
            <span className="text-[16px] text-foreground">{lang.label}</span>
            <Check
              className={cn(
                'h-5 w-5 text-primary transition-opacity',
                locale === lang.code ? 'opacity-100' : 'opacity-0',
              )}
            />
          </button>
        ))}
      </MobileGroup>

      <div className="px-4 pt-6">
        <button
          type="button"
          onClick={() => signOut()}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 py-3.5 text-[16px] font-semibold text-destructive active:bg-destructive/10"
        >
          <LogOut className="h-5 w-5" />
          {t('auth.logout')}
        </button>
      </div>
    </MobileScreen>
  );
}
