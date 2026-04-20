import { useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useLiveVisitors, useVisitorMap, useVisitorMapConfig } from '@/hooks/useVisitors';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { VisitorMap } from '@/components/visitors/VisitorMap';
import { VisitorDrawer } from '@/components/visitors/VisitorDrawer';
import type { VisitorIntelItem } from '@/lib/visitors-api';
import { cn } from '@/lib/utils';
import {
  Search, Eye, Globe2, Users, FileText, Monitor, MapPin,
  RefreshCcw, AlertTriangle, Wifi,
} from 'lucide-react';

function relativeTime(iso: string, t: (k: string, vars?: Record<string, string>) => string) {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return t('visitors.just_now');
  if (diffSec < 3600) return t('visitors.minutesAgo', { n: String(Math.floor(diffSec / 60)) });
  return t('visitors.hoursAgo', { n: String(Math.floor(diffSec / 3600)) });
}

export default function VisitorsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id;

  const [includeOffline, setIncludeOffline] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const live = useLiveVisitors(wsId, includeOffline);
  const map = useVisitorMap(wsId);
  const mapConfig = useVisitorMapConfig(wsId);

  const visitors: VisitorIntelItem[] = live.data?.items ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return visitors;
    const q = search.trim().toLowerCase();
    return visitors.filter(v =>
      (v.current_page || '').toLowerCase().includes(q) ||
      (v.geo.country || '').toLowerCase().includes(q) ||
      (v.geo.city || '').toLowerCase().includes(q) ||
      (v.browser || '').toLowerCase().includes(q) ||
      (v.contact?.name || '').toLowerCase().includes(q) ||
      (v.contact?.email || '').toLowerCase().includes(q)
    );
  }, [visitors, search]);

  const stats = useMemo(() => {
    const online = visitors.filter(v => v.status === 'online').length;
    const active = visitors.filter(v => v.status === 'online' || v.status === 'idle').length;
    const countries = new Set(visitors.map(v => v.geo.country_code).filter(Boolean)).size;
    const pages = new Set(visitors.map(v => v.current_page).filter(Boolean)).size;
    return { online, active, countries, pages };
  }, [visitors]);

  const statusDot: Record<string, string> = {
    online: 'bg-success',
    idle: 'bg-warning',
    offline: 'bg-muted-foreground',
    unknown: 'bg-muted-foreground',
  };

  const statCards = [
    { label: t('visitors.statOnline'), value: stats.online, icon: Eye, color: 'text-success', bg: 'bg-success/10', pulse: stats.online > 0 },
    { label: t('visitors.statActive'), value: stats.active, icon: Wifi, color: 'text-info', bg: 'bg-info/10' },
    { label: t('visitors.statCountries'), value: stats.countries, icon: Globe2, color: 'text-primary', bg: 'bg-primary/10' },
    { label: t('visitors.statPages'), value: stats.pages, icon: FileText, color: 'text-warning', bg: 'bg-warning/10' },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] animate-fade-in">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-4 pb-3 border-b border-border">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h1 className="page-header">{t('visitors.title')}</h1>
            <p className="page-subtitle">{t('visitors.subtitle')}</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <Switch checked={includeOffline} onCheckedChange={setIncludeOffline} />
              {t('visitors.includeOffline')}
            </label>
            <Button
              size="sm" variant="outline"
              onClick={() => { live.refetch(); map.refetch(); }}
              disabled={live.isFetching}
              aria-label={t('visitors.refresh')}
            >
              <RefreshCcw className={cn('w-3.5 h-3.5 me-1.5', live.isFetching && 'animate-spin')} />
              {t('visitors.refresh')}
            </Button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statCards.map(s => (
            <div key={s.label} className="stat-card">
              <div className="flex items-center justify-between mb-3">
                <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center', s.bg)}>
                  <s.icon className={cn('w-4 h-4', s.color)} />
                </div>
                {s.pulse && <div className="h-2 w-2 rounded-full bg-success animate-pulse" />}
              </div>
              <div className="text-2xl font-bold text-foreground">{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Body: list + map */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(320px,420px)_1fr] min-h-0">
        {/* Left: list */}
        <div className="flex flex-col border-e border-border min-h-0 max-h-[60vh] lg:max-h-none">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('visitors.searchPlaceholder')}
                className="ps-9 h-9"
                aria-label={t('visitors.searchPlaceholder')}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{t('visitors.activeSessions')}</span>
              <span>{t('visitors.visitorsCount', { count: String(filtered.length) })}</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {live.isLoading ? (
              <div className="p-3 space-y-2">
                {[1,2,3,4,5].map(i => (
                  <div key={i} className="flex items-center gap-3 p-2">
                    <Skeleton className="w-9 h-9 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-2.5 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : live.isError ? (
              <div className="p-8 text-center">
                <AlertTriangle className="w-8 h-8 text-destructive/60 mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground mb-1">{t('visitors.errorTitle')}</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => live.refetch()}>
                  {t('visitors.errorRetry')}
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center">
                <Eye className="w-9 h-9 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground mb-1">
                  {search ? t('visitors.noSearchResults') : t('visitors.emptyTitle')}
                </p>
                {!search && <p className="text-xs text-muted-foreground">{t('visitors.emptyDesc')}</p>}
              </div>
            ) : (
              <ul className="divide-y divide-border/60" role="list">
                {filtered.map(v => {
                  const isSelected = selectedId === v.id;
                  const name = v.contact?.name || v.contact?.email || t('visitors.unknownVisitor');
                  const loc = [v.geo.city, v.geo.country].filter(Boolean).join(', ') || t('visitors.unknownLocation');
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(v.id)}
                        className={cn(
                          'w-full text-start px-3 py-2.5 flex items-center gap-3 transition-colors',
                          'hover:bg-muted/40 focus:bg-muted/50 focus:outline-none',
                          isSelected && 'bg-primary/5 hover:bg-primary/10'
                        )}
                      >
                        <div className="relative shrink-0">
                          <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                            <Monitor className="w-4 h-4 text-muted-foreground" />
                          </div>
                          <span
                            className={cn(
                              'absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full border-2 border-card',
                              statusDot[v.status]
                            )}
                            aria-label={t(`visitors.${v.status}` as 'visitors.online')}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium text-foreground truncate">{name}</span>
                            {v.conversation && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                                {t('inbox.title') /* generic chip */}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="flex items-center gap-1 min-w-0">
                              <MapPin className="w-3 h-3 shrink-0" />
                              <span className="truncate">{loc}</span>
                            </span>
                            <span className="text-muted-foreground/50">·</span>
                            <span className="shrink-0">{relativeTime(v.last_activity_at, t as (k: string, p?: Record<string, string>) => string)}</span>
                          </div>
                          {v.current_page && (
                            <div className="mt-1 text-[11px] text-muted-foreground/80 truncate flex items-center gap-1">
                              <Globe2 className="w-3 h-3 shrink-0" />
                              <span className="truncate">{v.current_page}</span>
                            </div>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Right: map canvas */}
        <div className="relative min-h-[40vh] lg:min-h-0 bg-muted/20">
          {mapConfig.isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              {t('visitors.mapLoading')}
            </div>
          ) : (
            <>
              <VisitorMap
                config={mapConfig.data}
                markers={map.data?.markers ?? []}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              {mapConfig.data?.enabled && !mapConfig.data?.fallback_no_map && (map.data?.markers.length ?? 0) === 0 && !map.isLoading && (
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <div className="bg-card/90 border border-border rounded-lg px-4 py-3 text-center shadow-sm pointer-events-auto max-w-xs">
                    <Users className="w-6 h-6 text-muted-foreground/40 mx-auto mb-1" />
                    <p className="text-xs font-medium text-foreground">{t('visitors.mapNoMarkersTitle')}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{t('visitors.mapNoMarkersDesc')}</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <VisitorDrawer
        workspaceId={wsId}
        sessionId={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}