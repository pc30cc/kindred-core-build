import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import { Plus, Plug, ArrowDown, Shield } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { PROVIDER_TYPE_KEYS, useProviderSummary, type ProviderTypeKey } from '@/providers';
import { PROVIDER_SCHEMAS, getVendorSchema } from '@/features/providers/schemas';
import { ProviderConfigForm } from '@/features/providers/ProviderConfigForm';
import { ProviderIcon } from '@/features/providers/ProviderIcon';

export default function SettingsProvidersPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const summary = useProviderSummary();

  // Dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<string>('email');
  const [selectedVendor, setSelectedVendor] = useState<string>('');

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editConfig, setEditConfig] = useState<{ id: string; type: string; vendor: string; config: Record<string, string> } | null>(null);

  // Load workspace overrides
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
    mutationFn: async ({ type, vendor, config }: { type: string; vendor: string; config: Record<string, string> }) => {
      const { error } = await supabase.from('provider_configs').insert({
        workspace_id: workspace!.id,
        provider_type: type,
        provider_name: vendor,
        config,
        is_active: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provider-configs'] });
      setAddOpen(false);
      toast({ title: 'Provider override added' });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed', description: err.message, variant: 'destructive' });
    },
  });

  const updateConfig = useMutation({
    mutationFn: async ({ id, config }: { id: string; config: Record<string, string> }) => {
      const { error } = await supabase.from('provider_configs')
        .update({ config, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provider-configs'] });
      setEditOpen(false);
      setEditConfig(null);
      toast({ title: 'Provider config updated' });
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provider-configs'] });
      toast({ title: 'Override removed' });
    },
  });

  // Available types that allow workspace override
  const overridableTypes = PROVIDER_TYPE_KEYS.filter(
    (t) => PROVIDER_SCHEMAS[t]?.allowWorkspaceOverride
  );

  const selectedSchema = PROVIDER_SCHEMAS[selectedType];
  const vendorSchema = selectedVendor ? getVendorSchema(selectedType, selectedVendor) : undefined;

  // Reset vendor when type changes
  const handleTypeChange = (type: string) => {
    setSelectedType(type);
    setSelectedVendor(PROVIDER_SCHEMAS[type]?.vendors[0]?.name ?? '');
  };

  return (
    <div className="space-y-6 animate-fade-in max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('settings.providers')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Override platform defaults with workspace-specific provider configs.
            Types without overrides use the global default.
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 me-2" />Add Override</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add Provider Override</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {/* Type selector */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Provider Type</label>
                <Select value={selectedType} onValueChange={handleTypeChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {overridableTypes.map((typeKey) => {
                      const s = PROVIDER_SCHEMAS[typeKey];
                      const globalActive = summary[typeKey]?.active;
                      return (
                        <SelectItem key={typeKey} value={typeKey}>
                          <span>{s?.label ?? typeKey}</span>
                          {globalActive && (
                            <span className="text-xs text-muted-foreground ml-2">
                              (global: {globalActive})
                            </span>
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              {/* Vendor selector */}
              {selectedSchema && selectedSchema.vendors.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Vendor</label>
                  <Select value={selectedVendor} onValueChange={setSelectedVendor}>
                    <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
                    <SelectContent>
                      {selectedSchema.vendors.map((v) => (
                        <SelectItem key={v.name} value={v.name}>
                          {v.label} — {v.description}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Vendor config form */}
              {vendorSchema && (
                <ProviderConfigForm
                  vendor={vendorSchema}
                  onSubmit={(values) => createConfig.mutate({ type: selectedType, vendor: selectedVendor, config: values })}
                  onCancel={() => setAddOpen(false)}
                  isPending={createConfig.isPending}
                  submitLabel="Add Override"
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Inherited globals */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            Inherited Platform Defaults
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDER_TYPE_KEYS.map((typeKey) => {
              const active = summary[typeKey]?.active;
              const schema = PROVIDER_SCHEMAS[typeKey];
              const hasOverride = configs?.some(
                (c) => c.provider_type === typeKey && c.is_active
              );
              return (
                <div key={typeKey} className="flex items-center gap-2 text-xs p-1.5 rounded bg-muted/30">
                  {schema && <ProviderIcon iconName={schema.icon} className="h-3 w-3 text-muted-foreground" />}
                  <span className="text-muted-foreground">{schema?.label ?? typeKey}:</span>
                  <span className="font-medium">{active ?? 'none'}</span>
                  {hasOverride && (
                    <Badge variant="outline" className="text-[9px] h-4 px-1 bg-amber-900/30 text-amber-300 border-amber-700">
                      Overridden
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-2">
            <ArrowDown className="h-3 w-3" />
            Workspace overrides take priority over platform defaults
          </div>
        </CardContent>
      </Card>

      {/* Workspace overrides */}
      {isLoading ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : !configs?.length ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Plug className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No workspace overrides configured.</p>
            <p className="text-xs text-muted-foreground mt-1">
              All provider types are using platform defaults.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Workspace Overrides</h2>
          {configs.map((config) => {
            const schema = PROVIDER_SCHEMAS[config.provider_type];
            const vendorInfo = schema?.vendors.find((v) => v.name === config.provider_name);
            const globalActive = summary[config.provider_type as ProviderTypeKey]?.active;
            const configObj = (config.config ?? {}) as Record<string, string>;
            const safeFields = Object.entries(configObj).filter(
              ([k]) => !k.includes('key') && !k.includes('secret') && !k.includes('pass')
            );

            return (
              <Card key={config.id}>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {schema && <ProviderIcon iconName={schema.icon} className="h-4 w-4 text-primary" />}
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">{schema?.label ?? config.provider_type}</Badge>
                          <span className="font-medium text-sm">{vendorInfo?.label ?? config.provider_name}</span>
                          {config.is_active && (
                            <Badge className="bg-primary/20 text-primary text-[10px]">Active Override</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-muted-foreground">
                            Overrides: {globalActive ?? 'none'}
                          </span>
                          {safeFields.map(([k, v]) => (
                            <span key={k} className="text-[10px] text-muted-foreground">
                              · {k}: {String(v)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {vendorInfo && (
                        <Button
                          variant="ghost" size="sm" className="h-7 text-xs"
                          onClick={() => {
                            setEditConfig({
                              id: config.id,
                              type: config.provider_type,
                              vendor: config.provider_name,
                              config: configObj,
                            });
                            setEditOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                      )}
                      <Switch
                        checked={config.is_active ?? false}
                        onCheckedChange={(v) => toggleActive.mutate({ id: config.id, active: v })}
                      />
                      <Button
                        variant="ghost" size="sm" className="text-destructive h-7 w-7 p-0"
                        onClick={() => deleteConfig.mutate(config.id)}
                      >
                        <span className="text-xs">✕</span>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={(o) => { setEditOpen(o); if (!o) setEditConfig(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Provider Override</DialogTitle>
          </DialogHeader>
          {editConfig && (() => {
            const vs = getVendorSchema(editConfig.type, editConfig.vendor);
            if (!vs) return <p className="text-sm text-muted-foreground">No schema available for this vendor.</p>;
            return (
              <ProviderConfigForm
                vendor={vs}
                initialValues={editConfig.config}
                onSubmit={(values) => updateConfig.mutate({ id: editConfig.id, config: values })}
                onCancel={() => { setEditOpen(false); setEditConfig(null); }}
                isPending={updateConfig.isPending}
                submitLabel="Save Changes"
              />
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
