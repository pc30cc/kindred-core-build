// ============================================
// ADMIN PROVIDER TYPE CARD
// Full config UI per provider type: list, config, health, resolution
// ============================================

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RefreshCw, Plus, Settings, Trash2, ArrowDown } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useProviderSummary, useRegisteredProviders, providerRegistry,
  type ProviderTypeKey, type ProviderHealth,
  setGlobalDefaultProvider, getGlobalDefaultProvider,
} from '@/providers';
import { PROVIDER_SCHEMAS, getVendorSchema, type ProviderTypeSchema, type ProviderVendor } from './schemas';
import { ProviderConfigForm } from './ProviderConfigForm';
import { ProviderHealthBadge } from './ProviderHealthBadge';
import { ProviderIcon } from './ProviderIcon';

interface AdminProviderCardProps {
  type: ProviderTypeKey;
}

export function AdminProviderCard({ type }: AdminProviderCardProps) {
  const schema = PROVIDER_SCHEMAS[type];
  const providers = useRegisteredProviders(type);
  const summary = useProviderSummary();
  const qc = useQueryClient();
  const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({});
  const [checking, setChecking] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<string>(schema?.vendors[0]?.name ?? '');

  const activeName = summary[type]?.active;

  // Load existing global config
  const { data: globalConfig } = useQuery({
    queryKey: ['global-provider', type],
    queryFn: () => getGlobalDefaultProvider(type),
  });

  const saveConfig = useMutation({
    mutationFn: async ({ vendor, config }: { vendor: string; config: Record<string, string> }) => {
      const result = await setGlobalDefaultProvider(type, vendor, config);
      if (result.error) throw result.error;
    },
    onSuccess: (_, vars) => {
      toast({ title: 'Provider saved', description: `${schema?.label} set to ${vars.vendor}` });
      qc.invalidateQueries({ queryKey: ['global-provider', type] });
      setConfigOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const checkAllHealth = async () => {
    setChecking(true);
    const results = await providerRegistry.checkAllHealth(type);
    setHealthMap(results);
    setChecking(false);
  };

  if (!schema) return null;

  const vendorSchema = getVendorSchema(type, selectedVendor);
  const currentConfigValues = globalConfig?.provider_name === selectedVendor
    ? (globalConfig.config as Record<string, string>) ?? {}
    : {};

  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <ProviderIcon iconName={schema.icon} className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-sm text-foreground">{schema.label}</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{schema.description}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={checkAllHealth} disabled={checking}>
                <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setConfigOpen(true)}>
                <Settings className="h-3.5 w-3.5 me-1" />
                <span className="text-xs">Configure</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Current global default */}
          {globalConfig?.provider_name ? (
            <div className="flex items-center gap-2 p-2 rounded-md border border-primary/30 bg-primary/5">
              <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px]">Global Default</Badge>
              <span className="text-sm font-medium">{globalConfig.provider_name}</span>
              {healthMap[globalConfig.provider_name] && (
                <ProviderHealthBadge health={healthMap[globalConfig.provider_name]} />
              )}
            </div>
          ) : (
            <div className="p-2 rounded-md border border-border bg-muted/30">
              <span className="text-xs text-muted-foreground">No global default configured</span>
            </div>
          )}

          {/* Registered providers */}
          {providers.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                Registered in Registry ({providers.length})
              </p>
              {providers.map((p) => (
                <div
                  key={p.name}
                  className={`flex items-center justify-between p-1.5 rounded text-xs ${
                    p.name === activeName ? 'bg-primary/5 border border-primary/20' : 'bg-muted/20'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground">P:{p.priority}</span>
                    {p.name === activeName && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1">Active</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {healthMap[p.name] && <ProviderHealthBadge health={healthMap[p.name]} />}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Resolution chain */}
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground pt-1">
            <ArrowDown className="h-3 w-3" />
            <span>Resolution: Global Default → Registry Active → Priority Fallback → Stub</span>
          </div>

          {schema.allowWorkspaceOverride && (
            <Badge variant="outline" className="text-[9px]">Workspace override allowed</Badge>
          )}
        </CardContent>
      </Card>

      {/* Config Dialog */}
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ProviderIcon iconName={schema.icon} className="h-5 w-5 text-primary" />
              Configure {schema.label}
            </DialogTitle>
          </DialogHeader>

          {/* Current status */}
          {globalConfig?.provider_name && (
            <div className="p-3 rounded-md bg-muted/50 text-sm flex items-center gap-2">
              <span className="text-muted-foreground">Current:</span>
              <Badge variant="outline">{globalConfig.provider_name}</Badge>
              {globalConfig.config &&
                Object.entries(globalConfig.config).filter(([k]) => !k.includes('key') && !k.includes('secret') && !k.includes('pass')).map(([k, v]) => (
                  <span key={k} className="text-xs text-muted-foreground">{k}: {String(v)}</span>
                ))}
            </div>
          )}

          {/* Vendor selector — grouped by locale if vendors have locale tags */}
          {schema.vendors.length > 1 && (() => {
            const hasLocales = schema.vendors.some(v => v.locales?.length);
            if (!hasLocales) {
              return (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Select Vendor</label>
                  <Select value={selectedVendor} onValueChange={setSelectedVendor}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {schema.vendors.map((v) => (
                        <SelectItem key={v.name} value={v.name}>
                          {v.label} — {v.description}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            }
            const groups: { label: string; locale: string; vendors: typeof schema.vendors }[] = [
              { label: '🇺🇸 International (USD/EUR)', locale: 'en', vendors: schema.vendors.filter(v => v.locales?.includes('en')) },
              { label: '🇮🇷 ایران (IRR/تومان)', locale: 'fa', vendors: schema.vendors.filter(v => v.locales?.includes('fa')) },
              { label: '🇹🇷 Türkiye (TRY)', locale: 'tr', vendors: schema.vendors.filter(v => v.locales?.includes('tr')) },
              { label: '🌐 Other', locale: '', vendors: schema.vendors.filter(v => !v.locales?.length) },
            ].filter(g => g.vendors.length > 0);

            return (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Select Vendor</label>
                <Select value={selectedVendor} onValueChange={setSelectedVendor}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <div key={g.locale}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{g.label}</div>
                        {g.vendors.map((v) => (
                          <SelectItem key={v.name} value={v.name}>
                            {v.label}{v.currency ? ` (${v.currency})` : ''}
                          </SelectItem>
                        ))}
                      </div>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })()}

          {/* Config form */}
          {vendorSchema && (
            <ProviderConfigForm
              vendor={vendorSchema}
              initialValues={currentConfigValues}
              onSubmit={(values) => saveConfig.mutate({ vendor: selectedVendor, config: values })}
              onCancel={() => setConfigOpen(false)}
              isPending={saveConfig.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
