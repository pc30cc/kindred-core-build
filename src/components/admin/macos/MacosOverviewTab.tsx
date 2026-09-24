/**
 * Super Admin → macOS app → Overview.
 *
 * One screen answering "what are Macs doing and what are they being told":
 * how many copies are running right now (live, from the server's memory),
 * the update policy Sparkle is following, whether a maintenance notice is
 * showing, and which features or Mac integrations are switched off.
 *
 * Deliberately shows the SAVED settings, not the draft: this is what
 * installed Macs read from GET /api/platform/macos-app, which is one click
 * away at the bottom.
 */
import type { ReactNode } from 'react';
import {
  Activity, Radio, Users, Building2, Download, Wrench, CircleOff, ExternalLink, ArrowUpRight, FileJson,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SettingsSection } from '@/components/admin/settings/SettingsFields';
import { API_BASE } from '@/lib/api';
import { useDesktopLive } from '@/hooks/useDesktopApp';
import { MACOS_PUBLIC_CONFIG_PATH, type MacosAppSettings } from '@/hooks/useMacosApp';
import {
  MACOS_FEATURES,
  MACOS_INTEGRATIONS,
  effectiveFeature,
  maintenanceShowing,
  type MacosTab,
} from './macosModel';
import { cn } from '@/lib/utils';

/** How many versions / OS releases the overview lists before cutting off. */
const TOP = 5;

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Activity; label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-4">
      <span className={cn('flex h-11 w-11 items-center justify-center rounded-full', tone)}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

