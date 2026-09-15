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
  ExternalLink, Info, Link as LinkIcon, Power, RefreshCw, ShieldAlert, TestTube, Trash2, XCircle,
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
  adminSetStorageReplication, adminSyncStorageReplica, adminRefreshStoredUrls,
  type AdminStoragePoolDto, type AdminStorageProviderDto, type AdminStorageSyncReport,
  type AdminStorageUrlRefreshReport,
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

/**
 * A sync is a sequence of bounded batches, not one request. The panel
 * therefore has to say which of three things happened — a batch landed and
 * more remains, the walk finished, or it stopped on failures — because
 * reporting "synchronized" after batch one is exactly the lie that would
 * let someone promote a half-copied mirror.
 */
type SyncPhase = 'idle' | 'running' | 'paused' | 'complete' | 'failed';

interface SyncRun {
  phase: SyncPhase;
  batches: number;
  report: AdminStorageSyncReport | null;
  error: string | null;
}

const IDLE_SYNC: SyncRun = { phase: 'idle', batches: 0, report: null, error: null };

/** Batches per click. A click must never turn into an unbounded run of HTTP requests. */
const MAX_BATCHES_PER_RUN = 20;

function SyncProgressView({ run }: { run: SyncRun }) {
  const { t } = useI18n();
  const report = run.report;
  if (!report && !run.error) return null;

  const total = report?.total;
  const cells = total
    ? [
        { label: t('adminProviders.storage.sync.scanned'), value: total.scanned, tone: 'text-foreground' },
        { label: t('adminProviders.storage.sync.copied'), value: total.copied, tone: 'text-emerald-400' },
        { label: t('adminProviders.storage.sync.skipped'), value: total.skipped, tone: 'text-muted-foreground' },
        { label: t('adminProviders.storage.sync.failed'), value: total.failed, tone: total.failed > 0 ? 'text-destructive' : 'text-muted-foreground' },
      ]
    : [];

  const banner =
    run.phase === 'failed'
      ? { icon: XCircle, tone: 'border-destructive/30 bg-destructive/5 text-destructive', text: run.error ?? t('adminProviders.storage.sync.failedState') }
      : run.phase === 'complete'
        ? report?.markedSynchronized
          ? { icon: CheckCircle2, tone: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400', text: t('adminProviders.storage.sync.completeFull') }
          : { icon: CheckCircle2, tone: 'border-sky-500/30 bg-sky-500/5 text-sky-400', text: t('adminProviders.storage.sync.completePrefix') }
        : run.phase === 'paused'
          ? { icon: AlertTriangle, tone: 'border-amber-500/30 bg-amber-500/5 text-amber-400', text: t('adminProviders.storage.sync.more') }
          : { icon: RefreshCw, tone: 'border-border bg-muted/20 text-muted-foreground', text: t('adminProviders.storage.sync.running') };

  return (
    <div className="space-y-2">
      <div className={cn('flex items-start gap-2 rounded-lg border p-2.5', banner.tone)}>
        <banner.icon className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', run.phase === 'running' && 'animate-spin')} />
        <p className="text-[11px] leading-relaxed">{banner.text}</p>
      </div>

      {cells.length > 0 && (
        <div className="grid grid-cols-4 gap-px rounded-lg border border-border/60 bg-border/60 overflow-hidden">
          {cells.map((c) => (
            <div key={c.label} className="bg-card px-2 py-1.5 text-center">
              <p className={cn('text-sm font-semibold', c.tone)}>{c.value}</p>
              <p className="text-[10px] text-muted-foreground truncate">{c.label}</p>
            </div>
          ))}
        </div>
      )}

      {run.batches > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {t('adminProviders.storage.sync.batches', { count: run.batches })}
        </p>
      )}

      {report && report.errors.length > 0 && (
        <ul className="space-y-1">
          {report.errors.map((e, i) => (
            <li key={i} className="text-[11px] text-destructive break-all">{e}</li>
          ))}
        </ul>
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
  const [syncRun, setSyncRun] = useState<SyncRun>(IDLE_SYNC);
  const [urlReport, setUrlReport] = useState<AdminStorageUrlRefreshReport | null>(null);
  const [forcePromoteOpen, setForcePromoteOpen] = useState(false);
  const [forceRemoveOpen, setForceRemoveOpen] = useState(false);
  const [removeBlockedReason, setRemoveBlockedReason] = useState<string | null>(null);

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
    mutationFn: ({ name, config }: { name: string; config: Record<string, string> }) =>
      adminSaveStorageProvider(name, { config }),
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
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      adminPromoteStorageProvider(name, force),
    onSuccess: (next, vars) => {
      applyPool(next);
      setForcePromoteOpen(false);
      toast({
        title: t('adminProviders.storage.promoted'),
        description: t('adminProviders.storage.promotedDesc', { vendor: vars.name }),
      });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      adminRemoveStorageProvider(name, force),
    onSuccess: (next) => {
      applyPool(next);
      setRemoveOpen(false);
      setForceRemoveOpen(false);
      toast({ title: t('adminProviders.storage.removed') });
    },
    onError: (err: Error) => {
      // The server refuses while the vendor may still hold owner data. That
      // is the useful answer, not an error to bury in a toast: offer the
      // named destructive path instead of pretending Remove is retryable.
      setRemoveOpen(false);
      setForceRemoveOpen(true);
      setRemoveBlockedReason(err.message);
    },
  });

  const setReplication = useMutation({
    mutationFn: ({ enabled, mirrorDeletes }: { enabled: boolean; mirrorDeletes?: boolean }) =>
      adminSetStorageReplication(enabled, mirrorDeletes),
    onSuccess: applyPool,
    onError,
  });

  /**
   * A storage key is the same on every provider; a cached public URL names
   * one. So the avatar/logo columns that keep a URL for rendering go stale
   * the moment the primary changes, and this rebuilds them from the keys the
   * rows already hold.
   */
  const refreshUrls = useMutation({
    mutationFn: () => adminRefreshStoredUrls(),
    onSuccess: ({ report }) => {
      setUrlReport(report);
      toast({
        title: t('adminProviders.storage.urls.done'),
        description: report.complete
          ? t('adminProviders.storage.urls.doneDesc', { updated: report.totalUpdated })
          : t('adminProviders.storage.urls.doneMore', { updated: report.totalUpdated }),
        variant: report.sources.some((x) => x.failed > 0) ? 'destructive' : 'default',
      });
    },
    onError,
  });

  /**
   * Walk the prefix in bounded batches. Each batch is one ordinary HTTP
   * request; the server holds the cursor. The loop stops on completion, on
   * the first batch that reports failures, or after MAX_BATCHES_PER_RUN —
   * at which point the run is `paused` and the operator can continue it.
   */
  const runSyncBatches = useCallback(async (target: string, restart: boolean) => {
    setSyncRun((prev) => ({
      phase: 'running',
      batches: restart ? 0 : prev.batches,
      report: restart ? null : prev.report,
      error: null,
    }));

    let batches = 0;
    try {
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const { report } = await adminSyncStorageReplica({
          target,
          prefix: syncPrefix || undefined,
          restart: restart && i === 0,
        });
        batches++;
        const failedNow = report.batch.failed > 0;
        const finished = report.done;
        setSyncRun((prev) => ({
          phase: failedNow ? 'failed' : finished ? 'complete' : 'running',
          batches: (restart ? 0 : prev.batches) + batches,
          report,
          error: failedNow ? t('adminProviders.storage.sync.failedState') : null,
        }));
        if (failedNow) {
          toast({
            title: t('adminProviders.storage.sync.failedState'),
            description: report.errors[0] ?? '',
            variant: 'destructive',
          });
          return;
        }
        if (finished) {
          toast({
            title: t('adminProviders.storage.sync.done'),
            description: report.markedSynchronized
              ? t('adminProviders.storage.sync.completeFull')
              : t('adminProviders.storage.sync.completePrefix'),
          });
          qc.invalidateQueries({ queryKey: POOL_KEY });
          return;
        }
      }
      // Batch budget spent with objects still left — never report success.
      setSyncRun((prev) => ({ ...prev, phase: 'paused' }));
      qc.invalidateQueries({ queryKey: POOL_KEY });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSyncRun((prev) => ({ ...prev, phase: 'failed', error: message }));
      onError(err instanceof Error ? err : new Error(message));
    }
  }, [syncPrefix, t, qc, onError]);

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

  const syncing = syncRun.phase === 'running';
  const vendorSchema: ProviderVendor | undefined = vendors.find((v) => v.name === selected);
  const entry = entryOf(pool, selected);
  const isPrimary = !!entry?.isPrimary;
  const isMirror = !!entry && !entry.isPrimary && entry.enabled;
  // Readiness comes from the pool the server serialized, never from this
  // session's memory of a sync it just ran.
  const canPromote = !!entry && entry.enabled && entry.synchronized;
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

          {/* Cached URLs — derived from the stored keys, rebuilt on demand */}
          <div className="space-y-2 rounded-lg border border-border bg-muted/10 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <LinkIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium text-foreground">
                    {t('adminProviders.storage.urls.title')}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed max-w-2xl">
                  {t('adminProviders.storage.urls.desc')}
                </p>
              </div>
              <Button
                size="sm" variant="outline"
                onClick={() => refreshUrls.mutate()}
                disabled={refreshUrls.isPending}
              >
                {refreshUrls.isPending
                  ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                  : <LinkIcon className="h-3.5 w-3.5 me-1.5" />}
                {refreshUrls.isPending
                  ? t('adminProviders.storage.urls.running')
                  : t('adminProviders.storage.urls.run')}
              </Button>
            </div>

            {urlReport && (
              <div className="space-y-1">
                {urlReport.sources.map((source) => (
                  <div key={source.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                    <span className="font-mono text-muted-foreground">{source.name}</span>
                    <span className="text-emerald-400">
                      {source.updated} {t('adminProviders.storage.urls.updated')}
                    </span>
                    <span className="text-muted-foreground">
                      {source.unchanged} {t('adminProviders.storage.urls.unchanged')}
                    </span>
                    {source.skippedNoKey > 0 && (
                      <span className="text-muted-foreground/70">
                        {source.skippedNoKey} {t('adminProviders.storage.urls.noKey')}
                      </span>
                    )}
                    {source.failed > 0 && (
                      <span className="text-destructive">
                        {source.failed} {t('adminProviders.storage.sync.failed')}
                      </span>
                    )}
                  </div>
                ))}
                {!urlReport.complete && (
                  <p className="text-[11px] text-amber-400">{t('adminProviders.storage.urls.more')}</p>
                )}
              </div>
            )}
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
              onSelect={(name) => { setSelected(name); setSyncRun(IDLE_SYNC); }}
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

                {entry && !isPrimary && (
                  <div
                    className={cn(
                      'flex items-start gap-2 rounded-lg border p-2.5',
                      entry.synchronized
                        ? 'border-emerald-500/25 bg-emerald-500/5'
                        : 'border-amber-500/25 bg-amber-500/5',
                    )}
                  >
                    {entry.synchronized
                      ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 mt-0.5 shrink-0" />
                      : <ShieldAlert className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />}
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {entry.synchronized
                        ? t('adminProviders.storage.readiness.ready')
                        : entry.dirtyAt
                          ? t('adminProviders.storage.readiness.dirty')
                          : t('adminProviders.storage.readiness.notReady')}
                    </p>
                  </div>
                )}

                {/* A retired vendor is still purged when an owner is deleted —
                    that is the whole point of retiring instead of removing. */}
                {entry?.retired && (
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
                    <Info className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {t('adminProviders.storage.retiredNote')}
                    </p>
                  </div>
                )}

                {/* Vendor-level controls */}
                {entry && (
                  <div className="flex flex-wrap items-center gap-2">
                    {/*
                      The back-fill panel further down carries the prefix field
                      and the progress report, but it sits below a long
                      credentials form — so the action itself also lives up
                      here, where a mirror's controls are. Same call: a
                      whole-namespace walk in bounded batches.
                    */}
                    {!isPrimary && (
                      <Button
                        size="sm"
                        onClick={() => void runSyncBatches(selected, true)}
                        disabled={syncing || !pool?.primary}
                      >
                        {syncing
                          ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                          : <CloudUpload className="h-3.5 w-3.5 me-1.5" />}
                        {syncing
                          ? t('adminProviders.storage.sync.running')
                          : t('adminProviders.storage.sync.run')}
                      </Button>
                    )}
                    {/*
                      Promotion redirects every read to this vendor, so an
                      object it never received stops being downloadable. The
                      ordinary button is therefore only live once the SERVER
                      has recorded a completed whole-namespace sync from the
                      current primary; the forced path is a separate,
                      confirmed recovery action. The server enforces both —
                      this is the honest presentation of that rule, not the
                      rule itself.
                    */}
                    {!isPrimary && (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => promote.mutate({ name: selected })}
                        disabled={promote.isPending || !canPromote}
                        title={canPromote ? undefined : t('adminProviders.storage.promoteBlocked')}
                      >
                        <Crown className="h-3.5 w-3.5 me-1.5" />
                        {t('adminProviders.storage.makePrimary')}
                      </Button>
                    )}
                    {!isPrimary && !canPromote && (
                      <Button
                        size="sm" variant="ghost"
                        className="text-amber-400 hover:text-amber-400 hover:bg-amber-500/10"
                        onClick={() => setForcePromoteOpen(true)}
                        disabled={promote.isPending}
                      >
                        <ShieldAlert className="h-3.5 w-3.5 me-1.5" />
                        {t('adminProviders.storage.forcePromote')}
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
                    onSubmit={(config) => save.mutate({ name: selected, config })}
                  />
                )}

                {/* The primary is what everything is copied FROM — nothing to back-fill into. */}
                {entry && isPrimary && (
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/10 p-2.5">
                    <CloudUpload className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {t('adminProviders.storage.sync.primaryNote')}
                    </p>
                  </div>
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
                          placeholder={t('adminProviders.storage.sync.prefixPlaceholder')}
                          disabled={syncing}
                          className="h-8 text-xs font-mono"
                        />
                      </div>
                      <Button
                        size="sm"
                        onClick={() => void runSyncBatches(selected, true)}
                        disabled={syncing || !pool?.primary}
                      >
                        {syncing
                          ? <RefreshCw className="h-3.5 w-3.5 me-1.5 animate-spin" />
                          : <ArrowRight className={cn('h-3.5 w-3.5 me-1.5', rtl && 'rotate-180')} />}
                        {syncing
                          ? t('adminProviders.storage.sync.running')
                          : t('adminProviders.storage.sync.run')}
                      </Button>
                      {/* Only a run that stopped with objects still queued offers "continue". */}
                      {syncRun.phase === 'paused' && (
                        <Button
                          size="sm" variant="outline"
                          onClick={() => void runSyncBatches(selected, false)}
                          disabled={syncing}
                        >
                          <ArrowRight className={cn('h-3.5 w-3.5 me-1.5', rtl && 'rotate-180')} />
                          {t('adminProviders.storage.sync.continue')}
                        </Button>
                      )}
                    </div>

                    {/* Where the server thinks this walk stands, independent of this browser session. */}
                    {entry.sync && syncRun.phase === 'idle' && (
                      <p className="text-[11px] text-muted-foreground">
                        {entry.sync.hasMore
                          ? t('adminProviders.storage.sync.storedIncomplete', {
                              prefix: entry.sync.prefix || '/',
                              copied: entry.sync.total.copied,
                            })
                          : t('adminProviders.storage.sync.storedComplete', {
                              prefix: entry.sync.prefix || '/',
                              copied: entry.sync.total.copied,
                            })}
                      </p>
                    )}

                    <SyncProgressView run={syncRun} />
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={forceRemoveOpen} onOpenChange={setForceRemoveOpen}>
        <AlertDialogContent className="admin-scope bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              {t('adminProviders.storage.forceRemoveTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground space-y-2">
              <span className="block">{removeBlockedReason}</span>
              <span className="block">{t('adminProviders.storage.forceRemoveDesc')}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              {t('adminProviders.form.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate({ name: selected, force: true })}
              disabled={remove.isPending}
            >
              {t('adminProviders.storage.forceRemove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={forcePromoteOpen} onOpenChange={setForcePromoteOpen}>
        <AlertDialogContent className="admin-scope bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-400" />
              {t('adminProviders.storage.forcePromoteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {t('adminProviders.storage.forcePromoteDesc', { vendor: vendorSchema?.label ?? selected })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              {t('adminProviders.form.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => promote.mutate({ name: selected, force: true })}
              disabled={promote.isPending}
            >
              {t('adminProviders.storage.forcePromote')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
            <AlertDialogAction onClick={() => remove.mutate({ name: selected })} disabled={remove.isPending}>
              {t('adminProviders.storage.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
