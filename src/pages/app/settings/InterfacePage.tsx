/**
 * Interface settings — language + appearance preferences.
 *
 * Self-hosted: locale persisted via /api/account/me (preferred_locale)
 * and locally via the i18n provider's localStorage key. Theme is applied
 * by next-themes (class strategy on <html>) and stored in localStorage.
 *
 * Auto-saves on change. No Edge Functions involved.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { useTranslation, useI18n } from '@/i18n';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CheckCircle2, Loader2, Languages, Palette, Monitor, Sun, Moon } from 'lucide-react';
import { updateAccount } from '@/lib/account-api';
import { toast } from '@/hooks/use-toast';

const LOCALE_FLAGS: Record<Locale, string> = {
  en: '🇬🇧',
  fa: '🇮🇷',
  tr: '🇹🇷',
};

type Appearance = 'light' | 'dark' | 'system';

const APPEARANCE_ICONS: Record<Appearance, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export default function InterfacePage() {
  const { t } = useTranslation();
  const { locale, setLocale } = useI18n();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const { theme, setTheme, resolvedTheme } = useTheme();

  const [savingLocale, setSavingLocale] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const currentTheme = (theme as Appearance) || 'system';

  const localeOptions = useMemo(
    () => allowedLocales.map((loc) => ({
      value: loc,
      label: LOCALE_CONFIG[loc].nativeLabel,
      flag: LOCALE_FLAGS[loc] || '🌐',
    })),
    [allowedLocales]
  );

  const appearanceOptions: Array<{ value: Appearance; label: string }> = [
    { value: 'light', label: t('interface.light') },
    { value: 'dark', label: t('interface.dark') },
    { value: 'system', label: t('interface.system') },
  ];

  // Pulse the "auto-saved" badge briefly after each save
  useEffect(() => {
    if (savedAt === null) return;
    const id = window.setTimeout(() => setSavedAt(null), 2200);
    return () => window.clearTimeout(id);
  }, [savedAt]);

  async function handleLocaleChange(value: string) {
    const next = value as Locale;
    if (next === locale) return;

    setLocale(next); // optimistic local switch (also updates <html lang/dir>)
    setSavingLocale(true);
    try {
      await updateAccount({ preferred_locale: next });
      setSavedAt(Date.now());
    } catch (err: any) {
      toast({
        title: t('account.saveError'),
        description: err?.message || '',
        variant: 'destructive',
      });
    } finally {
      setSavingLocale(false);
    }
  }

  function handleThemeChange(value: string) {
    setTheme(value);
    setSavedAt(Date.now());
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('interface.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('interface.subtitle')}</p>
        </div>
        <div className="shrink-0">
          {savingLocale ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('account.saving')}
            </span>
          ) : (
            <span
              className={`inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full transition-opacity ${
                savedAt ? 'opacity-100' : 'opacity-70'
              } text-emerald-600 bg-emerald-500/10`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('interface.autoSaved')}
            </span>
          )}
        </div>
      </div>

      {/* Settings card */}
      <Card className="p-6">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Language — hidden when the platform runs in a single-language region */}
          {canSwitchLanguage && (
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Languages className="h-4 w-4 text-muted-foreground" />
              {t('interface.language')}
            </Label>
            <Select value={locale} onValueChange={handleLocaleChange} disabled={savingLocale}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {localeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <span className="inline-flex items-center gap-2">
                      <span className="text-base leading-none">{opt.flag}</span>
                      <span>{opt.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('interface.languageHelper')}</p>
          </div>
          )}

          {/* Appearance */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Palette className="h-4 w-4 text-muted-foreground" />
              {t('interface.appearance')}
            </Label>
            <Select value={currentTheme} onValueChange={handleThemeChange}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {appearanceOptions.map((opt) => {
                  const Icon = APPEARANCE_ICONS[opt.value];
                  return (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <span>{opt.label}</span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('interface.appearanceHelper')}
              {currentTheme === 'system' && resolvedTheme && (
                <>
                  {' '}
                  · <span className="text-foreground">{t('interface.currentlyUsing')} {t(`interface.${resolvedTheme}` as any)}</span>
                </>
              )}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
