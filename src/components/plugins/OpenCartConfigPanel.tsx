/**
 * OpenCart connection panel (Plugins → OpenCart).
 *
 * OpenCart is a DIRECT connector: Web Yar keeps no copy of the catalogue, so
 * there is no sync status, no "catalog ready" and no background polling to
 * show. This panel therefore loads the connections ONCE when opened (no
 * refetch interval) and refreshes only after an action the owner takes. The
 * "Check connection" button is rate limited on the server (once a minute).
 *
 * Pairing is started from the OpenCart admin (Extensions → Modules → Web Yar
 * → Connect), per store: a multi-store shop connects each store on its own,
 * which is why every connected store is listed separately here.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { API_BASE } from '@/lib/apiBase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { Loader2, RefreshCw, Download, CheckCircle2, XCircle } from 'lucide-react';

export const OPENCART_MANIFEST_PATH = '/downloads/opencart/manifest.json';

/** Fallback when the manifest cannot be read; kept in step with the build script. */
const DEFAULT_PACKAGES: OpenCartPackage[] = [
  { opencart: '4.1.x', path: '/downloads/opencart/4.1/webyar.ocmod.zip', file: 'webyar.ocmod.zip', php: '>=8.1' },
  { opencart: '3.0.5.x', path: '/downloads/opencart/3.0/webyar-oc3.ocmod.zip', file: 'webyar-oc3.ocmod.zip', php: '>=8.1' },
];

interface OpenCartPackage {
  opencart: string;
  path: string;
  file: string;
  php: string;
  tested?: string[];
}

interface Connection {
  id: string;
  provider_type: string;
  store_id: string;
  external_store_id: string | null;
  platform_version: string | null;
  connector_version: string | null;
  protocol_version: string;
  capabilities: string[];
  permissions: Record<string, boolean>;
  health: string;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  last_health_check_at: string | null;
}

const OPENCART_PERMISSION_KEYS = ['products', 'prices', 'stock', 'reviews', 'orders', 'tracking'] as const;

const HEALTH_TONES: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  connected: 'default',
  degraded: 'secondary',
  reconnecting: 'secondary',
  authentication_error: 'destructive',
  plugin_outdated: 'destructive',
  protocol_mismatch: 'destructive',
  stale_origin: 'destructive',
  offline: 'destructive',
  disconnected: 'outline',
};

