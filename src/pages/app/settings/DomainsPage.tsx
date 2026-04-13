import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Globe, CheckCircle, AlertCircle } from 'lucide-react';

export default function SettingsDomainsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const [newDomain, setNewDomain] = useState('');

  const { data: domains, isLoading } = useQuery({
    queryKey: ['domains', workspace?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_domains')
        .select('*')
        .eq('workspace_id', workspace!.id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!workspace?.id,
  });

  const addDomain = useMutation({
    mutationFn: async (domain: string) => {
      const { error } = await supabase.from('workspace_domains').insert({
        workspace_id: workspace!.id,
        domain,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains'] });
      setNewDomain('');
    },
  });

  const deleteDomain = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('workspace_domains').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
  });

  const setPrimary = useMutation({
    mutationFn: async (id: string) => {
      // Unset all primary
      await supabase.from('workspace_domains').update({ is_primary: false }).eq('workspace_id', workspace!.id);
      // Set new primary
      const { error } = await supabase.from('workspace_domains').update({ is_primary: true }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
  });

  return (
    <div className="space-y-6 animate-fade-in max-w-3xl">
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
