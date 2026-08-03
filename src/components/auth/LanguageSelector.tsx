import * as React from 'react';
import { useI18n } from '@/i18n';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';

const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  fa: 'فارسی',
  tr: 'Türkçe',
};

export function LanguageSelector({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { locale, setLocale } = useI18n();
  const { allowedLocales: locales, canSwitchLanguage } = usePlatformRegion();

  if (!canSwitchLanguage) return null;

  return (
    <div
      className={['flex items-center justify-center gap-3 flex-wrap', className].filter(Boolean).join(' ')}
      {...props}
    >
      {locales.map((loc) => (
        <button
          key={loc}
          onClick={() => setLocale(loc)}
          className={`text-sm px-3 py-1.5 rounded-lg transition-all ${
            locale === loc
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          }`}
        >
          {LOCALE_LABELS[loc] || loc}
        </button>
      ))}
    </div>
  );
}
