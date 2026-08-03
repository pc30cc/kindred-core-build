import { useState, useCallback, useMemo } from 'react';
import {
  Activity, CheckCircle, AlertTriangle, XCircle, RefreshCw, Search,
  BarChart3, Video, ArrowRight, LayoutGrid, History, ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  useProviderSummary, PROVIDER_TYPE_KEYS, providerRegistry, getFallbackLog,
  type ProviderTypeKey, type ProviderHealth,
} from '@/providers';
import { PROVIDER_SCHEMAS } from '@/features/providers/schemas';
import { ProviderIcon } from '@/features/providers/ProviderIcon';
import { AdminProviderCard } from '@/features/providers/AdminProviderCard';
import { AdminSmsProviderCard } from '@/features/providers/AdminSmsProviderCard';
import { AdminRealtimeCard } from '@/features/providers/AdminRealtimeCard';
import { PrivacyExportStorageCard } from '@/features/providers/PrivacyExportStorageCard';
import { VisitorIntelligenceSection } from '@/features/providers/VisitorIntelligenceSection';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';

type PanelKey = ProviderTypeKey | 'overview' | 'calls' | 'fallback';

const GROUPS: { key: string; types: ProviderTypeKey[] }[] = [
  { key: 'core', types: ['auth', 'database', 'realtime'] },
  { key: 'communication', types: ['email', 'sms', 'notification'] },
  { key: 'infrastructure', types: ['storage', 'cache', 'cdn', 'search'] },
  { key: 'business', types: ['ai', 'billing', 'feature_flag', 'widget', 'captcha'] },
  { key: 'visitor', types: ['geo_enrichment', 'map_tiles'] },
];

function RenderProviderCard({ type }: { type: ProviderTypeKey }) {
  if (type === 'realtime') return <AdminRealtimeCard />;
  if (type === 'sms') return <AdminSmsProviderCard />;
  if (type === 'storage') {
    return (
      <div className="space-y-4">
        <AdminProviderCard type={type} />
        <PrivacyExportStorageCard />
      </div>
    );
  }
  return <AdminProviderCard type={type} />;
}

