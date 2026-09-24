/**
 * WHMCS configuration panel (Plugins → WHMCS).
 *
 * Pairing is started from the WHMCS side (Addons → Web Yar → "Connect to Web
 * Yar"), exactly like the WordPress plugin. This panel is where the
 * connection is found afterwards: its observed health, versions, and which
 * account sections the assistant may read.
 *
 * Cost rules it follows (docs/commerce/WHMCS.md §Limits):
 *  - it reads Web Yar's own connection row only — the same query, and the
 *    same cache entry, as the WooCommerce panel; nothing here polls;
 *  - the merchant's WHMCS is contacted only when the admin presses "Check
 *    connection", and that button is busy while a check runs and cools down
 *    afterwards (the server also coalesces and rate-limits it);
 *  - there is no "Sync" action: WHMCS data is read live per question and
 *    never copied into Web Yar.
 *
 * Strings: plugins.whmcs.* in src/i18n/locales/{en,fa,tr}.ts.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { API_BASE } from '@/lib/apiBase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { formatDateTime } from '@/lib/date';
import { Loader2, RefreshCw, Download, ShieldCheck } from 'lucide-react';
import { WHMCS_CONNECTION_PERMISSIONS, WHMCS_DEFAULT_PERMISSIONS } from '../../../shared/commerce/whmcs';

const ADDON_DOWNLOAD_PATH = '/downloads/webyar-whmcs.zip';
/** After a check, the button rests this long before it can run another. */
const CHECK_COOLDOWN_MS = 10_000;

interface CommerceConnection {
  id: string;
  provider_type: string;
  store_id: string;
  approved_origin: string;
  protocol_version: string;
  connector_version: string | null;
  platform_version?: string | null;
  permissions: Record<string, boolean> | null;
  health: string;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
}

interface CheckResult {
  ok: boolean;
  health: string;
  lastErrorCode: string | null;
  checkedAt: string;
}

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

