import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterSettings, useUpdateCallCenterSettings, useCallCenterOverview } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState, useEffect } from 'react';
import { toast } from '@/hooks/use-toast';
import { Copy, AlertCircle, CheckCircle2, Plus, Trash2, Activity, Code2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

function HealthRow({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm">
      {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" /> : <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />}
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

const DOMAIN_RE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i;
function validateDomain(d: string): string | null {
  if (!d) return 'empty';
  if (/[\s]/.test(d)) return 'no whitespace allowed';
  if (/^https?:/i.test(d)) return 'no protocol (http/https)';
  if (d.includes('/')) return 'no slashes';
  if (!DOMAIN_RE.test(d)) return 'invalid domain';
  return null;
}

export default function InstallPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { data } = useCallCenterSettings(workspace?.id);
  const { data: overview } = useCallCenterOverview(workspace?.id);
  const update = useUpdateCallCenterSettings(workspace?.id);
  const apiBase = (RESOLVED_API_BASE as string) || window.location.origin;
  // Widget asset base may live on a different origin (e.g. CDN/frontend
  // host) than the API. Falls back to the API origin for single-host setups.
  const widgetAssetBase =
    (import.meta.env.VITE_CALL_WIDGET_ASSET_BASE_URL as string) ||
    (import.meta.env.VITE_WIDGET_ASSET_BASE_URL as string) ||
    window.location.origin;
  const loaderUrl = `${widgetAssetBase}/call-widget/l.js`;
  const wid = workspace?.id || '';
  const snippetWs = `<script async src="${loaderUrl}" api-base="${apiBase}" workspace-id="${wid}"></script>`;
  const snippetPk = data?.settings?.public_key
    ? `<script async src="${loaderUrl}" api-base="${apiBase}" public-key="${data.settings.public_key}"></script>`
    : null;

  const [domains, setDomains] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [bootstrapResult, setBootstrapResult] = useState<any>(null);

  useEffect(() => {
    if (data?.settings?.allowed_domains) setDomains([...data.settings.allowed_domains]);
  }, [data?.settings?.allowed_domains]);

  function copy(text: string) { navigator.clipboard.writeText(text); toast({ title: t('callCenter.common.copied') }); }

  function updateDomain(i: number, v: string) {
    const next = [...domains]; next[i] = v.trim(); setDomains(next);
    const err = validateDomain(next[i]);
    setErrors((e) => ({ ...e, [i]: err || '' }));
  }
  function addDomain() { setDomains([...domains, '']); }
  function removeDomain(i: number) {
    setDomains(domains.filter((_, idx) => idx !== i));
    setErrors((e) => { const c = { ...e }; delete c[i]; return c; });
  }

  async function saveDomains() {
    const cleaned = domains.map((d) => d.trim()).filter(Boolean);
    const errs: Record<number, string> = {};
    cleaned.forEach((d, i) => { const e = validateDomain(d); if (e) errs[i] = e; });
    if (Object.keys(errs).length) { setErrors(errs); toast({ title: t('callCenter.install.fixInvalidDomains'), variant: 'destructive' }); return; }
    await update.mutateAsync({ allowed_domains: cleaned });
    toast({ title: t('callCenter.install.allowedDomainsSaved') });
  }

  async function testBootstrap() {
    try {
      const r = await fetch(`${apiBase}/api/call-widget/bootstrap?workspaceId=${wid}`);
      const j = await r.json();
      setBootstrapResult({ httpStatus: r.status, ...j });
    } catch (e: any) {
      setBootstrapResult({ error: e.message });
    }
  }

  const platformOk = !!data?.platform?.call_center_enabled;
  const wsOk = !!data?.settings?.enabled;
  const providerOk = !!overview?.provider?.ready;
  const hasKey = !!data?.settings?.public_key;
  const domainsOk = (data?.settings?.allowed_domains?.length || 0) > 0;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Install health */}
      <Card className="p-5 space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="font-semibold">{t('callCenter.install.installHealth')}</h2>
        </div>
        <HealthRow ok={platformOk} label={t('callCenter.install.platformEnabled')} />
        <HealthRow ok={wsOk} label={t('callCenter.install.workspaceEnabled')} />
        <HealthRow ok={providerOk} label={t('callCenter.install.callsServiceReady')} />
        <HealthRow ok={hasKey} label={t('callCenter.install.publicKeyGenerated')} />
        <HealthRow ok={domainsOk} label={t('callCenter.install.allowedDomainConfigured')} hint={t('callCenter.install.domainCount', { count: String(data?.settings?.allowed_domains?.length || 0) })} />
      </Card>

      {/* Embed code */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-primary" />
          <h2 className="font-semibold">{t('callCenter.install.embedCode')}</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('callCenter.install.embedCodeHint', { assets: widgetAssetBase, api: apiBase })}
        </p>
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('callCenter.install.workspaceIdInstall')}</div>
          <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">{snippetWs}</pre>
          <Button size="sm" className="mt-2" onClick={() => copy(snippetWs)}><Copy className="h-3.5 w-3.5 me-1" />{t('callCenter.common.copy')}</Button>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('callCenter.install.publicKeyInstall')}</div>
          {snippetPk ? (
            <>
              <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">{snippetPk}</pre>
              <Button size="sm" className="mt-2" onClick={() => copy(snippetPk)}><Copy className="h-3.5 w-3.5 me-1" />{t('callCenter.common.copy')}</Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('callCenter.install.publicKeyNotAvailable')}</p>
          )}
        </div>
      </Card>

      {/* Domain allowlist */}
      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">{t('callCenter.install.allowedDomains')}</h2>
        <p className="text-xs text-muted-foreground">{t('callCenter.install.allowedDomainsHint')}</p>
        <div className="space-y-2">
          {domains.length === 0 && <p className="text-sm text-muted-foreground">{t('callCenter.install.noDomainsYet')}</p>}
          {domains.map((d, i) => (
            <div key={i} className="space-y-1">
              <div className="flex gap-2">
                <Input value={d} onChange={(e) => updateDomain(i, e.target.value)} placeholder="example.com" className={cn(errors[i] && 'border-destructive')} />
                <Button variant="ghost" size="icon" onClick={() => removeDomain(i)}><Trash2 className="h-4 w-4" /></Button>
              </div>
              {errors[i] && <p className="text-xs text-destructive">{errors[i]}</p>}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={addDomain}><Plus className="h-3.5 w-3.5 me-1" />{t('callCenter.install.addDomain')}</Button>
          <Button onClick={saveDomains} disabled={update.isPending || Object.values(errors).some(Boolean)}>{t('callCenter.common.save')}</Button>
        </div>
      </Card>

      {/* Bootstrap test */}
      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">{t('callCenter.install.testBootstrap')}</h2>
        <p className="text-xs text-muted-foreground">{t('callCenter.install.testBootstrapHint')}</p>
        <Button variant="outline" onClick={testBootstrap}>{t('callCenter.install.runTest')}</Button>
        {bootstrapResult && (
          <div className="rounded border p-3 text-sm space-y-2">
            <div className="flex items-center gap-2">
              {bootstrapResult.httpStatus === 200 && bootstrapResult.status !== 'disabled' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-amber-500" />
              )}
              <span className="font-medium">{t('callCenter.install.statusLabel')} {bootstrapResult.status || `HTTP ${bootstrapResult.httpStatus}`}</span>
            </div>
            {bootstrapResult.reason && <div className="text-xs text-muted-foreground">{t('callCenter.install.reasonLabel')} {bootstrapResult.reason}</div>}
            {bootstrapResult.effective && (
              <div className="grid grid-cols-2 gap-1 text-xs">
                {Object.entries(bootstrapResult.effective).map(([k, v]) => (
                  <div key={k}><span className="text-muted-foreground">{k}:</span> {String(v)}</div>
                ))}
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">{t('callCenter.install.rawResponse')}</summary>
              <pre className="mt-2 bg-muted p-2 rounded overflow-x-auto">{JSON.stringify(bootstrapResult, null, 2)}</pre>
            </details>
          </div>
        )}
      </Card>
    </div>
  );
}
