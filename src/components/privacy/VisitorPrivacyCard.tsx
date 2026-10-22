/**
 * Settings → Privacy requests → Visitor privacy (P-01, migration 281): what
 * the website widget records about a workspace's visitors, and for how long.
 *
 *   - Wait for visitor consent before tracking (widget_settings
 *     .tracking_requires_consent): tracking starts only after the site calls
 *     `__gs.push(['consent', true])` (docs/WIDGET_PUBLIC_API.md).
 *   - Keep query strings in page history (tracking_keep_query, default off).
 *   - Keep visitor tracking data for … (visitor_data_retention_days; empty =
 *     the platform's period, data_retention_policies).
 *
 * Shown once the database has the columns; until then, a short note.
 */
import { useTranslation } from '@/i18n';
import { useUpdateWidgetSettings, useWidgetSettings, useWidgetVisitorRetention } from '@/hooks/useWidgetSettings';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Eye, Info } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { widgetSaveErrorMessage } from '@/hooks/useWidgetSettingsDraft';
import type { WidgetSettings } from '@/types/models';

/** The periods a workspace may choose (days); the server takes 30 to 1095. */
const VISITOR_RETENTION_CHOICES = [30, 90, 180, 365, 395, 730, 1095] as const;

const DEFAULT_VALUE = 'default';

export function VisitorPrivacyCard({ workspaceId }: { workspaceId: string | undefined }) {
  const { t, dir } = useTranslation();
  const { data: settings, isLoading } = useWidgetSettings(workspaceId);
  const { data: retention } = useWidgetVisitorRetention(workspaceId);
  const updateMut = useUpdateWidgetSettings(workspaceId);

  const period = (days: number) => {
    if (days % 365 === 0) return days === 365 ? t('privacy.visitor.year') : t('privacy.visitor.years', { count: days / 365 });
    if (days === 30) return t('privacy.visitor.month');
    if (days % 30 === 0) return t('privacy.visitor.months', { count: days / 30 });
    if (days === 395) return t('privacy.visitor.months', { count: 13 });
    return t('privacy.visitor.days', { count: days });
  };

  const save = (patch: Partial<WidgetSettings>) => {
    updateMut.mutate(patch, {
      onSuccess: () => toast({ title: t('privacy.visitor.saved') }),
      // Why, in the panel's language (the widget page's sentences), never the server's code.
      onError: (e: Error) => toast({ title: t('privacy.visitor.saveError'), description: widgetSaveErrorMessage(e, t), variant: 'destructive' }),
    });
  };

  if (isLoading || !settings) return null;
  const ready = 'tracking_requires_consent' in settings;
  const days = settings.visitor_data_retention_days ?? null;
  const defaultDays = retention?.default_days ?? null;

  return (
    <Card dir={dir}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Eye className="h-5 w-5" />{t('privacy.visitor.title')}</CardTitle>
        <CardDescription>{t('privacy.visitor.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!ready ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />{t('privacy.visitor.notReady')}
          </p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <Label htmlFor="visitor-consent" className="text-sm font-medium">{t('privacy.visitor.consentTitle')}</Label>
                <p className="text-xs text-muted-foreground">{t('privacy.visitor.consentHint')}</p>
              </div>
              <Switch
                id="visitor-consent"
                checked={settings.tracking_requires_consent === true}
                disabled={updateMut.isPending}
                onCheckedChange={(v) => save({ tracking_requires_consent: v })}
              />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <Label htmlFor="visitor-keep-query" className="text-sm font-medium">{t('privacy.visitor.keepQueryTitle')}</Label>
                <p className="text-xs text-muted-foreground">{t('privacy.visitor.keepQueryHint')}</p>
              </div>
              <Switch
                id="visitor-keep-query"
                checked={settings.tracking_keep_query === true}
                disabled={updateMut.isPending}
                onCheckedChange={(v) => save({ tracking_keep_query: v })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="visitor-retention" className="text-sm font-medium">{t('privacy.visitor.retentionTitle')}</Label>
              <Select
                value={days == null ? DEFAULT_VALUE : String(days)}
                disabled={updateMut.isPending}
                onValueChange={(v) => save({ visitor_data_retention_days: v === DEFAULT_VALUE ? null : Number(v) })}
              >
                <SelectTrigger id="visitor-retention" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>
                    {defaultDays ? t('privacy.visitor.retentionDefault', { period: period(defaultDays) }) : t('privacy.visitor.retentionDefaultUnknown')}
                  </SelectItem>
                  {/* A stored period that is not one of the choices still shows. */}
                  {[...new Set([...VISITOR_RETENTION_CHOICES, ...(days != null ? [days] : [])])].sort((a, b) => a - b).map((d) => (
                    <SelectItem key={d} value={String(d)}>{period(d)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('privacy.visitor.retentionHint')}</p>
              {retention && !retention.enabled && (
                <p className="text-xs text-amber-700 dark:text-amber-400">{t('privacy.visitor.retentionOff')}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
