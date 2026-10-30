/**
 * Platform-owned "Powered by" credit configuration.
 *
 * Only platform admins reach this surface — workspace owners can no longer set
 * a branding name for the widget footer. Visibility per customer is decided in
 * Plans via the `widget_powered_by` feature toggle; this screen owns the master
 * switch, the wording and the outbound link.
 *
 * The preview is what visitors see, per widget language: the prefix where it
 * is written in that language's script, else the widget's own word
 * (shared/poweredByCredit.ts, the renderers' rule), and the platform's logo
 * where the widget draws one (configSnapshot.ts: the one uploaded in
 * Branding, else the International edition's RESPOK lockup or the Iranian
 * edition's Persian logotype), else the name.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { useEdition } from '@/hooks/useEdition';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { WEBYAR_BRAND, useWebyarKit } from '@/lib/webyarBrand';
import { useBrandAssets } from '@/lib/brandAssets';
import { useTranslation, type TranslationKey } from '@/i18n';
import { INTL_BRAND } from '../../../../shared/internationalMode';
import { SHIPS_IRAN_KIT } from '../../../../shared/buildBrand';
import { POWERED_BY_WIDGET_WORDS, poweredByPrefixFor, type PoweredByLocale } from '../../../../shared/poweredByCredit';

interface Props {
  settings: WidgetPlatformSettings;
  onSave: (patch: Partial<WidgetPlatformSettings>) => void;
  saving: boolean;
}

export function PoweredBySection({ settings, onSave, saving }: Props) {
  const { t, locale } = useTranslation();
  const { isInternational } = useEdition();
  const localKit = useWebyarKit();
  const brandAssets = useBrandAssets();
  const { allowedLocales } = usePlatformRegion();
  const { platformName } = useBrandingContext();
  const [enabled, setEnabled] = useState(settings.powered_by_enabled ?? true);
  const [text, setText] = useState(settings.powered_by_text ?? '');
  const [brand, setBrand] = useState(settings.powered_by_brand_text ?? '');
  const [url, setUrl] = useState(settings.powered_by_url ?? '');

  useEffect(() => {
    setEnabled(settings.powered_by_enabled ?? true);
    setText(settings.powered_by_text ?? '');
    setBrand(settings.powered_by_brand_text ?? '');
    setUrl(settings.powered_by_url ?? '');
  }, [settings]);

  const urlInvalid = url.trim().length > 0 && !/^https?:\/\//i.test(url.trim());
  // The widget languages visitors may have (the platform's languages).
  const previewLocales = (allowedLocales.length ? allowedLocales : ['en']).filter(
    (lang): lang is PoweredByLocale => lang in POWERED_BY_WIDGET_WORDS,
  );
  const brandName = brand.trim() || (platformName || '').trim() || t('admin.widgetSettingsPage.poweredBy.defaultBrand');
  // The platform's logo in the name's place, as the widget draws it: the
  // upload in either edition, else the edition's kit.
  const logo = brandAssets.source === 'custom' && brandAssets.lockup && (isInternational || localKit)
    ? brandAssets.lockup.light
    : isInternational
      ? INTL_BRAND.horizontal.light
      : SHIPS_IRAN_KIT && localKit ? WEBYAR_BRAND.logo.light : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('admin.widgetSettingsPage.poweredBy.title')}</CardTitle>
        <CardDescription>{t('admin.widgetSettingsPage.poweredBy.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border border-border p-4 bg-muted/20">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.poweredBy.master')}</Label>
            <p className="text-xs text-muted-foreground">{t('admin.widgetSettingsPage.poweredBy.masterHint')}</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('admin.widgetSettingsPage.poweredBy.prefix')}</Label>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={POWERED_BY_WIDGET_WORDS[(locale in POWERED_BY_WIDGET_WORDS ? locale : 'en') as PoweredByLocale]}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('admin.widgetSettingsPage.poweredBy.prefixHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('admin.widgetSettingsPage.poweredBy.brand')}</Label>
            <Input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder={t('admin.widgetSettingsPage.poweredBy.brandPlaceholder')}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('admin.widgetSettingsPage.poweredBy.brandHint')}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('admin.widgetSettingsPage.poweredBy.url')}</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
          />
          <p className="text-[11px] text-muted-foreground">
            {t('admin.widgetSettingsPage.poweredBy.urlHint')}
          </p>
          {urlInvalid && (
            <p className="text-[11px] text-destructive">{t('admin.widgetSettingsPage.poweredBy.urlInvalid')}</p>
          )}
          {!urlInvalid && /^http:\/\//i.test(url.trim()) && (
            <p className="text-[11px] text-amber-600">
              {t('admin.widgetSettingsPage.poweredBy.httpWarning')}
            </p>
          )}

        </div>

        <div className="rounded-lg border border-border p-4 bg-background space-y-2" data-powered-preview>
          <p className="text-[11px] text-muted-foreground">{t('admin.widgetSettingsPage.poweredBy.preview')}</p>
          {!enabled ? (
            <p className="text-xs text-muted-foreground" data-powered-preview-off>{t('admin.widgetSettingsPage.poweredBy.previewOff')}</p>
          ) : (
            <ul className="space-y-1.5">
              {previewLocales.map((lang) => (
                <li key={lang} className="flex items-center gap-3 text-xs" data-powered-preview-locale={lang}>
                  <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{t(`widgetCatalog.languages.${lang}` as TranslationKey)}</span>
                  <span
                    lang={lang}
                    dir={lang === 'fa' ? 'rtl' : 'ltr'}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1"
                  >
                    <span data-powered-prefix>{poweredByPrefixFor(text, lang)}</span>
                    {logo
                      ? <img src={logo} alt={brandName} className="h-3.5 w-auto" data-powered-logo />
                      : <span data-powered-brand>{brandName}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">{t('admin.widgetSettingsPage.poweredBy.previewPlans')}</p>
        </div>

        <Button
          size="sm"
          disabled={saving || urlInvalid}
          onClick={() =>
            onSave({
              powered_by_enabled: enabled,
              powered_by_text: text.trim(),
              powered_by_brand_text: brand.trim() || null,
              powered_by_url: url.trim() || null,
            })
          }
        >
          {saving ? t('admin.widgetSettingsPage.poweredBy.saving') : t('admin.widgetSettingsPage.poweredBy.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
