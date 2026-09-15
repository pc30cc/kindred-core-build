/**
 * ADMIN — PROVIDER TYPE WORKSPACE
 *
 * Full-width configuration surface for a single provider type. Replaces the
 * old cramped card + modal flow: every vendor of the type gets its own tab,
 * so its credentials, docs and runtime status are readable at a glance
 * instead of hidden behind a dropdown inside a dialog.
 *
 * Sections
 *  - Overview : what is live right now + the saved values (secrets masked)
 *  - Vendors  : one tab per vendor, with its configuration form inline
 *  - Runtime  : resolution chain, registered instances, health, fallbacks
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, ExternalLink, Info,
  Layers, Plug, RefreshCw, Search, Server, Settings2, ShieldCheck, Sparkles,
  TestTube, Trash2, Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import {
  useProviderSummary, useRegisteredProviders, providerRegistry,
  getGlobalDefaultProvider, setGlobalDefaultProvider, removeGlobalDefaultProvider,
  testProviderConnection, getFallbackLog,
  type ProviderTypeKey, type ProviderHealth,
} from '@/providers';
import { PROVIDER_SCHEMAS, type ProviderVendor, type ProviderField } from './schemas';
import { ProviderConfigForm } from './ProviderConfigForm';
import { ProviderHealthBadge, ProviderHealthDot } from './ProviderHealthBadge';
import { ProviderIcon } from './ProviderIcon';

type Section = 'overview' | 'vendors' | 'runtime';
type HealthMap = Record<string, { health: ProviderHealth; checkedAt: number }>;

const LOCALE_GROUPS: { key: 'en' | 'fa' | 'tr'; flag: string }[] = [
  { key: 'en', flag: '🌍' },
  { key: 'fa', flag: '🇮🇷' },
  { key: 'tr', flag: '🇹🇷' },
];

const DEPLOYMENT_TONE: Record<string, string> = {
  selfhosted: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  external: 'border-violet-500/30 bg-violet-500/10 text-violet-400',
  builtin: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  disabled: 'border-border bg-muted text-muted-foreground',
};

const isSecretField = (field: ProviderField) =>
  field.type === 'password' || /token|key|secret|password|merchant/i.test(field.key);

/** Human-readable rendering of one saved config value — secrets never leak. */
function displayValue(
  field: ProviderField | undefined,
  raw: unknown,
  boolLabels: { on: string; off: string },
): { text: string; secret: boolean } {
  if (field && isSecretField(field)) return { text: '••••••••••••', secret: true };
  if (typeof raw === 'boolean' || field?.type === 'toggle') {
    const on = raw === true || String(raw) === 'true';
    return { text: on ? boolLabels.on : boolLabels.off, secret: false };
  }
  const value = String(raw ?? '');
  if (field?.type === 'select') {
    const option = field.options?.find((o) => o.value === value);
    return { text: option?.label ?? value, secret: false };
  }
  if (!value) return { text: '—', secret: false };
  return { text: value.length > 72 ? `${value.slice(0, 72)}…` : value, secret: false };
}

