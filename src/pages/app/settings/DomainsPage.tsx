import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceDomains } from '@/hooks/useWorkspaceDomains';
import { API_BASE } from '@/lib/api';
import { SettingsRequestError, settingsErrorMessage } from '@/lib/settingsErrors';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Globe, CheckCircle, AlertCircle } from 'lucide-react';

/** A domains request; a refusal carries the server's code (DOMAIN_TAKEN, MALFORMED, …) for the sentence shown. */
async function domainsApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new SettingsRequestError(String(body.code || body.error || ''), res.status);
  return body as T;
}

export default function SettingsDomainsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const [newDomain, setNewDomain] = useState('');

  const { data: domains, isLoading } = useWorkspaceDomains(workspace?.id);

  const failed = (err: unknown) => toast({
    title: t('settings.domainsPage.failed'),
    description: settingsErrorMessage(err, t),
    variant: 'destructive',
  });

  const addDomain = useMutation({
    mutationFn: (domain: string) =>
      domainsApi(`/api/workspaces/${workspace!.id}/domains`, {
        method: 'POST',
        body: JSON.stringify({ domain }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains'] });
      setNewDomain('');
      toast({ title: t('settings.domainsPage.added') });
    },
    onError: failed,
  });

  const deleteDomain = useMutation({
    mutationFn: (id: string) =>
      domainsApi(`/api/workspaces/${workspace!.id}/domains/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains'] });
      toast({ title: t('settings.domainsPage.removed') });
    },
    onError: failed,
  });

  const setPrimary = useMutation({
    mutationFn: (id: string) =>
      domainsApi(`/api/workspaces/${workspace!.id}/domains/${id}/primary`, { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
    onError: failed,
  });

  const submit = () => {
    const value = newDomain.trim();
    if (value && !addDomain.isPending) addDomain.mutate(value);
  };

  // The primary domain is the website registered at signup, fixed for good
  // (owner, 2026-10-28): it is neither removed nor replaced (the server
  // refuses both too).
  const hasPrimary = !!domains?.some(d => d.is_primary);

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.domains')}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.domainsPage.addTitle')}</CardTitle>
          <CardDescription>{t('settings.domainsPage.addDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="example.com"
              dir="ltr"
              aria-label={t('settings.domainsPage.domainLabel')}
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />
            <Button onClick={submit} disabled={!newDomain.trim() || addDomain.isPending}>
              <Plus className="h-4 w-4 me-1" /> {t('settings.domainsPage.add')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.domainsPage.listTitle')}</CardTitle>
          <CardDescription>{t('settings.domainsPage.verifiedHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !domains?.length ? (
            <div className="text-center py-6">
              <Globe className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">{t('settings.domainsPage.empty')}</p>
            </div>
          ) : (
            domains.map(domain => (
              <div key={domain.id} className="flex items-center justify-between bg-muted rounded-lg px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  {domain.verified ? (
                    <CheckCircle className="h-4 w-4 text-success" aria-hidden />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-warning" aria-hidden />
                  )}
                  <span className="font-mono text-sm" dir="ltr">{domain.domain}</span>
                  {domain.is_primary && <Badge>{t('settings.domainsPage.primary')}</Badge>}
                  <Badge variant="outline" className="text-xs">
                    {domain.verified ? t('settings.domainsPage.verified') : t('settings.domainsPage.unverified')}
                  </Badge>
                  {!domain.verified && (
                    <p className="basis-full text-xs text-muted-foreground">{t('settings.domainsPage.unverifiedHint')}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {!hasPrimary && (
                    <Button variant="ghost" size="sm" onClick={() => setPrimary.mutate(domain.id)}>
                      {t('settings.domainsPage.setPrimary')}
                    </Button>
                  )}
                  {!domain.is_primary && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('settings.domainsPage.remove', { domain: domain.domain })}
                      title={t('settings.domainsPage.remove', { domain: domain.domain })}
                      onClick={() => deleteDomain.mutate(domain.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
