import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Loader2, MapPin, AlertTriangle, CheckCircle2, RefreshCw, Trash2, PlayCircle, Save, Undo2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { mapGeoApi, type MapGeoSettings, type MaxmindRuntimeHealth } from '@/lib/map-geo-api';
import { MapTilesPreview } from '@/components/admin/MapTilesPreview';

/**
 * Tile provider presets — all free / no-key sources, picked for visual
 * variety: standard, light/minimal, dark, and topographic. Operators can
 * still type a custom URL template; the preset just fills the two fields.
 *
 * NOTE: Carto and Stadia ask for attribution — we surface the canonical
 * strings so the map UI stays compliant. OSM is the safe default.
 */

/**
 * MaxMind Local runtime diagnostics.
 *
 * The point of this panel is that geo degradation is NEVER silent: if the
 * provider is enabled but the .mmdb file is missing, unreadable or corrupt,
 * the admin sees exactly which of those it is — while visitors keep working
 * on fallback sources.
 */
function MaxmindRuntimePanel({ health, t }: { health: MaxmindRuntimeHealth | null; t: (k: string) => string }) {
  if (!health?.maxmind_local) return null;
  const m = health.maxmind_local;
  const u = health.maxmind_update;
  const yn = (v: boolean) => (v ? t('admin.mapGeo.runtime.yes') : t('admin.mapGeo.runtime.no'));
  const rows: Array<[string, string]> = [
    [t('admin.mapGeo.runtime.enabled'), m.enabled ? t('admin.mapGeo.runtime.enabledLabel') : t('admin.mapGeo.runtime.disabledLabel')],
    [t('admin.mapGeo.runtime.path'), m.db_path || '—'],
    [t('admin.mapGeo.runtime.fileExists'), yn(m.file_exists)],
    [t('admin.mapGeo.runtime.readable'), yn(m.readable)],
    [t('admin.mapGeo.runtime.usable'), yn(m.usable)],
    [t('admin.mapGeo.runtime.modified'), m.mtime ?? '—'],
    [t('admin.mapGeo.runtime.buildEpoch'), m.build_epoch ?? '—'],
    [t('admin.mapGeo.runtime.edition'), m.database_type ?? '—'],
    [t('admin.mapGeo.runtime.autoUpdate'), u?.enabled ? t('admin.mapGeo.runtime.enabledLabel') : t('admin.mapGeo.runtime.disabledLabel')],
    [t('admin.mapGeo.runtime.lastUpdate'), u?.last_status === 'success' && u?.last_run_at ? u.last_run_at : t('admin.mapGeo.runtime.never')],
    [t('admin.mapGeo.runtime.lastError'), u?.last_error ?? '—'],
  ];
  return (
    <div className="space-y-3">
      {health.degraded && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('admin.mapGeo.runtime.degradedTitle')}</AlertTitle>
          <AlertDescription>{t('admin.mapGeo.runtime.degraded')}</AlertDescription>
        </Alert>
      )}
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="flex items-center gap-2 mb-2">
          {m.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
          <span className="text-sm font-semibold">{t('admin.mapGeo.runtime.title')}</span>
          <Badge variant={m.ok ? 'default' : 'destructive'} className="ms-auto">
            {m.ok ? t('admin.mapGeo.maxmind.statusOk') : t('admin.mapGeo.maxmind.statusFail')}
          </Badge>
        </div>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3 border-b border-border/40 py-1">
              <dt className="text-muted-foreground shrink-0">{k}</dt>
              <dd className="font-mono text-[11px] text-foreground break-all text-end">{v}</dd>
            </div>
          ))}
        </dl>
        {m.error && <p className="mt-2 text-xs text-destructive break-all">{m.error}</p>}
      </div>
    </div>
  );
}