/** Shared panel header — also used for provider types that ship a custom card. */
export function ProviderPanelHeader({
  type, actions,
}: { type: ProviderTypeKey; actions?: React.ReactNode }) {
  const { t } = useI18n();
  const schema = PROVIDER_SCHEMAS[type];
  const labelKey = `adminProviders.types.${type}.label`;
  const descKey = `adminProviders.types.${type}.desc`;
  const label = t(labelKey as never) === labelKey ? (schema?.label ?? type) : t(labelKey as never);
  const desc = t(descKey as never) === descKey ? (schema?.description ?? '') : t(descKey as never);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3 min-w-0">
        <div className="p-2.5 rounded-xl bg-primary/10 text-primary shrink-0">
          <ProviderIcon iconName={schema?.icon ?? 'Shield'} className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground leading-tight">{label}</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{desc}</p>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

function StatCell({
  icon: Icon, label, value, tone, trailing,
}: {
  icon: typeof Zap;
  label: string;
  value: string;
  tone?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 bg-card p-3 min-w-0">
      <Icon className={cn('h-4 w-4 shrink-0', tone ?? 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 truncate">{label}</p>
        <p className="text-xs font-medium text-foreground truncate">{value}</p>
      </div>
      {trailing}
    </div>
  );
}

function VendorBadges({ vendor }: { vendor: ProviderVendor }) {
  const { t } = useI18n();
  return (
    <>
      {vendor.deployment && (
        <Badge variant="outline" className={cn('text-[10px] h-5', DEPLOYMENT_TONE[vendor.deployment])}>
          {t(`adminProviders.panel.deployment.${vendor.deployment}` as never)}
        </Badge>
      )}
      {vendor.recommendation && (
        <Badge variant="outline" className="text-[10px] h-5 border-primary/30 bg-primary/10 text-primary gap-1">
          <Sparkles className="h-3 w-3" />
          {t(`adminProviders.panel.recommendation.${vendor.recommendation}` as never)}
        </Badge>
      )}
      {vendor.currency && (
        <Badge variant="outline" className="text-[10px] h-5 border-border text-muted-foreground">
          {vendor.currency}
        </Badge>
      )}
    </>
  );
}

interface Props {
  type: ProviderTypeKey;
  /** Type-specific panels appended to the Overview section (e.g. storage privacy). */
  extra?: React.ReactNode;
}

export function AdminProviderWorkspace({ type, extra }: Props) {
  const { t, dir } = useI18n();
  const rtl = dir === 'rtl';
  const qc = useQueryClient();
  const schema = PROVIDER_SCHEMAS[type];
  const providers = useRegisteredProviders(type);
  const summary = useProviderSummary();

  const [section, setSection] = useState<Section>('overview');
  const [selectedVendor, setSelectedVendor] = useState<string>(schema?.vendors[0]?.name ?? '');
  const [vendorQuery, setVendorQuery] = useState('');
  const [healthMap, setHealthMap] = useState<HealthMap>({});
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const typeLabelKey = `adminProviders.types.${type}.label`;
  const typeLabel = t(typeLabelKey as never) === typeLabelKey
    ? (schema?.label ?? type)
    : t(typeLabelKey as never);
  const boolLabels = {
    on: t('adminProviders.form.enabled'),
    off: t('adminProviders.form.disabled'),
  };

  const activeName = summary[type]?.active ?? null;
  const effectiveName = summary[type]?.effective ?? null;

  const { data: globalConfig, isLoading: configLoading } = useQuery({
    queryKey: ['global-provider', type],
    queryFn: () => getGlobalDefaultProvider(type),
  });

  const configuredVendor = globalConfig?.provider_name ?? null;

  // Open on whatever is actually configured — not on the first vendor in the catalogue.
  useEffect(() => {
    if (configuredVendor) setSelectedVendor(configuredVendor);
  }, [configuredVendor]);

  useEffect(() => {
    setSection('overview');
    setVendorQuery('');
    setHealthMap({});
    setSelectedVendor(PROVIDER_SCHEMAS[type]?.vendors[0]?.name ?? '');
  }, [type]);

  const saveConfig = useMutation({
    mutationFn: async ({ vendor, config }: { vendor: string; config: Record<string, string> }) => {
      const result = await setGlobalDefaultProvider(type, vendor, config);
      if (result.error) throw result.error;
    },
    onSuccess: (_, vars) => {
      toast({
        title: t('adminProviders.panel.savedTitle'),
        description: t('adminProviders.panel.savedDesc', { vendor: vars.vendor }),
      });
      qc.invalidateQueries({ queryKey: ['global-provider', type] });
      setSection('overview');
    },
    onError: (err: Error) => {
      toast({ title: t('adminProviders.panel.saveFailed'), description: err.message, variant: 'destructive' });
    },
  });

  const removeDefault = useMutation({
    mutationFn: async () => {
      const result = await removeGlobalDefaultProvider(type);
      if (result.error) throw result.error;
    },
    onSuccess: () => {
      toast({ title: t('adminProviders.panel.removedTitle'), description: t('adminProviders.panel.removedDesc') });
      qc.invalidateQueries({ queryKey: ['global-provider', type] });
      setRemoveOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: t('adminProviders.panel.saveFailed'), description: err.message, variant: 'destructive' });
    },
  });

  const checkAllHealth = useCallback(async () => {
    setChecking(true);
    try {
      const results = await providerRegistry.checkAllHealth(type);
      const now = Date.now();
      const mapped: HealthMap = {};
      for (const [name, health] of Object.entries(results)) mapped[name] = { health, checkedAt: now };
      setHealthMap(mapped);
    } finally {
      setChecking(false);
    }
  }, [type]);

  const handleTest = useCallback(async (providerName: string) => {
    setTesting(providerName);
    try {
      const result = await testProviderConnection(type, providerName);
      setHealthMap((prev) => ({
        ...prev,
        [providerName]: { health: result.status as ProviderHealth, checkedAt: result.checkedAt },
      }));
      toast({
        title: result.status === 'healthy'
          ? t('adminProviders.panel.testOk')
          : t('adminProviders.panel.testFailed'),
        description: result.message,
        variant: result.status === 'healthy' ? 'default' : 'destructive',
      });
    } finally {
      setTesting(null);
    }
  }, [type, t]);

  const vendorGroups = useMemo(() => {
    const all = schema?.vendors ?? [];
    const q = vendorQuery.trim().toLowerCase();
    const filtered = q
      ? all.filter((v) =>
          v.name.toLowerCase().includes(q) ||
          v.label.toLowerCase().includes(q) ||
          v.description.toLowerCase().includes(q))
      : all;

    const localised = all.some((v) => v.locales?.length);
    if (!localised) return [{ key: '', label: '', vendors: filtered }];

    const groups: { key: string; label: string; vendors: ProviderVendor[] }[] = LOCALE_GROUPS.map((g) => ({
      key: g.key,
      label: `${g.flag} ${t(`adminProviders.panel.regions.${g.key}` as never)}`,
      vendors: filtered.filter((v) => v.locales?.includes(g.key)),
    }));
    const rest = filtered.filter((v) => !v.locales?.length);
    if (rest.length) {
      groups.push({ key: 'other', label: `🌐 ${t('adminProviders.panel.regions.other')}`, vendors: rest });
    }
    return groups.filter((g) => g.vendors.length > 0);
  }, [schema, vendorQuery, t]);

  const visibleVendorCount = vendorGroups.reduce((n, g) => n + g.vendors.length, 0);
  const activeVendorSchema = schema?.vendors.find((v) => v.name === selectedVendor);
  // A default may point at a vendor that is no longer in the catalogue — still
  // show what is stored rather than pretending nothing is configured.
  const configuredVendorSchema: ProviderVendor | undefined =
    schema?.vendors.find((v) => v.name === configuredVendor)
    ?? (configuredVendor
      ? {
          name: configuredVendor,
          label: configuredVendor,
          description: t('adminProviders.panel.unknownVendor'),
          fields: [],
        }
      : undefined);
  const resolutionChain = providerRegistry.getResolutionChain(type);
  const fallbackEvents = getFallbackLog().filter((e) => e.type === type).slice().reverse();

  const initialValues = useMemo(() => {
    if (!configuredVendor || configuredVendor !== selectedVendor) return {};
    const raw = (globalConfig?.config ?? {}) as Record<string, unknown>;
    const mapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      mapped[k] = typeof v === 'boolean' ? String(v) : String(v ?? '');
    }
    return mapped;
  }, [configuredVendor, selectedVendor, globalConfig]);

  if (!schema) return null;

  const openVendor = (name: string) => {
    setSelectedVendor(name);
    setSection('vendors');
  };

  const effectiveHealth = effectiveName ? healthMap[effectiveName] : undefined;

  return (
    <div className="space-y-4">
      {/* ── Header + live status strip ─────────────────────────────── */}
      <Card className="border-border/60 overflow-hidden">
        <CardContent className="p-4 space-y-4">
          <ProviderPanelHeader
            type={type}
            actions={
              <>
                {effectiveName && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => handleTest(effectiveName)}
                    disabled={testing === effectiveName}
                  >
                    {testing === effectiveName
                      ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                      : <TestTube className="h-3.5 w-3.5 me-1.5" />}
                    {t('adminProviders.panel.test')}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={checkAllHealth} disabled={checking}>
                  <RefreshCw className={cn('h-3.5 w-3.5 me-1.5', checking && 'animate-spin')} />
                  {t('adminProviders.panel.recheck')}
                </Button>
              </>
            }
          />

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-lg border border-border/60 bg-border/60 overflow-hidden">
            <StatCell
              icon={Zap}
              tone="text-primary"
              label={t('adminProviders.panel.runtimeProvider')}
              value={effectiveName ?? t('adminProviders.status.none')}
              trailing={effectiveHealth ? <ProviderHealthDot health={effectiveHealth.health} /> : undefined}
            />
            <StatCell
              icon={ShieldCheck}
              tone={configuredVendor ? 'text-emerald-400' : 'text-muted-foreground'}
              label={t('adminProviders.panel.globalDefault')}
              value={
                configLoading
                  ? '…'
                  : configuredVendorSchema?.label ?? configuredVendor ?? t('adminProviders.panel.usingFallback')
              }
            />
            <StatCell
              icon={Server}
              label={t('adminProviders.panel.registered')}
              value={String(providers.length)}
            />
            <StatCell
              icon={Layers}
              label={t('adminProviders.panel.vendorsAvailable')}
              value={
                schema.allowWorkspaceOverride
                  ? `${schema.vendors.length} · ${t('adminProviders.panel.wsOverrideOn')}`
                  : `${schema.vendors.length} · ${t('adminProviders.panel.wsOverrideOff')}`
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Sections ───────────────────────────────────────────────── */}
      <Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto bg-muted/40 p-1">
          <TabsTrigger value="overview" className="gap-1.5 text-xs">
            <Info className="h-3.5 w-3.5" />
            {t('adminProviders.panel.tabs.overview')}
          </TabsTrigger>
          <TabsTrigger value="vendors" className="gap-1.5 text-xs">
            <Plug className="h-3.5 w-3.5" />
            {t('adminProviders.panel.tabs.vendors')}
            <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
              {schema.vendors.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="runtime" className="gap-1.5 text-xs">
            <Server className="h-3.5 w-3.5" />
            {t('adminProviders.panel.tabs.runtime')}
          </TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          {configuredVendor && configuredVendorSchema ? (
            <Card className="border-emerald-500/25">
              <CardContent className="p-4 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <span className="text-sm font-semibold text-foreground">{configuredVendorSchema.label}</span>
                      <Badge variant="outline" className="text-[10px] h-5 font-mono border-border text-muted-foreground">
                        {configuredVendorSchema.name}
                      </Badge>
                      <VendorBadges vendor={configuredVendorSchema} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      {configuredVendorSchema.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => openVendor(configuredVendor)}>
                      <Settings2 className="h-3.5 w-3.5 me-1.5" />
                      {t('adminProviders.panel.editConfig')}
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setRemoveOpen(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5 me-1.5" />
                      {t('adminProviders.panel.removeDefault')}
                    </Button>
                  </div>
                </div>

                {/* Saved values — secrets masked */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('adminProviders.panel.savedValues')}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  {(() => {
                    const raw = (globalConfig?.config ?? {}) as Record<string, unknown>;
                    const fields = configuredVendorSchema.fields;
                    const rows = fields.length > 0
                      ? fields.map((f) => ({ key: f.key, label: f.label, field: f, raw: raw[f.key] }))
                      : Object.keys(raw).map((k) => ({ key: k, label: k, field: undefined, raw: raw[k] }));

                    if (rows.length === 0) {
                      return (
                        <p className="text-xs text-muted-foreground py-2">
                          {t('adminProviders.panel.noValues')}
                        </p>
                      );
                    }

                    return (
                      <dl className="grid gap-px sm:grid-cols-2 rounded-lg border border-border/60 bg-border/60 overflow-hidden">
                        {rows.map((row) => {
                          const present = row.raw !== undefined && row.raw !== null && String(row.raw) !== '';
                          const { text, secret } = displayValue(row.field, row.raw, boolLabels);
                          return (
                            <div key={row.key} className="bg-card px-3 py-2 min-w-0">
                              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground/70 truncate">
                                {row.label}
                              </dt>
                              <dd className="mt-0.5 flex items-center gap-1.5 min-w-0">
                                {present ? (
                                  <>
                                    <span
                                      dir="ltr"
                                      className={cn(
                                        'text-xs truncate',
                                        secret ? 'font-mono text-muted-foreground' : 'text-foreground',
                                      )}
                                    >
                                      {text}
                                    </span>
                                    {secret && (
                                      <Badge variant="outline" className="h-4 px-1 text-[9px] border-border text-muted-foreground shrink-0">
                                        {t('adminProviders.panel.hidden')}
                                      </Badge>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-xs text-muted-foreground/60">
                                    {row.field?.required
                                      ? t('adminProviders.panel.missing')
                                      : t('adminProviders.panel.notSet')}
                                  </span>
                                )}
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    );
                  })()}
                </div>

                {configuredVendorSchema.docsUrl && (
                  <a
                    href={configuredVendorSchema.docsUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    {t('adminProviders.form.docs')} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-dashed border-border">
              <CardContent className="p-8 flex flex-col items-center text-center gap-3">
                <div className="p-3 rounded-xl bg-muted">
                  <Plug className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('adminProviders.panel.notConfigured')}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-md leading-relaxed">
                    {t('adminProviders.panel.notConfiguredDesc')}
                  </p>
                </div>
                <Button size="sm" onClick={() => setSection('vendors')}>
                  {t('adminProviders.panel.chooseVendor')}
                  <ArrowRight className={cn('h-3.5 w-3.5 ms-1.5', rtl && 'rotate-180')} />
                </Button>
              </CardContent>
            </Card>
          )}

          {/* What serves traffic right now */}
          <Card className="border-border/60">
            <CardContent className="p-4 flex flex-wrap items-center gap-3">
              <Zap className="h-4 w-4 text-primary shrink-0" />
              <p className="text-xs text-muted-foreground leading-relaxed flex-1 min-w-[16rem]">
                {effectiveName
                  ? configuredVendor
                    ? t('adminProviders.panel.servingConfigured', { provider: effectiveName })
                    : t('adminProviders.panel.servingFallback', { provider: effectiveName })
                  : t('adminProviders.panel.servingNone')}
              </p>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setSection('runtime')}>
                {t('adminProviders.panel.tabs.runtime')}
                <ChevronRight className={cn('h-3.5 w-3.5 ms-1', rtl && 'rotate-180')} />
              </Button>
            </CardContent>
          </Card>

          {extra}
        </TabsContent>

        {/* ── Vendors ──────────────────────────────────────────────── */}
        <TabsContent value="vendors" className="mt-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            {/* Vendor rail — one entry per vendor, acts as the tab list */}
            <Card className="border-border/60 h-fit">
              <CardContent className="p-2.5 space-y-2.5">
                {schema.vendors.length > 6 && (
                  <div className="relative">
                    <Search className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground start-2.5" />
                    <Input
                      value={vendorQuery}
                      onChange={(e) => setVendorQuery(e.target.value)}
                      placeholder={t('adminProviders.panel.searchVendors')}
                      className="h-8 text-xs ps-8"
                    />
                  </div>
                )}

                <ScrollArea className="max-h-[32rem] lg:max-h-[calc(100vh-22rem)] pe-1">
                  <div className="space-y-3" role="tablist" aria-orientation="vertical">
                    {vendorGroups.map((group) => (
                      <div key={group.key || 'all'} className="space-y-1">
                        {group.label && (
                          <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                            {group.label}
                          </p>
                        )}
                        {group.vendors.map((vendor) => {
                          const isSelected = vendor.name === selectedVendor;
                          const isConfigured = vendor.name === configuredVendor;
                          const isEffective = vendor.name === effectiveName;
                          return (
                            <button
                              key={vendor.name}
                              type="button"
                              role="tab"
                              aria-selected={isSelected}
                              onClick={() => setSelectedVendor(vendor.name)}
                              className={cn(
                                'w-full text-start rounded-lg px-2.5 py-2 transition-colors',
                                isSelected
                                  ? 'bg-primary/10 ring-1 ring-primary/25'
                                  : 'hover:bg-muted',
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    'h-1.5 w-1.5 rounded-full shrink-0',
                                    isEffective ? 'bg-emerald-400'
                                      : isConfigured ? 'bg-primary'
                                        : vendor.comingSoon ? 'bg-muted-foreground/40'
                                          : 'bg-border',
                                  )}
                                />
                                <span
                                  className={cn(
                                    'flex-1 truncate text-xs',
                                    isSelected ? 'font-medium text-primary' : 'text-foreground',
                                  )}
                                >
                                  {vendor.label}
                                </span>
                                {isConfigured && (
                                  <Badge className="h-4 px-1 text-[9px] bg-emerald-500/15 text-emerald-400 border-emerald-500/30 shrink-0">
                                    {t('adminProviders.panel.vendorActive')}
                                  </Badge>
                                )}
                                {!isConfigured && vendor.comingSoon && (
                                  <Badge variant="outline" className="h-4 px-1 text-[9px] border-border text-muted-foreground shrink-0">
                                    {t('adminProviders.panel.comingSoon')}
                                  </Badge>
                                )}
                              </div>
                              <p className="mt-0.5 ps-3.5 text-[10px] text-muted-foreground truncate">
                                {vendor.deployment
                                  ? t(`adminProviders.panel.deployment.${vendor.deployment}` as never)
                                  : `${vendor.fields.length} ${t('adminProviders.panel.fields')}`}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    ))}

                    {visibleVendorCount === 0 && (
                      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                        {t('adminProviders.panel.noVendorMatch')}
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Vendor detail — the selected tab's panel */}
            <Card className="border-border/60 min-w-0">
              <CardContent className="p-4 space-y-4">
                {!activeVendorSchema ? (
                  <p className="text-xs text-muted-foreground py-6 text-center">
                    {t('adminProviders.panel.noVendorMatch')}
                  </p>
                ) : (
                  <>
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{activeVendorSchema.label}</h3>
                        <Badge variant="outline" className="text-[10px] h-5 font-mono border-border text-muted-foreground">
                          {activeVendorSchema.name}
                        </Badge>
                        <VendorBadges vendor={activeVendorSchema} />
                        {activeVendorSchema.name === configuredVendor && (
                          <Badge className="h-5 text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                            {t('adminProviders.panel.vendorActive')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {activeVendorSchema.description}
                      </p>
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <span>
                          {activeVendorSchema.fields.length} {t('adminProviders.panel.fields')}
                          {activeVendorSchema.fields.some((f) => f.required) && (
                            <> · {activeVendorSchema.fields.filter((f) => f.required).length} {t('adminProviders.panel.requiredShort')}</>
                          )}
                        </span>
                        {activeVendorSchema.docsUrl && (
                          <a
                            href={activeVendorSchema.docsUrl} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            {t('adminProviders.form.docs')} <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>

                    <div
                      className={cn(
                        'flex items-start gap-2 rounded-lg border p-2.5',
                        activeVendorSchema.name === configuredVendor
                          ? 'border-emerald-500/25 bg-emerald-500/5'
                          : 'border-border bg-muted/20',
                      )}
                    >
                      {activeVendorSchema.name === configuredVendor
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 mt-0.5 shrink-0" />
                        : <Info className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />}
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {activeVendorSchema.name === configuredVendor
                          ? t('adminProviders.panel.vendorActiveNote')
                          : t('adminProviders.panel.vendorInactiveNote')}
                      </p>
                    </div>

                    {activeVendorSchema.comingSoon ? (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                        <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('adminProviders.panel.comingSoonDesc')}
                        </p>
                      </div>
                    ) : (
                      <ProviderConfigForm
                        key={`${type}:${activeVendorSchema.name}:${configuredVendor ?? ''}`}
                        vendor={activeVendorSchema}
                        initialValues={initialValues}
                        dense
                        hideVendorHeader
                        isPending={saveConfig.isPending}
                        submitLabel={
                          activeVendorSchema.name === configuredVendor
                            ? t('adminProviders.panel.saveChanges')
                            : t('adminProviders.panel.saveActivate')
                        }
                        onSubmit={(config) =>
                          saveConfig.mutate({ vendor: activeVendorSchema.name, config })
                        }
                        extraActions={
                          <>
                            {providers.some((p) => p.name === activeVendorSchema.name) && (
                              <Button
                                type="button" variant="outline" size="sm"
                                onClick={() => handleTest(activeVendorSchema.name)}
                                disabled={testing === activeVendorSchema.name}
                              >
                                {testing === activeVendorSchema.name
                                  ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                                  : <TestTube className="h-3.5 w-3.5 me-1.5" />}
                                {t('adminProviders.panel.test')}
                              </Button>
                            )}
                            {activeVendorSchema.name === configuredVendor && (
                              <Button
                                type="button" variant="ghost" size="sm"
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setRemoveOpen(true)}
                              >
                                <Trash2 className="h-3.5 w-3.5 me-1.5" />
                                {t('adminProviders.panel.removeDefault')}
                              </Button>
                            )}
                            {healthMap[activeVendorSchema.name] && (
                              <ProviderHealthBadge
                                health={healthMap[activeVendorSchema.name].health}
                                checkedAt={healthMap[activeVendorSchema.name].checkedAt}
                              />
                            )}
                          </>
                        }
                      />
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Runtime ──────────────────────────────────────────────── */}
        <TabsContent value="runtime" className="mt-4 space-y-4">
          <Card className="border-border/60">
            <CardContent className="p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{t('adminProviders.panel.chain')}</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">{t('adminProviders.panel.chainDesc')}</p>
              </div>
              <ol className="space-y-1.5">
                {resolutionChain.map((step, i) => (
                  <li
                    key={`${step.step}-${i}`}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border px-3 py-2',
                      step.isActive ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/10',
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={cn(
                          'grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold shrink-0',
                          step.isActive
                            ? 'bg-primary/15 text-primary'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {i + 1}
                      </span>
                      <span className={cn('text-xs truncate', step.isActive ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                        {step.step}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={cn('text-xs', step.providerName ? 'text-foreground' : 'text-muted-foreground/60')}>
                        {step.providerName ?? '—'}
                      </span>
                      {step.isActive && (
                        <Badge className="h-4 px-1.5 text-[9px] bg-primary/15 text-primary border-primary/30">
                          {t('adminProviders.panel.effective')}
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {t('adminProviders.panel.instances')} ({providers.length})
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{t('adminProviders.panel.instancesDesc')}</p>
                </div>
                <Button variant="outline" size="sm" onClick={checkAllHealth} disabled={checking}>
                  <RefreshCw className={cn('h-3.5 w-3.5 me-1.5', checking && 'animate-spin')} />
                  {t('adminProviders.panel.recheck')}
                </Button>
              </div>

              {providers.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t('adminProviders.panel.noInstances')}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {providers.map((p) => (
                    <div
                      key={p.name}
                      className={cn(
                        'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2',
                        p.name === effectiveName ? 'border-primary/25 bg-primary/5' : 'border-border',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="text-xs font-medium text-foreground">{p.name}</span>
                        <Badge variant="outline" className="h-4 px-1 text-[9px] border-border text-muted-foreground">
                          {t('adminProviders.panel.priority')} {p.priority}
                        </Badge>
                        {p.name === activeName && (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] border-border text-muted-foreground">
                            {t('adminProviders.panel.globalDefault')}
                          </Badge>
                        )}
                        {p.name === effectiveName && (
                          <Badge className="h-4 px-1 text-[9px] bg-primary/15 text-primary border-primary/30">
                            {t('adminProviders.panel.effective')}
                          </Badge>
                        )}
                        {p.meta?.builtIn ? (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] bg-muted/50 border-border text-muted-foreground">
                            {t('adminProviders.panel.builtIn')}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {healthMap[p.name] && (
                          <ProviderHealthBadge
                            health={healthMap[p.name].health}
                            checkedAt={healthMap[p.name].checkedAt}
                            compact
                          />
                        )}
                        <Button
                          variant="ghost" size="sm" className="h-7 px-2 text-[11px]"
                          onClick={() => handleTest(p.name)}
                          disabled={testing === p.name}
                        >
                          {testing === p.name
                            ? <RefreshCw className="h-3 w-3 animate-spin" />
                            : <><TestTube className="h-3 w-3 me-1" />{t('adminProviders.panel.test')}</>}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-semibold text-foreground">{t('adminProviders.panel.fallbackEvents')}</h3>
              {fallbackEvents.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground">
                  {t('adminProviders.panel.noFallback')}
                </p>
              ) : (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {fallbackEvents.map((entry, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-destructive line-through truncate">{entry.failedProvider}</span>
                        <ArrowRight className={cn('h-3 w-3 text-muted-foreground shrink-0', rtl && 'rotate-180')} />
                        <span className="font-medium text-foreground truncate">{entry.fallbackProvider}</span>
                      </div>
                      <span className="text-muted-foreground shrink-0">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent className="admin-scope bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">
              {t('adminProviders.panel.removeTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {t('adminProviders.panel.removeDesc', { label: typeLabel })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              {t('adminProviders.form.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => removeDefault.mutate()} disabled={removeDefault.isPending}>
              {t('adminProviders.panel.removeDefault')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
