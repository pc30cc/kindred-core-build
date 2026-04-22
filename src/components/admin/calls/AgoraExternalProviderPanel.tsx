/**
 * Phase 8A.1 — Agora (External / Cloud) provider admin panel.
 *
 * UX rules (NON-NEGOTIABLE):
 *   - Agora is shown as a separate, clearly-labeled "External / Cloud"
 *     section. It is NEVER presented as equivalent to the self-hosted
 *     LiveKit / Jitsi / Janus family.
 *   - Disabled by default. Requires explicit `enabled` toggle.
 *   - When enabled, the admin sees an explicit warning that Agora
 *     introduces an external dependency.
 *   - Secrets are write-only: the form shows presence indicators, never
 *     the actual stored values. Sending an empty string explicitly clears.
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
  fetchAgoraConfig,
  updateAgoraConfig,
  type AgoraConfigPublicView,
  type AgoraConfigPatch,
} from '@/lib/admin-calls-api';
import { Cloud, ExternalLink, Loader2, Save, ShieldAlert } from 'lucide-react';

export function AgoraExternalProviderPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<AgoraConfigPublicView | null>(null);

  // Local-only secret edit buffers. We never seed them from the server.
  const [appCertEdit, setAppCertEdit] = useState<string>('');
  const [tokenSecretEdit, setTokenSecretEdit] = useState<string>('');

  async function load() {
    setLoading(true);
    try {
      const r = await fetchAgoraConfig();
      setCfg(r.agora);
    } catch (e: any) {
      toast({
        title: 'Failed to load Agora settings',
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

  async function save(patch: AgoraConfigPatch) {
    setSaving(true);
    try {
      const r = await updateAgoraConfig(patch);
      setCfg(r.agora);
      // Clear secret edit buffers after a successful save.
      if ('app_certificate' in patch) setAppCertEdit('');
      if ('token_secret' in patch) setTokenSecretEdit('');
      toast({ title: 'Agora settings saved' });
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

  const fullySetUp = cfg.enabled && !!cfg.app_id && (cfg.app_certificate_present || cfg.token_secret_present);

  return (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Cloud className="h-5 w-5" /> Agora
              <Badge variant="outline" className="gap-1">
                <ExternalLink className="h-3 w-3" /> External / Cloud
              </Badge>
              <Badge variant="secondary">Not self-hosted</Badge>
            </CardTitle>
            <CardDescription>
              Optional cloud-backed voice/video provider. Disabled by default and never
              auto-selected — you must explicitly choose <code>agora_cloud</code> as the
              primary or secondary provider above for it to be used.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="agora-enabled" className="text-sm">
              Enabled
            </Label>
            <Switch
              id="agora-enabled"
              checked={cfg.enabled}
              onCheckedChange={(v) => save({ enabled: v })}
              disabled={saving}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {cfg.enabled && (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>External dependency active</AlertTitle>
            <AlertDescription>
              Enabling Agora routes call media through Agora's cloud infrastructure. This
              breaks the self-hosted-first guarantee. Self-hosted providers (LiveKit, Jitsi,
              Janus) remain available and preferred unless you explicitly select Agora.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>App ID</Label>
            <Input
              value={cfg.app_id ?? ''}
              onChange={(e) => setCfg({ ...cfg, app_id: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.app_id ?? '')) save({ app_id: v || null });
              }}
              placeholder="Agora project App ID"
            />
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
              placeholder="e.g. GLOBAL, EU, NA"
            />
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between">
              <Label>App Certificate</Label>
              <Badge variant={cfg.app_certificate_present ? 'default' : 'secondary'}>
                {cfg.app_certificate_present ? 'configured' : 'not set'}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={appCertEdit}
                onChange={(e) => setAppCertEdit(e.target.value)}
                placeholder={
                  cfg.app_certificate_present
                    ? 'Leave blank to keep current value'
                    : 'Paste Agora App Certificate'
                }
              />
              <Button
                variant="outline"
                disabled={saving || appCertEdit === ''}
                onClick={() => save({ app_certificate: appCertEdit })}
              >
                <Save className="h-4 w-4 mr-2" /> Save
              </Button>
              {cfg.app_certificate_present && (
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => save({ app_certificate: '' })}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label>Token broker secret (alternative)</Label>
              <Badge variant={cfg.token_secret_present ? 'default' : 'secondary'}>
                {cfg.token_secret_present ? 'configured' : 'not set'}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={tokenSecretEdit}
                onChange={(e) => setTokenSecretEdit(e.target.value)}
                placeholder={
                  cfg.token_secret_present
                    ? 'Leave blank to keep current value'
                    : 'Optional — only if you mint via a custom broker'
                }
              />
              <Button
                variant="outline"
                disabled={saving || tokenSecretEdit === ''}
                onClick={() => save({ token_secret: tokenSecretEdit })}
              >
                <Save className="h-4 w-4 mr-2" /> Save
              </Button>
              {cfg.token_secret_present && (
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => save({ token_secret: '' })}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </div>

        <Separator />

        <div>
          <Label>Webhook URL (optional)</Label>
          <Input
            value={cfg.webhook_url ?? ''}
            onChange={(e) => setCfg({ ...cfg, webhook_url: e.target.value })}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (cfg.webhook_url ?? '')) save({ webhook_url: v || null });
            }}
            placeholder="https://your-host/api/calls/agora/webhook"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Admin-managed callback. No domain is hardcoded — supply the URL that Agora
            should call back into.
          </p>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div>
            <Label>Cloud recording</Label>
            <p className="text-xs text-muted-foreground">
              Uses Agora Cloud Recording. Storage destination is supplied below and is not
              hardcoded.
            </p>
          </div>
          <Switch
            checked={cfg.recording_config.enabled}
            onCheckedChange={(v) =>
              save({ recording_config: { ...cfg.recording_config, enabled: v } })
            }
            disabled={saving}
          />
        </div>

        {cfg.recording_config.enabled && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Storage vendor</Label>
              <Input
                value={cfg.recording_config.storage_vendor ?? ''}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    recording_config: { ...cfg.recording_config, storage_vendor: e.target.value },
                  })
                }
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (cfg.recording_config.storage_vendor ?? '')) {
                    save({
                      recording_config: { ...cfg.recording_config, storage_vendor: v || null },
                    });
                  }
                }}
                placeholder="e.g. s3, gcs, oss"
              />
            </div>
            <div>
              <Label>Storage bucket</Label>
              <Input
                value={cfg.recording_config.storage_bucket ?? ''}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    recording_config: { ...cfg.recording_config, storage_bucket: e.target.value },
                  })
                }
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (cfg.recording_config.storage_bucket ?? '')) {
                    save({
                      recording_config: { ...cfg.recording_config, storage_bucket: v || null },
                    });
                  }
                }}
                placeholder="bucket-name"
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          <Badge variant={fullySetUp ? 'default' : 'secondary'}>
            Status: {fullySetUp ? 'ready (opt-in)' : 'not ready'}
          </Badge>
          <Badge variant="outline">Self-hosted: no</Badge>
          <Badge variant="outline">Auto-selected: never</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
