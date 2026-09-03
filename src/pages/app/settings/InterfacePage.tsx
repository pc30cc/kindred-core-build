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
import { CheckCircle2, Loader2, Languages, Palette, Monitor, Sun, Moon, Type, Droplet, Contrast, LayoutGrid, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUiPreferences } from '@/features/ui-preferences/UiPreferencesContext';
import { UI_ACCENT_SWATCH, UI_FONT_SIZE_PX, type UiChroma, type UiFontSize, type UiPreferences, type UiSkin } from '@/lib/ui-preferences';
import { updateAccount } from '@/lib/account-api';
import { toast } from '@/hooks/use-toast';

const LOCALE_FLAGS: Record<Locale, string> = {
  en: '🇬🇧',
  fa: '🇮🇷',
  tr: '🇹🇷',
};

type Appearance = 'light' | 'dark' | 'system';

const FONT_SIZES: UiFontSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

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
  const { preferences, setPreference, reset } = useUiPreferences();

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

  function handlePref<K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) {
    setPreference(key, value);
    setSavedAt(Date.now());
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

      {/* Personal display preferences */}
      <Card className="p-6 space-y-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t('interface.displayTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t('interface.displayHelper')}</p>
        </div>

        {/* Font size */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Type className="h-4 w-4 text-muted-foreground" />
            {t('interface.fontSize')}
          </Label>
          <div className="flex flex-wrap gap-2">
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => handlePref('fontSize', size)}
                className={`rounded-xl border px-4 py-2 transition-all ${
                  preferences.fontSize === size
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:border-primary/40'
                }`}
                style={{ fontSize: `${UI_FONT_SIZE_PX[size]}px` }}
              >
                {t(`interface.fontSize_${size}` as any)}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('interface.fontSizeHelper')}</p>
        </div>

        {/* Accent colour */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Droplet className="h-4 w-4 text-muted-foreground" />
            {t('interface.accent')}
          </Label>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(UI_ACCENT_SWATCH) as Array<keyof typeof UI_ACCENT_SWATCH>).map((accent) => (
              <button
                key={accent}
                type="button"
                aria-label={t(`interface.accent_${accent}` as any)}
                onClick={() => handlePref('accent', accent)}
                disabled={preferences.chroma === 'mono'}
                className={`h-9 w-9 rounded-full border-2 transition-transform disabled:opacity-40 ${
                  preferences.accent === accent ? 'border-foreground scale-110' : 'border-transparent hover:scale-105'
                }`}
                style={{ backgroundColor: UI_ACCENT_SWATCH[accent] }}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {preferences.chroma === 'mono' ? t('interface.accentMonoNote') : t('interface.accentHelper')}
          </p>
        </div>

        {/* Chroma + skin */}
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Contrast className="h-4 w-4 text-muted-foreground" />
              {t('interface.chroma')}
            </Label>
            <Select value={preferences.chroma} onValueChange={(v) => handlePref('chroma', v as UiChroma)}>
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="color">{t('interface.chroma_color')}</SelectItem>
                <SelectItem value="mono">{t('interface.chroma_mono')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('interface.chromaHelper')}</p>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <LayoutGrid className="h-4 w-4 text-muted-foreground" />
              {t('interface.skin')}
            </Label>
            <Select value={preferences.skin} onValueChange={(v) => handlePref('skin', v as UiSkin)}>
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cloud">{t('interface.skin_cloud')}</SelectItem>
                <SelectItem value="linen">{t('interface.skin_linen')}</SelectItem>
                <SelectItem value="graphite">{t('interface.skin_graphite')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('interface.skinHelper')}</p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              reset();
              setSavedAt(Date.now());
            }}
          >
            <RotateCcw className="h-3.5 w-3.5 me-2" />
            {t('interface.resetDefaults')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

