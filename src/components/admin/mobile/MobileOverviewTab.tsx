/**
 * Readiness at a glance: the score, what is blocking submission right now,
 * and the state of the things this server can actually observe (push
 * credentials, the native checkout, the generated files).
 */
import { AlertTriangle, CheckCircle2, CircleDashed, Server, Smartphone, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { MobileAppPayload } from '@/hooks/useMobileApp';
import { cn } from '@/lib/utils';

export function MobileOverviewTab({
  data,
  onGoToTab,
}: {
  data: MobileAppPayload;
  onGoToTab: (tab: string) => void;
}) {
  const { t } = useTranslation();
  const { summary, checks, environment, settings } = data;

  const blockers = checks.filter((c) => c.severity === 'blocker' && c.status !== 'pass');

  const stats = [
    { key: 'passed', value: summary.passed, icon: CheckCircle2, tone: 'text-emerald-600' },
    { key: 'failed', value: summary.failed, icon: XCircle, tone: 'text-destructive' },
    { key: 'manual', value: summary.manual, icon: CircleDashed, tone: 'text-amber-600' },
    { key: 'blockers', value: summary.blockers, icon: AlertTriangle, tone: 'text-destructive' },
  ] as const;

  const env = [
    { key: 'pushConfigured', ok: environment.pushConfigured },
    { key: 'nativeProject', ok: environment.nativeProject.available },
    { key: 'googleServicePlist', ok: environment.nativeProject.googleServicePlist },
    { key: 'appIcon', ok: environment.nativeProject.appIcon1024 },
    { key: 'privacyManifestFile', ok: environment.nativeProject.privacyManifestFile },
    { key: 'entitlementsFile', ok: environment.nativeProject.entitlementsFile },
  ] as const;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('admin.mobileApp.overview.title')}</CardTitle>
          <p className="text-xs text-muted-foreground">{t('admin.mobileApp.overview.subtitle')}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-4xl font-bold tabular-nums">{summary.score}%</p>
              <p className="text-xs text-muted-foreground">
                {t('admin.mobileApp.overview.ofRequirements', {
                  passed: summary.passed,
                  total: summary.total,
                })}
              </p>
            </div>
            <p
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold',
                summary.submittable
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {summary.submittable
                ? t('admin.mobileApp.overview.readyToSubmit')
                : t('admin.mobileApp.overview.notReady')}
            </p>
          </div>
          <Progress value={summary.score} />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.key} className="rounded-xl border border-border/70 p-3">
                <div className="flex items-center gap-2">
                  <stat.icon className={cn('h-4 w-4', stat.tone)} />
                  <span className="text-xs text-muted-foreground">
                    {t(`admin.mobileApp.overview.stat.${stat.key}` as TranslationKey)}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold tabular-nums">{stat.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">{t('admin.mobileApp.overview.appCard')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label={t('admin.mobileApp.identity.displayName')} value={settings.display_name} />
            <Row label={t('admin.mobileApp.identity.bundleId')} value={settings.bundle_id} mono />
            <Row
              label={t('admin.mobileApp.build.version')}
              value={`${settings.marketing_version} (${settings.build_number})`}
              mono
            />
            <Row
              label={t('admin.mobileApp.identity.teamId')}
              value={settings.apple_team_id || t('admin.mobileApp.common.notSet')}
              mono
            />
            <Row
              label={t('admin.mobileApp.build.minimumOs')}
              value={`iOS ${settings.minimum_os_version}`}
              mono
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">
                {t('admin.mobileApp.overview.environmentCard')}
              </CardTitle>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin.mobileApp.overview.environmentHint')}
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {env.map((entry) => (
              <div key={entry.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  {t(`admin.mobileApp.overview.env.${entry.key}` as TranslationKey)}
                </span>
                {entry.ok ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t('admin.mobileApp.common.present')}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs font-medium text-amber-600">
                    <CircleDashed className="h-3.5 w-3.5" />
                    {t('admin.mobileApp.common.missing')}
                  </span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {blockers.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <CardTitle className="text-base">
                  {t('admin.mobileApp.overview.blockersTitle')}
                </CardTitle>
              </div>
              <Button size="sm" variant="outline" onClick={() => onGoToTab('appStore')}>
                {t('admin.mobileApp.overview.openChecklist')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {blockers.slice(0, 8).map((check) => (
              <div key={check.id} className="flex items-start gap-2 text-sm">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span>{t(`admin.mobileApp.checks.${check.id}.title` as TranslationKey)}</span>
              </div>
            ))}
            {blockers.length > 8 && (
              <p className="text-xs text-muted-foreground">
                {t('admin.mobileApp.overview.andMore', { count: blockers.length - 8 })}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('truncate font-medium', mono && 'font-mono text-[12.5px]')} dir={mono ? 'ltr' : undefined}>
        {value}
      </span>
    </div>
  );
}
