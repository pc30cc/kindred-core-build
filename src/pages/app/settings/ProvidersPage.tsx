import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Plus, Plug } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

const PROVIDER_TYPES = ['auth', 'email', 'ai', 'storage', 'search', 'notification', 'cache', 'realtime'];

export default function SettingsProvidersPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ provider_type: 'email', provider_name: '', config: '{}' });

  const { data: configs, isLoading } = useQuery({
    queryKey: ['provider-configs', workspace?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('provider_configs')
        .select('*')
        .eq('workspace_id', workspace!.id)
        .order('provider_type');
      if (error) throw error;
      return data;
    },
    enabled: !!workspace?.id,
  });

  const createConfig = useMutation({
    mutationFn: async (input: typeof form) => {
      let configJson;
      try { configJson = JSON.parse(input.config); } catch { throw new Error('Invalid JSON'); }
      const { error } = await supabase.from('provider_configs').insert({
        workspace_id: workspace!.id,
        provider_type: input.provider_type,
        provider_name: input.provider_name,
        config: configJson,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provider-configs'] });
      setOpen(false);
      setForm({ provider_type: 'email', provider_name: '', config: '{}' });
      toast({ title: 'Provider added' });
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.from('provider_configs').update({ is_active: active }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['provider-configs'] }),
  });

  const deleteConfig = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('provider_configs').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['provider-configs'] }),
  });

  return (
    <div className="space-y-6 animate-fade-in max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t('settings.providers')}</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 me-2" />Add Provider</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Provider Configuration</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Provider Type</Label>
                <Select value={form.provider_type} onValueChange={v => setForm(p => ({ ...p, provider_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROVIDER_TYPES.map(t => (
                      <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Provider Name</Label>
                <Input
                  placeholder="e.g. resend, openai, s3"
                  value={form.provider_name}
                  onChange={e => setForm(p => ({ ...p, provider_name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Configuration (JSON)</Label>
                <Input
                  value={form.config}
                  onChange={e => setForm(p => ({ ...p, config: e.target.value }))}
                  placeholder='{"api_key": "..."}'
                />
                <p className="text-xs text-muted-foreground">⚠️ Store sensitive keys server-side only. This is for non-secret config.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => createConfig.mutate(form)} disabled={!form.provider_name || createConfig.isPending}>
                {createConfig.isPending ? 'Adding...' : 'Add'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : !configs?.length ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Plug className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No providers configured. Add providers for email, AI, storage, etc.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {configs.map(config => (
            <Card key={config.id}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">{config.provider_type}</Badge>
                    <span className="font-medium">{config.provider_name}</span>
                    {config.is_active && <Badge className="bg-success text-success-foreground">Active</Badge>}
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={config.is_active}
                      onCheckedChange={v => toggleActive.mutate({ id: config.id, active: v })}
                    />
                    <Button variant="ghost" size="sm" onClick={() => deleteConfig.mutate(config.id)} className="text-destructive">
                      Remove
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