export default function AdminProvidersPage() {
  const { t, dir } = useI18n();
  const rtl = dir === 'rtl';
  const summary = useProviderSummary();
  const [searchQuery, setSearchQuery] = useState('');
  const [panel, setPanel] = useState<PanelKey>('overview');
  const [healthOverview, setHealthOverview] = useState<Record<string, Record<string, ProviderHealth>>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const fallbackLog = getFallbackLog();

  const typeLabel = useCallback((type: ProviderTypeKey) => {
    const key = `adminProviders.types.${type}.label`;
    const val = t(key as never);
    return val === key ? (PROVIDER_SCHEMAS[type]?.label ?? type) : val;
  }, [t]);

  const typeDesc = useCallback((type: ProviderTypeKey) => {
    const key = `adminProviders.types.${type}.desc`;
    const val = t(key as never);
    return val === key ? (PROVIDER_SCHEMAS[type]?.description ?? '') : val;
  }, [t]);

  const configured = Object.entries(summary).filter(([, s]) => s.active !== null).length;
  const withEffective = Object.entries(summary).filter(([, s]) => s.effective !== null).length;
  const totalRegistered = Object.values(summary).reduce((sum, s) => sum + s.registered.length, 0);
  const totalVendors = PROVIDER_TYPE_KEYS.reduce((sum, type) => sum + (PROVIDER_SCHEMAS[type]?.vendors.length ?? 0), 0);

  const matches = useCallback((type: ProviderTypeKey) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    const schema = PROVIDER_SCHEMAS[type];
    return (
      type.includes(q) ||
      typeLabel(type).toLowerCase().includes(q) ||
      typeDesc(type).toLowerCase().includes(q) ||
      (schema?.label.toLowerCase().includes(q) ?? false) ||
      (schema?.vendors.some((v) => v.label.toLowerCase().includes(q) || v.name.includes(q)) ?? false)
    );
  }, [searchQuery, typeLabel, typeDesc]);

  const visibleGroups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        types: g.types.filter(
          (t2) => (PROVIDER_TYPE_KEYS as readonly string[]).includes(t2) && matches(t2),
        ),
      })).filter((g) => g.types.length > 0),
    [matches],
  );

  const checkAllProviders = useCallback(async () => {
    setCheckingAll(true);
    const results: Record<string, Record<string, ProviderHealth>> = {};
    await Promise.all(
      PROVIDER_TYPE_KEYS.map(async (type) => {
        results[type] = await providerRegistry.checkAllHealth(type);
      }),
    );
    setHealthOverview(results);
    setCheckingAll(false);
  }, []);

  const healthCounts = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
  for (const typeHealth of Object.values(healthOverview)) {
    for (const h of Object.values(typeHealth)) healthCounts[h]++;
  }

  const stats = [
    { icon: Activity, tone: 'text-primary bg-primary/10', value: `${configured}/${PROVIDER_TYPE_KEYS.length}`, label: t('adminProviders.stats.configured') },
    { icon: CheckCircle, tone: 'text-emerald-500 bg-emerald-500/10', value: String(withEffective), label: t('adminProviders.stats.active') },
    { icon: BarChart3, tone: 'text-muted-foreground bg-muted', value: String(totalRegistered), label: t('adminProviders.stats.registered') },
    { icon: Search, tone: 'text-muted-foreground bg-muted', value: String(totalVendors), label: t('adminProviders.stats.vendors') },
  ];

  const NavButton = ({
    active, onClick, icon, label, badge,
  }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: string }) => (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors text-start',
        active
          ? 'bg-primary/10 text-primary font-medium ring-1 ring-primary/20'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">{badge}</Badge>
      )}
      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 opacity-40', rtl && 'rotate-180')} />
    </button>
  );

  const activeType = (PROVIDER_TYPE_KEYS as readonly string[]).includes(panel as string)
    ? (panel as ProviderTypeKey)
    : null;

  return (
    <div className="space-y-6" dir={dir}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('adminProviders.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('adminProviders.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={checkAllProviders} disabled={checkingAll}>
          <RefreshCw className={cn('h-3.5 w-3.5 me-1.5', checkingAll && 'animate-spin')} />
          {checkingAll ? t('adminProviders.checking') : t('adminProviders.checkAll')}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="border-border/60">
            <CardContent className="py-3 flex items-center gap-3">
              <div className={cn('p-2 rounded-lg', s.tone.split(' ')[1])}>
                <s.icon className={cn('h-4 w-4', s.tone.split(' ')[0])} />
              </div>
              <div className="min-w-0">
                <p className="text-xl font-bold text-foreground leading-tight">{s.value}</p>
                <p className="text-[11px] text-muted-foreground truncate">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Health summary */}
      {Object.keys(healthOverview).length > 0 && (
        <Card className="border-border/60">
          <CardContent className="py-3 flex flex-wrap items-center gap-4">
            <span className="text-xs font-medium text-muted-foreground">{t('adminProviders.health.summary')}</span>
            {healthCounts.healthy > 0 && (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <CheckCircle className="h-3 w-3" /> {healthCounts.healthy} {t('adminProviders.health.healthy')}
              </span>
            )}
            {healthCounts.degraded > 0 && (
              <span className="flex items-center gap-1 text-xs text-amber-500">
                <AlertTriangle className="h-3 w-3" /> {healthCounts.degraded} {t('adminProviders.health.degraded')}
              </span>
            )}
            {healthCounts.down > 0 && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <XCircle className="h-3 w-3" /> {healthCounts.down} {t('adminProviders.health.down')}
              </span>
            )}
            {healthCounts.unknown > 0 && (
              <span className="text-xs text-muted-foreground">
                {healthCounts.unknown} {t('adminProviders.health.unknown')}
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        {/* Sidebar tabs */}
        <Card className="border-border/60 h-fit lg:sticky lg:top-4">
          <CardContent className="p-3 space-y-3">
            <div className="relative">
              <Search className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground start-2.5" />
              <Input
                placeholder={t('adminProviders.search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 text-xs ps-8"
              />
            </div>

            <ScrollArea className="max-h-[60vh] lg:max-h-[calc(100vh-14rem)] pe-1">
              <div className="space-y-4">
                <div className="space-y-1">
                  <NavButton
                    active={panel === 'overview'}
                    onClick={() => setPanel('overview')}
                    icon={<LayoutGrid className="h-4 w-4" />}
                    label={t('adminProviders.tabs.overview')}
                  />
                  <NavButton
                    active={panel === 'calls'}
                    onClick={() => setPanel('calls')}
                    icon={<Video className="h-4 w-4" />}
                    label={t('adminProviders.tabs.calls')}
                  />
                  {fallbackLog.length > 0 && (
                    <NavButton
                      active={panel === 'fallback'}
                      onClick={() => setPanel('fallback')}
                      icon={<History className="h-4 w-4" />}
                      label={t('adminProviders.tabs.fallback')}
                      badge={String(fallbackLog.length)}
                    />
                  )}
                </div>

                {visibleGroups.map((group) => (
                  <div key={group.key} className="space-y-1">
                    <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {t(`adminProviders.groups.${group.key}` as never)}
                    </p>
                    {group.types.map((type) => (
                      <NavButton
                        key={type}
                        active={panel === type}
                        onClick={() => setPanel(type)}
                        icon={<ProviderIcon iconName={PROVIDER_SCHEMAS[type]?.icon ?? 'Shield'} className="h-4 w-4" />}
                        label={typeLabel(type)}
                      />
                    ))}
                  </div>
                ))}

                {visibleGroups.length === 0 && (
                  <p className="px-3 py-6 text-xs text-center text-muted-foreground">
                    {t('adminProviders.noResults')}
                  </p>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Panel */}
        <div className="min-w-0 space-y-4">
          {panel === 'overview' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('adminProviders.overview.title')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t('adminProviders.overview.subtitle')}</p>
              </div>
              {visibleGroups.map((group) => (
                <div key={group.key} className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t(`adminProviders.groups.${group.key}` as never)}
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {group.types.map((type) => {
                      const s = summary[type];
                      const effective = s?.effective ?? null;
                      const explicit = s?.active !== null;
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setPanel(type)}
                          className="text-start rounded-xl border border-border/60 bg-card p-4 hover:border-primary/40 hover:shadow-sm transition-all"
                        >
                          <div className="flex items-center gap-2.5">
                            <div className="p-2 rounded-lg bg-primary/10 text-primary">
                              <ProviderIcon iconName={PROVIDER_SCHEMAS[type]?.icon ?? 'Shield'} className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-foreground truncate">{typeLabel(type)}</p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {effective ?? t('adminProviders.status.none')}
                              </p>
                            </div>
                          </div>
                          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
                            {typeDesc(type)}
                          </p>
                          <div className="mt-3 flex items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px]',
                                explicit
                                  ? 'border-emerald-500/40 text-emerald-500'
                                  : effective
                                    ? 'border-amber-500/40 text-amber-500'
                                    : 'border-border text-muted-foreground',
                              )}
                            >
                              {explicit
                                ? t('adminProviders.status.configured')
                                : effective
                                  ? t('adminProviders.status.fallback')
                                  : t('adminProviders.status.none')}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px] font-normal">
                              {PROVIDER_SCHEMAS[type]?.vendors.length ?? 0} {t('adminProviders.status.vendorsShort')}
                            </Badge>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeType && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
                  <ProviderIcon iconName={PROVIDER_SCHEMAS[activeType]?.icon ?? 'Shield'} className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">{typeLabel(activeType)}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{typeDesc(activeType)}</p>
                </div>
              </div>
              {(activeType === 'geo_enrichment' || activeType === 'map_tiles') && <VisitorIntelligenceSection />}
              <RenderProviderCard type={activeType} />
            </div>
          )}

          {panel === 'calls' && (
            <Card className="border-border/60">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Video className="h-4 w-4 text-primary" /> {t('adminProviders.calls.title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">{t('adminProviders.calls.desc')}</p>
                <Button asChild size="sm">
                  <Link to="/admin/voice-video" className="gap-1.5">
                    {t('adminProviders.calls.cta')}
                    <ArrowRight className={cn('h-3.5 w-3.5', rtl && 'rotate-180')} />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {panel === 'fallback' && (
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-foreground">{t('adminProviders.fallback.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                {fallbackLog.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">{t('adminProviders.fallback.empty')}</p>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {fallbackLog.slice().reverse().map((entry, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 p-2 rounded-md border border-border text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant="outline" className="text-[9px]">{entry.type}</Badge>
                          <span className="text-destructive line-through truncate">{entry.failedProvider}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-foreground font-medium truncate">{entry.fallbackProvider}</span>
                        </div>
                        <span className="text-muted-foreground shrink-0">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
