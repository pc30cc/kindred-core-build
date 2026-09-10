/**
 * WooCommerce (Commerce Integration Platform) configuration panel.
 *
 * Shared between the Plugin Platform detail page
 * (src/pages/app/PluginDetailPage.tsx — reached from Plugins → WooCommerce,
 * where every other connector like Telegram/Bale/WhatsApp/Instagram shows
 * its own config panel instead of the generic "no settings" fallback) and
 * Settings → Commerce (src/pages/app/settings/CommercePage.tsx). One
 * component, two entry points, so they can never drift apart.
 *
 * Pairing itself is INITIATED from the WordPress plugin ("Connect to Web
 * Yar" button in wp-admin) — this panel is where the connection is
 * discovered, monitored, and managed afterward: health, negotiated
 * capabilities, owner permissions, sync status, and diagnostics. No AI
 * prompt/model/handoff settings live here — those stay in the AI Agent
 * settings (docs/commerce/ARCHITECTURE.md).
 *
 * All strings go through useTranslation() (plugins.woocommerce.* in
 * src/i18n/locales/{en,fa}.ts) so this reads correctly for Web Yar's
 * Persian-speaking workspace owners, not just hard-coded English.
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
import { Loader2, CheckCircle2, XCircle, RefreshCw, Download } from 'lucide-react';

const PLUGIN_DOWNLOAD_PATH = '/downloads/webyar-woocommerce.zip';

interface CommerceConnection {
  id: string;
  provider_type: string;
  store_id: string;
  approved_origin: string;
  protocol_version: string;
  connector_version: string | null;
  woocommerce_version: string | null;
  wordpress_version: string | null;
  hpos_enabled: boolean | null;
  capabilities: string[];
  permissions: Record<string, boolean>;
  health: string;
  catalog_ready: boolean;
  last_sync_at: string | null;
  last_event_at: string | null;
  last_error_code: string | null;
}

const PERMISSION_KEYS = [
  'products', 'prices', 'stock', 'orders',
  'order_status', 'tracking', 'customer_history', 'coupons',
] as const;

const HEALTH_KEYS = [
  'connected', 'degraded', 'reconnecting', 'authentication_error',
  'plugin_outdated', 'protocol_mismatch', 'stale_origin', 'offline', 'disconnected',
] as const;

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export function WooCommerceConfigPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['commerce-connections', workspaceId],
    queryFn: () => api<{ connections: CommerceConnection[] }>(`/api/workspaces/${workspaceId}/commerce/connections`),
    enabled: !!workspaceId,
    refetchInterval: 15_000,
  });

  const connection = data?.connections?.[0] ?? null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['commerce-connections', workspaceId] });

  const runAction = async (actionLabel: string, path: string) => {
    if (!workspaceId || !connection) return;
    setBusyAction(actionLabel);
    try {
      await api(`/api/workspaces/${workspaceId}/commerce/connections/${connection.id}/${path}`, { method: 'POST' });
      toast({ title: t('plugins.woocommerce.toast.doneTitle'), description: t('plugins.woocommerce.toast.requested', { action: actionLabel }) });
      invalidate();
    } catch (err) {
      toast({
        title: t('plugins.woocommerce.toast.failedTitle'),
        description: err instanceof Error ? err.message : t('plugins.woocommerce.toast.genericError'),
        variant: 'destructive',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const permissionMutation = useMutation({
    mutationFn: (permissions: Record<string, boolean>) =>
      api(`/api/workspaces/${workspaceId}/commerce/connections/${connection?.id}/permissions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(permissions),
      }),
    onSuccess: invalidate,
    onError: (err: Error) => toast({ title: t('plugins.woocommerce.toast.permissionFailedTitle'), description: err.message, variant: 'destructive' }),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (!connection) {
    const webYarUrl = typeof window !== 'undefined' ? window.location.origin : '';
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('plugins.woocommerce.connect.title')}</CardTitle>
          <CardDescription>{t('plugins.woocommerce.connect.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Button asChild size="lg">
            <a href={PLUGIN_DOWNLOAD_PATH} download>
              <Download className="h-4 w-4 mr-2" />
              {t('plugins.woocommerce.connect.download')}
            </a>
          </Button>

          <div>
            <h3 className="text-sm font-semibold mb-2">{t('plugins.woocommerce.connect.stepsTitle')}</h3>
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>{t('plugins.woocommerce.connect.step1')}</li>
              <li>{t('plugins.woocommerce.connect.step2')}</li>
              <li>{t('plugins.woocommerce.connect.step3')}</li>
              <li>
                {t('plugins.woocommerce.connect.step4')}{' '}
                {webYarUrl && <code className="bg-muted px-1.5 py-0.5 rounded" dir="ltr">{webYarUrl}</code>}
              </li>
              <li>{t('plugins.woocommerce.connect.step5')}</li>
              <li>{t('plugins.woocommerce.connect.step6')}</li>
            </ol>
          </div>

          <p className="text-xs text-muted-foreground">{t('plugins.woocommerce.connect.troubleshoot')}</p>
        </CardContent>
      </Card>
    );
  }

  const healthTone = HEALTH_TONES[connection.health] ?? 'outline';
  const healthLabel = HEALTH_KEYS.includes(connection.health as typeof HEALTH_KEYS[number])
    ? t(`plugins.woocommerce.health.${connection.health}` as never)
    : connection.health;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground" dir="ltr">{connection.approved_origin}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('plugins.woocommerce.connection.title')}
            <Badge variant={healthTone}>{healthLabel}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>{t('plugins.woocommerce.connection.protocol')}: <code dir="ltr">{connection.protocol_version}</code></div>
          <div dir="auto">
            {t('plugins.woocommerce.connection.versions', {
              woo: connection.woocommerce_version ?? '—',
              wp: connection.wordpress_version ?? '—',
            })}
          </div>
          <div>
            {t('plugins.woocommerce.connection.hpos')}: {
              connection.hpos_enabled === null
                ? '—'
                : connection.hpos_enabled
                  ? t('plugins.woocommerce.connection.enabled')
                  : t('plugins.woocommerce.connection.disabled')
            }
          </div>
          <div>
            {t('plugins.woocommerce.connection.catalog')}: {
              connection.catalog_ready
                ? t('plugins.woocommerce.connection.catalogReady')
                : t('plugins.woocommerce.connection.catalogSyncing')
            }
          </div>
          {connection.last_error_code && (
            <div className="text-destructive">
              {t('plugins.woocommerce.connection.lastError', { code: connection.last_error_code })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('plugins.woocommerce.capabilitiesTitle')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm">
          {['products.read', 'availability.read', 'orders.read', 'tracking.read', 'customer_context'].map((cap) => (
            <div key={cap} className="flex items-center gap-2" dir="ltr">
              {connection.capabilities.includes(cap)
                ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                : <XCircle className="h-4 w-4 text-muted-foreground" />}
              {cap}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('plugins.woocommerce.permissions.title')}</CardTitle>
          <CardDescription>{t('plugins.woocommerce.permissions.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          {PERMISSION_KEYS.map((key) => (
            <label key={key} className="flex items-center justify-between gap-2 text-sm">
              {t(`plugins.woocommerce.permissions.${key}` as never)}
              <Switch
                checked={!!connection.permissions?.[key]}
                onCheckedChange={(checked) => permissionMutation.mutate({ ...connection.permissions, [key]: checked })}
              />
            </label>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!!busyAction} onClick={() => runAction(t('plugins.woocommerce.actions.test'), 'test')}>
          {busyAction === t('plugins.woocommerce.actions.test') ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          {t('plugins.woocommerce.actions.test')}
        </Button>
        <Button variant="outline" disabled={!!busyAction} onClick={() => runAction(t('plugins.woocommerce.actions.sync'), 'sync')}>
          {t('plugins.woocommerce.actions.sync')}
        </Button>
        <Button variant="outline" disabled={!!busyAction} onClick={() => runAction(t('plugins.woocommerce.actions.rotate'), 'rotate')}>
          {t('plugins.woocommerce.actions.rotate')}
        </Button>
        <Button
          variant="destructive"
          disabled={!!busyAction}
          onClick={() => {
            if (confirm(t('plugins.woocommerce.actions.disconnectConfirm'))) runAction(t('plugins.woocommerce.actions.disconnect'), 'disconnect');
          }}
        >
          {t('plugins.woocommerce.actions.disconnect')}
        </Button>
      </div>
    </div>
  );
}
