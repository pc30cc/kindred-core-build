/**
 * Platform-owned "Powered by" footer configuration.
 *
 * Only platform admins reach this surface — workspace owners can no longer set
 * a branding name for the widget footer. Visibility per customer is decided in
 * Plans via the `widget_powered_by` feature toggle; this screen owns the master
 * switch, the wording and the outbound link.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { useTranslation } from '@/i18n';

interface Props {
  settings: WidgetPlatformSettings;
  onSave: (patch: Partial<WidgetPlatformSettings>) => void;
  saving: boolean;
}

export function PoweredBySection({ settings, onSave, saving }: Props) {
  const { t } = useTranslation();
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('admin.widgetSettingsPage.poweredBy.title' as any)}</CardTitle>
        <CardDescription>{t('admin.widgetSettingsPage.poweredBy.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border border-border p-4 bg-muted/20">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.poweredBy.master' as any)}</Label>
            <p className="text-xs text-muted-foreground">{t('admin.widgetSettingsPage.poweredBy.masterHint' as any)}</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('admin.widgetSettingsPage.poweredBy.prefix' as any)}</Label>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('admin.widgetSettingsPage.poweredBy.defaultPrefix' as any)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('admin.widgetSettingsPage.poweredBy.prefixHint' as any)}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('admin.widgetSettingsPage.poweredBy.brand' as any)}</Label>
            <Input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder={t('admin.widgetSettingsPage.poweredBy.brandPlaceholder' as any)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('admin.widgetSettingsPage.poweredBy.brandHint' as any)}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('admin.widgetSettingsPage.poweredBy.url' as any)}</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
          />
          <p className="text-[11px] text-muted-foreground">
            {t('admin.widgetSettingsPage.poweredBy.urlHint' as any)}
          </p>
          {urlInvalid && (
            <p className="text-[11px] text-destructive">{t('admin.widgetSettingsPage.poweredBy.urlInvalid' as any)}</p>
          )}
          {!urlInvalid && /^http:\/\//i.test(url.trim()) && (
            <p className="text-[11px] text-amber-600">
              {t('admin.widgetSettingsPage.poweredBy.httpWarning' as any)}
            </p>
          )}

        </div>

        <div className="rounded-lg border border-border p-4 bg-background">
          <p className="text-[11px] text-muted-foreground mb-2">{t('admin.widgetSettingsPage.poweredBy.preview' as any)}</p>
          <p className="text-xs">
            {(text.trim() || t('admin.widgetSettingsPage.poweredBy.defaultPrefix' as any)) + ' ' + (brand.trim() || t('admin.widgetSettingsPage.poweredBy.defaultBrand' as any))}
          </p>
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
          {saving ? t('admin.widgetSettingsPage.poweredBy.saving' as any) : t('admin.widgetSettingsPage.poweredBy.save' as any)}
        </Button>
      </CardContent>
    </Card>
  );
}
