import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { API_BASE } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Globe, CheckCircle, AlertCircle } from 'lucide-react';

async function domainsApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

export default function SettingsDomainsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const [newDomain, setNewDomain] = useState('');

  const { data: domains, isLoading } = useQuery({
    queryKey: ['domains', workspace?.id],
    queryFn: async () => {
      const { domains } = await domainsApi<{ domains: any[] }>(`/api/workspaces/${workspace!.id}/domains`);
      return domains;
    },
    enabled: !!workspace?.id,
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
    },
  });

  const deleteDomain = useMutation({
    mutationFn: (id: string) =>
      domainsApi(`/api/workspaces/${workspace!.id}/domains/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
  });

  const setPrimary = useMutation({
    mutationFn: (id: string) =>
      domainsApi(`/api/workspaces/${workspace!.id}/domains/${id}/primary`, { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.domains')}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Domain</CardTitle>
          <CardDescription>Add domains for your workspace. The primary domain is used in canonical URLs and emails.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="example.com"
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && newDomain && addDomain.mutate(newDomain)}
            />
            <Button onClick={() => addDomain.mutate(newDomain)} disabled={!newDomain || addDomain.isPending}>
              <Plus className="h-4 w-4 me-1" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured Domains</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !domains?.length ? (
            <div className="text-center py-6">
              <Globe className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No domains configured</p>
            </div>
          ) : (
            domains.map(domain => (
              <div key={domain.id} className="flex items-center justify-between bg-muted rounded-lg px-4 py-3">
                <div className="flex items-center gap-3">
                  {domain.verified ? (
                    <CheckCircle className="h-4 w-4 text-success" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-warning" />
                  )}
                  <span className="font-mono text-sm">{domain.domain}</span>
                  {domain.is_primary && <Badge>Primary</Badge>}
                  {!domain.verified && <Badge variant="outline" className="text-xs">Unverified</Badge>}
                </div>
                <div className="flex gap-2">
                  {!domain.is_primary && (
                    <Button variant="ghost" size="sm" onClick={() => setPrimary.mutate(domain.id)}>
                      Set Primary
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => deleteDomain.mutate(domain.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