const TILE_PRESETS: Array<{
  id: string;
  label: string;
  theme: 'light' | 'dark' | 'standard' | 'topo';
  url: string;
  attribution: string;
  maxZoom: number;
}> = [
  {
    id: 'osm',
    label: 'OpenStreetMap (standard)',
    theme: 'standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
  {
    id: 'carto-voyager',
    label: 'Carto Voyager (balanced)',
    theme: 'standard',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
  },
  {
    id: 'carto-positron',
    label: 'Carto Positron (light, minimal) ☀️',
    theme: 'light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
  },
  {
    id: 'carto-positron-nolabels',
    label: 'Carto Positron — no labels (ultra clean) ☀️',
    theme: 'light',
    url: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
  },
  {
    id: 'carto-dark',
    label: 'Carto Dark Matter (dark) 🌙',
    theme: 'dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
  },
  {
    id: 'carto-dark-nolabels',
    label: 'Carto Dark Matter — no labels 🌙',
    theme: 'dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
  },
  {
    id: 'stadia-smooth',
    label: 'Stadia Alidade Smooth (light) ☀️',
    theme: 'light',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    maxZoom: 20,
  },
  {
    id: 'stadia-smooth-dark',
    label: 'Stadia Alidade Smooth Dark 🌙',
    theme: 'dark',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    maxZoom: 20,
  },
  {
    id: 'esri-gray',
    label: 'Esri World Gray Canvas (very minimal) ☀️',
    theme: 'light',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri',
    maxZoom: 16,
  },
  {
    id: 'esri-dark-gray',
    label: 'Esri World Dark Gray Canvas 🌙',
    theme: 'dark',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri',
    maxZoom: 16,
  },
  {
    id: 'opentopo',
    label: 'OpenTopoMap (topographic)',
    theme: 'topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  },
];

/**
 * Map & Geo settings page.
 *
 * Edits are kept in a local `draft` and only persisted when the operator
 * clicks "Save settings" in the active tab. Each tab saves only its own
 * section, with an "unsaved changes" indicator + Reset button.
 */
export default function MapGeoPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<MapGeoSettings | null>(null);
  const [draft, setDraft] = useState<MapGeoSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const [testIp, setTestIp] = useState('');
  const [testResult, setTestResult] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await mapGeoApi.getSettings();
      setSettings(s.settings);
      setDraft(s.settings);
      mapGeoApi.health().then(setHealth).catch(() => setHealth(null));
    } catch (e: any) {
      const msg = e?.message || 'Failed to load Map & Geo settings';
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  /**
   * Persist a single section of the draft to the server. Section save keeps
   * the API surface scoped — operators can save Geo without flushing
   * unrelated draft edits in other tabs.
   */
  const saveSection = async <K extends keyof MapGeoSettings>(section: K) => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await mapGeoApi.updateSettings({ [section]: draft[section] } as any);
      setSettings(r.settings);
      // Keep the draft in sync with persisted state for this section,
      // but preserve the user's in-progress edits in other tabs.
      setDraft((prev) => prev ? { ...prev, [section]: r.settings[section] } : r.settings);
      toast.success(t('admin.mapGeo.saved'));
      mapGeoApi.health().then(setHealth).catch(() => {});
    } catch (e: any) {
      toast.error(e.message || t('admin.mapGeo.saveError'));
    } finally {
      setSaving(false);
    }
  };

  /** Persist multiple sections in one PUT (used by tabs that span sections). */
  const saveSections = async (sections: (keyof MapGeoSettings)[]) => {
    if (!draft) return;
    setSaving(true);
    try {
      const patch: any = {};
      for (const s of sections) patch[s] = draft[s];
      const r = await mapGeoApi.updateSettings(patch);
      setSettings(r.settings);
      setDraft((prev) => {
        if (!prev) return r.settings;
        const next = { ...prev };
        for (const s of sections) (next as any)[s] = (r.settings as any)[s];
        return next;
      });
      toast.success(t('admin.mapGeo.saved'));
      mapGeoApi.health().then(setHealth).catch(() => {});
    } catch (e: any) {
      toast.error(e.message || t('admin.mapGeo.saveError'));
    } finally {
      setSaving(false);
    }
  };

  /** Compare draft vs persisted for a single section (shallow JSON eq). */
  const isDirty = (section: keyof MapGeoSettings): boolean => {
    if (!draft || !settings) return false;
    return JSON.stringify(draft[section]) !== JSON.stringify(settings[section]);
  };

  /** Revert one tab's draft back to the last persisted state. */
  const resetSection = (section: keyof MapGeoSettings) => {
    if (!settings || !draft) return;
    setDraft({ ...draft, [section]: settings[section] });
  };

  /** Patch helper: update a nested field on the draft for a given section. */
  const setField = <K extends keyof MapGeoSettings>(section: K, patch: Partial<MapGeoSettings[K]>) => {
    setDraft((prev) => prev ? { ...prev, [section]: { ...(prev[section] as any), ...patch } } : prev);
  };

  if (loading) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (loadError || !settings || !draft) {
    return (
      <div className="container mx-auto p-6 max-w-3xl space-y-4">
        <div className="flex items-start gap-3">
          <MapPin className="h-7 w-7 text-primary mt-1" />
          <div>
            <h1 className="text-2xl font-bold">{t('admin.mapGeo.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('admin.mapGeo.subtitle')}</p>
          </div>
        </div>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>API unreachable</AlertTitle>
          <AlertDescription>
            {loadError || 'Settings unavailable.'}
            <div className="mt-2 text-xs opacity-80">
              The admin UI calls the backend at <code>/api/admin/map-geo/*</code>.
              In the Lovable preview the production API host may be unreachable —
              this works after deploying the server (Coolify) on your real domain.
            </div>
          </AlertDescription>
        </Alert>
        <Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4 me-2" />Retry</Button>
      </div>
    );
  }

  const tilesUnconfigured = !settings.tiles.url_template;

  /** Footer with Save / Reset for one or more sections of the draft. */
  const SectionFooter = ({ sections }: { sections: (keyof MapGeoSettings)[] }) => {
    const dirty = sections.some((s) => isDirty(s));
    return (
      <div className="flex items-center justify-between gap-2 border-t pt-4 mt-4">
        <div className="text-xs text-muted-foreground">
          {dirty ? <span className="text-warning font-medium">● Unsaved changes</span> : <span>All changes saved</span>}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => sections.forEach(resetSection)} disabled={!dirty || saving}>
            <Undo2 className="h-4 w-4 me-2" />Reset
          </Button>
          <Button size="sm" onClick={() => saveSections(sections)} disabled={!dirty || saving}>
            {saving ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Save className="h-4 w-4 me-2" />}
            Save settings
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div className="flex items-start gap-3">
        <MapPin className="h-7 w-7 text-primary mt-1" />
        <div>
          <h1 className="text-2xl font-bold">{t('admin.mapGeo.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.mapGeo.subtitle')}</p>
        </div>
      </div>

      {tilesUnconfigured && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('admin.mapGeo.tiles.notConfigured')}</AlertTitle>
          <AlertDescription>{t('admin.mapGeo.tiles.notConfiguredDesc')}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="geo">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="geo">{t('admin.mapGeo.tabs.geo')}</TabsTrigger>
          <TabsTrigger value="maxmind">{t('admin.mapGeo.tabs.maxmind')}</TabsTrigger>
          <TabsTrigger value="updates">{t('admin.mapGeo.tabs.updates')}</TabsTrigger>
          <TabsTrigger value="tiles">{t('admin.mapGeo.tabs.tiles')}</TabsTrigger>
          <TabsTrigger value="behavior">{t('admin.mapGeo.tabs.behavior')}</TabsTrigger>
          <TabsTrigger value="diagnostics">{t('admin.mapGeo.tabs.diagnostics')}</TabsTrigger>
        </TabsList>

        {/* GEO CORE */}
        <TabsContent value="geo">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.geo')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.geo.enabled')}</Label>
                <Switch checked={draft.geo.enabled} onCheckedChange={(v) => setField('geo', { enabled: v })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.defaultProvider')}</Label>
                <Select value={draft.geo.default_provider} onValueChange={(v) => setField('geo', { default_provider: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="maxmind_local">maxmind_local</SelectItem><SelectItem value="none">none</SelectItem></SelectContent>
                </Select></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.preferredPrecision')}</Label>
                <Select value={draft.geo.preferred_precision} onValueChange={(v: any) => setField('geo', { preferred_precision: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="country">country</SelectItem><SelectItem value="region">region</SelectItem><SelectItem value="city">city</SelectItem></SelectContent>
                </Select></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.geo.allowCentroidFallback')}</Label>
                <Switch checked={draft.geo.allow_centroid_fallback} onCheckedChange={(v) => setField('geo', { allow_centroid_fallback: v })} /></div>
              <div className="flex items-center justify-between">
                <div><Label>{t('admin.mapGeo.geo.storeRawIp')}</Label><p className="text-xs text-muted-foreground">{t('admin.mapGeo.geo.storeRawIpHint')}</p></div>
                <Switch checked={draft.geo.store_raw_ip} onCheckedChange={(v) => setField('geo', { store_raw_ip: v })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.rawIpRetentionDays')}</Label>
                <Input type="number" value={draft.geo.raw_ip_retention_days}
                  onChange={(e) => setField('geo', { raw_ip_retention_days: Number(e.target.value) })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.geo.autoEnrich')}</Label>
                <Switch checked={draft.geo.auto_enrich_on_session_create} onCheckedChange={(v) => setField('geo', { auto_enrich_on_session_create: v })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.cacheTtlSeconds')}</Label>
                <Input type="number" value={draft.geo.cache_ttl_seconds}
                  onChange={(e) => setField('geo', { cache_ttl_seconds: Number(e.target.value) })} /></div>
              <SectionFooter sections={['geo']} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* MAXMIND LOCAL */}
        <TabsContent value="maxmind">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.maxmind')}</CardTitle>
              <CardDescription>{t('admin.mapGeo.maxmind.notice')}</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.maxmind.enabled')}</Label>
                <Switch checked={draft.maxmind_local.enabled} onCheckedChange={(v) => setField('maxmind_local', { enabled: v })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.maxmind.dbPath')}</Label>
                <Input value={draft.maxmind_local.db_path}
                  onChange={(e) => setField('maxmind_local', { db_path: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t('admin.mapGeo.maxmind.dbPathHint')}</p></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.maxmind.autoReload')}</Label>
                <Switch checked={draft.maxmind_local.auto_reload} onCheckedChange={(v) => setField('maxmind_local', { auto_reload: v })} /></div>
              <p className="text-xs text-muted-foreground">{t('admin.mapGeo.runtime.sourceOfTruth')}</p>
              <MaxmindRuntimePanel health={health} t={t} />
              <SectionFooter sections={['maxmind_local']} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* UPDATES */}
        <TabsContent value="updates">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.updates')}</CardTitle>
              <CardDescription>{t('admin.mapGeo.updates.runNowHint')}</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.mode')}</Label>
                <Select value={draft.maxmind_update.mode} onValueChange={(v: any) => setField('maxmind_update', { mode: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t('admin.mapGeo.updates.modeManual')}</SelectItem>
                    <SelectItem value="auto">{t('admin.mapGeo.updates.modeAuto')}</SelectItem>
                  </SelectContent>
                </Select></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.accountId')}</Label>
                <Input value={draft.maxmind_update.account_id}
                  onChange={(e) => setField('maxmind_update', { account_id: e.target.value })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.licenseKey')}</Label>
                <Input type="password" value={draft.maxmind_update.license_key}
                  onChange={(e) => setField('maxmind_update', { license_key: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t('admin.mapGeo.updates.licenseKeyHint')}</p></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.editionId')}</Label>
                <Input value={draft.maxmind_update.edition_id}
                  onChange={(e) => setField('maxmind_update', { edition_id: e.target.value })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.intervalHours')}</Label>
                <Input type="number" min={24} value={draft.maxmind_update.interval_hours}
                  onChange={(e) => setField('maxmind_update', { interval_hours: Math.max(24, Number(e.target.value) || 24) })} /></div>
              <MaxmindRuntimePanel health={health} t={t} />
              <Button variant="outline" onClick={async () => {
                  try {
                    const r = await mapGeoApi.runUpdate();
                    if (r.status === 'updated') toast.success(t('admin.mapGeo.runtime.updated'));
                    else if (r.status === 'skipped') toast.info(`${t('admin.mapGeo.runtime.skipped')}: ${r.reason ?? ''}`);
                    else toast.error(r.reason ?? t('admin.mapGeo.maxmind.statusFail'));
                    mapGeoApi.health().then(setHealth).catch(() => {});
                  } catch (e: any) { toast.error(e.message); }
                }}>
                <PlayCircle className="h-4 w-4 me-2" />{t('admin.mapGeo.updates.runNow')}
              </Button>
              <SectionFooter sections={['maxmind_update']} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* TILES */}
        <TabsContent value="tiles">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.tiles')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Tile preset</Label>
                <Select
                  value={
                    TILE_PRESETS.find((p) => p.url === draft.tiles.url_template)?.id ?? 'custom'
                  }
                  onValueChange={(id) => {
                    if (id === 'custom') return;
                    const p = TILE_PRESETS.find((x) => x.id === id);
                    if (!p) return;
                    // Apply URL + attribution + safe maxZoom in one shot.
                    setField('tiles', {
                      url_template: p.url,
                      attribution: p.attribution,
                      max_zoom: Math.min(draft.tiles.max_zoom || p.maxZoom, p.maxZoom),
                    });
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="Choose a built-in style…" /></SelectTrigger>
                  <SelectContent className="max-h-80">
                    <SelectItem value="custom">Custom (use fields below)</SelectItem>
                    {TILE_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Free, no-API-key tile sources. ☀️ = light/minimal, 🌙 = dark. Picking a preset fills the URL + attribution below — you still need to click <strong>Save settings</strong>.
                </p>
              </div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.urlTemplate')}</Label>
                <Input
                  value={draft.tiles.url_template}
                  onChange={(e) => setField('tiles', { url_template: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t('admin.mapGeo.tiles.urlTemplateHint')}</p></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.attribution')}</Label>
                <Input
                  value={draft.tiles.attribution}
                  onChange={(e) => setField('tiles', { attribution: e.target.value })}
                /></div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.minZoom')}</Label>
                  <Input type="number" value={draft.tiles.min_zoom}
                    onChange={(e) => setField('tiles', { min_zoom: Number(e.target.value) })} /></div>
                <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.maxZoom')}</Label>
                  <Input type="number" value={draft.tiles.max_zoom}
                    onChange={(e) => setField('tiles', { max_zoom: Number(e.target.value) })} /></div>
              </div>
              {/* Display + initial framing */}
              <div className="border-t pt-4 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">Map display on Visitors page</h3>
                  <p className="text-xs text-muted-foreground">Default size and starting view for the embedded map.</p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Fill viewport height</Label>
                    <p className="text-xs text-muted-foreground">When on, the map fills the available viewport height. When off, uses the fixed height below.</p>
                  </div>
                  <Switch
                    checked={draft.display.fill_viewport}
                    onCheckedChange={(v) => setField('display', { fill_viewport: v })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Map height (px)</Label>
                  <Input
                    type="number" min={240} max={2000}
                    value={draft.display.height_px}
                    onChange={(e) => setField('display', { height_px: Number(e.target.value) })}
                    disabled={draft.display.fill_viewport}
                  />
                  <p className="text-xs text-muted-foreground">Used when "Fill viewport" is off. Recommended: 480–800.</p>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Default center lat</Label>
                    <Input type="number" step="0.0001" value={draft.behavior.default_center_lat}
                      onChange={(e) => setField('behavior', { default_center_lat: Number(e.target.value) })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Default center lng</Label>
                    <Input type="number" step="0.0001" value={draft.behavior.default_center_lng}
                      onChange={(e) => setField('behavior', { default_center_lng: Number(e.target.value) })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Default zoom</Label>
                    <Input type="number" min={0} max={22} value={draft.behavior.default_zoom}
                      onChange={(e) => setField('behavior', { default_zoom: Number(e.target.value) })} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Quick presets</Label>
                  <div className="flex flex-wrap gap-2">
                    {([
                      // Zoom values chosen so the whole region fits in a
                      // ~480px tall map without cropping borders.
                      { label: '🇹🇷 Turkey',  lat: 39.0,  lng: 35.0,   zoom: 5 },
                      { label: '🇮🇷 Iran',    lat: 32.4,  lng: 53.7,   zoom: 5 },
                      { label: '🇺🇸 USA',     lat: 39.5,  lng: -98.35, zoom: 3 },
                      { label: '🇪🇺 Europe',  lat: 54.0,  lng: 15.0,   zoom: 3 },
                      { label: '🌍 World',    lat: 20.0,  lng: 0.0,    zoom: 2 },
                    ] as const).map((p) => (
                      <Button
                        key={p.label}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setField('behavior', {
                          default_center_mode: 'fixed',
                          default_center_lat: p.lat,
                          default_center_lng: p.lng,
                          default_zoom: p.zoom,
                        })}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Click a preset to set center + zoom in the draft. Don't forget to click Save settings.</p>
                </div>
                <div className="space-y-2">
                  <Label>Live preview</Label>
                  <MapTilesPreview
                    tileUrl={draft.tiles.url_template}
                    attribution={draft.tiles.attribution}
                    minZoom={draft.tiles.min_zoom}
                    maxZoom={draft.tiles.max_zoom}
                    centerLat={draft.behavior.default_center_lat}
                    centerLng={draft.behavior.default_center_lng}
                    zoom={draft.behavior.default_zoom}
                    heightPx={draft.display.fill_viewport ? 480 : draft.display.height_px}
                  />
                  <p className="text-xs text-muted-foreground">Reflects the draft values instantly. Click Save settings to persist.</p>
                </div>
              </div>
              {health?.tiles && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{t('admin.mapGeo.diagnostics.tilesHealth')}:</span>
                  <Badge variant={health.tiles.configured ? 'default' : 'destructive'}>
                    {health.tiles.health_status === 'healthy' ? t('admin.mapGeo.diagnostics.healthy')
                      : health.tiles.health_status === 'unconfigured' ? t('admin.mapGeo.diagnostics.unconfigured')
                      : health.tiles.health_status === 'fallback' ? t('admin.mapGeo.diagnostics.fallbackStatus')
                      : t('admin.mapGeo.diagnostics.disabled')}
                  </Badge>
                </div>
              )}
              <SectionFooter sections={['tiles', 'display', 'behavior']} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* BEHAVIOR */}
        <TabsContent value="behavior">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.behavior')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.showOnlyValidCoords')}</Label>
                <Switch checked={draft.behavior.show_only_valid_coords} onCheckedChange={(v) => setField('behavior', { show_only_valid_coords: v })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.ignoreFallbackOnly')}</Label>
                <Switch checked={draft.behavior.ignore_fallback_only} onCheckedChange={(v) => setField('behavior', { ignore_fallback_only: v })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.includeGeoLabels')}</Label>
                <Switch checked={draft.behavior.include_geo_labels} onCheckedChange={(v) => setField('behavior', { include_geo_labels: v })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.debugMetadata')}</Label>
                <Switch checked={draft.behavior.debug_metadata} onCheckedChange={(v) => setField('behavior', { debug_metadata: v })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.behavior.defaultZoom')}</Label>
                <Input type="number" value={draft.behavior.default_zoom}
                  onChange={(e) => setField('behavior', { default_zoom: Number(e.target.value) })} /></div>

              {/* Presence cadence — controls how fast new visitors appear */}
              <div className="border-t pt-4 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">Realtime presence</h3>
                  <p className="text-xs text-muted-foreground">
                    Tunes how quickly the Visitors page reflects new sessions.
                    Lower values feel snappier but cost more requests.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Live refresh (ms)</Label>
                    <Input
                      type="number" min={2000} step={1000}
                      value={(draft as any).presence?.live_refresh_ms ?? 5000}
                      onChange={(e) => setField('presence' as any, { live_refresh_ms: Number(e.target.value) } as any)}
                    />
                    <p className="text-[11px] text-muted-foreground">Visitors page polling. Recommended: 3000–8000.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Widget heartbeat (ms)</Label>
                    <Input
                      type="number" min={5000} step={1000}
                      value={(draft as any).presence?.heartbeat_interval_ms ?? 15000}
                      onChange={(e) => setField('presence' as any, { heartbeat_interval_ms: Number(e.target.value) } as any)}
                    />
                    <p className="text-[11px] text-muted-foreground">How often each browser pings the server. Recommended: 10000–30000.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Stale after (ms)</Label>
                    <Input
                      type="number" min={15000} step={5000}
                      value={(draft as any).presence?.stale_after_ms ?? 60000}
                      onChange={(e) => setField('presence' as any, { stale_after_ms: Number(e.target.value) } as any)}
                    />
                    <p className="text-[11px] text-muted-foreground">Mark a visitor offline after this much inactivity. Recommended: 45000–120000.</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {([
                    { label: '⚡ Snappy (3s / 10s / 45s)', refresh: 3000, hb: 10000, stale: 45000 },
                    { label: '⚖️ Balanced (5s / 15s / 60s)', refresh: 5000, hb: 15000, stale: 60000 },
                    { label: '🐢 Economy (10s / 30s / 120s)', refresh: 10000, hb: 30000, stale: 120000 },
                  ] as const).map((p) => (
                    <Button
                      key={p.label}
                      type="button" size="sm" variant="outline"
                      onClick={() => setField('presence' as any, {
                        live_refresh_ms: p.refresh,
                        heartbeat_interval_ms: p.hb,
                        stale_after_ms: p.stale,
                      } as any)}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              </div>

              <SectionFooter sections={['behavior', 'presence' as any]} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* DIAGNOSTICS */}
        <TabsContent value="diagnostics">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.diagnostics')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>{t('admin.mapGeo.diagnostics.testIp')}</Label>
                <div className="flex gap-2">
                  <Input value={testIp} onChange={(e) => setTestIp(e.target.value)} placeholder="8.8.8.8" />
                  <Button onClick={async () => { try { setTestResult(await mapGeoApi.testResolve(testIp)); } catch (e: any) { toast.error(e.message); } }}>
                    {t('admin.mapGeo.diagnostics.resolve')}
                  </Button>
                </div></div>
              {testResult && (
                <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto">{JSON.stringify(testResult, null, 2)}</pre>
              )}
              <div className="flex gap-2 pt-2 border-t">
                <Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4 me-2" />{t('common.loading')}</Button>
                <Button variant="outline" onClick={async () => { try { const r = await mapGeoApi.purgeCache(); toast.success(t('admin.mapGeo.diagnostics.purged', { count: r.purged } as any)); } catch (e: any) { toast.error(e.message); } }}>
                  <Trash2 className="h-4 w-4 me-2" />{t('admin.mapGeo.diagnostics.purgeCache')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {saving && <div className="fixed bottom-4 end-4 bg-card border rounded-md px-3 py-2 shadow-lg flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />...</div>}
    </div>
  );
}