const KNOWN_HEALTH = Object.keys(HEALTH_TONES);

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export function OpenCartConfigPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  // Loaded once per visit — never polled. The store is not contacted by
  // opening this page; only the owner's explicit "check" does that.
  const { data, isLoading } = useQuery({
    queryKey: ['commerce-connections', workspaceId],
    queryFn: () => api<{ connections: Connection[] }>(`/api/workspaces/${workspaceId}/commerce/connections`),
    enabled: !!workspaceId,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const { data: manifest } = useQuery({
    queryKey: ['opencart-manifest'],
    queryFn: async () => {
      const res = await fetch(OPENCART_MANIFEST_PATH, { cache: 'no-store' });
      if (!res.ok) throw new Error('manifest');
      return res.json() as Promise<{ version: string; packages: OpenCartPackage[] }>;
    },
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    retry: false,
  });

  const connections = (data?.connections ?? []).filter((c) => c.provider_type === 'opencart');
  const packages = manifest?.packages?.length ? manifest.packages : DEFAULT_PACKAGES;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['commerce-connections', workspaceId] });

  const runAction = async (connection: Connection, action: 'test' | 'disconnect') => {
    setBusy(`${connection.id}:${action}`);
    try {
      await api(`/api/workspaces/${workspaceId}/commerce/connections/${connection.id}/${action}`, { method: 'POST' });
      toast({ title: t('plugins.opencart.toast.doneTitle'), description: t(action === 'test' ? 'plugins.opencart.toast.checked' : 'plugins.opencart.toast.disconnected') });
      invalidate();
    } catch (err) {
      const rateLimited = err instanceof ApiError && err.status === 429;
      toast({
        title: t('plugins.opencart.toast.failedTitle'),
        description: rateLimited ? t('plugins.opencart.toast.checkRateLimited') : err instanceof Error ? err.message : t('plugins.opencart.toast.genericError'),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  const permissionMutation = useMutation({
    mutationFn: ({ id, permissions }: { id: string; permissions: Record<string, boolean> }) =>
      api(`/api/workspaces/${workspaceId}/commerce/connections/${id}/permissions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(permissions),
      }),
    onSuccess: invalidate,
    onError: (err: Error) => toast({ title: t('plugins.opencart.toast.permissionFailedTitle'), description: err.message, variant: 'destructive' }),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('plugins.opencart.connect.title')}</CardTitle>
          <CardDescription>{t('plugins.opencart.connect.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {packages.map((pkg) => (
              <div key={pkg.path} className="rounded-lg border p-3 space-y-2">
                <div className="text-sm font-medium" dir="ltr">OpenCart {pkg.opencart}</div>
                <div className="text-xs text-muted-foreground" dir="ltr">PHP {pkg.php} · {pkg.file}</div>
                <Button asChild size="sm" variant="secondary">
                  <a href={pkg.path} download={pkg.file}>
                    <Download className="h-4 w-4 me-2" />
                    {t('plugins.opencart.connect.download', { version: pkg.opencart })}
                  </a>
                </Button>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('plugins.opencart.connect.versionHint')}</p>

          <div>
            <h3 className="text-sm font-semibold mb-2">{t('plugins.opencart.connect.stepsTitle')}</h3>
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>{t('plugins.opencart.connect.step1')}</li>
              <li>{t('plugins.opencart.connect.step2')}</li>
              <li>{t('plugins.opencart.connect.step3')}</li>
              <li>{t('plugins.opencart.connect.step4')}</li>
              <li>{t('plugins.opencart.connect.step5')}</li>
              <li>{t('plugins.opencart.connect.step6')}</li>
            </ol>
          </div>
          <p className="text-xs text-muted-foreground">{t('plugins.opencart.connect.privacy')}</p>
        </CardContent>
      </Card>

      {connections.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('plugins.opencart.noStores')}</p>
      )}

      {connections.map((connection) => {
        const tone = HEALTH_TONES[connection.health] ?? 'outline';
        const healthLabel = KNOWN_HEALTH.includes(connection.health) ? t(`plugins.opencart.health.${connection.health}` as never) : connection.health;
        return (
          <Card key={connection.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <span dir="ltr">{connection.store_id}</span>
                <Badge variant={tone}>{healthLabel}</Badge>
              </CardTitle>
              <CardDescription>
                {t('plugins.opencart.connection.store', { id: connection.external_store_id ?? '0' })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 text-sm">
              <div className="grid gap-1 sm:grid-cols-2">
                <div>{t('plugins.opencart.connection.opencartVersion')}: <code dir="ltr">{connection.platform_version ?? '—'}</code></div>
                <div>{t('plugins.opencart.connection.extensionVersion')}: <code dir="ltr">{connection.connector_version ?? '—'}</code></div>
                <div>{t('plugins.opencart.connection.protocol')}: <code dir="ltr">{connection.protocol_version}</code></div>
                <div>{t('plugins.opencart.connection.lastCheck')}: {connection.last_health_check_at ? new Date(connection.last_health_check_at).toLocaleString() : '—'}</div>
              </div>
              <p className="text-xs text-muted-foreground">{t('plugins.opencart.connection.directNote')}</p>
              {connection.health === 'stale_origin' && <p className="text-destructive">{t('plugins.opencart.connection.staleOrigin')}</p>}
              {connection.last_error_code && (
                <p className="text-destructive">{t('plugins.opencart.connection.lastError', { code: connection.last_error_code })}</p>
              )}

              <div>
                <h4 className="font-medium mb-2">{t('plugins.opencart.capabilitiesTitle')}</h4>
                <div className="grid grid-cols-2 gap-2">
                  {['products.read', 'reviews.read', 'orders.read', 'tracking.read', 'returns.read', 'customer_context'].map((cap) => (
                    <div key={cap} className="flex items-center gap-2" dir="ltr">
                      {connection.capabilities.includes(cap)
                        ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                        : <XCircle className="h-4 w-4 text-muted-foreground" />}
                      {cap}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="font-medium">{t('plugins.opencart.permissions.title')}</h4>
                <p className="text-xs text-muted-foreground mb-2">{t('plugins.opencart.permissions.description')}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {OPENCART_PERMISSION_KEYS.map((key) => {
                    // Reviews default to on when never set (public data).
                    const checked = key === 'reviews' ? connection.permissions?.reviews !== false : !!connection.permissions?.[key];
                    return (
                      <label key={key} className="flex items-center justify-between gap-2">
                        {t(`plugins.opencart.permissions.${key}` as never)}
                        <Switch
                          checked={checked}
                          disabled={permissionMutation.isPending}
                          onCheckedChange={(value) => {
                            const next: Record<string, boolean> = { ...connection.permissions, [key]: value };
                            // One "orders" switch for the owner; the gateway's
                            // finer keys follow it.
                            if (key === 'orders') {
                              next.order_status = value;
                              next.customer_history = value;
                            }
                            permissionMutation.mutate({ id: connection.id, permissions: next });
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!!busy} onClick={() => runAction(connection, 'test')}>
                  {busy === `${connection.id}:test` ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <RefreshCw className="h-4 w-4 me-2" />}
                  {t('plugins.opencart.actions.test')}
                </Button>
                <Button
                  variant="destructive"
                  disabled={!!busy}
                  onClick={() => { if (confirm(t('plugins.opencart.actions.disconnectConfirm'))) runAction(connection, 'disconnect'); }}
                >
                  {t('plugins.opencart.actions.disconnect')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('plugins.opencart.actions.reconnectHint')}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
