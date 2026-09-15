/**
 * ADMIN — STORAGE PROVIDER POOL
 *
 * Storage is the one provider type where several vendors run at once:
 * one PRIMARY serves every read and write, and every other enabled vendor is
 * a MIRROR that receives a copy of each write. So this panel does not ask
 * "which vendor?" — it shows all of them, each in its own tab with its own
 * saved settings and its own state, and lets the operator promote, switch on
 * or off, and back-fill a mirror that has fallen behind.
 *
 * Credentials never come back from the server: a secret field arrives blank
 * with a "saved" marker, and leaving it blank keeps the stored value.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, CheckCircle2, CloudUpload, Copy, Crown, Database,
  ExternalLink, Info, Power, RefreshCw, TestTube, Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import {
  adminGetStoragePool, adminSaveStorageProvider, adminSetStorageProviderEnabled,
  adminPromoteStorageProvider, adminRemoveStorageProvider, adminTestStorageProvider,
  adminSetStorageReplication, adminSyncStorageReplica,
  type AdminStoragePoolDto, type AdminStorageProviderDto, type AdminStorageSyncReport,
} from '@/lib/storage-providers-api';
import { PROVIDER_SCHEMAS, type ProviderVendor } from './schemas';
import { ProviderConfigForm } from './ProviderConfigForm';
import { ProviderVendorRail, type VendorState } from './ProviderVendorRail';

const POOL_KEY = ['admin-storage-pool'];

function entryOf(pool: AdminStoragePoolDto | undefined, name: string): AdminStorageProviderDto | undefined {
  return pool?.providers.find((p) => p.name === name);
}

/** Non-secret saved values, as strings the config form can prefill. */
function initialValuesOf(entry: AdminStorageProviderDto | undefined): Record<string, string> {
  if (!entry) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.config)) {
    out[key] = typeof value === 'boolean' ? String(value) : String(value ?? '');
  }
  return out;
}

function SyncReportView({ report }: { report: AdminStorageSyncReport }) {
  const { t } = useI18n();
  const cells = [
    { label: t('adminProviders.storage.sync.scanned'), value: report.scanned, tone: 'text-foreground' },
    { label: t('adminProviders.storage.sync.copied'), value: report.copied, tone: 'text-emerald-400' },
    { label: t('adminProviders.storage.sync.skipped'), value: report.skipped, tone: 'text-muted-foreground' },
    { label: t('adminProviders.storage.sync.failed'), value: report.failed, tone: report.failed > 0 ? 'text-destructive' : 'text-muted-foreground' },
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-px rounded-lg border border-border/60 bg-border/60 overflow-hidden">
        {cells.map((c) => (
          <div key={c.label} className="bg-card px-2 py-1.5 text-center">
            <p className={cn('text-sm font-semibold', c.tone)}>{c.value}</p>
            <p className="text-[10px] text-muted-foreground truncate">{c.label}</p>
          </div>
        ))}
      </div>
      {report.errors.length > 0 && (
        <ul className="space-y-1">
          {report.errors.map((e, i) => (
            <li key={i} className="text-[11px] text-destructive break-all">{e}</li>
          ))}
        </ul>
      )}
      {report.nextCursor && (
        <p className="text-[11px] text-amber-400">{t('adminProviders.storage.sync.more')}</p>
      )}
    </div>
  );
}

