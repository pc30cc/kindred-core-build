// ============================================
// ADMIN PROVIDER TYPE CARD
// Full config UI per provider type: CRUD, health, resolution chain
// ============================================

import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  RefreshCw, Plus, Settings, Trash2, ArrowDown, Power, PowerOff,
  TestTube, ChevronRight, Zap, Info,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useProviderSummary, useRegisteredProviders, providerRegistry,
  type ProviderTypeKey, type ProviderHealth,
  setGlobalDefaultProvider, getGlobalDefaultProvider, removeGlobalDefaultProvider,
  testProviderConnection,
} from '@/providers';
import { PROVIDER_SCHEMAS, getVendorSchema, type ProviderVendor } from './schemas';
import { ProviderConfigForm } from './ProviderConfigForm';
import { ProviderHealthBadge, ProviderHealthDot } from './ProviderHealthBadge';
import { ProviderIcon } from './ProviderIcon';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';

interface AdminProviderCardProps {
  type: ProviderTypeKey;
}

export function AdminProviderCard({ type }: AdminProviderCardProps) {
  const schema = PROVIDER_SCHEMAS[type];
  const providers = useRegisteredProviders(type);
  const summary = useProviderSummary();
  const qc = useQueryClient();
  const [healthMap, setHealthMap] = useState<Record<string, { health: ProviderHealth; checkedAt: number }>>({});
  const [checking, setChecking] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<string>(schema?.vendors[0]?.name ?? '');
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  const activeName = summary[type]?.active;
  const effectiveName = summary[type]?.effective;

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
      toast({ title: 'Provider configured', description: `${schema?.label}: ${vars.vendor} set as global default` });
      qc.invalidateQueries({ queryKey: ['global-provider', type] });
      setConfigOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const removeDefault = useMutation({
    mutationFn: async () => {
      const result = await removeGlobalDefaultProvider(type);
      if (result.error) throw result.error;
    },
    onSuccess: () => {
      toast({ title: 'Default removed', description: `${schema?.label} reverted to fallback` });
      qc.invalidateQueries({ queryKey: ['global-provider', type] });
      setDeleteConfirm(false);
    },
  });

  const checkAllHealth = useCallback(async () => {
    setChecking(true);
    const results = await providerRegistry.checkAllHealth(type);
    const now = Date.now();
    const mapped: Record<string, { health: ProviderHealth; checkedAt: number }> = {};
    for (const [name, health] of Object.entries(results)) {
      mapped[name] = { health, checkedAt: now };
    }
    setHealthMap(mapped);
    setChecking(false);
  }, [type]);

  const handleTestConnection = useCallback(async (providerName: string) => {
    setTestingProvider(providerName);
    try {
      const result = await testProviderConnection(type, providerName);
      setHealthMap(prev => ({
        ...prev,
        [providerName]: { health: result.status as ProviderHealth, checkedAt: result.checkedAt },
      }));
      toast({
        title: result.status === 'healthy' ? '✓ Connection OK' : '⚠ Connection Issue',
        description: result.message,
        variant: result.status === 'healthy' ? 'default' : 'destructive',
      });
    } finally {
      setTestingProvider(null);
    }
  }, [type]);

  if (!schema) return null;

  const vendorSchema = getVendorSchema(type, selectedVendor);
  const currentConfigValues = globalConfig?.provider_name === selectedVendor
    ? (globalConfig.config as Record<string, string>) ?? {}
    : {};

  // Resolution chain
  const resolutionChain = providerRegistry.getResolutionChain(type);

  // Determine card status — active if configured OR has an effective (built-in) provider
  const hasGlobalDefault = !!globalConfig?.provider_name;
  const isActive = hasGlobalDefault || !!effectiveName;
  const statusColor = isActive
    ? 'border-admin-accent/30'
    : providers.some(p => p.meta?.builtIn) ? 'border-admin-border' : 'border-amber-500/30';

  return (
    <>
      <Card className={`bg-admin-card ${statusColor} hover:border-admin-accent/50 transition-colors`}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isActive ? 'bg-emerald-500/10' : 'bg-admin-muted'}`}>
                <ProviderIcon iconName={schema.icon} className={`h-5 w-5 ${isActive ? 'text-emerald-400' : 'text-admin-muted-foreground'}`} />
              </div>
              <div>
                <CardTitle className="text-sm text-admin-foreground flex items-center gap-2">
                  {schema.label}
                  {isActive && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[9px] h-4">
                      {hasGlobalDefault ? 'Configured' : 'Active'}
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-[11px] text-admin-muted-foreground mt-0.5 line-clamp-1">{schema.description}</p>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Effective provider */}
          <div className="flex items-center justify-between p-2 rounded-md border border-admin-border bg-admin-muted/20">
            <div className="flex items-center gap-2">
              <Zap className="h-3 w-3 text-admin-muted-foreground" />
              <span className="text-[11px] text-admin-muted-foreground">Runtime:</span>
              <span className="text-xs font-medium text-admin-foreground">{effectiveName ?? 'none'}</span>
            </div>
            {effectiveName && healthMap[effectiveName] && (
              <ProviderHealthDot health={healthMap[effectiveName].health} />
            )}
          </div>

          {/* Global default info */}
          {globalConfig?.provider_name ? (
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="text-[9px] h-4 border-admin-border text-admin-muted-foreground">Default</Badge>
              <span className="font-medium text-admin-foreground">{globalConfig.provider_name}</span>
              {globalConfig.config &&
                Object.entries(globalConfig.config as Record<string, unknown>)
                  .filter(([k]) => !k.includes('key') && !k.includes('secret') && !k.includes('pass') && !k.includes('token'))
                  .slice(0, 2)
                  .map(([k, v]) => (
                    <span key={k} className="text-[10px] text-admin-muted-foreground">{k}: {String(v)}</span>
                  ))
              }
            </div>
          ) : (
            <div className="text-[11px] text-admin-muted-foreground">No explicit default — using registry fallback</div>
          )}

          {/* Registered count and vendor count */}
          <div className="flex items-center justify-between text-[10px] text-admin-muted-foreground">
            <span>{providers.length} registered · {schema.vendors.length} available</span>
            {schema.allowWorkspaceOverride && (
              <Badge variant="outline" className="text-[9px] h-4 bg-admin-muted/50 border-admin-border text-admin-muted-foreground">WS Override ✓</Badge>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 pt-1">
            <Button variant="outline" size="sm" className="h-7 text-xs flex-1 border-admin-border text-admin-foreground hover:bg-admin-muted" onClick={() => setConfigOpen(true)}>
              <Settings className="h-3 w-3 me-1" />
              Configure
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-admin-muted-foreground hover:text-admin-foreground hover:bg-admin-muted" onClick={checkAllHealth} disabled={checking}>
              <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-admin-muted-foreground hover:text-admin-foreground hover:bg-admin-muted" onClick={() => setDetailOpen(true)}>
              <Info className="h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Detail Dialog — Resolution Chain & Registry */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="admin-scope max-w-lg bg-admin-card border-admin-border text-admin-foreground">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-admin-foreground">
              <ProviderIcon iconName={schema.icon} className="h-5 w-5 text-admin-accent" />
              {schema.label} — Runtime Details
            </DialogTitle>
          </DialogHeader>

          {/* Resolution Chain */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-admin-muted-foreground uppercase tracking-wide">Resolution Chain</h4>
            {resolutionChain.map((step, i) => (
              <div
                key={i}
                className={`flex items-center justify-between p-2 rounded-md border text-xs ${
                  step.isActive ? 'border-admin-accent/30 bg-admin-accent/5' : 'border-admin-border bg-admin-muted/20'
                }`}
              >
                <div className="flex items-center gap-2">
                  {step.isActive ? (
                    <ChevronRight className="h-3 w-3 text-admin-accent" />
                  ) : (
                    <ArrowDown className="h-3 w-3 text-admin-muted-foreground" />
                  )}
                  <span className={step.isActive ? 'font-medium text-admin-accent' : 'text-admin-muted-foreground'}>
                    {step.step}
                  </span>
                </div>
                <span className={step.isActive ? 'font-medium text-admin-foreground' : 'text-admin-muted-foreground'}>
                  {step.providerName ?? '—'}
                </span>
              </div>
            ))}
          </div>

          {/* Registry */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-admin-muted-foreground uppercase tracking-wide">
              Registered Providers ({providers.length})
            </h4>
            {providers.map((p) => (
              <div
                key={p.name}
                className={`flex items-center justify-between p-2 rounded-md border text-xs ${
                  p.name === effectiveName ? 'border-admin-accent/20 bg-admin-accent/5' : 'border-admin-border'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-admin-foreground">{p.name}</span>
                  <span className="text-admin-muted-foreground">priority: {p.priority}</span>
                  {p.name === activeName && (
                    <Badge variant="outline" className="text-[9px] h-4 px-1 border-admin-border text-admin-muted-foreground">Global Default</Badge>
                  )}
                  {p.name === effectiveName && (
                    <Badge className="bg-admin-accent/20 text-admin-accent text-[9px] h-4 px-1">Effective</Badge>
                  )}
                  {p.meta?.builtIn && (
                    <Badge variant="outline" className="text-[9px] h-4 px-1 bg-admin-muted/50 border-admin-border text-admin-muted-foreground">Built-in</Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {healthMap[p.name] && (
                    <ProviderHealthBadge health={healthMap[p.name].health} checkedAt={healthMap[p.name].checkedAt} compact />
                  )}
                  <Button
                    variant="ghost" size="sm" className="h-6 text-[10px] px-2 text-admin-muted-foreground hover:text-admin-foreground hover:bg-admin-muted"
                    onClick={() => handleTestConnection(p.name)}
                    disabled={testingProvider === p.name}
                  >
                    {testingProvider === p.name ? (
                      <RefreshCw className="h-3 w-3 animate-spin" />
                    ) : (
                      <><TestTube className="h-3 w-3 me-1" />Test</>
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {/* Meta info */}
          <div className="text-[10px] text-admin-muted-foreground space-y-1 border-t border-admin-border pt-2">
            <p>• Workspace override: {schema.allowWorkspaceOverride ? 'Allowed' : 'Disabled'}</p>
            <p>• Available vendors: {schema.vendors.length}</p>
            <p>• Effective provider: <strong className="text-admin-foreground">{effectiveName ?? 'none'}</strong></p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Config Dialog */}
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="admin-scope max-w-lg max-h-[85vh] overflow-y-auto bg-admin-card border-admin-border text-admin-foreground">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-admin-foreground">
              <ProviderIcon iconName={schema.icon} className="h-5 w-5 text-admin-accent" />
              Configure {schema.label}
            </DialogTitle>
          </DialogHeader>

          {/* Current status */}
          {globalConfig?.provider_name && (
            <div className="p-3 rounded-md bg-admin-muted/50 text-sm flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-admin-muted-foreground">Current default:</span>
                <Badge variant="outline" className="border-admin-border text-admin-foreground">{globalConfig.provider_name}</Badge>
              </div>
              <Button
                variant="ghost" size="sm" className="h-7 text-red-400 text-xs hover:bg-red-500/10"
                onClick={() => setDeleteConfirm(true)}
              >
                <Trash2 className="h-3 w-3 me-1" />
                Remove
              </Button>
            </div>
          )}

          {/* Vendor selector — grouped by locale if vendors have locale tags */}
          {schema.vendors.length > 1 && (() => {
            const hasLocales = schema.vendors.some(v => v.locales?.length);
            if (!hasLocales) {
              return (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-admin-foreground">Select Vendor</label>
                  <Select value={selectedVendor} onValueChange={setSelectedVendor}>
                    <SelectTrigger className="bg-admin-input border-admin-border text-admin-foreground"><SelectValue /></SelectTrigger>
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
            const groups = [
              { label: '🇺🇸 International (USD/EUR)', locale: 'en', vendors: schema.vendors.filter(v => v.locales?.includes('en')) },
              { label: '🇮🇷 ایران (IRR/تومان)', locale: 'fa', vendors: schema.vendors.filter(v => v.locales?.includes('fa')) },
              { label: '🇹🇷 Türkiye (TRY)', locale: 'tr', vendors: schema.vendors.filter(v => v.locales?.includes('tr')) },
              { label: '🌐 Other', locale: '', vendors: schema.vendors.filter(v => !v.locales?.length) },
            ].filter(g => g.vendors.length > 0);

            return (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-admin-foreground">Select Vendor</label>
                <Select value={selectedVendor} onValueChange={setSelectedVendor}>
                  <SelectTrigger className="bg-admin-input border-admin-border text-admin-foreground"><SelectValue /></SelectTrigger>
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

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent className="admin-scope bg-admin-card border-admin-border text-admin-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-admin-foreground">Remove Global Default?</AlertDialogTitle>
            <AlertDialogDescription className="text-admin-muted-foreground">
              This will remove the explicit global default for {schema.label}.
              The system will fall back to priority-based resolution (built-in providers → stubs).
              Workspace overrides will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-admin-border text-admin-foreground hover:bg-admin-muted">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => removeDefault.mutate()}>
              Remove Default
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
