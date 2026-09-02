import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { useLiveVisitors, useVisitorMap, useVisitorMapConfig } from '@/hooks/useVisitors';
import { useVisitorsRealtime } from '@/hooks/useVisitorsRealtime';
import { warmVisitorGeo } from '@/lib/visitors-api';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { VisitorMap } from '@/components/visitors/VisitorMap';
import { VisitorDetailPanel } from '@/components/visitors/VisitorDetailPanel';
import type { VisitorIntelItem, MapMarker } from '@/lib/visitors-api';
import { cn } from '@/lib/utils';
import {
  Search, Eye, Globe2, Users, FileText, Monitor, MapPin,
  RefreshCcw, AlertTriangle, Wifi, MessageSquare, X, Flame,
} from 'lucide-react';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { localizedCountryName } from '@/lib/geo/countryLocalization';
import { localizedLocationLabel } from '@/lib/geo/localizedGeo';
import { contactDisplayName } from '@/lib/contact-display';

function relativeTime(iso: string, t: (k: string, vars?: Record<string, string>) => string) {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return t('visitors.just_now');
  if (diffSec < 3600) return t('visitors.minutesAgo', { n: String(Math.floor(diffSec / 60)) });
  return t('visitors.hoursAgo', { n: String(Math.floor(diffSec / 3600)) });
}

