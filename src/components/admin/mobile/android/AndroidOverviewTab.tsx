/**
 * The Android app at a glance: what is on Play, what is ready for it, and
 * which in-app switches are away from their defaults.
 *
 * The checks are the few this screen can know for itself — a listing link,
 * a privacy policy, a target SDK Google Play still accepts, push credentials
 * on this server. Everything else about a Play release lives in the Play
 * Console, and pretending otherwise would be a score that means nothing.
 */
import { CheckCircle2, Smartphone, ToggleRight, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { MobileAppPayload } from '@/hooks/useMobileApp';
import { androidChecks, PLAY_MIN_TARGET_SDK } from './androidChecks';
import { cn } from '@/lib/utils';

export function AndroidOverviewTab({
  data,
  onGoToTab,
}: {
  data: MobileAppPayload;
  onGoToTab: (tab: string) => void;
}) {
  const { t } = useTranslation();
  const settings = data.settings;
  const checks = androidChecks(settings, data.environment.pushConfigured);
  const passed = checks.filter((c) => c.ok).length;

  // The switches that differ from how the app behaves out of the box.
  const switches = [
    { key: 'showStorage', on: settings.android_app_show_storage, standard: true },
    { key: 'showSecurity', on: settings.android_app_show_security, standard: true },
    { key: 'showNotificationSettings', on: settings.android_app_show_notification_settings, standard: true },
    { key: 'allowWallpaperColors', on: settings.android_app_allow_wallpaper_colors, standard: true },
    { key: 'profileNameEditable', on: settings.android_app_profile_name_editable, standard: false },
    { key: 'profilePhoneEditable', on: settings.android_app_profile_phone_editable, standard: false },
    { key: 'profilePhotoEditable', on: settings.android_app_profile_photo_editable, standard: true },
  ] as const;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4 text-primary" />
            {settings.android_app_name}
          </CardTitle>
          <p className="text-xs text-muted-foreground" dir="ltr">
            {settings.android_package_name}
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.mobileApp.android.overview.version')}</p>
            <p className="font-semibold tabular-nums" dir="ltr">
              {settings.android_version_name} ({settings.android_version_code})
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.mobileApp.android.overview.track')}</p>
            <p className="font-semibold">
              {t(`admin.mobileApp.android.release.track${
                settings.android_release_track.charAt(0).toUpperCase() + settings.android_release_track.slice(1)
              }` as TranslationKey)}
              {settings.android_release_track === 'production' && settings.android_rollout_percent < 100 && (
                <span className="ms-2 text-xs text-muted-foreground tabular-nums">
                  {t('admin.mobileApp.android.overview.rolloutAt', { percent: settings.android_rollout_percent })}
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.mobileApp.android.overview.sdk')}</p>
            <p className="font-semibold tabular-nums" dir="ltr">
              {settings.android_min_sdk} – {settings.android_target_sdk}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">{t('admin.mobileApp.android.overview.readiness')}</CardTitle>
            <Badge variant={passed === checks.length ? 'default' : 'secondary'} className="tabular-nums">
              {t('admin.mobileApp.android.overview.passed', { passed, total: checks.length })}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {checks.map((check) => (
            <div
              key={check.key}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3"
            >
              <div className="flex items-start gap-2">
                {check.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <div>
                  <p className="text-sm font-medium">
                    {t(`admin.mobileApp.android.overview.checks.${check.key}` as TranslationKey)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`admin.mobileApp.android.overview.checks.${check.key}Hint` as TranslationKey, {
                      sdk: PLAY_MIN_TARGET_SDK,
                    })}
                  </p>
                </div>
              </div>
              {!check.ok && check.tab && (
                <Button size="sm" variant="outline" onClick={() => onGoToTab(check.tab)}>
                  {t('admin.mobileApp.android.overview.fix')}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ToggleRight className="h-4 w-4 text-primary" />
              {t('admin.mobileApp.android.overview.switches')}
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => onGoToTab('inApp')}>
              {t('admin.mobileApp.android.overview.editSwitches')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('admin.mobileApp.android.overview.switchesCaption')}</p>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {switches.map((entry) => (
            <div
              key={entry.key}
              className={cn(
                'flex items-center justify-between gap-3 rounded-xl border p-3 text-sm',
                entry.on !== entry.standard ? 'border-primary/40 bg-primary/5' : 'border-border/70',
              )}
            >
              <span>{t(`admin.mobileApp.android.inApp.${entry.key}` as TranslationKey)}</span>
              <Badge variant={entry.on ? 'default' : 'secondary'}>
                {entry.on ? t('admin.mobileApp.android.overview.on') : t('admin.mobileApp.android.overview.off')}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
