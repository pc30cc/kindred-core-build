/**
 * Settings → Commerce → WooCommerce.
 *
 * Web Yar-side half of the Commerce Integration Platform admin UX
 * (docs/commerce/ARCHITECTURE.md). Pairing itself is INITIATED from the
 * WordPress plugin ("Connect to Web Yar" button in wp-admin) — this page
 * is where the connection is monitored and managed afterward: health,
 * negotiated capabilities, owner permissions, sync status, and
 * diagnostics. No AI prompt/model/handoff settings live here — those stay
 * in the AI Agent settings, per spec §34/§36.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { API_BASE } from '@/lib/apiBase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { Loader2, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';

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

const PERMISSION_LABELS: Record<string, string> = {
  products: 'Products',
  prices: 'Prices',
  stock: 'Stock',
  orders: 'Orders',
  order_status: 'Order status',
  tracking: 'Tracking',
  customer_history: 'Customer order history',
  coupons: 'Coupons',
};

const HEALTH_LABELS: Record<string, { label: string; tone: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  connected: { label: 'Healthy', tone: 'default' },
  degraded: { label: 'Degraded', tone: 'secondary' },
  reconnecting: { label: 'Connecting…', tone: 'secondary' },
  authentication_error: { label: 'Authentication error', tone: 'destructive' },
  plugin_outdated: { label: 'Plugin outdated', tone: 'destructive' },
  protocol_mismatch: { label: 'Protocol mismatch', tone: 'destructive' },
  stale_origin: { label: 'Store origin changed', tone: 'destructive' },
  offline: { label: 'Offline', tone: 'destructive' },
  disconnected: { label: 'Disconnected', tone: 'outline' },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export default function CommercePage() {
  const workspace = useCurrentWorkspace();
  const workspaceId = workspace?.id;
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

  const runAction = async (action: string, path: string) => {
    if (!workspaceId || !connection) return;
    setBusyAction(action);
    try {
      await api(`/api/workspaces/${workspaceId}/commerce/connections/${connection.id}/${path}`, { method: 'POST' });
      toast({ title: 'Done', description: `${action} requested.` });
      invalidate();
    } catch (err) {
      toast({ title: 'Failed', description: err instanceof Error ? err.message : 'Something went wrong', variant: 'destructive' });
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
    onError: (err: Error) => toast({ title: 'Could not update permission', description: err.message, variant: 'destructive' }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-4">
        <h1 className="text-2xl font-semibold">Commerce</h1>
        <Card>
          <CardHeader>
            <CardTitle>Connect a WooCommerce store</CardTitle>
            <CardDescription>
              Install the "Web Yar Connector for WooCommerce" plugin on your WordPress site, then click
              "Connect to Web Yar" inside wp-admin. You'll be brought back here automatically once the
              store is paired — there's no API key to copy or paste.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            No store is connected to this workspace yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  const health = HEALTH_LABELS[connection.health] ?? { label: connection.health, tone: 'outline' as const };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Commerce — WooCommerce</h1>
        <p className="text-sm text-muted-foreground">{connection.approved_origin}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Connection
            <Badge variant={health.tone}>{health.label}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>Protocol: <code>{connection.protocol_version}</code></div>
          <div>WooCommerce: {connection.woocommerce_version ?? '—'} · WordPress: {connection.wordpress_version ?? '—'}</div>
          <div>HPOS: {connection.hpos_enabled === null ? '—' : connection.hpos_enabled ? 'enabled' : 'disabled'}</div>
          <div>Catalog: {connection.catalog_ready ? 'Ready' : 'Syncing…'}</div>
          {connection.last_error_code && <div className="text-destructive">Last error: {connection.last_error_code}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Capabilities</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm">
          {['products.read', 'availability.read', 'orders.read', 'tracking.read', 'customer_context'].map((cap) => (
            <div key={cap} className="flex items-center gap-2">
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
          <CardTitle>Permissions</CardTitle>
          <CardDescription>Changes take effect immediately for the AI Assistant's commerce tools.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          {Object.entries(PERMISSION_LABELS).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between gap-2 text-sm">
              {label}
              <Switch
                checked={!!connection.permissions?.[key]}
                onCheckedChange={(checked) => permissionMutation.mutate({ ...connection.permissions, [key]: checked })}
              />
            </label>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!!busyAction} onClick={() => runAction('Test connection', 'test')}>
          {busyAction === 'Test connection' ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Test connection
        </Button>
        <Button variant="outline" disabled={!!busyAction} onClick={() => runAction('Sync now', 'sync')}>
          Sync now
        </Button>
        <Button variant="outline" disabled={!!busyAction} onClick={() => runAction('Rotate credentials', 'rotate')}>
          Rotate credentials
        </Button>
        <Button
          variant="destructive"
          disabled={!!busyAction}
          onClick={() => {
            if (confirm('Disconnect this store from Web Yar?')) runAction('Disconnect', 'disconnect');
          }}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}