export default function VisitorsPage() {
  const { t, locale } = useTranslation();
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id;
  const { data: role } = useWorkspaceRole(wsId);
  const isAdmin = role === 'owner' || role === 'admin';
  const qc = useQueryClient();
  const [warming, setWarming] = useState(false);

  const onWarmGeo = useCallback(async () => {
    if (!wsId || warming) return;
    setWarming(true);
    try {
      const r = await warmVisitorGeo(wsId, { lookback_days: 7, limit: 100 });
      if (r.status === 'noop') {
        toast({
          title: t('visitors.warmGeoCta'),
          description: t('visitors.warmGeoNoop', { state: r.reason ?? 'unknown' }),
        });
      } else {
        toast({
          title: t('visitors.warmGeoCta'),
          description: t('visitors.warmGeoDone', {
            enriched: String(r.enriched), cached: String(r.cached),
            centroid: String(r.centroid), skipped: String(r.skipped),
          }),
        });
        qc.invalidateQueries({ queryKey: ['visitor-intel-live', wsId] });
        qc.invalidateQueries({ queryKey: ['visitor-intel-map', wsId] });
      }
    } catch (err: any) {
      const msg = String(err?.message || '');
      toast({
        title: t('visitors.warmGeoCta'),
        description: msg.includes('Cooldown') ? t('visitors.warmGeoCooldown') : msg,
        variant: 'destructive',
      });
    } finally {
      setWarming(false);
    }
  }, [wsId, warming, qc, t]);

  const [includeOffline, setIncludeOffline] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterOnline, setFilterOnline] = useState(false);
  const [filterHasConv, setFilterHasConv] = useState(false);
  const [filterCountry, setFilterCountry] = useState<string>('all');

  const live = useLiveVisitors(wsId, includeOffline);
  const map = useVisitorMap(wsId);
  const mapConfig = useVisitorMapConfig(wsId);
  // Realtime push: patches the cached live + map data; falls back to polling.
  useVisitorsRealtime(wsId);

  const visitors: VisitorIntelItem[] = live.data?.items ?? [];

  // Country list derived from current visitors (for the dropdown). Localized
  // for display only — filtering still matches on the canonical country_code.
  const countryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of visitors) {
      const code = v.geo.country_code;
      const name = v.geo.country;
      if (code && name && !seen.has(code)) seen.set(code, name);
    }
    return [...seen.entries()]
      .map(([code, name]) => ({ code, name: localizedCountryName(code, locale, name) ?? name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [visitors, locale]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visitors.filter((v) => {
      if (filterOnline && v.status !== 'online') return false;
      if (filterHasConv && !v.conversation) return false;
      if (filterCountry !== 'all' && v.geo.country_code !== filterCountry) return false;
      if (!q) return true;
      return (
        (v.current_page || '').toLowerCase().includes(q) ||
        (v.geo.country || '').toLowerCase().includes(q) ||
        (v.geo.city || '').toLowerCase().includes(q) ||
        (v.browser || '').toLowerCase().includes(q) ||
        (v.contact?.name || '').toLowerCase().includes(q) ||
        (v.contact?.email || '').toLowerCase().includes(q)
      );
    });
  }, [visitors, search, filterOnline, filterHasConv, filterCountry]);

  // Keyboard navigation: ↑/↓ moves the focused row, Enter opens the drawer,
  // Esc closes it. Roving tabindex pattern keeps Tab order shallow.
  const listRef = useRef<HTMLUListElement>(null);
  const focusRow = useCallback((id: string | null) => {
    if (!id) return;
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-visitor-id="${id}"]`,
    );
    el?.focus();
  }, []);
  const onListKeyDown = useCallback((e: React.KeyboardEvent<HTMLUListElement>) => {
    if (filtered.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentId = active?.dataset?.visitorId ?? null;
    const idx = currentId ? filtered.findIndex((v) => v.id === currentId) : -1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = filtered[Math.min(filtered.length - 1, idx + 1)] ?? filtered[0];
      focusRow(next.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = filtered[Math.max(0, idx - 1)] ?? filtered[0];
      focusRow(next.id);
    } else if (e.key === 'Enter' && currentId) {
      e.preventDefault();
      setSelectedId(currentId);
    }
  }, [filtered, focusRow]);
  // Esc closes the drawer (Sheet already does this when focused; this covers
  // the case where focus stayed on the list).
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  // Map markers must reflect the same filter set as the list, so the two
  // surfaces stay in sync. Build a Set of allowed session ids and intersect.
  const filteredMarkers: MapMarker[] = useMemo(() => {
    const allMarkers = map.data?.markers ?? [];
    const filtersActive =
      !!search.trim() || filterOnline || filterHasConv || filterCountry !== 'all';
    if (!filtersActive) return allMarkers;
    const allowed = new Set(filtered.map((v) => v.id));
    return allMarkers.filter((m) => allowed.has(m.id));
  }, [map.data?.markers, filtered, search, filterOnline, filterHasConv, filterCountry]);

  const activeFilterCount =
    (filterOnline ? 1 : 0) + (filterHasConv ? 1 : 0) + (filterCountry !== 'all' ? 1 : 0);
  const resetFilters = () => {
    setFilterOnline(false);
    setFilterHasConv(false);
    setFilterCountry('all');
  };

  const stats = useMemo(() => {
    const online = visitors.filter(v => v.status === 'online').length;
    const active = visitors.filter(v => v.status === 'online' || v.status === 'idle').length;
    const countries = new Set(visitors.map(v => v.geo.country_code).filter(Boolean)).size;
    const pages = new Set(visitors.map(v => v.current_page).filter(Boolean)).size;
    return { online, active, countries, pages };
  }, [visitors]);

  // Geo source breakdown — drives the header insight strip. Derived from the
  // same `visitors` array as the list/map so it updates in realtime when the
  // realtime hook patches the cache (no extra refetch).
  const geoInsight = useMemo(() => {
    let precise = 0, approximate = 0, unavailable = 0;
    for (const v of visitors) {
      const s = v.geo.source;
      if (s === 'provider' || s === 'cache') precise++;
      else if (s === 'centroid') approximate++;
      else unavailable++;
    }
    const total = visitors.length;
    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
    return {
      total,
      precise,
      approximate,
      unavailable,
      withoutLocation: map.data?.without_location ?? unavailable,
      pctPrecise: pct(precise),
      pctApprox: pct(approximate),
      pctUnavailable: pct(unavailable),
    };
  }, [visitors, map.data?.without_location]);

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
    <div className="flex flex-col h-full min-h-0 animate-fade-in">
      {/* Body: list + map */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left: list (resizable on desktop) */}
        <div
          className="relative flex flex-col border-e border-border min-h-0 max-h-[60vh] lg:max-h-none w-full lg:w-auto shrink-0"
          style={isDesktop ? { width: listWidth } : undefined}
        >
          {/* Resize handle (desktop) */}
          <div
            onMouseDown={() => setIsResizing(true)}
            onDoubleClick={() => setListWidth(380)}
            className={cn(
              'hidden lg:block absolute inset-y-0 w-1.5 cursor-col-resize z-[500] hover:bg-primary/30 transition-colors',
              isResizing && 'bg-primary/40'
            )}
            style={{ insetInlineEnd: -3 }}
            role="separator"
            aria-orientation="vertical"
          />

          {selectedId ? (
            <VisitorDetailPanel
              workspaceId={wsId}
              sessionId={selectedId}
              onBack={() => setSelectedId(null)}
            />
          ) : (
          <>
          <div className="p-3 border-b border-border">
            {/* Compact title above search */}
            <div className="mb-2 px-0.5">
              <h1 className="text-sm font-semibold text-foreground leading-tight">{t('visitors.title')}</h1>
              <p className="text-[11px] text-muted-foreground leading-tight">{t('visitors.subtitle')}</p>
            </div>
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
            {/* Filter chips */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFilterOnline((v) => !v)}
                aria-pressed={filterOnline}
                className={cn(
                  'inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] border transition-colors',
                  filterOnline
                    ? 'bg-success/15 border-success/30 text-success'
                    : 'bg-background border-border text-muted-foreground hover:bg-muted/50'
                )}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-success" />
                {t('visitors.filterOnline')}
              </button>
              <button
                type="button"
                onClick={() => setFilterHasConv((v) => !v)}
                aria-pressed={filterHasConv}
                className={cn(
                  'inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] border transition-colors',
                  filterHasConv
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'bg-background border-border text-muted-foreground hover:bg-muted/50'
                )}
              >
                <MessageSquare className="w-3 h-3" />
                {t('visitors.filterHasConversation')}
              </button>
              <Select value={filterCountry} onValueChange={setFilterCountry}>
                <SelectTrigger
                  className="h-6 px-2 w-auto min-w-[110px] text-[11px] rounded-full border-border bg-background gap-1"
                  aria-label={t('visitors.filterCountry')}
                >
                  <Globe2 className="w-3 h-3 text-muted-foreground" />
                  <SelectValue placeholder={t('visitors.filterCountryAll')} />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  <SelectItem value="all">{t('visitors.filterCountryAll')}</SelectItem>
                  {countryOptions.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50"
                >
                  <X className="w-3 h-3" />
                  {t('visitors.filterReset')}
                </button>
              )}
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
              <ul
                ref={listRef}
                className="divide-y divide-border/60 outline-none"
                role="listbox"
                aria-label={t('visitors.activeSessions')}
                tabIndex={-1}
                onKeyDown={onListKeyDown}
              >
                {filtered.map(v => {
                  const isSelected = selectedId === v.id;
                  // Identity is resolved exactly like Inbox/Contacts: never the
                  // generic "unknown visitor" label — a stable, geo-aware code.
                  const name = contactDisplayName(
                    v.contact ?? null,
                    v.contact?.id ?? v.id,
                    t,
                    v.geo,
                    locale,
                  );
                  const loc = localizedLocationLabel(v.geo, locale) || t('visitors.unknownLocation');
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        data-visitor-id={v.id}
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => setSelectedId(v.id)}
                        className={cn(
                          'w-full text-start px-3 py-2.5 flex items-center gap-3 transition-colors',
                          'hover:bg-muted/40 focus:bg-muted/50 focus:outline-none',
                          isSelected && 'bg-primary/5 hover:bg-primary/10'
                        )}
                      >
                        <div className="relative shrink-0">
                          <ContactAvatar
                            name={name}
                            email={v.contact?.email}
                            avatarUrl={v.contact?.avatar_url}
                            os={v.os}
                            device={v.device}
                            countryCode={v.geo?.country_code}
                            size="sm"
                          />
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

          {/* Footer controls — refresh, include offline, warm geo */}
          <div className="border-t border-border p-2.5 space-y-2 bg-muted/20">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
                <Switch checked={includeOffline} onCheckedChange={setIncludeOffline} />
                {t('visitors.includeOffline')}
              </label>
              <Button
                size="sm" variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => { live.refetch(); map.refetch(); }}
                disabled={live.isFetching}
                aria-label={t('visitors.refresh')}
              >
                <RefreshCcw className={cn('w-3 h-3 me-1', live.isFetching && 'animate-spin')} />
                {t('visitors.refresh')}
              </Button>
            </div>
            {isAdmin && (
              <Button
                size="sm" variant="outline"
                className="w-full h-7 text-[11px]"
                onClick={onWarmGeo}
                disabled={warming}
                title={t('visitors.warmGeoDesc')}
                aria-label={t('visitors.warmGeoCta')}
              >
                <Flame className={cn('w-3 h-3 me-1', warming && 'animate-pulse')} />
                {warming ? t('visitors.warmGeoRunning') : t('visitors.warmGeoCta')}
              </Button>
            )}
            {geoInsight.total > 0 && (
              <div
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground pt-1"
                aria-label={t('visitors.insightTitle')}
              >
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-success" aria-hidden />
                  <span className="text-foreground tabular-nums">{geoInsight.precise}</span>
                  <span>{t('visitors.insightPrecise')}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning" aria-hidden />
                  <span className="text-foreground tabular-nums">{geoInsight.approximate}</span>
                  <span>{t('visitors.insightApproximate')}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
                  <span className="text-foreground tabular-nums">{geoInsight.unavailable}</span>
                  <span>{t('visitors.insightUnavailable')}</span>
                </span>
              </div>
            )}
          </div>
          </>
          )}
        </div>

        {/* Right: map canvas */}
        <div
          className="relative min-h-[40vh] lg:min-h-0 bg-muted/20"
          style={
            mapConfig.data?.display && !mapConfig.data.display.fill_viewport
              ? { height: `${mapConfig.data.display.height_px}px` }
              : undefined
          }
        >
          {mapConfig.isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              {t('visitors.mapLoading')}
            </div>
          ) : (
            <>
              <VisitorMap
                config={mapConfig.data}
                markers={filteredMarkers}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              {/* Stat overlay — Crisp-style floating panel on top of the map */}
              <div className="pointer-events-none absolute top-3 start-3 z-[400] flex flex-wrap gap-2 max-w-[calc(100%-1.5rem)]">
                {statCards.map(s => (
                  <div
                    key={s.label}
                    className="pointer-events-auto flex items-center gap-2 rounded-lg bg-card/95 backdrop-blur-sm border border-border shadow-sm px-3 py-2 min-w-[120px]"
                  >
                    <div className={cn('w-8 h-8 rounded-md flex items-center justify-center shrink-0', s.bg)}>
                      <s.icon className={cn('w-4 h-4', s.color)} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-lg font-bold text-foreground leading-none tabular-nums">{s.value}</span>
                        {s.pulse && <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{s.label}</div>
                    </div>
                  </div>
                ))}
              </div>
              {mapConfig.data?.enabled && !mapConfig.data?.fallback_no_map && filteredMarkers.length === 0 && !map.isLoading && (
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
    </div>
  );
}