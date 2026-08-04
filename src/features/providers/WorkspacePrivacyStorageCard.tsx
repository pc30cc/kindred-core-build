/**
 * Workspace-level Privacy Export Storage override card.
 *
 * Lets a workspace owner/admin pick a dedicated storage provider for THIS
 * workspace's privacy export artifacts, overriding the platform default.
 * Backend resolution order (in server/services/privacy/storageResolver.ts):
 *   1) workspace override (this card)
 *   2) platform default (Admin → Providers → Privacy Export Storage)
 *   3) attachment-storage fallback (only if explicitly allowed at platform level)
 *   4) otherwise the export job fails with a clear error
 *
 * Sensitive: privacy export ZIPs contain raw subject PII. We make this UI
 * intentionally distinct from generic provider settings.
 */
import { useEffect, useState } from 'react';
import { ShieldAlert, Save, Loader2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from '@/lib/toast';
import {
  useWorkspacePrivacyStorage,
  useUpsertWorkspacePrivacyStorage,
  useClearWorkspacePrivacyStorage,
  type PrivacyStorageProvider,
} from '@/hooks/useWorkspacePrivacyStorage';

interface FieldDef { key: string; label: string; placeholder?: string; secret?: boolean; }

const PROVIDER_FIELDS: Record<PrivacyStorageProvider, FieldDef[]> = {
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

export function WorkspacePrivacyStorageCard({ workspaceId }: { workspaceId: string }) {
  const { data: existing, isLoading } = useWorkspacePrivacyStorage(workspaceId);
  const upsert = useUpsertWorkspacePrivacyStorage(workspaceId);
  const clear = useClearWorkspacePrivacyStorage(workspaceId);

  const [provider, setProvider] = useState<PrivacyStorageProvider>('local');
  const [config, setConfig] = useState<Record<string, string>>({});

  useEffect(() => {
    if (existing) {
      setProvider(existing.provider_name);
      setConfig((existing.config || {}) as Record<string, string>);
    }
  }, [existing]);

  const fields = PROVIDER_FIELDS[provider] || [];

  const onSave = () => {
    upsert.mutate(
      { provider_name: provider, config },
      {
        onSuccess: () => toast.success('Workspace privacy export storage saved'),
        onError: (e) => toast.error('Save failed: ' + (e as Error).message),
      },
    );
  };

  const onClear = () => {
    clear.mutate(undefined, {
      onSuccess: () => {
        toast.success('Workspace override removed — using platform default');
        setProvider('local');
        setConfig({});
      },
      onError: (e) => toast.error('Remove failed: ' + (e as Error).message),
    });
  };

  return (
    <Card className="border-warning/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="w-4 h-4 text-warning" />
          Privacy Export Storage (workspace override)
        </CardTitle>
        <CardDescription className="text-xs">
          Choose where this workspace's GDPR/privacy export ZIPs are stored.
          Leaving this empty falls back to the platform default. Privacy
          exports contain raw subject PII and are intentionally separated
          from your normal attachment storage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle className="text-xs">Resolution order</AlertTitle>
          <AlertDescription className="text-xs space-y-0.5 mt-1">
            <p>1. This workspace override (if set below)</p>
            <p>2. Platform default</p>
            <p>3. Attachment storage fallback (only if the platform allows it)</p>
            <p>4. Otherwise the export job fails — never silently writes to /tmp.</p>
          </AlertDescription>
        </Alert>

        {isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label className="text-xs">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => { setProvider(v as PrivacyStorageProvider); setConfig({}); }}
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
                    value={config[f.key] ?? ''}
                    onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <Button onClick={onSave} disabled={upsert.isPending} size="sm" className="gap-1.5">
                {upsert.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save override
              </Button>

              {existing && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5 me-1" /> Remove override
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove privacy storage override?</AlertDialogTitle>
                      <AlertDialogDescription>
                        New privacy exports for this workspace will revert to the
                        platform default storage policy. Existing artifacts that
                        were already written via the override remain readable from
                        their original provider until they expire.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onClear}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
