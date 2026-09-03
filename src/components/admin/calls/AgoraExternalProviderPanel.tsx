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
import { useTranslation } from '@/i18n';
import {
  fetchAgoraConfig,
  updateAgoraConfig,
  type AgoraConfigPublicView,
  type AgoraConfigPatch,
} from '@/lib/admin-calls-api';
import { Cloud, ExternalLink, Loader2, Save, ShieldAlert } from 'lucide-react';

export function AgoraExternalProviderPanel() {
  const { toast } = useToast();
  const { t } = useTranslation();
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
        title: t('admin.voiceVideo.agora.loadFailed' as any),
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
      toast({ title: t('admin.voiceVideo.agora.saved' as any) });
    } catch (e: any) {
      toast({ title: t('admin.voiceVideo.agora.saveFailed' as any), description: e.message, variant: 'destructive' });
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
                <ExternalLink className="h-3 w-3" /> {t('admin.voiceVideo.agora.externalCloud' as any)}
              </Badge>
              <Badge variant="secondary">{t('admin.voiceVideo.agora.notSelfHosted' as any)}</Badge>
            </CardTitle>
            <CardDescription>
              {t('admin.voiceVideo.agora.descriptionBefore' as any)} <code>agora_cloud</code>{' '}
              {t('admin.voiceVideo.agora.descriptionAfter' as any)}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="agora-enabled" className="text-sm">
              {t('admin.voiceVideo.agora.enabled' as any)}
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
            <AlertTitle>{t('admin.voiceVideo.agora.externalActive' as any)}</AlertTitle>
            <AlertDescription>{t('admin.voiceVideo.agora.externalWarning' as any)}</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>{t('admin.voiceVideo.agora.appId' as any)}</Label>
            <Input
              value={cfg.app_id ?? ''}
              onChange={(e) => setCfg({ ...cfg, app_id: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.app_id ?? '')) save({ app_id: v || null });
              }}
              placeholder={t('admin.voiceVideo.agora.appIdPlaceholder' as any)}
            />
          </div>
          <div>
            <Label>{t('admin.voiceVideo.agora.region' as any)}</Label>
            <Input
              value={cfg.region ?? ''}
              onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (cfg.region ?? '')) save({ region: v || null });
              }}
              placeholder={t('admin.voiceVideo.agora.regionPlaceholder' as any)}
            />
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between">
              <Label>{t('admin.voiceVideo.agora.appCertificate' as any)}</Label>
              <Badge variant={cfg.app_certificate_present ? 'default' : 'secondary'}>
                {cfg.app_certificate_present
                  ? t('admin.voiceVideo.agora.configured' as any)
                  : t('admin.voiceVideo.agora.notSet' as any)}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={appCertEdit}
                onChange={(e) => setAppCertEdit(e.target.value)}
                placeholder={
                  cfg.app_certificate_present
                    ? t('admin.voiceVideo.agora.keepCurrent' as any)
                    : t('admin.voiceVideo.agora.pasteCertificate' as any)
                }
              />
              <Button
                variant="outline"
                disabled={saving || appCertEdit === ''}
                onClick={() => save({ app_certificate: appCertEdit })}
              >
                <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.agora.save' as any)}
              </Button>
              {cfg.app_certificate_present && (
                <Button variant="ghost" disabled={saving} onClick={() => save({ app_certificate: '' })}>
                  {t('admin.voiceVideo.agora.clear' as any)}
                </Button>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label>{t('admin.voiceVideo.agora.tokenSecret' as any)}</Label>
              <Badge variant={cfg.token_secret_present ? 'default' : 'secondary'}>
                {cfg.token_secret_present
                  ? t('admin.voiceVideo.agora.configured' as any)
                  : t('admin.voiceVideo.agora.notSet' as any)}
              </Badge>
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                type="password"
                value={tokenSecretEdit}
                onChange={(e) => setTokenSecretEdit(e.target.value)}
                placeholder={
                  cfg.token_secret_present
                    ? t('admin.voiceVideo.agora.keepCurrent' as any)
                    : t('admin.voiceVideo.agora.tokenSecretPlaceholder' as any)
                }
              />
              <Button
                variant="outline"
                disabled={saving || tokenSecretEdit === ''}
                onClick={() => save({ token_secret: tokenSecretEdit })}
              >
                <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.agora.save' as any)}
              </Button>
              {cfg.token_secret_present && (
                <Button variant="ghost" disabled={saving} onClick={() => save({ token_secret: '' })}>
                  {t('admin.voiceVideo.agora.clear' as any)}
                </Button>
              )}
            </div>
          </div>
        </div>

        <Separator />

        <div>
          <Label>{t('admin.voiceVideo.agora.webhookUrl' as any)}</Label>
          <Input
            value={cfg.webhook_url ?? ''}
            onChange={(e) => setCfg({ ...cfg, webhook_url: e.target.value })}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (cfg.webhook_url ?? '')) save({ webhook_url: v || null });
            }}
            placeholder="https://your-host/api/calls/agora/webhook"
          />
          <p className="text-xs text-muted-foreground mt-1">{t('admin.voiceVideo.agora.webhookHint' as any)}</p>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div>
            <Label>{t('admin.voiceVideo.agora.cloudRecording' as any)}</Label>
            <p className="text-xs text-muted-foreground">{t('admin.voiceVideo.agora.cloudRecordingHint' as any)}</p>
          </div>
          <Switch
            checked={cfg.recording_config.enabled}
            onCheckedChange={(v) => save({ recording_config: { ...cfg.recording_config, enabled: v } })}
            disabled={saving}
          />
        </div>

        {cfg.recording_config.enabled && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t('admin.voiceVideo.agora.storageVendor' as any)}</Label>
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
                placeholder={t('admin.voiceVideo.agora.storageVendorPlaceholder' as any)}
              />
            </div>
            <div>
              <Label>{t('admin.voiceVideo.agora.storageBucket' as any)}</Label>
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
            {t('admin.voiceVideo.agora.status' as any)}:{' '}
            {fullySetUp ? t('admin.voiceVideo.agora.readyOptIn' as any) : t('admin.voiceVideo.agora.notReady' as any)}
          </Badge>
          <Badge variant="outline">{t('admin.voiceVideo.agora.selfHostedNo' as any)}</Badge>
          <Badge variant="outline">{t('admin.voiceVideo.agora.autoSelectedNever' as any)}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
