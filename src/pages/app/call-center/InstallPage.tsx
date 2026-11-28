import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterSettings, useUpdateCallCenterSettings } from '@/hooks/useCallCenter';
import { Panel, SectionHeading } from '@/features/calls/callCenterUi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState, useEffect } from 'react';
import { toast } from '@/hooks/use-toast';
import { Copy, Plus, Trash2, Code2, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
import { usePlanAccess } from '@/hooks/useEntitlements';
import {
  CALL_WIDGET_DOMAINS_LIMIT_KEY, canAddDomain, cleanDomainEntry, domainSlotsUsed, isValidDomainEntry,
} from '../../../../shared/callCenter/callWidgetDomains';

function validateDomain(d: string): string | null {
  if (!d) return 'empty';
  if (/[\s]/.test(d)) return 'no whitespace allowed';
  if (/^https?:/i.test(d)) return 'no protocol (http/https)';
  if (d.includes('/')) return 'no slashes';
  // The rule the server applies to an added entry (shared/callCenter/callWidgetDomains.ts).
  if (!isValidDomainEntry(cleanDomainEntry(d))) return 'invalid domain';
  return null;
}

export default function InstallPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { data } = useCallCenterSettings(workspace?.id);
  const update = useUpdateCallCenterSettings(workspace?.id);
  const plan = usePlanAccess(workspace?.id);
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

  useEffect(() => {
    if (data?.settings?.allowed_domains) setDomains([...data.settings.allowed_domains]);
  }, [data?.settings?.allowed_domains]);

  function copy(text: string) { navigator.clipboard.writeText(text); toast({ title: t('callCenter.common.copied') }); }

  function updateDomain(i: number, v: string) {
    const next = [...domains]; next[i] = v.trim(); setDomains(next);
    const err = validateDomain(next[i]);
    setErrors((e) => ({ ...e, [i]: err || '' }));
  }
  // The call widget's sites (owner, 2026-11-28): the registered website counts
  // as one of the plan's max_call_widget_domains (-1 = unlimited), this list
  // holds the rest, and Add is offered only while a slot is free. The server
  // refuses a save that adds past the number (PUT /api/call-center/settings).
  const registered = data?.registered_domains ?? [];
  const maxDomains = plan.limit(CALL_WIDGET_DOMAINS_LIMIT_KEY);
  const slotsUsed = domainSlotsUsed(registered, domains);
  const mayAdd = canAddDomain(registered, domains, maxDomains);
  function addDomain() { if (mayAdd) setDomains([...domains, '']); }
  function removeDomain(i: number) {
    setDomains(domains.filter((_, idx) => idx !== i));
    setErrors((e) => { const c = { ...e }; delete c[i]; return c; });
  }

  async function saveDomains() {
    const cleaned = domains.map((d) => d.trim()).filter(Boolean);
    const errs: Record<number, string> = {};
    cleaned.forEach((d, i) => { const e = validateDomain(d); if (e) errs[i] = e; });
    if (Object.keys(errs).length) { setErrors(errs); toast({ title: t('callCenter.install.fixInvalidDomains'), variant: 'destructive' }); return; }
    try {
      await update.mutateAsync({ allowed_domains: cleaned });
      toast({ title: t('callCenter.install.allowedDomainsSaved') });
    } catch (err: unknown) {
      const e = err as { code?: unknown; message?: string };
      if (e.code === 'plan_limit') {
        toast({ title: t('callCenter.install.domainLimitReached', { max: String(maxDomains ?? 0) }), variant: 'destructive' });
      } else if (e.code === 'invalid_body') {
        toast({ title: t('callCenter.install.fixInvalidDomains'), variant: 'destructive' });
      } else {
        toast({ title: t('callCenter.settingsPage.saveFailed'), description: e.message, variant: 'destructive' });
      }
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Embed code */}
      <Panel className="space-y-4">
        <SectionHeading
          icon={Code2}
          title={t('callCenter.install.embedCode')}
          hint={t('callCenter.install.embedCodeHint', { assets: widgetAssetBase, api: apiBase })}
        />
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('callCenter.install.workspaceIdInstall')}</div>
          <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/60 p-3 text-xs">{snippetWs}</pre>
          <Button size="sm" className="mt-2" onClick={() => copy(snippetWs)}><Copy className="h-3.5 w-3.5 me-1" />{t('callCenter.common.copy')}</Button>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('callCenter.install.publicKeyInstall')}</div>
          {snippetPk ? (
            <>
              <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/60 p-3 text-xs">{snippetPk}</pre>
              <Button size="sm" className="mt-2" onClick={() => copy(snippetPk)}><Copy className="h-3.5 w-3.5 me-1" />{t('callCenter.common.copy')}</Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('callCenter.install.publicKeyNotAvailable')}</p>
          )}
        </div>
      </Panel>

      {/* Domain allowlist */}
      <Panel className="space-y-3">
        <SectionHeading
          icon={Globe}
          title={t('callCenter.install.allowedDomains')}
          hint={t('callCenter.install.allowedDomainsHint')}
          count={slotsUsed || undefined}
        />
        <div className="space-y-2">
          {registered.map((d) => (
            <div key={`registered-${d}`} data-registered-domain className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-sm" dir="ltr">{d}</span>
              <span className="text-xs text-muted-foreground" title={t('callCenter.install.registeredDomainHint')}>{t('callCenter.install.registeredDomain')}</span>
            </div>
          ))}
          {registered.length === 0 && domains.length === 0 && <p className="text-sm text-muted-foreground">{t('callCenter.install.noDomainsYet')}</p>}
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
        {maxDomains !== null && maxDomains >= 0 && (
          <p data-domain-slots className="text-xs text-muted-foreground">
            {t('callCenter.install.domainsOfPlan', { used: String(slotsUsed), max: String(maxDomains) })}
          </p>
        )}
        <div className="flex gap-2">
          {mayAdd && (
            <Button variant="outline" size="sm" onClick={addDomain} data-add-domain><Plus className="h-3.5 w-3.5 me-1" />{t('callCenter.install.addDomain')}</Button>
          )}
          <Button onClick={saveDomains} disabled={update.isPending || Object.values(errors).some(Boolean)}>{t('callCenter.common.save')}</Button>
        </div>
      </Panel>
    </div>
  );
}
