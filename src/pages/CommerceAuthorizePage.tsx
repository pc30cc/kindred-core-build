/**
 * /commerce/authorize?state=...&provider=woocommerce|whmcs
 *
 * The consent screen the WordPress plugin opens in the admin's browser
 * (docs/commerce/SECURITY.md §Pairing, step "user logs in → select
 * Workspace → approve WooCommerce permissions"). On submit, the backend
 * issues a single-use authorization code and this page navigates the
 * browser to the returned redirect URL (back to wp-admin), completing the
 * OAuth-style handoff.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { API_BASE } from '@/lib/apiBase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';

const DEFAULT_PERMISSIONS: Record<string, boolean> = {
  products: true,
  prices: true,
  stock: true,
  orders: false,
  order_status: false,
  tracking: false,
  customer_history: false,
  coupons: false,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export default function CommerceAuthorizePage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const state = searchParams.get('state') || '';
  const { data: workspaces } = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: pairing, isLoading, error: loadError } = useQuery({
    queryKey: ['commerce-pairing', state],
    queryFn: () => api<{ redirectUri: string; requestedOrigin: string; providerType: string; expired: boolean }>(`/api/commerce/pairing/${state}`),
    enabled: !!state,
    retry: false,
  });

  const activeWorkspaceId = useMemo(() => workspaceId || workspaces?.[0]?.id || '', [workspaceId, workspaces]);

  if (!state) return <div className="p-8 text-center text-muted-foreground">{t('commerceAuthorize.missing')}</div>;
  if (isLoading) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (loadError || !pairing) return <div className="p-8 text-center text-destructive">{t('commerceAuthorize.invalid')}</div>;
  // WHMCS starts with only its public catalogue enabled (server-side default);
  // private account sections are turned on later, per section, in Plugins → WHMCS.
  const isWhmcs = pairing.providerType === 'whmcs';
  if (pairing.expired) {
    return <div className="p-8 text-center text-destructive">{t(isWhmcs ? 'commerceAuthorize.whmcs.expired' : 'commerceAuthorize.expired')}</div>;
  }

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<{ redirectUrl: string }>(`/api/commerce/pairing/${state}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: activeWorkspaceId, permissions: isWhmcs ? {} : permissions }),
      });
      window.location.href = result.redirectUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('commerceAuthorize.genericError'));
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto p-6 pt-16">
      <Card>
        <CardHeader>
          <CardTitle>{t(isWhmcs ? 'commerceAuthorize.whmcs.title' : 'commerceAuthorize.title')}</CardTitle>
          <CardDescription>
            {t(isWhmcs ? 'commerceAuthorize.whmcs.description' : 'commerceAuthorize.description', { origin: pairing.requestedOrigin })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('commerceAuthorize.workspace')}</label>
            <Select value={activeWorkspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger><SelectValue placeholder={t('commerceAuthorize.workspacePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {(workspaces ?? []).map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isWhmcs ? (
            <div>
              <label className="text-sm font-medium mb-1 block">{t('commerceAuthorize.permissions')}</label>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                <li>{t('commerceAuthorize.whmcs.catalog')}</li>
                <li>{t('commerceAuthorize.whmcs.private')}</li>
                <li>{t('commerceAuthorize.whmcs.readOnly')}</li>
              </ul>
            </div>
          ) : (
          <div>
            <label className="text-sm font-medium mb-1 block">{t('commerceAuthorize.permissions')}</label>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(permissions).map(([key, value]) => (
                <label key={key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(e) => setPermissions((p) => ({ ...p, [key]: e.target.checked }))}
                  />
                  {t(`commerceAuthorize.permission.${key}` as never)}
                </label>
              ))}
            </div>
          </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button className="w-full" disabled={!activeWorkspaceId || submitting} onClick={submit}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {t('commerceAuthorize.approve')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
