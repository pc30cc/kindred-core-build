/**
 * Admin → Providers → Privacy Export Storage
 *
 * Privacy export ZIPs contain raw subject PII and are intentionally
 * resolved through their OWN storage policy — separate from the normal
 * attachment storage provider. This card lets a platform admin set:
 *
 *   - which storage provider holds privacy export artifacts
 *   - whether to fall back to the workspace's attachment storage when
 *     no privacy-export-specific provider is set
 *
 * The selected provider may be any vendor the storage subsystem already
 * supports (local, s3, bunny_storage, …). Provider-specific credentials
 * are stored in app_runtime_config under key 'privacy_export_storage'.
 * Workspace-level overrides live in provider_configs with provider_type
 * 'privacy_export_storage'.
 */

import { useEffect, useState } from 'react';
import { ShieldAlert, Save, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { adminFetch } from '@/hooks/useAdmin';
import { toast } from '@/hooks/use-toast';

type Provider = 'local' | 's3' | 'cloudflare_r2' | 'minio' | 'do_spaces' | 'bunny_storage';

interface PolicyValue {
  provider: Provider;
  config: Record<string, string | undefined>;
  allow_attachment_fallback: boolean;
}

const DEFAULT_VALUE: PolicyValue = {
  provider: 'local',
  config: { local_path: '/var/lib/privacy-exports' },
  allow_attachment_fallback: false,
};

const PROVIDER_FIELDS: Record<Provider, Array<{ key: string; label: string; placeholder?: string; secret?: boolean }>> = {
  local: [
    { key: 'local_path', label: 'Persistent directory', placeholder: '/var/lib/privacy-exports' },
  ],
  s3: [
    { key: 'bucket', label: 'Bucket' },
    { key: 'region', label: 'Region', placeholder: 'us-east-1' },
    { key: 'access_key_id', label: 'Access key ID' },
    { key: 'secret_access_key', label: 'Secret access key', secret: true },
    { key: 'endpoint', label: 'Endpoint (optional)', placeholder: 'https://s3.example.com' },
  ],
  cloudflare_r2: [
    { key: 'bucket', label: 'Bucket' },
    { key: 'access_key_id', label: 'Access key ID' },
    { key: 'secret_access_key', label: 'Secret access key', secret: true },
    { key: 'endpoint', label: 'R2 endpoint', placeholder: 'https://<account>.r2.cloudflarestorage.com' },
  ],
  minio: [
    { key: 'bucket', label: 'Bucket' },
    { key: 'access_key_id', label: 'Access key' },
    { key: 'secret_access_key', label: 'Secret key', secret: true },
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://minio.example.com' },
    { key: 'region', label: 'Region', placeholder: 'us-east-1' },
  ],
  do_spaces: [
    { key: 'bucket', label: 'Space name' },
    { key: 'region', label: 'Region', placeholder: 'nyc3' },
    { key: 'access_key_id', label: 'Access key' },
    { key: 'secret_access_key', label: 'Secret key', secret: true },
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://nyc3.digitaloceanspaces.com' },
  ],
  bunny_storage: [
    { key: 'storage_zone', label: 'Storage zone' },
    { key: 'api_key', label: 'API key', secret: true },
    { key: 'region', label: 'Region (optional)', placeholder: 'de' },
  ],
};

export function PrivacyExportStorageCard() {
  const [value, setValue] = useState<PolicyValue>(DEFAULT_VALUE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const loaded = await adminFetch<{ value: unknown }>(
        '/api/admin/management/runtime-config/privacy_export_storage',
      ).catch(() => ({ value: null }));
      if (loaded.value && typeof loaded.value === 'object' && !Array.isArray(loaded.value)) {
        const v = loaded.value as Record<string, unknown>;
        setValue({
          provider: (v.provider as Provider) || 'local',
          config: (v.config as Record<string, string | undefined>) || {},
          allow_attachment_fallback: Boolean(v.allow_attachment_fallback),
        });
      }
      setLoading(false);
    })();
  }, []);

  const onSave = async () => {
    setSaving(true);
    try {
      await adminFetch('/api/admin/management/runtime-config/privacy_export_storage', {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
    } catch (err) {
      setSaving(false);
      toast({
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
      return;
    }
    setSaving(false);
    toast({ title: 'Privacy export storage updated' });
  };

  const fields = PROVIDER_FIELDS[value.provider] || [];

  return (
    <Card className="border-warning/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="w-4 h-4 text-warning" />
          Privacy Export Storage
        </CardTitle>
        <CardDescription className="text-xs">
          Where GDPR/privacy export ZIPs are stored. This is intentionally
          separate from normal attachment storage because export artifacts
          contain raw subject PII.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle className="text-xs">Resolution order</AlertTitle>
          <AlertDescription className="text-xs space-y-0.5 mt-1">
            <p>1. Workspace privacy-export override (if configured)</p>
            <p>2. Platform default below</p>
            <p>3. Attachment storage fallback (only if explicitly allowed)</p>
            <p>4. Otherwise the export job fails with a clear error — never silently writes to /tmp.</p>
          </AlertDescription>
        </Alert>

        {loading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select
                value={value.provider}
                onValueChange={(v) => setValue({ ...value, provider: v as Provider, config: {} })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local persistent disk</SelectItem>
                  <SelectItem value="s3">Amazon S3</SelectItem>
                  <SelectItem value="cloudflare_r2">Cloudflare R2</SelectItem>
                  <SelectItem value="minio">MinIO (self-hosted)</SelectItem>
                  <SelectItem value="do_spaces">DigitalOcean Spaces</SelectItem>
                  <SelectItem value="bunny_storage">BunnyCDN Storage</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              {fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label className="text-xs">{f.label}</Label>
                  <Input
                    type={f.secret ? 'password' : 'text'}
                    placeholder={f.placeholder}
                    value={value.config[f.key] ?? ''}
                    onChange={(e) =>
                      setValue({ ...value, config: { ...value.config, [f.key]: e.target.value } })
                    }
                  />
                </div>
              ))}
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm">Allow attachment-storage fallback</Label>
                <p className="text-xs text-muted-foreground">
                  When enabled, a workspace with no privacy-export-specific provider
                  may fall back to its general attachment storage. Off by default to
                  keep PII isolated.
                </p>
              </div>
              <Switch
                checked={value.allow_attachment_fallback}
                onCheckedChange={(v) => setValue({ ...value, allow_attachment_fallback: v })}
              />
            </div>

            <div className="flex justify-end">
              <Button onClick={onSave} disabled={saving} size="sm" className="gap-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save policy
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