export function AdminStorageProvidersPanel() {
  const { t, dir } = useI18n();
  const rtl = dir === 'rtl';
  const qc = useQueryClient();
  const schema = PROVIDER_SCHEMAS.storage;
  const vendors = useMemo(() => schema?.vendors ?? [], [schema]);

  const [selected, setSelected] = useState<string>(vendors[0]?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [syncPrefix, setSyncPrefix] = useState('');
  const [syncReport, setSyncReport] = useState<AdminStorageSyncReport | null>(null);

  const { data: pool, isLoading } = useQuery({ queryKey: POOL_KEY, queryFn: adminGetStoragePool });

  // Land on whatever actually serves traffic, not on the catalogue's first row.
  useEffect(() => {
    if (pool?.primary) setSelected((current) => (entryOf(pool, current) ? current : pool.primary!));
  }, [pool]);

  const applyPool = useCallback((next: AdminStoragePoolDto) => {
    qc.setQueryData(POOL_KEY, next);
  }, [qc]);

  const onError = useCallback((err: Error) => {
    toast({ title: t('adminProviders.panel.saveFailed'), description: err.message, variant: 'destructive' });
  }, [t]);

  const save = useMutation({
    mutationFn: ({ name, config, makePrimary }: { name: string; config: Record<string, string>; makePrimary?: boolean }) =>
      adminSaveStorageProvider(name, { config, makePrimary }),
    onSuccess: (next, vars) => {
      applyPool(next);
      toast({
        title: t('adminProviders.storage.saved'),
        description: t('adminProviders.storage.savedDesc', { vendor: vars.name }),
      });
    },
    onError,
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      adminSetStorageProviderEnabled(name, enabled),
    onSuccess: applyPool,
    onError,
  });

  const promote = useMutation({
    mutationFn: (name: string) => adminPromoteStorageProvider(name),
    onSuccess: (next, name) => {
      applyPool(next);
      toast({
        title: t('adminProviders.storage.promoted'),
        description: t('adminProviders.storage.promotedDesc', { vendor: name }),
      });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (name: string) => adminRemoveStorageProvider(name),
    onSuccess: (next) => {
      applyPool(next);
      setRemoveOpen(false);
      toast({ title: t('adminProviders.storage.removed') });
    },
    onError,
  });

  const setReplication = useMutation({
    mutationFn: ({ enabled, mirrorDeletes }: { enabled: boolean; mirrorDeletes?: boolean }) =>
      adminSetStorageReplication(enabled, mirrorDeletes),
    onSuccess: applyPool,
    onError,
  });

  const runSync = useMutation({
    mutationFn: ({ target, prefix }: { target: string; prefix?: string }) =>
      adminSyncStorageReplica({ target, prefix: prefix || undefined }),
    onSuccess: ({ report }) => {
      setSyncReport(report);
      toast({
        title: t('adminProviders.storage.sync.done'),
        description: t('adminProviders.storage.sync.doneDesc', { copied: report.copied, failed: report.failed }),
        variant: report.failed > 0 ? 'destructive' : 'default',
      });
    },
    onError,
  });

  const test = useCallback(async (name: string) => {
    setBusy(name);
    try {
      const result = await adminTestStorageProvider(name);
      toast({
        title: result.success ? t('adminProviders.panel.testOk') : t('adminProviders.panel.testFailed'),
        description: result.success
          ? t('adminProviders.storage.testLatency', { ms: result.latencyMs })
          : (result.error ?? ''),
        variant: result.success ? 'default' : 'destructive',
      });
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(null);
    }
  }, [t, onError]);

  const vendorSchema: ProviderVendor | undefined = vendors.find((v) => v.name === selected);
  const entry = entryOf(pool, selected);
  const isPrimary = !!entry?.isPrimary;
  const isMirror = !!entry && !entry.isPrimary && entry.enabled;
  const primaryEntry = pool?.primary ? entryOf(pool, pool.primary) : undefined;
  const primaryVendor = vendors.find((v) => v.name === pool?.primary);
  const mirrors = (pool?.providers ?? []).filter((p) => !p.isPrimary && p.enabled);

  const stateOf = useCallback((vendor: ProviderVendor): VendorState => {
    const e = entryOf(pool, vendor.name);
    if (e?.isPrimary) return 'primary';
    if (e?.enabled) return 'active';
    if (e) return 'saved';
    return vendor.comingSoon ? 'soon' : 'idle';
  }, [pool]);

  const badgeLabel = useCallback((state: VendorState): string | null => {
    if (state === 'primary') return t('adminProviders.storage.primaryShort');
    if (state === 'active') return t('adminProviders.storage.mirrorShort');
    if (state === 'saved') return t('adminProviders.storage.offShort');
    if (state === 'soon') return t('adminProviders.panel.comingSoon');
    return null;
  }, [t]);

  if (!schema) return null;

  return (
    <div className="space-y-4">
      {/* ── Pool summary ─────────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Database className="h-4 w-4 text-primary" />
                {t('adminProviders.storage.title')}
              </h3>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed max-w-2xl">
                {t('adminProviders.storage.subtitle')}
              </p>
            </div>
            <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
              {t('adminProviders.storage.poolCount', {
                total: pool?.providers.length ?? 0,
                mirrors: mirrors.length,
              })}
            </Badge>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {/* Primary */}
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2">
                <Crown className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('adminProviders.storage.primary')}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-foreground truncate">
                {isLoading ? '…' : (primaryVendor?.label ?? pool?.primary ?? t('adminProviders.storage.noPrimary'))}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                {primaryEntry
                  ? t('adminProviders.storage.primaryNote')
                  : t('adminProviders.storage.noPrimaryNote')}
              </p>
            </div>

            {/* Mirrors */}
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-2">
                <Copy className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('adminProviders.storage.mirrors')}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-foreground truncate">
                {mirrors.length === 0
                  ? t('adminProviders.storage.noMirrors')
                  : mirrors.map((m) => vendors.find((v) => v.name === m.name)?.label ?? m.name).join('، ')}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                {t('adminProviders.storage.mirrorsNote')}
              </p>
            </div>
          </div>

          {/* Replication switches */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/10 p-3">
            <div className="flex items-center gap-2.5">
              <Switch
                checked={pool?.replication.enabled ?? false}
                disabled={setReplication.isPending || !pool}
                onCheckedChange={(v) => setReplication.mutate({ enabled: v })}
              />
              <div>
                <Label className="text-xs">{t('adminProviders.storage.replication')}</Label>
                <p className="text-[10px] text-muted-foreground">{t('adminProviders.storage.replicationHint')}</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <Switch
                checked={pool?.replication.mirrorDeletes ?? false}
                disabled={setReplication.isPending || !pool?.replication.enabled}
                onCheckedChange={(v) =>
                  setReplication.mutate({ enabled: pool?.replication.enabled ?? true, mirrorDeletes: v })
                }
              />
              <div>
                <Label className="text-xs">{t('adminProviders.storage.mirrorDeletes')}</Label>
                <p className="text-[10px] text-muted-foreground">{t('adminProviders.storage.mirrorDeletesHint')}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Vendor tabs + detail ─────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <Card className="border-border/60 h-fit">
          <CardContent className="p-2.5">
            <ProviderVendorRail
              vendors={vendors}
              selected={selected}
              onSelect={(name) => { setSelected(name); setSyncReport(null); }}
              stateOf={stateOf}
              badgeLabel={badgeLabel}
            />
          </CardContent>
        </Card>

        <Card className="border-border/60 min-w-0">
          <CardContent className="p-4 space-y-4">
            {!vendorSchema ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {t('adminProviders.panel.noVendorMatch')}
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{vendorSchema.label}</h3>
                    <Badge variant="outline" className="text-[10px] h-5 font-mono border-border text-muted-foreground">
                      {vendorSchema.name}
                    </Badge>
                    {isPrimary && (
                      <Badge className="h-5 text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1">
                        <Crown className="h-3 w-3" />
                        {t('adminProviders.storage.primaryShort')}
                      </Badge>
                    )}
                    {isMirror && (
                      <Badge className="h-5 text-[10px] bg-sky-500/15 text-sky-400 border-sky-500/30 gap-1">
                        <Copy className="h-3 w-3" />
                        {t('adminProviders.storage.mirrorShort')}
                      </Badge>
                    )}
                    {entry && !entry.enabled && (
                      <Badge variant="outline" className="h-5 text-[10px] border-amber-500/30 text-amber-400">
                        {t('adminProviders.storage.offShort')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{vendorSchema.description}</p>
                  {vendorSchema.docsUrl && (
                    <a
                      href={vendorSchema.docsUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      {t('adminProviders.form.docs')} <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>

                {/* What this vendor's state means right now */}
                <div
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-2.5',
                    isPrimary ? 'border-emerald-500/25 bg-emerald-500/5'
                      : isMirror ? 'border-sky-500/25 bg-sky-500/5'
                        : 'border-border bg-muted/20',
                  )}
                >
                  {isPrimary ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 mt-0.5 shrink-0" />
                    : isMirror ? <Copy className="h-3.5 w-3.5 text-sky-400 mt-0.5 shrink-0" />
                      : <Info className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />}
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {isPrimary ? t('adminProviders.storage.state.primary')
                      : isMirror ? t('adminProviders.storage.state.mirror')
                        : entry ? t('adminProviders.storage.state.off')
                          : t('adminProviders.storage.state.unconfigured')}
                  </p>
                </div>

                {/* Vendor-level controls */}
                {entry && (
                  <div className="flex flex-wrap items-center gap-2">
                    {!isPrimary && (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => promote.mutate(selected)}
                        disabled={promote.isPending}
                      >
                        <Crown className="h-3.5 w-3.5 me-1.5" />
                        {t('adminProviders.storage.makePrimary')}
                      </Button>
                    )}
                    {!isPrimary && (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => toggleEnabled.mutate({ name: selected, enabled: !entry.enabled })}
                        disabled={toggleEnabled.isPending}
                      >
                        <Power className="h-3.5 w-3.5 me-1.5" />
                        {entry.enabled ? t('adminProviders.storage.disable') : t('adminProviders.storage.enable')}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => test(selected)} disabled={busy === selected}>
                      {busy === selected
                        ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                        : <TestTube className="h-3.5 w-3.5 me-1.5" />}
                      {t('adminProviders.panel.test')}
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setRemoveOpen(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5 me-1.5" />
                      {t('adminProviders.storage.remove')}
                    </Button>
                  </div>
                )}

                {vendorSchema.comingSoon ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                    <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {t('adminProviders.panel.comingSoonDesc')}
                    </p>
                  </div>
                ) : (
                  <ProviderConfigForm
                    key={`${selected}:${entry?.updatedAt ?? 'new'}`}
                    vendor={vendorSchema}
                    initialValues={initialValuesOf(entry)}
                    savedSecretKeys={entry?.secretKeys}
                    dense
                    hideVendorHeader
                    isPending={save.isPending}
                    submitLabel={entry ? t('adminProviders.panel.saveChanges') : t('adminProviders.storage.saveAndAdd')}
                    onSubmit={(config) =>
                      save.mutate({ name: selected, config, makePrimary: !pool?.primary })
                    }
                  />
                )}

                {/* Back-fill a mirror from the primary */}
                {entry && !isPrimary && (
                  <div className="space-y-3 rounded-lg border border-border bg-muted/10 p-3">
                    <div className="flex items-center gap-2">
                      <CloudUpload className="h-3.5 w-3.5 text-sky-400" />
                      <span className="text-xs font-medium text-foreground">
                        {t('adminProviders.storage.sync.title')}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {t('adminProviders.storage.sync.desc')}
                    </p>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="flex-1 min-w-[12rem] space-y-1.5">
                        <Label className="text-[11px]">{t('adminProviders.storage.sync.prefix')}</Label>
                        <Input
                          dir="ltr"
                          value={syncPrefix}
                          onChange={(e) => setSyncPrefix(e.target.value)}
                          placeholder="workspace/"
                          className="h-8 text-xs font-mono"
                        />
                      </div>
                      <Button
                        size="sm"
                        onClick={() => runSync.mutate({ target: selected, prefix: syncPrefix })}
                        disabled={runSync.isPending || !pool?.primary}
                      >
                        {runSync.isPending
                          ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                          : <ArrowRight className={cn('h-3.5 w-3.5 me-1.5', rtl && 'rotate-180')} />}
                        {runSync.isPending
                          ? t('adminProviders.storage.sync.running')
                          : t('adminProviders.storage.sync.run')}
                      </Button>
                    </div>
                    {syncReport && <SyncReportView report={syncReport} />}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent className="admin-scope bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">
              {t('adminProviders.storage.removeTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {t('adminProviders.storage.removeDesc', { vendor: vendorSchema?.label ?? selected })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              {t('adminProviders.form.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate(selected)} disabled={remove.isPending}>
              {t('adminProviders.storage.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
