/**
 * Admin → Providers → Map & Geo
 *
 * Platform-level control surface for the geo enrichment + map filtering
 * pipeline. Settings persist to app_runtime_config.map_geo_settings via
 * the self-hosted backend (/api/admin/map-geo/*). All access is gated by
 * the global admin role (RequireAdmin in App.tsx + requireAdmin on the
 * server). No workspace scoping — these are platform defaults.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, MapPin, Database, Map as MapIcon, Activity, Bug,
  RefreshCw, Save, PlayCircle, AlertTriangle, CheckCircle2, XCircle, Server, Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import {
  mapGeoAdminApi, type MapGeoSettings, type MaxmindStatus,
  type TestIpResult, type WarmGeoResult,
} from '@/lib/map-geo-admin-api';

function StatusBadge({ ok, label, warning }: { ok: boolean; label: string; warning?: boolean }) {
  const cls = ok
    ? 'bg-success/15 text-success border-success/30'
    : warning
      ? 'bg-warning/15 text-warning border-warning/30'
      : 'bg-destructive/15 text-destructive border-destructive/30';
  const Icon = ok ? CheckCircle2 : warning ? AlertTriangle : XCircle;
  return (
    <Badge className={`${cls} text-[10px] h-5`}>
      <Icon className="h-3 w-3 me-1" /> {label}
    </Badge>
  );
}

function SectionCard({
  icon: Icon, title, description, children,
}: { icon: typeof MapPin; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm text-foreground flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
        {description && <p className="text-[11px] text-muted-foreground mt-1">{description}</p>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function FieldRow({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-4 items-start">
      <div className="md:col-span-1">
        <Label className="text-xs font-medium text-foreground">{label}</Label>
        {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="md:col-span-2">{children}</div>
    </div>
  );
}

export default function AdminMapGeoPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const settingsQ = useQuery({
    queryKey: ['admin', 'map-geo', 'settings'],
    queryFn: () => mapGeoAdminApi.getSettings().then(r => r.settings),
    retry: 1,
    retryDelay: 500,
    staleTime: 30_000,
  });
  const statusQ = useQuery({
    queryKey: ['admin', 'map-geo', 'maxmind-status'],
    queryFn: () => mapGeoAdminApi.maxmindStatus(),
    refetchInterval: 30_000,
    retry: 1,
    retryDelay: 500,
  });

  // Local editable copy. Reset on server reload.
  const [draft, setDraft] = useState<MapGeoSettings | null>(null);
  useEffect(() => { if (settingsQ.data) setDraft(settingsQ.data); }, [settingsQ.data]);

  const dirty = useMemo(() => {
    if (!draft || !settingsQ.data) return false;
    return JSON.stringify(draft) !== JSON.stringify(settingsQ.data);
  }, [draft, settingsQ.data]);

  const saveMu = useMutation({
    mutationFn: (next: MapGeoSettings) => mapGeoAdminApi.updateSettings(next),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'map-geo', 'settings'], data.settings);
      qc.invalidateQueries({ queryKey: ['admin', 'map-geo', 'maxmind-status'] });
      toast({
        title: t('admin.mapGeo.toasts.saved'),
        description: data.changed
          ? t('admin.mapGeo.toasts.savedWithChanges')
          : t('admin.mapGeo.toasts.savedNoChanges'),
      });
    },
    onError: (err: any) => toast({
      title: t('admin.mapGeo.toasts.saveFailed'),
      description: err.message, variant: 'destructive',
    }),
  });

  // ─── Diagnostics state ───
  const [testIp, setTestIp] = useState('');
  const [testResult, setTestResult] = useState<TestIpResult | null>(null);
  const testMu = useMutation({
    mutationFn: (ip: string) => mapGeoAdminApi.testIp(ip),
    onSuccess: (r) => setTestResult(r),
    onError: (err: any) => toast({
      title: t('admin.mapGeo.toasts.testFailed'),
      description: err.message, variant: 'destructive',
    }),
  });

  // ─── Warm geo state ───
  const [warmResult, setWarmResult] = useState<WarmGeoResult | null>(null);
  const warmMu = useMutation({
    mutationFn: (opts: { lookback_days: number; limit: number; force: boolean }) =>
      mapGeoAdminApi.warmGeo(opts),
    onSuccess: (r) => {
      setWarmResult(r);
      toast({
        title: t('admin.mapGeo.toasts.warmDone'),
        description: `${t('admin.mapGeo.jobs.stats.enriched')}: ${r.enriched} · ${t('admin.mapGeo.jobs.stats.skipped_no_raw_ip')}: ${r.skipped_no_raw_ip}`,
      });
    },
    onError: (err: any) => toast({
      title: t('admin.mapGeo.toasts.warmFailed'),
      description: err.message, variant: 'destructive',
    }),
  });

  if (settingsQ.isError) {
    const errMsg = (settingsQ.error as Error)?.message || '';
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/admin/providers" className="hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> {t('admin.nav.providers')}
          </Link>
        </div>
        <Card className="bg-card border-destructive/30">
          <CardContent className="py-6 space-y-3">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <XCircle className="h-4 w-4" /> {t('admin.mapGeo.loadError')}
            </div>
            {errMsg && (
              <p className="text-xs text-muted-foreground font-mono break-all">{errMsg}</p>
            )}
            <Button size="sm" variant="outline" onClick={() => settingsQ.refetch()}>
              <RefreshCw className="h-3 w-3 me-1" />
              {t('admin.mapGeo.actions.refresh')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (settingsQ.isLoading || !draft) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const status: MaxmindStatus | undefined = statusQ.data;
  const overviewIssues: string[] = [];
  if (draft.allow_centroid_fallback) overviewIssues.push(t('admin.mapGeo.overview.warnCentroid'));
  if (!draft.store_raw_ip) overviewIssues.push(t('admin.mapGeo.overview.warnRawIp'));
  if (!status?.usable && draft.maxmind_local.enabled) overviewIssues.push(t('admin.mapGeo.overview.warnMmdb'));
  if (draft.min_accuracy_for_map === 'city') overviewIssues.push(t('admin.mapGeo.overview.warnStrict'));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link to="/admin/providers" className="hover:text-foreground inline-flex items-center gap-1">
              <ArrowLeft className="h-3 w-3" /> {t('admin.nav.providers')}
            </Link>
            <span>/</span>
            <span>{t('admin.mapGeo.title')}</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground mt-1">{t('admin.mapGeo.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('admin.mapGeo.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!dirty}
            onClick={() => settingsQ.data && setDraft(settingsQ.data)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!dirty || saveMu.isPending}
            onClick={() => saveMu.mutate(draft)}>
            <Save className="h-3.5 w-3.5 me-1" />
            {saveMu.isPending ? t('common.loading') : t('admin.mapGeo.actions.save')}
          </Button>
        </div>
      </div>

      {/* ─── 1. Overview ─── */}
      <SectionCard
        icon={Activity}
        title={t('admin.mapGeo.overview.title')}
        description={t('admin.mapGeo.overview.subtitle')}
      >
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <div className="p-3 rounded-md border border-border bg-muted/20">
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">{t('admin.mapGeo.overview.activeProvider')}</p>
            <p className="text-sm font-semibold text-foreground mt-1">{draft.default_provider}</p>
          </div>
          <div className="p-3 rounded-md border border-border bg-muted/20">
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">{t('admin.mapGeo.overview.precision')}</p>
            <p className="text-sm font-semibold text-foreground mt-1 capitalize">{draft.preferred_precision}</p>
          </div>
          <div className="p-3 rounded-md border border-border bg-muted/20">
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">{t('admin.mapGeo.overview.minAccuracy')}</p>
            <p className="text-sm font-semibold text-foreground mt-1 capitalize">{draft.min_accuracy_for_map}</p>
          </div>
          <div className="p-3 rounded-md border border-border bg-muted/20">
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">{t('admin.mapGeo.overview.mmdb')}</p>
            <div className="mt-1">
              {status
                ? <StatusBadge ok={!!status.usable} warning={!status.enabled}
                    label={status.usable ? t('admin.mapGeo.status.healthy') : (status.enabled ? t('admin.mapGeo.status.error') : t('admin.mapGeo.status.disabled'))} />
                : <span className="text-xs text-muted-foreground">…</span>}
            </div>
          </div>
        </div>
        {overviewIssues.length > 0 && (
          <div className="space-y-1.5">
            {overviewIssues.map((m, i) => (
              <div key={i} className="flex items-start gap-2 p-2 rounded-md border border-warning/30 bg-warning/5 text-[11px] text-foreground">
                <AlertTriangle className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />
                <span>{m}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ─── 2. Geo Core ─── */}
      <SectionCard icon={MapPin} title={t('admin.mapGeo.core.title')}
        description={t('admin.mapGeo.core.subtitle')}>
        <FieldRow label={t('admin.mapGeo.core.enabled')} hint={t('admin.mapGeo.core.enabledHint')}>
          <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.core.defaultProvider')}>
          <Input value={draft.default_provider}
            onChange={(e) => setDraft({ ...draft, default_provider: e.target.value })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.core.precision')} hint={t('admin.mapGeo.core.precisionHint')}>
          <Select value={draft.preferred_precision}
            onValueChange={(v) => setDraft({ ...draft, preferred_precision: v as any })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="country">{t('admin.mapGeo.precision.country')}</SelectItem>
              <SelectItem value="region">{t('admin.mapGeo.precision.region')}</SelectItem>
              <SelectItem value="city">{t('admin.mapGeo.precision.city')}</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.core.allowCentroid')} hint={t('admin.mapGeo.core.allowCentroidHint')}>
          <Switch checked={draft.allow_centroid_fallback}
            onCheckedChange={(v) => setDraft({ ...draft, allow_centroid_fallback: v })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.core.minAccuracy')} hint={t('admin.mapGeo.core.minAccuracyHint')}>
          <Select value={draft.min_accuracy_for_map}
            onValueChange={(v) => setDraft({ ...draft, min_accuracy_for_map: v as any })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="country">{t('admin.mapGeo.precision.country')}</SelectItem>
              <SelectItem value="region">{t('admin.mapGeo.precision.region')}</SelectItem>
              <SelectItem value="city">{t('admin.mapGeo.precision.city')}</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.core.storeRawIp')} hint={t('admin.mapGeo.core.storeRawIpHint')}>
          <Switch checked={draft.store_raw_ip}
            onCheckedChange={(v) => setDraft({ ...draft, store_raw_ip: v })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.core.retentionDays')}>
          <Input type="number" min={1} max={365} value={draft.raw_ip_retention_days}
            onChange={(e) => setDraft({ ...draft, raw_ip_retention_days: Number(e.target.value) })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.core.autoEnrich')}>
          <Switch checked={draft.auto_enrich_on_session_create}
            onCheckedChange={(v) => setDraft({ ...draft, auto_enrich_on_session_create: v })} />
        </FieldRow>
        {!draft.store_raw_ip && (
          <div className="flex items-start gap-2 p-2 rounded-md border border-border bg-muted/20 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {t('admin.mapGeo.core.privacyNote')}
          </div>
        )}
      </SectionCard>

      {/* ─── 3. MaxMind Local ─── */}
      <SectionCard icon={Database} title={t('admin.mapGeo.mmdb.title')}
        description={t('admin.mapGeo.mmdb.subtitle')}>
        <FieldRow label={t('admin.mapGeo.mmdb.enabled')}>
          <Switch checked={draft.maxmind_local.enabled}
            onCheckedChange={(v) => setDraft({
              ...draft, maxmind_local: { ...draft.maxmind_local, enabled: v },
            })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.mmdb.dbPath')} hint={t('admin.mapGeo.mmdb.dbPathHint')}>
          <Input value={draft.maxmind_local.db_path}
            onChange={(e) => setDraft({
              ...draft, maxmind_local: { ...draft.maxmind_local, db_path: e.target.value },
            })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.mmdb.autoReload')}>
          <Switch checked={draft.maxmind_local.auto_reload}
            onCheckedChange={(v) => setDraft({
              ...draft, maxmind_local: { ...draft.maxmind_local, auto_reload: v },
            })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.mmdb.cacheTtl')}>
          <Input type="number" min={60} max={604800} value={draft.maxmind_local.cache_ttl_seconds}
            onChange={(e) => setDraft({
              ...draft, maxmind_local: { ...draft.maxmind_local, cache_ttl_seconds: Number(e.target.value) },
            })} />
        </FieldRow>

        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-foreground">{t('admin.mapGeo.mmdb.healthTitle')}</h4>
            <Button variant="outline" size="sm" onClick={() => statusQ.refetch()} disabled={statusQ.isFetching}>
              <RefreshCw className={`h-3 w-3 me-1 ${statusQ.isFetching ? 'animate-spin' : ''}`} />
              {t('admin.mapGeo.actions.refresh')}
            </Button>
          </div>
          {status ? (
            <div className="grid gap-2 md:grid-cols-2 text-[11px]">
              <div className="p-2 rounded-md border border-border bg-muted/20 flex items-center justify-between">
                <span className="text-muted-foreground">{t('admin.mapGeo.mmdb.field.configured')}</span>
                <StatusBadge ok={status.configured} label={status.configured ? t('admin.mapGeo.status.yes') : t('admin.mapGeo.status.no')} />
              </div>
              <div className="p-2 rounded-md border border-border bg-muted/20 flex items-center justify-between">
                <span className="text-muted-foreground">{t('admin.mapGeo.mmdb.field.fileExists')}</span>
                <StatusBadge ok={status.file_exists} label={status.file_exists ? t('admin.mapGeo.status.yes') : t('admin.mapGeo.status.no')} />
              </div>
              <div className="p-2 rounded-md border border-border bg-muted/20 flex items-center justify-between">
                <span className="text-muted-foreground">{t('admin.mapGeo.mmdb.field.usable')}</span>
                <StatusBadge ok={status.usable} label={status.usable ? t('admin.mapGeo.status.yes') : t('admin.mapGeo.status.no')} />
              </div>
              <div className="p-2 rounded-md border border-border bg-muted/20 flex items-center justify-between">
                <span className="text-muted-foreground">{t('admin.mapGeo.mmdb.field.size')}</span>
                <span className="font-mono text-foreground">{status.size_bytes ? `${(status.size_bytes / 1024 / 1024).toFixed(1)} MB` : '—'}</span>
              </div>
              <div className="md:col-span-2 p-2 rounded-md border border-border bg-muted/20">
                <span className="text-muted-foreground">{t('admin.mapGeo.mmdb.field.path')}: </span>
                <code className="font-mono text-foreground break-all">{status.db_path || '—'}</code>
              </div>
              {status.error && (
                <div className="md:col-span-2 p-2 rounded-md border border-destructive/30 bg-destructive/5 text-destructive">
                  <strong>{t('admin.mapGeo.status.error')}:</strong> {status.error}
                </div>
              )}
              {status.mtime && (
                <div className="md:col-span-2 text-muted-foreground">
                  {t('admin.mapGeo.mmdb.field.mtime')}: {new Date(status.mtime).toLocaleString()}
                </div>
              )}
            </div>
          ) : statusQ.isLoading ? (
            <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : null}
        </div>

        <div className="text-[11px] text-muted-foreground border-t border-border pt-2 leading-relaxed">
          <Server className="h-3 w-3 inline me-1" />
          {t('admin.mapGeo.mmdb.deployHint')}
        </div>
      </SectionCard>

      {/* ─── 4. Map Behavior ─── */}
      <SectionCard icon={MapIcon} title={t('admin.mapGeo.map.title')}
        description={t('admin.mapGeo.map.subtitle')}>
        <FieldRow label={t('admin.mapGeo.map.showOnlyValid')}>
          <Switch checked={draft.map.show_only_valid_coords}
            onCheckedChange={(v) => setDraft({ ...draft, map: { ...draft.map, show_only_valid_coords: v } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.map.ignoreFallback')} hint={t('admin.mapGeo.map.ignoreFallbackHint')}>
          <Switch checked={draft.map.ignore_fallback_only_points}
            onCheckedChange={(v) => setDraft({ ...draft, map: { ...draft.map, ignore_fallback_only_points: v } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.map.includeLabels')}>
          <Switch checked={draft.map.include_geo_labels}
            onCheckedChange={(v) => setDraft({ ...draft, map: { ...draft.map, include_geo_labels: v } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.map.debugMode')} hint={t('admin.mapGeo.map.debugModeHint')}>
          <Switch checked={draft.map.debug_mode}
            onCheckedChange={(v) => setDraft({ ...draft, map: { ...draft.map, debug_mode: v } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.map.centerMode')}>
          <Select value={draft.map.default_center_mode}
            onValueChange={(v) => setDraft({ ...draft, map: { ...draft.map, default_center_mode: v as any } })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('admin.mapGeo.map.auto')}</SelectItem>
              <SelectItem value="manual">{t('admin.mapGeo.map.manual')}</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.map.defaultLat')}>
          <Input type="number" step="0.000001" min={-90} max={90} value={draft.map.default_lat}
            onChange={(e) => setDraft({ ...draft, map: { ...draft.map, default_lat: Number(e.target.value) } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.map.defaultLng')}>
          <Input type="number" step="0.000001" min={-180} max={180} value={draft.map.default_lng}
            onChange={(e) => setDraft({ ...draft, map: { ...draft.map, default_lng: Number(e.target.value) } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.map.defaultZoom')}>
          <Input type="number" min={0} max={22} value={draft.map.default_zoom}
            onChange={(e) => setDraft({ ...draft, map: { ...draft.map, default_zoom: Number(e.target.value) } })} />
        </FieldRow>
      </SectionCard>

      {/* ─── 5. Geo Jobs ─── */}
      <SectionCard icon={RefreshCw} title={t('admin.mapGeo.jobs.title')}
        description={t('admin.mapGeo.jobs.subtitle')}>
        <FieldRow label={t('admin.mapGeo.jobs.lookback')}>
          <Input type="number" min={1} max={90} value={draft.jobs.warm_lookback_days}
            onChange={(e) => setDraft({ ...draft, jobs: { ...draft.jobs, warm_lookback_days: Number(e.target.value) } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.jobs.limit')}>
          <Input type="number" min={1} max={5000} value={draft.jobs.warm_limit}
            onChange={(e) => setDraft({ ...draft, jobs: { ...draft.jobs, warm_limit: Number(e.target.value) } })} />
        </FieldRow>
        <FieldRow label={t('admin.mapGeo.jobs.force')} hint={t('admin.mapGeo.jobs.forceHint')}>
          <Switch checked={draft.jobs.warm_force_reenrich}
            onCheckedChange={(v) => setDraft({ ...draft, jobs: { ...draft.jobs, warm_force_reenrich: v } })} />
        </FieldRow>
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Button onClick={() => warmMu.mutate({
            lookback_days: draft.jobs.warm_lookback_days,
            limit: draft.jobs.warm_limit,
            force: draft.jobs.warm_force_reenrich,
          })} disabled={warmMu.isPending}>
            <PlayCircle className="h-3.5 w-3.5 me-1" />
            {warmMu.isPending ? t('common.loading') : t('admin.mapGeo.jobs.run')}
          </Button>
          {warmResult && (
            <span className="text-[11px] text-muted-foreground">
              {t('admin.mapGeo.jobs.lastRun')}
            </span>
          )}
        </div>
        {warmResult && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px]">
            {([
              ['scanned', warmResult.scanned],
              ['enriched', warmResult.enriched],
              ['skipped_no_raw_ip', warmResult.skipped_no_raw_ip],
              ['skipped_already_good', warmResult.skipped_already_good],
              ['failed', warmResult.failed],
              ['fallback_count', warmResult.fallback_count],
            ] as const).map(([k, v]) => (
              <div key={k} className="p-2 rounded-md border border-border bg-muted/20 flex items-center justify-between">
                <span className="text-muted-foreground">{t(`admin.mapGeo.jobs.stats.${k}` as Parameters<typeof t>[0])}</span>
                <span className="font-mono text-foreground">{v}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ─── 6. Diagnostics ─── */}
      <SectionCard icon={Bug} title={t('admin.mapGeo.diag.title')}
        description={t('admin.mapGeo.diag.subtitle')}>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label className="text-xs">{t('admin.mapGeo.diag.ip')}</Label>
            <Input value={testIp} onChange={(e) => setTestIp(e.target.value)}
              placeholder="8.8.8.8" className="mt-1" />
          </div>
          <Button onClick={() => testMu.mutate(testIp.trim())}
            disabled={!testIp.trim() || testMu.isPending}>
            <PlayCircle className="h-3.5 w-3.5 me-1" />
            {testMu.isPending ? t('common.loading') : t('admin.mapGeo.diag.run')}
          </Button>
        </div>
        {testResult && (
          <div className="space-y-2">
            <div className="grid gap-2 md:grid-cols-2 text-[11px]">
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.provider')}: </span><span className="font-mono text-foreground">{testResult.result.source_provider ?? '—'}</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.source')}: </span><span className="font-mono text-foreground">{testResult.result.source}</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.country')}: </span><span className="text-foreground">{testResult.result.country ?? '—'} ({testResult.result.country_code ?? '—'})</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.region')}: </span><span className="text-foreground">{testResult.result.region ?? '—'}</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.city')}: </span><span className="text-foreground">{testResult.result.city ?? '—'}</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.coords')}: </span><span className="font-mono text-foreground">{testResult.result.latitude?.toFixed(4) ?? '—'}, {testResult.result.longitude?.toFixed(4) ?? '—'}</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.timezone')}: </span><span className="text-foreground">{testResult.result.timezone ?? '—'}</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20"><span className="text-muted-foreground">{t('admin.mapGeo.diag.field.accuracy')}: </span><span className="font-mono capitalize text-foreground">{testResult.result.accuracy_level ?? '—'}</span></div>
              <div className="p-2 rounded-md border border-border bg-muted/20 md:col-span-2 flex items-center justify-between">
                <span className="text-muted-foreground">{t('admin.mapGeo.diag.field.fallback')}</span>
                <StatusBadge ok={!testResult.result.is_fallback}
                  warning={testResult.result.is_fallback}
                  label={testResult.result.is_fallback ? t('admin.mapGeo.status.fallback') : t('admin.mapGeo.status.precise')} />
              </div>
            </div>
            {testResult.fallback_reason && (
              <div className="p-2 rounded-md border border-warning/30 bg-warning/5 text-[11px] text-foreground flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />
                <span>{testResult.fallback_reason}</span>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}