import { useEffect, useState } from 'react';
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
import { Loader2, MapPin, AlertTriangle, CheckCircle2, RefreshCw, Trash2, PlayCircle } from 'lucide-react';
import { toast } from 'sonner';
import { mapGeoApi, type MapGeoSettings } from '@/lib/map-geo-api';

export default function MapGeoPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<MapGeoSettings | null>(null);
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

  const save = async (patch: Partial<MapGeoSettings>) => {
    setSaving(true);
    try {
      const r = await mapGeoApi.updateSettings(patch);
      setSettings(r.settings);
      toast.success(t('admin.mapGeo.saved'));
      mapGeoApi.health().then(setHealth).catch(() => {});
    } catch (e: any) {
      toast.error(e.message || t('admin.mapGeo.saveError'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (loadError || !settings) {
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
                <Switch checked={settings.geo.enabled} onCheckedChange={(v) => save({ geo: { ...settings.geo, enabled: v } })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.defaultProvider')}</Label>
                <Select value={settings.geo.default_provider} onValueChange={(v) => save({ geo: { ...settings.geo, default_provider: v } })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="maxmind_local">maxmind_local</SelectItem><SelectItem value="none">none</SelectItem></SelectContent>
                </Select></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.preferredPrecision')}</Label>
                <Select value={settings.geo.preferred_precision} onValueChange={(v: any) => save({ geo: { ...settings.geo, preferred_precision: v } })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="country">country</SelectItem><SelectItem value="region">region</SelectItem><SelectItem value="city">city</SelectItem></SelectContent>
                </Select></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.geo.allowCentroidFallback')}</Label>
                <Switch checked={settings.geo.allow_centroid_fallback} onCheckedChange={(v) => save({ geo: { ...settings.geo, allow_centroid_fallback: v } })} /></div>
              <div className="flex items-center justify-between">
                <div><Label>{t('admin.mapGeo.geo.storeRawIp')}</Label><p className="text-xs text-muted-foreground">{t('admin.mapGeo.geo.storeRawIpHint')}</p></div>
                <Switch checked={settings.geo.store_raw_ip} onCheckedChange={(v) => save({ geo: { ...settings.geo, store_raw_ip: v } })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.rawIpRetentionDays')}</Label>
                <Input type="number" defaultValue={settings.geo.raw_ip_retention_days}
                  onBlur={(e) => save({ geo: { ...settings.geo, raw_ip_retention_days: Number(e.target.value) } })} /></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.geo.autoEnrich')}</Label>
                <Switch checked={settings.geo.auto_enrich_on_session_create} onCheckedChange={(v) => save({ geo: { ...settings.geo, auto_enrich_on_session_create: v } })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.geo.cacheTtlSeconds')}</Label>
                <Input type="number" defaultValue={settings.geo.cache_ttl_seconds}
                  onBlur={(e) => save({ geo: { ...settings.geo, cache_ttl_seconds: Number(e.target.value) } })} /></div>
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
                <Switch checked={settings.maxmind_local.enabled} onCheckedChange={(v) => save({ maxmind_local: { ...settings.maxmind_local, enabled: v } })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.maxmind.dbPath')}</Label>
                <Input defaultValue={settings.maxmind_local.db_path}
                  onBlur={(e) => save({ maxmind_local: { ...settings.maxmind_local, db_path: e.target.value } })} />
                <p className="text-xs text-muted-foreground">{t('admin.mapGeo.maxmind.dbPathHint')}</p></div>
              <div className="flex items-center justify-between"><Label>{t('admin.mapGeo.maxmind.autoReload')}</Label>
                <Switch checked={settings.maxmind_local.auto_reload} onCheckedChange={(v) => save({ maxmind_local: { ...settings.maxmind_local, auto_reload: v } })} /></div>
              {health?.maxmind_local && (
                <Alert variant={health.maxmind_local.ok ? 'default' : 'destructive'}>
                  {health.maxmind_local.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                  <AlertTitle>{health.maxmind_local.ok ? t('admin.mapGeo.maxmind.statusOk') : t('admin.mapGeo.maxmind.statusFail')}</AlertTitle>
                  <AlertDescription>
                    {health.maxmind_local.ok ? `${t('admin.mapGeo.maxmind.size')}: ${(health.maxmind_local.size_bytes / 1024 / 1024).toFixed(1)} MB · ${t('admin.mapGeo.maxmind.modified')}: ${health.maxmind_local.mtime}` : health.maxmind_local.error}
                  </AlertDescription>
                </Alert>
              )}
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
                <Select value={settings.maxmind_update.mode} onValueChange={(v: any) => save({ maxmind_update: { ...settings.maxmind_update, mode: v } })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t('admin.mapGeo.updates.modeManual')}</SelectItem>
                    <SelectItem value="auto">{t('admin.mapGeo.updates.modeAuto')}</SelectItem>
                  </SelectContent>
                </Select></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.accountId')}</Label>
                <Input defaultValue={settings.maxmind_update.account_id}
                  onBlur={(e) => save({ maxmind_update: { ...settings.maxmind_update, account_id: e.target.value } })} /></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.licenseKey')}</Label>
                <Input type="password" defaultValue={settings.maxmind_update.license_key}
                  onBlur={(e) => { if (e.target.value && e.target.value !== '••••••••') save({ maxmind_update: { ...settings.maxmind_update, license_key: e.target.value } }); }} />
                <p className="text-xs text-muted-foreground">{t('admin.mapGeo.updates.licenseKeyHint')}</p></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.updates.editionId')}</Label>
                <Input defaultValue={settings.maxmind_update.edition_id}
                  onBlur={(e) => save({ maxmind_update: { ...settings.maxmind_update, edition_id: e.target.value } })} /></div>
              <Button variant="outline" onClick={async () => { try { const r = await mapGeoApi.runUpdate(); toast.success(r.instructions); } catch (e: any) { toast.error(e.message); } }}>
                <PlayCircle className="h-4 w-4 me-2" />{t('admin.mapGeo.updates.runNow')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TILES */}
        <TabsContent value="tiles">
          <Card>
            <CardHeader><CardTitle>{t('admin.mapGeo.tabs.tiles')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.urlTemplate')}</Label>
                <Input defaultValue={settings.tiles.url_template}
                  onBlur={(e) => save({ tiles: { ...settings.tiles, url_template: e.target.value } })} />
                <p className="text-xs text-muted-foreground">{t('admin.mapGeo.tiles.urlTemplateHint')}</p></div>
              <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.attribution')}</Label>
                <Input defaultValue={settings.tiles.attribution}
                  onBlur={(e) => save({ tiles: { ...settings.tiles, attribution: e.target.value } })} /></div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.minZoom')}</Label>
                  <Input type="number" defaultValue={settings.tiles.min_zoom}
                    onBlur={(e) => save({ tiles: { ...settings.tiles, min_zoom: Number(e.target.value) } })} /></div>
                <div className="space-y-2"><Label>{t('admin.mapGeo.tiles.maxZoom')}</Label>
                  <Input type="number" defaultValue={settings.tiles.max_zoom}
                    onBlur={(e) => save({ tiles: { ...settings.tiles, max_zoom: Number(e.target.value) } })} /></div>
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