/** Error codes with a plain explanation; anything else is shown as its code. */
const KNOWN_ERRORS = [
  'commerce_permission_denied', 'commerce_live_unavailable', 'commerce_timeout',
  'schema_unsupported', 'connector_outdated', 'protocol_mismatch', 'rate_limited',
] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function WhmcsConfigPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const [lastCheck, setLastCheck] = useState<CheckResult | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!coolingDown) return;
    const timer = setTimeout(() => setCoolingDown(false), CHECK_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [coolingDown]);

  const { data, isLoading } = useQuery({
    // Same key as the WooCommerce panel: one request serves both.
    queryKey: ['commerce-connections', workspaceId],
    queryFn: () => api<{ connections: CommerceConnection[] }>(`/api/workspaces/${workspaceId}/commerce/connections`),
    enabled: !!workspaceId,
  });

  const connection = data?.connections?.find((c) => c.provider_type === 'whmcs') ?? null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['commerce-connections', workspaceId] });

  const permissions: Record<string, boolean> = { ...WHMCS_DEFAULT_PERMISSIONS };
  for (const key of WHMCS_CONNECTION_PERMISSIONS) {
    if (typeof connection?.permissions?.[key] === 'boolean') permissions[key] = connection.permissions[key];
  }

  const permissionMutation = useMutation({
    mutationFn: (next: Record<string, boolean>) =>
      api(`/api/workspaces/${workspaceId}/commerce/connections/${connection?.id}/permissions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }),
    onSuccess: invalidate,
    onError: (err: Error) => toast({ title: t('plugins.whmcs.toast.permissionFailed'), description: err.message, variant: 'destructive' }),
  });

  const runCheck = async () => {
    if (!connection || checking || coolingDown) return;
    setChecking(true);
    try {
      const result = await api<CheckResult>(`/api/workspaces/${workspaceId}/commerce/connections/${connection.id}/test`, { method: 'POST' });
      setLastCheck(result);
      invalidate();
    } catch (err) {
      const status = (err as { status?: number }).status;
      toast({
        title: t('plugins.whmcs.toast.checkFailed'),
        description: status === 429 ? t('plugins.whmcs.toast.tooMany') : err instanceof Error ? err.message : '',
        variant: 'destructive',
      });
    } finally {
      setChecking(false);
      setCoolingDown(true);
    }
  };

  const disconnect = async () => {
    if (!connection || !confirm(t('plugins.whmcs.actions.disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      await api(`/api/workspaces/${workspaceId}/commerce/connections/${connection.id}/disconnect`, { method: 'POST' });
      setLastCheck(null);
      invalidate();
    } catch (err) {
      toast({ title: t('plugins.whmcs.toast.disconnectFailed'), description: err instanceof Error ? err.message : '', variant: 'destructive' });
    } finally {
      setDisconnecting(false);
    }
  };

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
          <CardTitle>{t('plugins.whmcs.connect.title')}</CardTitle>
          <CardDescription>{t('plugins.whmcs.connect.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Button asChild size="lg">
            <a href={ADDON_DOWNLOAD_PATH} download>
              <Download className="h-4 w-4 me-2" />
              {t('plugins.whmcs.connect.download')}
            </a>
          </Button>

          <div>
            <h3 className="text-sm font-semibold mb-2">{t('plugins.whmcs.connect.stepsTitle')}</h3>
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>{t('plugins.whmcs.connect.step1')}</li>
              <li>{t('plugins.whmcs.connect.step2')}</li>
              <li>
                {t('plugins.whmcs.connect.step3')}{' '}
                {webYarUrl && <code className="bg-muted px-1.5 py-0.5 rounded" dir="ltr">{webYarUrl}</code>}
              </li>
              <li>{t('plugins.whmcs.connect.step4')}</li>
              <li>{t('plugins.whmcs.connect.step5')}</li>
            </ol>
          </div>

          <p className="text-xs text-muted-foreground">{t('plugins.whmcs.connect.requirements')}</p>
          <p className="text-xs text-muted-foreground">{t('plugins.whmcs.connect.noBackground')}</p>
        </CardContent>
      </Card>
    );
  }

  const health = lastCheck?.health ?? connection.health;
  const errorCode = lastCheck ? lastCheck.lastErrorCode : connection.last_error_code;
  const healthLabel = HEALTH_KEYS.includes(health as typeof HEALTH_KEYS[number])
    ? t(`plugins.whmcs.health.${health}` as never)
    : health;
  const errorText = errorCode
    ? KNOWN_ERRORS.includes(errorCode as typeof KNOWN_ERRORS[number])
      ? t(`plugins.whmcs.errors.${errorCode}` as never)
      : t('plugins.whmcs.errors.other', { code: errorCode })
    : null;
  // "Last observed", never a guess: the time of the check just run, else the
  // latest time the server recorded a success or an error.
  const observedAt = lastCheck?.checkedAt
    ?? [connection.last_success_at, connection.last_error_at].filter(Boolean).sort().pop()
    ?? null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground" dir="ltr">{connection.store_id || connection.approved_origin}</p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('plugins.whmcs.connection.title')}
            <Badge variant={HEALTH_TONES[health] ?? 'outline'}>{healthLabel}</Badge>
          </CardTitle>
          <CardDescription>
            {observedAt
              ? t('plugins.whmcs.connection.observedAt', { time: formatDateTime(observedAt) })
              : t('plugins.whmcs.connection.neverChecked')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>{t('plugins.whmcs.connection.addonVersion')}: <code dir="ltr">{connection.connector_version ?? '—'}</code></div>
          <div>{t('plugins.whmcs.connection.whmcsVersion')}: <code dir="ltr">{connection.platform_version ?? '—'}</code></div>
          <div>{t('plugins.whmcs.connection.protocol')}: <code dir="ltr">{connection.protocol_version}</code></div>
          {errorText && <div className="text-destructive">{errorText}</div>}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" disabled={checking || coolingDown || disconnecting} onClick={runCheck}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <RefreshCw className="h-4 w-4 me-2" />}
              {checking ? t('plugins.whmcs.actions.checking') : t('plugins.whmcs.actions.check')}
            </Button>
            <Button variant="destructive" disabled={checking || disconnecting} onClick={disconnect}>
              {disconnecting && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              {t('plugins.whmcs.actions.disconnect')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('plugins.whmcs.permissions.title')}</CardTitle>
          <CardDescription>{t('plugins.whmcs.permissions.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {WHMCS_CONNECTION_PERMISSIONS.map((key) => (
            <label key={key} className="flex items-start justify-between gap-4 text-sm">
              <span>
                <span className="font-medium">{t(`plugins.whmcs.permissions.${key}` as never)}</span>
                <span className="block text-xs text-muted-foreground">{t(`plugins.whmcs.permissions.${key}Hint` as never)}</span>
              </span>
              <Switch
                checked={permissions[key]}
                disabled={permissionMutation.isPending}
                onCheckedChange={(checked) => permissionMutation.mutate({ ...permissions, [key]: checked })}
              />
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            {t('plugins.whmcs.privacy.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-muted-foreground space-y-2 list-disc list-inside">
            <li>{t('plugins.whmcs.privacy.signedIn')}</li>
            <li>{t('plugins.whmcs.privacy.live')}</li>
            <li>{t('plugins.whmcs.privacy.readOnly')}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
