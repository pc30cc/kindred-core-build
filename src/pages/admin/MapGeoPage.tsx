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
import { toast } from 'sonner';
import { mapGeoApi, type MapGeoSettings } from '@/lib/map-geo-api';
import { MapTilesPreview } from '@/components/admin/MapTilesPreview';

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
              <SectionFooter section="geo" />
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
              {health?.maxmind_local && (
                <Alert variant={health.maxmind_local.ok ? 'default' : 'destructive'}>
                  {health.maxmind_local.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                  <AlertTitle>{health.maxmind_local.ok ? t('admin.mapGeo.maxmind.statusOk') : t('admin.mapGeo.maxmind.statusFail')}</AlertTitle>
                  <AlertDescription>
                    {health.maxmind_local.ok ? `${t('admin.mapGeo.maxmind.size')}: ${(health.maxmind_local.size_bytes / 1024 / 1024).toFixed(1)} MB · ${t('admin.mapGeo.maxmind.modified')}: ${health.maxmind_local.mtime}` : health.maxmind_local.error}
                  </AlertDescription>
                </Alert>
              )}
              <SectionFooter section="maxmind_local" />
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
              <Button variant="outline" onClick={async () => { try { const r = await mapGeoApi.runUpdate(); toast.success(r.instructions); } catch (e: any) { toast.error(e.message); } }}>
                <PlayCircle className="h-4 w-4 me-2" />{t('admin.mapGeo.updates.runNow')}
              </Button>
              <SectionFooter section="maxmind_update" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* TILES */}
        <TabsContent value="tiles">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.tiles')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.urlTemplate')}</Label>
                <Input
                  value={settings.tiles.url_template}
                  onChange={(e) => setSettings({ ...settings, tiles: { ...settings.tiles, url_template: e.target.value } })}
                  onBlur={(e) => save({ tiles: { ...settings.tiles, url_template: e.target.value } })}
                />
                <p className="text-xs text-muted-foreground">{t('admin.mapGeo.tiles.urlTemplateHint')}</p></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.attribution')}</Label>
                <Input
                  value={settings.tiles.attribution}
                  onChange={(e) => setSettings({ ...settings, tiles: { ...settings.tiles, attribution: e.target.value } })}
                  onBlur={(e) => save({ tiles: { ...settings.tiles, attribution: e.target.value } })}
                /></div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.minZoom')}</Label>
                  <Input type="number" value={settings.tiles.min_zoom}
                    onChange={(e) => setSettings({ ...settings, tiles: { ...settings.tiles, min_zoom: Number(e.target.value) } })}
                    onBlur={(e) => save({ tiles: { ...settings.tiles, min_zoom: Number(e.target.value) } })} /></div>
                <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.maxZoom')}</Label>
                  <Input type="number" value={settings.tiles.max_zoom}
                    onChange={(e) => setSettings({ ...settings, tiles: { ...settings.tiles, max_zoom: Number(e.target.value) } })}
                    onBlur={(e) => save({ tiles: { ...settings.tiles, max_zoom: Number(e.target.value) } })} /></div>
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
                    checked={settings.display.fill_viewport}
                    onCheckedChange={(v) => { setSettings({ ...settings, display: { ...settings.display, fill_viewport: v } }); save({ display: { ...settings.display, fill_viewport: v } }); }}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Map height (px)</Label>
                  <Input
                    type="number" min={240} max={2000}
                    value={settings.display.height_px}
                    onChange={(e) => setSettings({ ...settings, display: { ...settings.display, height_px: Number(e.target.value) } })}
                    onBlur={(e) => save({ display: { ...settings.display, height_px: Number(e.target.value) } })}
                    disabled={settings.display.fill_viewport}
                  />
                  <p className="text-xs text-muted-foreground">Used when "Fill viewport" is off. Recommended: 480–800.</p>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Default center lat</Label>
                    <Input type="number" step="0.0001" value={settings.behavior.default_center_lat}
                      onChange={(e) => setSettings({ ...settings, behavior: { ...settings.behavior, default_center_lat: Number(e.target.value) } })}
                      onBlur={(e) => save({ behavior: { ...settings.behavior, default_center_lat: Number(e.target.value) } })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Default center lng</Label>
                    <Input type="number" step="0.0001" value={settings.behavior.default_center_lng}
                      onChange={(e) => setSettings({ ...settings, behavior: { ...settings.behavior, default_center_lng: Number(e.target.value) } })}
                      onBlur={(e) => save({ behavior: { ...settings.behavior, default_center_lng: Number(e.target.value) } })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Default zoom</Label>
                    <Input type="number" min={0} max={22} value={settings.behavior.default_zoom}
                      onChange={(e) => setSettings({ ...settings, behavior: { ...settings.behavior, default_zoom: Number(e.target.value) } })}
                      onBlur={(e) => save({ behavior: { ...settings.behavior, default_zoom: Number(e.target.value) } })} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Quick presets</Label>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { label: '🇹🇷 Turkey',  lat: 39.0,  lng: 35.0,  zoom: 6 },
                      { label: '🇮🇷 Iran',    lat: 32.4,  lng: 53.7,  zoom: 5 },
                      { label: '🇺🇸 USA',     lat: 39.5,  lng: -98.35, zoom: 4 },
                      { label: '🇪🇺 Europe',  lat: 54.0,  lng: 15.0,  zoom: 4 },
                      { label: '🌍 World',    lat: 20.0,  lng: 0.0,   zoom: 2 },
                    ] as const).map((p) => (
                      <Button
                        key={p.label}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const next = {
                            ...settings,
                            behavior: {
                              ...settings.behavior,
                              default_center_mode: 'fixed' as const,
                              default_center_lat: p.lat,
                              default_center_lng: p.lng,
                              default_zoom: p.zoom,
                            },
                          };
                          setSettings(next);
                          save({ behavior: next.behavior });
                        }}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Click a preset to set center + zoom. The preview above and the Visitors page will use it as the initial view.</p>
                </div>
                <div className="space-y-2">
                  <Label>Live preview</Label>
                  <MapTilesPreview
                    tileUrl={settings.tiles.url_template}
                    attribution={settings.tiles.attribution}
                    minZoom={settings.tiles.min_zoom}
                    maxZoom={settings.tiles.max_zoom}
                    centerLat={settings.behavior.default_center_lat}
                    centerLng={settings.behavior.default_center_lng}
                    zoom={settings.behavior.default_zoom}
                    heightPx={settings.display.fill_viewport ? 480 : settings.display.height_px}
                  />
                  <p className="text-xs text-muted-foreground">Reflects the values above instantly. Tiles load from the URL you entered — verify the provider is reachable.</p>
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
            </CardContent>
          </Card>
        </TabsContent>

        {/* BEHAVIOR */}
        <TabsContent value="behavior">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.behavior')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.showOnlyValidCoords')}</Label>
                <Switch checked={settings.behavior.show_only_valid_coords} onCheckedChange={(v) => save({ behavior: { ...settings.behavior, show_only_valid_coords: v } })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.ignoreFallbackOnly')}</Label>
                <Switch checked={settings.behavior.ignore_fallback_only} onCheckedChange={(v) => save({ behavior: { ...settings.behavior, ignore_fallback_only: v } })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.includeGeoLabels')}</Label>
                <Switch checked={settings.behavior.include_geo_labels} onCheckedChange={(v) => save({ behavior: { ...settings.behavior, include_geo_labels: v } })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.behavior.debugMetadata')}</Label>
                <Switch checked={settings.behavior.debug_metadata} onCheckedChange={(v) => save({ behavior: { ...settings.behavior, debug_metadata: v } })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.behavior.defaultZoom')}</Label>
                <Input type="number" defaultValue={settings.behavior.default_zoom}
                  onBlur={(e) => save({ behavior: { ...settings.behavior, default_zoom: Number(e.target.value) } })} /></div>
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