/** A label / value row of the status cards. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-end font-medium">{children}</span>
    </div>
  );
}

function EditLink({ tab, onNavigate }: { tab: MacosTab; onNavigate: (tab: MacosTab) => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={() => onNavigate(tab)}>
      {t('admin.macosApp.overview.edit')}
      <ArrowUpRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
    </Button>
  );
}

export function MacosOverviewTab({
  settings,
  onNavigate,
}: {
  settings: MacosAppSettings;
  onNavigate: (tab: MacosTab) => void;
}) {
  const { t, locale } = useTranslation();
  const { data, isLoading } = useDesktopLive('macos');
  const live = data?.live;
  const fmt = (n: number) => n.toLocaleString(locale);
  const notSet = t('admin.macosApp.common.notSet');

  const showing = maintenanceShowing(settings);
  const untilText = settings.maintenance_until ? new Date(settings.maintenance_until).toLocaleString(locale) : null;

  const featuresOff = MACOS_FEATURES.filter(({ key }) => !effectiveFeature(settings, key));
  const integrationsOff = MACOS_INTEGRATIONS.filter(({ key }) => !settings[key]);

  const autoUpdate = !settings.auto_update_enabled
    ? t('admin.macosApp.overview.autoManual')
    : settings.auto_download_enabled
      ? t('admin.macosApp.overview.autoCheckAndDownload')
      : t('admin.macosApp.overview.autoCheckOnly');

  const publicUrl = `${API_BASE}${MACOS_PUBLIC_CONFIG_PATH}`;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('admin.macosApp.overview.savedNote')}</p>

      <SettingsSection
        icon={Activity}
        heading={t('admin.macosApp.overview.liveTitle')}
        caption={t('admin.macosApp.overview.liveCaption')}
        action={<EditLink tab="live" onNavigate={onNavigate} />}
      >
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !live ? (
          <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
            {t('admin.macosApp.overview.liveFailed')}
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat icon={Radio} label={t('admin.macosApp.overview.online')} value={fmt(live.online)} tone="bg-emerald-500/10 text-emerald-600" />
              <Stat icon={Users} label={t('admin.macosApp.overview.users')} value={fmt(live.users)} tone="bg-primary/10 text-primary" />
              <Stat icon={Building2} label={t('admin.macosApp.overview.workspaces')} value={fmt(live.workspaces)} tone="bg-violet-500/10 text-violet-600" />
            </div>
            {live.online === 0 ? (
              <p className="text-xs text-muted-foreground">{t('admin.macosApp.overview.noneOnline')}</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <RankedList label={t('admin.macosApp.overview.versions')} items={live.versions.map((v) => ({ name: v.version, count: v.count }))} fmt={fmt} />
                <RankedList label={t('admin.macosApp.overview.oses')} items={(live.oses ?? []).map((o) => ({ name: o.os, count: o.count }))} fmt={fmt} />
              </div>
            )}
          </>
        )}
      </SettingsSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <SettingsSection
          icon={Download}
          heading={t('admin.macosApp.overview.updatesTitle')}
          caption={t('admin.macosApp.overview.updatesCaption')}
          action={<EditLink tab="updates" onNavigate={onNavigate} />}
        >
          <div>
            <Row label={t('admin.macosApp.overview.latest')}>
              <span dir="ltr">{settings.latest_version ?? notSet}</span>
            </Row>
            <Row label={t('admin.macosApp.overview.minimum')}>
              <span dir="ltr">{settings.minimum_supported_version ?? notSet}</span>
            </Row>
            <Row label={t('admin.macosApp.overview.blocked')}>
              {settings.blocked_versions.length === 0 ? (
                t('admin.macosApp.overview.noneBlocked')
              ) : (
                <Badge variant="outline" className="border-rose-500/40 text-rose-600">
                  {t('admin.macosApp.overview.blockedCount', { count: fmt(settings.blocked_versions.length) })}
                </Badge>
              )}
            </Row>
            <Row label={t('admin.macosApp.overview.channel')}>
              {settings.update_channel === 'beta'
                ? t('admin.macosApp.updates.channelBeta')
                : t('admin.macosApp.updates.channelStable')}
            </Row>
            <Row label={t('admin.macosApp.overview.autoUpdate')}>{autoUpdate}</Row>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Wrench}
          heading={t('admin.macosApp.overview.maintenanceTitle')}
          caption={t('admin.macosApp.overview.maintenanceCaption')}
          action={<EditLink tab="maintenance" onNavigate={onNavigate} />}
        >
          <div
            className={cn(
              'flex items-start gap-3 rounded-xl border p-3 text-sm',
              showing ? 'border-rose-500/40 bg-rose-500/10' : 'border-border/70',
            )}
          >
            <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', showing ? 'animate-pulse bg-rose-500' : 'bg-emerald-500')} />
            <div className="space-y-1">
              <p className="font-medium">
                {showing ? t('admin.macosApp.overview.maintenanceOn') : t('admin.macosApp.overview.maintenanceOff')}
              </p>
              {showing && (
                <p className="text-xs text-muted-foreground">
                  {untilText
                    ? t('admin.macosApp.overview.maintenanceUntil', { time: untilText })
                    : t('admin.macosApp.overview.maintenanceNoEnd')}
                </p>
              )}
              {settings.maintenance_enabled && !showing && untilText && (
                <p className="text-xs text-muted-foreground">
                  {t('admin.macosApp.overview.maintenanceExpired', { time: untilText })}
                </p>
              )}
            </div>
          </div>
        </SettingsSection>
      </div>

      <SettingsSection
        icon={CircleOff}
        heading={t('admin.macosApp.overview.offTitle')}
        caption={t('admin.macosApp.overview.offCaption')}
      >
        {featuresOff.length === 0 && integrationsOff.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('admin.macosApp.overview.allOn')}</p>
        ) : (
          <div className="grid gap-3">
            {featuresOff.length > 0 && (
              <OffGroup
                label={t('admin.macosApp.tabs.features')}
                names={featuresOff.map(({ copy }) => t(`admin.macosApp.features.${copy}` as TranslationKey))}
                onEdit={() => onNavigate('features')}
              />
            )}
            {integrationsOff.length > 0 && (
              <OffGroup
                label={t('admin.macosApp.tabs.integration')}
                names={integrationsOff.map(({ copy }) => t(`admin.macosApp.integration.${copy}` as TranslationKey))}
                onEdit={() => onNavigate('integration')}
              />
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        icon={FileJson}
        heading={t('admin.macosApp.overview.publicTitle')}
        caption={t('admin.macosApp.overview.publicCaption')}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <code dir="ltr" className="min-w-0 truncate rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
            {MACOS_PUBLIC_CONFIG_PATH}
          </code>
          <Button asChild variant="outline" size="sm">
            <a href={publicUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="me-1.5 h-4 w-4" />
              {t('admin.macosApp.overview.openPublic')}
            </a>
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}

function RankedList({
  label,
  items,
  fmt,
}: {
  label: string;
  items: Array<{ name: string; count: number }>;
  fmt: (n: number) => string;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const max = items[0]?.count || 1;
  const rest = items.length - TOP;
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="grid gap-1.5">
        {items.slice(0, TOP).map((item) => (
          <div key={item.name} className="grid gap-1">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span dir="ltr" className="min-w-0 truncate">
                {item.name === 'unknown' ? t('admin.macosApp.overview.unknown') : item.name}
              </span>
              <span className="tabular-nums text-muted-foreground">{fmt(item.count)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${(item.count / max) * 100}%` }} />
            </div>
          </div>
        ))}
        {rest > 0 && (
          <p className="text-xs text-muted-foreground">{t('admin.macosApp.overview.more', { count: fmt(rest) })}</p>
        )}
      </div>
    </div>
  );
}

function OffGroup({ label, names, onEdit }: { label: string; names: string[]; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/70 p-3">
      <div className="min-w-0 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="flex flex-wrap gap-1.5">
          {names.map((name) => (
            <Badge key={name} variant="secondary" className="gap-1 font-normal">
              <CircleOff className="h-3 w-3 text-muted-foreground" />
              {name}
            </Badge>
          ))}
        </div>
      </div>
      <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onEdit}>
        {t('admin.macosApp.overview.edit')}
      </Button>
    </div>
  );
}
