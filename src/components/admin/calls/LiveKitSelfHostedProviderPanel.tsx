/**
 * Self-hosted LiveKit provider admin panel.
 *
 * Mirrors the UX rules of the Agora panel but for a self-hosted server:
 *   - Disabled by default; explicit `enabled` toggle.
 *   - Secrets are write-only — UI shows presence badges, never values.
 *     Send "" to clear, send a value to set, omit to preserve.
 *   - Readiness summary mirrors backend `livekitProvider.isReady()`:
 *     enabled && api_key && api_secret && rtc_url.
 *   - TURN / ICE policy are NOT duplicated here — they live in the generic
 *     RTC / Network section. We only show a short pointer note.
 *
 * Uses the existing endpoints:
 *   GET  /api/admin/calls/livekit
 *   PUT  /api/admin/calls/livekit
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import {
  fetchLiveKitConfig,
  updateLiveKitConfig,
  testLiveKitConnection,
  type LiveKitConfigPublicView,
  type LiveKitConfigPatch,
  type LiveKitTestResult,
} from '@/lib/admin-calls-api';
import { Server, Loader2, Save, ShieldCheck, Info, CheckCircle2, AlertTriangle, Plug } from 'lucide-react';

function ReadinessBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? 'default' : 'secondary'} className="gap-1 text-[10px]">
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

export function LiveKitSelfHostedProviderPanel() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<LiveKitConfigPublicView | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LiveKitTestResult | null>(null);
  // Tracks the last value the server confirmed it persisted, so we can detect
  // unsaved edits in URL/region fields before running a connection test.
  const [savedRtcUrl, setSavedRtcUrl] = useState<string | null>(null);
  const [savedWsUrl, setSavedWsUrl] = useState<string | null>(null);
  const [savedRegion, setSavedRegion] = useState<string | null>(null);
  const [savedEgressUrl, setSavedEgressUrl] = useState<string | null>(null);

  // Local-only secret edit buffers — never seeded from the server.
  const [apiKeyEdit, setApiKeyEdit] = useState('');
  const [apiSecretEdit, setApiSecretEdit] = useState('');
  const [webhookSecretEdit, setWebhookSecretEdit] = useState('');
  const [s3AccessEdit, setS3AccessEdit] = useState('');
  const [s3SecretEdit, setS3SecretEdit] = useState('');

  async function load() {
    setLoading(true);
    try {
      const r = await fetchLiveKitConfig();
      setCfg(r.livekit);
      setSavedRtcUrl(r.livekit.rtc_url);
      setSavedWsUrl(r.livekit.ws_url);
      setSavedRegion(r.livekit.region);
      setSavedEgressUrl(r.livekit.egress_url);
    } catch (e: any) {
      toast({
        title: t('admin.voiceVideo.livekit.loadFailed' as any),
        description: e.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(patch: LiveKitConfigPatch) {
    setSaving(true);
    try {
      const r = await updateLiveKitConfig(patch);
      setCfg(r.livekit);
      setSavedRtcUrl(r.livekit.rtc_url);
      setSavedWsUrl(r.livekit.ws_url);
      setSavedRegion(r.livekit.region);
      setSavedEgressUrl(r.livekit.egress_url);
      if ('api_key' in patch) setApiKeyEdit('');
      if ('api_secret' in patch) setApiSecretEdit('');
      if ('webhook_secret' in patch) setWebhookSecretEdit('');
      if (patch.recording_storage && 'access_key' in patch.recording_storage) setS3AccessEdit('');
      if (patch.recording_storage && 'secret_key' in patch.recording_storage) setS3SecretEdit('');
      // Stale once config changes — force a fresh probe.
      setTestResult(null);
      toast({ title: t('admin.voiceVideo.livekit.saved' as any) });
    } catch (e: any) {
      toast({ title: t('admin.voiceVideo.livekit.saveFailed' as any), description: e.message, variant: 'destructive' });
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!cfg) return;
    // Auto-flush any unsaved URL/region edits the user typed but didn't blur
    // before clicking Test. Without this, Test races against state and the
    // server returns "RTC URL is required before testing."
    const pendingPatch: LiveKitConfigPatch = {};
    const currentRtc = (cfg.rtc_url ?? '').trim();
    const currentWs = (cfg.ws_url ?? '').trim();
    const currentRegion = (cfg.region ?? '').trim();
    const currentEgress = (cfg.egress_url ?? '').trim();
    if (currentRtc !== (savedRtcUrl ?? '')) pendingPatch.rtc_url = currentRtc || null;
    if (currentWs !== (savedWsUrl ?? '')) pendingPatch.ws_url = currentWs || null;
    if (currentRegion !== (savedRegion ?? '')) pendingPatch.region = currentRegion || null;
    if (cfg.egress_enabled && currentEgress !== (savedEgressUrl ?? '')) {
      pendingPatch.egress_url = currentEgress || null;
    }
    if (Object.keys(pendingPatch).length > 0) {
      try {
        await save(pendingPatch);
      } catch {
        // save() already toasted; abort the test so we don't probe with stale data.
        return;
      }
    }
    if (!currentRtc) {
      toast({
        title: t('admin.voiceVideo.livekit.rtcRequired' as any),
        description: t('admin.voiceVideo.livekit.rtcRequiredHint' as any),
        variant: 'destructive',
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testLiveKitConnection();
      setTestResult(r);
      toast({
        title: r.ok ? t('admin.voiceVideo.livekit.testOk' as any) : t('admin.voiceVideo.livekit.testFailed' as any),
        description: r.ok
          ? t('admin.voiceVideo.livekit.reached' as any, { url: r.rtc_url, latency: r.latency_ms })
          : r.error || t('admin.voiceVideo.livekit.unknownError' as any),
        variant: r.ok ? 'default' : 'destructive',
      });
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message });
      toast({ title: t('admin.voiceVideo.livekit.testFailed' as any), description: e.message, variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  }

  if (loading || !cfg) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // Mirror of livekitProvider.isReady() in the backend.
  const ready = cfg.enabled && cfg.api_key_present && cfg.api_secret_present && !!cfg.rtc_url;
  // For the Test button: trust the *typed* RTC URL too (we'll auto-save before probing).
  const canTest = cfg.enabled && cfg.api_key_present && cfg.api_secret_present && !!(cfg.rtc_url ?? '').trim();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" /> LiveKit
              <Badge variant="outline" className="gap-1">
                <ShieldCheck className="h-3 w-3" /> {t('admin.voiceVideo.livekit.selfHosted' as any)}
              </Badge>
              <Badge variant={ready ? 'default' : 'secondary'} className="gap-1">
                {ready ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                {ready ? t('admin.voiceVideo.livekit.ready' as any) : t('admin.voiceVideo.livekit.notReady' as any)}
              </Badge>
            </CardTitle>
            <CardDescription>{t('admin.voiceVideo.livekit.description' as any)}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="livekit-enabled" className="text-sm">
              {t('admin.voiceVideo.livekit.enabled' as any)}
            </Label>
            <Switch
              id="livekit-enabled"
              checked={cfg.enabled}
              onCheckedChange={(v) => save({ enabled: v })}
              disabled={saving}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Readiness summary — mirrors backend livekitProvider.isReady() */}
        <div className="rounded-md border border-border p-3 space-y-2 bg-muted/20">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-foreground">
              {t('admin.voiceVideo.livekit.readiness' as any)}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={runTest}
              disabled={testing || saving || !canTest}
              title={
                !canTest
                  ? t('admin.voiceVideo.livekit.testDisabledHint' as any)
                  : t('admin.voiceVideo.livekit.testHint' as any)
              }
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 me-1.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5 me-1.5" />
              )}
              {t('admin.voiceVideo.livekit.testConnection' as any)}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <ReadinessBadge ok={cfg.enabled} label={t('admin.voiceVideo.livekit.enabled' as any)} />
            <ReadinessBadge ok={cfg.api_key_present} label={t('admin.voiceVideo.livekit.apiKey' as any)} />
            <ReadinessBadge ok={cfg.api_secret_present} label={t('admin.voiceVideo.livekit.apiSecret' as any)} />
            <ReadinessBadge ok={!!cfg.rtc_url} label={t('admin.voiceVideo.livekit.rtcUrl' as any)} />
          </div>
          {!ready && (
            <p className="text-[11px] text-muted-foreground">{t('admin.voiceVideo.livekit.readinessHint' as any)}</p>
          )}
          {testResult && (
            <div
              className={
                'mt-2 rounded-md border p-2 text-xs ' +
                (testResult.ok
                  ? 'border-primary/40 bg-primary/5 text-foreground'
                  : 'border-destructive/40 bg-destructive/5 text-destructive')
              }
            >
              {testResult.ok ? (
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>
                    {t('admin.voiceVideo.livekit.reached' as any, {
                      url: testResult.rtc_url,
                      latency: testResult.latency_ms,
                    })}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span className="break-words">{testResult.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* URLs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>{t('admin.voiceVideo.livekit.rtcUrl' as any)}</Label>
            <Input
              value={cfg.rtc_url ?? ''}
              onChange={(e) => setCfg({ ...cfg, rtc_url: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.rtc_url ?? '')) save({ rtc_url: v || null });
              }}
              placeholder="wss://livekit.example.com"
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t('admin.voiceVideo.livekit.rtcHint' as any)}</p>
          </div>
          <div>
            <Label>{t('admin.voiceVideo.livekit.websocketUrl' as any)}</Label>
            <Input
              value={cfg.ws_url ?? ''}
              onChange={(e) => setCfg({ ...cfg, ws_url: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.ws_url ?? '')) save({ ws_url: v || null });
              }}
              placeholder="wss://livekit.example.com"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {t('admin.voiceVideo.livekit.websocketHint' as any)}
            </p>
          </div>
          <div>
            <Label>{t('admin.voiceVideo.livekit.region' as any)}</Label>
            <Input
              value={cfg.region ?? ''}
              onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.region ?? '')) save({ region: v || null });
              }}
              placeholder="e.g. eu-west, us-east"
            />
          </div>
        </div>

        <Separator />

        {/* Credentials (write-only) */}
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between">
              <Label>{t('admin.voiceVideo.livekit.apiKey' as any)}</Label>
              <Badge variant={cfg.api_key_present ? 'default' : 'secondary'}>
                {cfg.api_key_present
                  ? t('admin.voiceVideo.livekit.configured' as any)
                  : t('admin.voiceVideo.livekit.notSet' as any)}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={apiKeyEdit}
                onChange={(e) => setApiKeyEdit(e.target.value)}
                placeholder={
                  cfg.api_key_present
                    ? t('admin.voiceVideo.livekit.keepCurrent' as any)
                    : t('admin.voiceVideo.livekit.pasteApiKey' as any)
                }
              />
              <Button
                variant="outline"
                disabled={saving || apiKeyEdit === ''}
                onClick={() => save({ api_key: apiKeyEdit })}
              >
                <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.livekit.save' as any)}
              </Button>
              {cfg.api_key_present && (
                <Button variant="ghost" disabled={saving} onClick={() => save({ api_key: '' })}>
                  {t('admin.voiceVideo.livekit.clear' as any)}
                </Button>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label>{t('admin.voiceVideo.livekit.apiSecret' as any)}</Label>
              <Badge variant={cfg.api_secret_present ? 'default' : 'secondary'}>
                {cfg.api_secret_present
                  ? t('admin.voiceVideo.livekit.configured' as any)
                  : t('admin.voiceVideo.livekit.notSet' as any)}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={apiSecretEdit}
                onChange={(e) => setApiSecretEdit(e.target.value)}
                placeholder={
                  cfg.api_secret_present
                    ? t('admin.voiceVideo.livekit.keepCurrent' as any)
                    : t('admin.voiceVideo.livekit.pasteApiSecret' as any)
                }
              />
              <Button
                variant="outline"
                disabled={saving || apiSecretEdit === ''}
                onClick={() => save({ api_secret: apiSecretEdit })}
              >
                <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.livekit.save' as any)}
              </Button>
              {cfg.api_secret_present && (
                <Button variant="ghost" disabled={saving} onClick={() => save({ api_secret: '' })}>
                  {t('admin.voiceVideo.livekit.clear' as any)}
                </Button>
              )}
            </div>
          </div>
        </div>

        <Separator />

        {/* Webhooks */}
        <div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('admin.voiceVideo.livekit.webhookSecret' as any)}</Label>
              <p className="text-[11px] text-muted-foreground">
                {t('admin.voiceVideo.livekit.webhookSecretHint' as any)}
              </p>
            </div>
            <Badge variant={cfg.webhook_secret_present ? 'default' : 'secondary'}>
              {cfg.webhook_secret_present
                ? t('admin.voiceVideo.livekit.configured' as any)
                : t('admin.voiceVideo.livekit.notSet' as any)}
            </Badge>
          </div>
          <div className="flex gap-2 mt-1">
            <Input
              type="password"
              value={webhookSecretEdit}
              onChange={(e) => setWebhookSecretEdit(e.target.value)}
              placeholder={
                cfg.webhook_secret_present
                  ? t('admin.voiceVideo.livekit.keepCurrent' as any)
                  : t('admin.voiceVideo.livekit.webhookSecretPlaceholder' as any)
              }
            />
            <Button
              variant="outline"
              disabled={saving || webhookSecretEdit === ''}
              onClick={() => save({ webhook_secret: webhookSecretEdit })}
            >
              <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.livekit.save' as any)}
            </Button>
            {cfg.webhook_secret_present && (
              <Button variant="ghost" disabled={saving} onClick={() => save({ webhook_secret: '' })}>
                {t('admin.voiceVideo.livekit.clear' as any)}
              </Button>
            )}
          </div>
        </div>

        <Separator />

        {/* Egress */}
        <div className="flex items-center justify-between">
          <div>
            <Label>{t('admin.voiceVideo.livekit.egress' as any)}</Label>
            <p className="text-[11px] text-muted-foreground">{t('admin.voiceVideo.livekit.egressHint' as any)}</p>
          </div>
          <Switch checked={cfg.egress_enabled} onCheckedChange={(v) => save({ egress_enabled: v })} disabled={saving} />
        </div>
        {cfg.egress_enabled && (
          <div>
            <Label>{t('admin.voiceVideo.livekit.egressUrl' as any)}</Label>
            <Input
              value={cfg.egress_url ?? ''}
              onChange={(e) => setCfg({ ...cfg, egress_url: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.egress_url ?? '')) save({ egress_url: v || null });
              }}
              placeholder="https://egress.example.com"
            />
          </div>
        )}

        {/* Recording storage */}
        {cfg.egress_enabled && (
          <>
            <Separator />
            <div className="space-y-3">
              <div className="text-xs font-semibold text-foreground">
                {t('admin.voiceVideo.livekit.storageTitle' as any)}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>{t('admin.voiceVideo.livekit.vendor' as any)}</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={cfg.recording_storage.vendor ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      const vendor = v === 's3' || v === 's3_compatible' ? v : null;
                      save({ recording_storage: { vendor } });
                    }}
                    disabled={saving}
                  >
                    <option value="">— {t('admin.voiceVideo.livekit.none' as any)} —</option>
                    <option value="s3">AWS S3</option>
                    <option value="s3_compatible">{t('admin.voiceVideo.livekit.s3Compatible' as any)}</option>
                  </select>
                </div>
                <div>
                  <Label>{t('admin.voiceVideo.livekit.bucket' as any)}</Label>
                  <Input
                    value={cfg.recording_storage.bucket ?? ''}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        recording_storage: { ...cfg.recording_storage, bucket: e.target.value },
                      })
                    }
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (cfg.recording_storage.bucket ?? '')) {
                        save({ recording_storage: { bucket: v || null } });
                      }
                    }}
                    placeholder="bucket-name"
                  />
                </div>
                <div>
                  <Label>{t('admin.voiceVideo.livekit.storageRegion' as any)}</Label>
                  <Input
                    value={cfg.recording_storage.region ?? ''}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        recording_storage: { ...cfg.recording_storage, region: e.target.value },
                      })
                    }
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (cfg.recording_storage.region ?? '')) {
                        save({ recording_storage: { region: v || null } });
                      }
                    }}
                    placeholder="e.g. us-east-1"
                  />
                </div>
                <div>
                  <Label>{t('admin.voiceVideo.livekit.endpoint' as any)}</Label>
                  <Input
                    value={cfg.recording_storage.endpoint ?? ''}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        recording_storage: { ...cfg.recording_storage, endpoint: e.target.value },
                      })
                    }
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (cfg.recording_storage.endpoint ?? '')) {
                        save({ recording_storage: { endpoint: v || null } });
                      }
                    }}
                    placeholder="https://s3.example.com"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="lk-fps" className="text-sm">
                  {t('admin.voiceVideo.livekit.forcePathStyle' as any)}
                </Label>
                <Switch
                  id="lk-fps"
                  checked={cfg.recording_storage.force_path_style}
                  onCheckedChange={(v) => save({ recording_storage: { force_path_style: v } })}
                  disabled={saving}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <Label>{t('admin.voiceVideo.livekit.accessKey' as any)}</Label>
                  <Badge variant={cfg.recording_storage.access_key_present ? 'default' : 'secondary'}>
                    {cfg.recording_storage.access_key_present
                      ? t('admin.voiceVideo.livekit.configured' as any)
                      : t('admin.voiceVideo.livekit.notSet' as any)}
                  </Badge>
                </div>
                <div className="flex gap-2 mt-1">
                  <Input
                    type="password"
                    value={s3AccessEdit}
                    onChange={(e) => setS3AccessEdit(e.target.value)}
                    placeholder={
                      cfg.recording_storage.access_key_present
                        ? t('admin.voiceVideo.livekit.keep' as any)
                        : t('admin.voiceVideo.livekit.s3AccessKey' as any)
                    }
                  />
                  <Button
                    variant="outline"
                    disabled={saving || s3AccessEdit === ''}
                    onClick={() => save({ recording_storage: { access_key: s3AccessEdit } })}
                  >
                    <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.livekit.save' as any)}
                  </Button>
                  {cfg.recording_storage.access_key_present && (
                    <Button
                      variant="ghost"
                      disabled={saving}
                      onClick={() => save({ recording_storage: { access_key: '' } })}
                    >
                      {t('admin.voiceVideo.livekit.clear' as any)}
                    </Button>
                  )}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <Label>{t('admin.voiceVideo.livekit.secretKey' as any)}</Label>
                  <Badge variant={cfg.recording_storage.secret_key_present ? 'default' : 'secondary'}>
                    {cfg.recording_storage.secret_key_present
                      ? t('admin.voiceVideo.livekit.configured' as any)
                      : t('admin.voiceVideo.livekit.notSet' as any)}
                  </Badge>
                </div>
                <div className="flex gap-2 mt-1">
                  <Input
                    type="password"
                    value={s3SecretEdit}
                    onChange={(e) => setS3SecretEdit(e.target.value)}
                    placeholder={
                      cfg.recording_storage.secret_key_present
                        ? t('admin.voiceVideo.livekit.keep' as any)
                        : t('admin.voiceVideo.livekit.s3SecretKey' as any)
                    }
                  />
                  <Button
                    variant="outline"
                    disabled={saving || s3SecretEdit === ''}
                    onClick={() => save({ recording_storage: { secret_key: s3SecretEdit } })}
                  >
                    <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.livekit.save' as any)}
                  </Button>
                  {cfg.recording_storage.secret_key_present && (
                    <Button
                      variant="ghost"
                      disabled={saving}
                      onClick={() => save({ recording_storage: { secret_key: '' } })}
                    >
                      {t('admin.voiceVideo.livekit.clear' as any)}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        <Separator />

        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>{t('admin.voiceVideo.livekit.networkTitle' as any)}</AlertTitle>
          <AlertDescription>{t('admin.voiceVideo.livekit.networkHint' as any)}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
