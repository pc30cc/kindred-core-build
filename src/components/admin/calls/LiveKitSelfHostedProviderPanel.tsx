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
import {
  fetchLiveKitConfig,
  updateLiveKitConfig,
  type LiveKitConfigPublicView,
  type LiveKitConfigPatch,
} from '@/lib/admin-calls-api';
import { Server, Loader2, Save, ShieldCheck, Info, CheckCircle2, AlertTriangle } from 'lucide-react';

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<LiveKitConfigPublicView | null>(null);

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
    } catch (e: any) {
      toast({
        title: 'Failed to load LiveKit settings',
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
      if ('api_key' in patch) setApiKeyEdit('');
      if ('api_secret' in patch) setApiSecretEdit('');
      if ('webhook_secret' in patch) setWebhookSecretEdit('');
      if (patch.recording_storage && 'access_key' in patch.recording_storage) setS3AccessEdit('');
      if (patch.recording_storage && 'secret_key' in patch.recording_storage) setS3SecretEdit('');
      toast({ title: 'LiveKit settings saved' });
    } catch (e: any) {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" /> LiveKit
              <Badge variant="outline" className="gap-1">
                <ShieldCheck className="h-3 w-3" /> Self-hosted
              </Badge>
              <Badge variant={ready ? 'default' : 'secondary'} className="gap-1">
                {ready ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                {ready ? 'Ready' : 'Not ready'}
              </Badge>
            </CardTitle>
            <CardDescription>
              Connect your self-hosted LiveKit server. Secrets are write-only — the UI only
              shows whether each value is configured, never the value itself.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="livekit-enabled" className="text-sm">Enabled</Label>
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
          <div className="text-xs font-semibold text-foreground">Readiness</div>
          <div className="flex flex-wrap gap-2">
            <ReadinessBadge ok={cfg.enabled} label="Enabled" />
            <ReadinessBadge ok={cfg.api_key_present} label="API key" />
            <ReadinessBadge ok={cfg.api_secret_present} label="API secret" />
            <ReadinessBadge ok={!!cfg.rtc_url} label="RTC URL" />
          </div>
          {!ready && (
            <p className="text-[11px] text-muted-foreground">
              All four conditions must be satisfied for the resolver to mark LiveKit as ready.
            </p>
          )}
        </div>

        {/* URLs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>RTC URL</Label>
            <Input
              value={cfg.rtc_url ?? ''}
              onChange={(e) => setCfg({ ...cfg, rtc_url: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.rtc_url ?? '')) save({ rtc_url: v || null });
              }}
              placeholder="wss://livekit.example.com"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Required. The LiveKit server signaling endpoint.
            </p>
          </div>
          <div>
            <Label>WebSocket URL (optional override)</Label>
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
              Defaults to RTC URL when blank.
            </p>
          </div>
          <div>
            <Label>Region (optional)</Label>
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
              <Label>API Key</Label>
              <Badge variant={cfg.api_key_present ? 'default' : 'secondary'}>
                {cfg.api_key_present ? 'configured' : 'not set'}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={apiKeyEdit}
                onChange={(e) => setApiKeyEdit(e.target.value)}
                placeholder={cfg.api_key_present ? 'Leave blank to keep current value' : 'Paste LiveKit API key'}
              />
              <Button
                variant="outline"
                disabled={saving || apiKeyEdit === ''}
                onClick={() => save({ api_key: apiKeyEdit })}
              >
                <Save className="h-4 w-4 mr-2" /> Save
              </Button>
              {cfg.api_key_present && (
                <Button variant="ghost" disabled={saving} onClick={() => save({ api_key: '' })}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label>API Secret</Label>
              <Badge variant={cfg.api_secret_present ? 'default' : 'secondary'}>
                {cfg.api_secret_present ? 'configured' : 'not set'}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={apiSecretEdit}
                onChange={(e) => setApiSecretEdit(e.target.value)}
                placeholder={cfg.api_secret_present ? 'Leave blank to keep current value' : 'Paste LiveKit API secret'}
              />
              <Button
                variant="outline"
                disabled={saving || apiSecretEdit === ''}
                onClick={() => save({ api_secret: apiSecretEdit })}
              >
                <Save className="h-4 w-4 mr-2" /> Save
              </Button>
              {cfg.api_secret_present && (
                <Button variant="ghost" disabled={saving} onClick={() => save({ api_secret: '' })}>
                  Clear
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
              <Label>Webhook secret (optional)</Label>
              <p className="text-[11px] text-muted-foreground">
                Used to verify LiveKit server webhooks. Defaults to API secret when blank.
              </p>
            </div>
            <Badge variant={cfg.webhook_secret_present ? 'default' : 'secondary'}>
              {cfg.webhook_secret_present ? 'configured' : 'not set'}
            </Badge>
          </div>
          <div className="flex gap-2 mt-1">
            <Input
              type="password"
              value={webhookSecretEdit}
              onChange={(e) => setWebhookSecretEdit(e.target.value)}
              placeholder={cfg.webhook_secret_present ? 'Leave blank to keep current value' : 'Optional webhook secret'}
            />
            <Button
              variant="outline"
              disabled={saving || webhookSecretEdit === ''}
              onClick={() => save({ webhook_secret: webhookSecretEdit })}
            >
              <Save className="h-4 w-4 mr-2" /> Save
            </Button>
            {cfg.webhook_secret_present && (
              <Button variant="ghost" disabled={saving} onClick={() => save({ webhook_secret: '' })}>
                Clear
              </Button>
            )}
          </div>
        </div>

        <Separator />

        {/* Egress */}
        <div className="flex items-center justify-between">
          <div>
            <Label>Egress (recording / streaming)</Label>
            <p className="text-[11px] text-muted-foreground">
              Enable LiveKit Egress for server-side recording and streaming.
            </p>
          </div>
          <Switch
            checked={cfg.egress_enabled}
            onCheckedChange={(v) => save({ egress_enabled: v })}
            disabled={saving}
          />
        </div>
        {cfg.egress_enabled && (
          <div>
            <Label>Egress URL</Label>
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
              <div className="text-xs font-semibold text-foreground">Recording storage (S3 / S3-compatible)</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>Vendor</Label>
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
                    <option value="">— none —</option>
                    <option value="s3">AWS S3</option>
                    <option value="s3_compatible">S3-compatible (MinIO, R2, etc.)</option>
                  </select>
                </div>
                <div>
                  <Label>Bucket</Label>
                  <Input
                    value={cfg.recording_storage.bucket ?? ''}
                    onChange={(e) => setCfg({
                      ...cfg,
                      recording_storage: { ...cfg.recording_storage, bucket: e.target.value },
                    })}
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
                  <Label>Region</Label>
                  <Input
                    value={cfg.recording_storage.region ?? ''}
                    onChange={(e) => setCfg({
                      ...cfg,
                      recording_storage: { ...cfg.recording_storage, region: e.target.value },
                    })}
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
                  <Label>Endpoint (S3-compatible)</Label>
                  <Input
                    value={cfg.recording_storage.endpoint ?? ''}
                    onChange={(e) => setCfg({
                      ...cfg,
                      recording_storage: { ...cfg.recording_storage, endpoint: e.target.value },
                    })}
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
                <Label htmlFor="lk-fps" className="text-sm">Force path-style URLs</Label>
                <Switch
                  id="lk-fps"
                  checked={cfg.recording_storage.force_path_style}
                  onCheckedChange={(v) => save({ recording_storage: { force_path_style: v } })}
                  disabled={saving}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <Label>Access key</Label>
                  <Badge variant={cfg.recording_storage.access_key_present ? 'default' : 'secondary'}>
                    {cfg.recording_storage.access_key_present ? 'configured' : 'not set'}
                  </Badge>
                </div>
                <div className="flex gap-2 mt-1">
                  <Input
                    type="password"
                    value={s3AccessEdit}
                    onChange={(e) => setS3AccessEdit(e.target.value)}
                    placeholder={cfg.recording_storage.access_key_present ? 'Leave blank to keep' : 'S3 access key'}
                  />
                  <Button
                    variant="outline"
                    disabled={saving || s3AccessEdit === ''}
                    onClick={() => save({ recording_storage: { access_key: s3AccessEdit } })}
                  >
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  {cfg.recording_storage.access_key_present && (
                    <Button
                      variant="ghost"
                      disabled={saving}
                      onClick={() => save({ recording_storage: { access_key: '' } })}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <Label>Secret key</Label>
                  <Badge variant={cfg.recording_storage.secret_key_present ? 'default' : 'secondary'}>
                    {cfg.recording_storage.secret_key_present ? 'configured' : 'not set'}
                  </Badge>
                </div>
                <div className="flex gap-2 mt-1">
                  <Input
                    type="password"
                    value={s3SecretEdit}
                    onChange={(e) => setS3SecretEdit(e.target.value)}
                    placeholder={cfg.recording_storage.secret_key_present ? 'Leave blank to keep' : 'S3 secret key'}
                  />
                  <Button
                    variant="outline"
                    disabled={saving || s3SecretEdit === ''}
                    onClick={() => save({ recording_storage: { secret_key: s3SecretEdit } })}
                  >
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  {cfg.recording_storage.secret_key_present && (
                    <Button
                      variant="ghost"
                      disabled={saving}
                      onClick={() => save({ recording_storage: { secret_key: '' } })}
                    >
                      Clear
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
          <AlertTitle>TURN / ICE policy lives in the Network section</AlertTitle>
          <AlertDescription>
            TURN URLs, TURN credentials and ICE policy are cross-provider network settings.
            They are configured in the <em>Channels &amp; recording</em> tab under RTC / Network,
            and LiveKit consumes those resolved values at runtime.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}