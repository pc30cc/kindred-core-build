/**
 * ADMIN — ANALYTICS STORAGE
 *
 * Web Analytics writes its raw events as Parquet objects under `analytics/`,
 * and it uses its OWN primary and replicas — chosen here, independently of
 * the general storage pool on the sibling tab.
 *
 * The one thing this screen has to make unmistakable is that independence:
 * an operator picking "Arvan" here must not wonder whether their avatars
 * just moved. So the two primaries are shown side by side, with the general
 * one explicitly marked as untouched.
 *
 * No credential is asked for, shown, or sent from this screen. Vendors are
 * referenced by name and their credentials are resolved server-side from
 * Providers → Storage, which is also where the "edit credentials" link goes.
 */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, BarChart3, CheckCircle2, ChevronDown, Copy, Crown,
  Database, ExternalLink, FlaskConical, RefreshCw, Settings2, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
  adminGetAnalyticsStorage, adminSaveAnalyticsSettings, adminSetAnalyticsPrimary,
  adminSetAnalyticsReplicas, adminSyncAnalyticsReplica, adminTestAnalyticsProvider,
  type AnalyticsProviderDto, type AnalyticsStorageDto, type AnalyticsSyncReport,
} from '@/lib/analytics-storage-api';
import { PROVIDER_SCHEMAS } from './schemas';

const ANALYTICS_KEY = ['admin-analytics-storage'];

/** Batches per click. A click must never turn into an unbounded run of HTTP requests. */
const MAX_BATCHES_PER_RUN = 20;

/**
 * Vendor display names come from the same schema the Storage pool tab uses,
 * so a vendor is called the same thing on both tabs.
 */
function useVendorLabel() {
  const vendors = useMemo(() => PROVIDER_SCHEMAS.storage?.vendors ?? [], []);
  return useCallback(
    (name: string) => vendors.find((v) => v.name === name)?.label ?? name,
    [vendors],
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function StatCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-card px-2.5 py-2 min-w-0">
      <p className={cn('text-sm font-semibold truncate', tone ?? 'text-foreground')}>{value}</p>
      <p className="text-[10px] text-muted-foreground truncate">{label}</p>
    </div>
  );
}

// ─── Replication health ──────────────────────────────────────────

const HEALTH_TONE: Record<string, string> = {
  synchronized: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  behind: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  dirty: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  never_synchronized: 'border-border bg-muted/20 text-muted-foreground',
};

function HealthBadge({ health }: { health: string }) {
  const { t } = useI18n();
  return (
    <Badge variant="outline" className={cn('h-5 text-[10px]', HEALTH_TONE[health] ?? HEALTH_TONE.never_synchronized)}>
      {t(`analyticsStorage.health.${health}` as never)}
    </Badge>
  );
}

// ─── Sync run state ──────────────────────────────────────────────

type SyncPhase = 'idle' | 'running' | 'paused' | 'complete' | 'failed';

interface SyncRun {
  phase: SyncPhase;
  target: string | null;
  report: AnalyticsSyncReport | null;
  error: string | null;
}

const IDLE_SYNC: SyncRun = { phase: 'idle', target: null, report: null, error: null };

export function AdminAnalyticsStoragePanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const vendorLabel = useVendorLabel();

  const { data, isLoading, error } = useQuery({
    queryKey: ANALYTICS_KEY,
    queryFn: adminGetAnalyticsStorage,
  });

  const [syncRun, setSyncRun] = useState<SyncRun>(IDLE_SYNC);
  const [promoteTarget, setPromoteTarget] = useState<string | null>(null);
  const [forcePromoteTarget, setForcePromoteTarget] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<AnalyticsStorageDto>>({});
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const settled = useCallback(
    (next: AnalyticsStorageDto) => {
      queryClient.setQueryData(ANALYTICS_KEY, next);
      setDraft({});
    },
    [queryClient],
  );

  const onError = useCallback(
    (err: unknown) => {
      toast({
        variant: 'destructive',
        title: t('analyticsStorage.toast.failed'),
        description: err instanceof Error ? err.message : String(err),
      });
    },
    [t],
  );

  const saveSettings = useMutation({
    mutationFn: adminSaveAnalyticsSettings,
    onSuccess: (next) => {
      settled(next);
      toast({ title: t('analyticsStorage.toast.saved') });
    },
    onError,
  });

  const setPrimary = useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) => adminSetAnalyticsPrimary(name, force),
    onSuccess: (next) => {
      settled(next);
      setPromoteTarget(null);
      setForcePromoteTarget(null);
      toast({
        title: t('analyticsStorage.toast.primaryChanged'),
        description: t('analyticsStorage.toast.primaryChangedDesc', { vendor: vendorLabel(next.primary ?? '') }),
      });
    },
    onError: (err) => {
      setPromoteTarget(null);
      onError(err);
    },
  });

  const setReplicas = useMutation({
    mutationFn: adminSetAnalyticsReplicas,
    onSuccess: (next) => {
      settled(next);
      toast({ title: t('analyticsStorage.toast.replicasSaved') });
    },
    onError,
  });

  const testProvider = useMutation({
    mutationFn: adminTestAnalyticsProvider,
    onError,
  });

  const runTest = useCallback(
    async (name: string) => {
      try {
        const result = await testProvider.mutateAsync(name);
        const failedStep = Object.entries(result.steps).find(([, ok]) => !ok)?.[0];
        setTestResults((prev) => ({
          ...prev,
          [name]: {
            ok: result.success,
            message: result.success
              ? t('analyticsStorage.test.passed', { ms: result.latencyMs })
              : result.error ?? t('analyticsStorage.test.failedStep', { step: failedStep ?? '—' }),
          },
        }));
      } catch {
        /* surfaced by onError */
      }
    },
    [testProvider, t],
  );

  /**
   * A sync is a sequence of BOUNDED batches, not one request. Reporting
   * "synchronized" after batch one is exactly the lie that would let someone
   * promote a half-copied replica, so the loop runs until the server says
   * the walk is exhausted — or until the per-click ceiling stops it and the
   * operator is told there is more.
   */
  const runSync = useCallback(
    async (target: string, restart: boolean) => {
      setSyncRun({ phase: 'running', target, report: null, error: null });
      let batches = 0;
      let last: AnalyticsSyncReport | null = null;
      try {
        for (; batches < MAX_BATCHES_PER_RUN; batches++) {
          const { report } = await adminSyncAnalyticsReplica({
            target,
            restart: batches === 0 ? restart : false,
          });
          last = report;
          setSyncRun({ phase: 'running', target, report, error: null });
          if (report.done) break;
        }
        await queryClient.invalidateQueries({ queryKey: ANALYTICS_KEY });
        setSyncRun({
          phase: last?.done ? (last.total.failed > 0 ? 'failed' : 'complete') : 'paused',
          target,
          report: last,
          error: last && last.total.failed > 0 ? t('analyticsStorage.sync.failedState') : null,
        });
      } catch (err) {
        setSyncRun({
          phase: 'failed',
          target,
          report: last,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [queryClient, t],
  );

  const pool = data;
  const providers = useMemo(() => pool?.providers ?? [], [pool]);
  const primaryCandidates = useMemo(
    () => providers.filter((p) => p.analyticsPrimaryEligible && p.configured),
    [providers],
  );
  const replicaCandidates = useMemo(
    () => providers.filter((p) => p.analyticsReplicaEligible && p.configured && p.name !== pool?.primary),
    [providers, pool?.primary],
  );

  const value = <K extends keyof AnalyticsStorageDto>(key: K): AnalyticsStorageDto[K] | undefined =>
    (draft[key] as AnalyticsStorageDto[K] | undefined) ?? pool?.[key];

  const dirty = Object.keys(draft).length > 0;

  if (error) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="p-4 text-xs text-destructive">
          {error instanceof Error ? error.message : t('analyticsStorage.toast.failed')}
        </CardContent>
      </Card>
    );
  }

  const replicaHealthSummary = pool?.replicas.length
    ? pool.replicas.every((name) => providers.find((p) => p.name === name)?.health === 'synchronized')
      ? 'synchronized'
      : pool.replicas.some((name) => providers.find((p) => p.name === name)?.health === 'failed')
        ? 'failed'
        : 'behind'
    : 'never_synchronized';

  return (
    <div className="space-y-4">
      {/* ── Header + enable ──────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />
                {t('analyticsStorage.title')}
              </h3>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed max-w-2xl">
                {t('analyticsStorage.subtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <Label className="text-xs">{t('analyticsStorage.enabled')}</Label>
              <Switch
                checked={pool?.enabled ?? false}
                disabled={saveSettings.isPending || !pool || (!pool.primary && !pool.enabled)}
                onCheckedChange={(v) => saveSettings.mutate({ enabled: v })}
              />
            </div>
          </div>

          {/* ── Independence callout: the two primaries, side by side ── */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-2">
                <Database className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('analyticsStorage.generalPrimary')}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-foreground truncate">
                {isLoading ? '…' : pool?.generalPrimary ? vendorLabel(pool.generalPrimary) : t('analyticsStorage.none')}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                {t('analyticsStorage.generalPrimaryNote')}
              </p>
            </div>

            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <div className="flex items-center gap-2">
                <Crown className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('analyticsStorage.analyticsPrimary')}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-foreground truncate">
                {isLoading ? '…' : pool?.primary ? vendorLabel(pool.primary) : t('analyticsStorage.noPrimary')}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                {t('analyticsStorage.analyticsPrimaryNote')}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-sky-400 mt-0.5 shrink-0" />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('analyticsStorage.independenceNote')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Status overview ──────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardContent className="p-4 space-y-3">
          <h4 className="text-xs font-semibold text-foreground">{t('analyticsStorage.status.title')}</h4>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px rounded-lg border border-border/60 bg-border/60 overflow-hidden">
            <StatCell
              label={t('analyticsStorage.status.state')}
              value={pool?.enabled ? t('analyticsStorage.status.enabled') : t('analyticsStorage.status.disabled')}
              tone={pool?.enabled ? 'text-emerald-400' : 'text-muted-foreground'}
            />
            <StatCell
              label={t('analyticsStorage.status.writeMode')}
              value={t(`analyticsStorage.writeMode.${pool?.writeMode ?? 'dual_write'}` as never)}
            />
            <StatCell
              label={t('analyticsStorage.status.readMode')}
              value={t(`analyticsStorage.readMode.${pool?.readMode ?? 'postgres'}` as never)}
            />
            <StatCell
              label={t('analyticsStorage.status.replicas')}
              value={String(pool?.replicas.length ?? 0)}
            />
            <StatCell
              label={t('analyticsStorage.status.objects')}
              value={String(pool?.objectsWritten ?? 0)}
            />
            <StatCell
              label={t('analyticsStorage.status.bytes')}
              value={formatBytes(pool?.bytesWritten ?? 0)}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2 text-[11px] text-muted-foreground">
            <p>
              {t('analyticsStorage.status.replication')}:{' '}
              <HealthBadge health={replicaHealthSummary} />
            </p>
            <p>
              {t('analyticsStorage.status.lastWrite')}:{' '}
              <span className="text-foreground">
                {pool?.lastWriteAt ? new Date(pool.lastWriteAt).toLocaleString() : t('analyticsStorage.never')}
              </span>
            </p>
            <p>
              {t('analyticsStorage.status.lastReplication')}:{' '}
              <span className="text-foreground">
                {pool?.lastReplicationAt ? new Date(pool.lastReplicationAt).toLocaleString() : t('analyticsStorage.never')}
              </span>
            </p>
            <p>
              {t('analyticsStorage.status.buffered')}:{' '}
              <span className="text-foreground">{pool?.bufferedRows ?? 0}</span>
            </p>
          </div>

          {pool?.lastError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 flex items-start gap-2">
              <XCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
              <p className="text-[11px] leading-relaxed text-destructive break-all">
                {t('analyticsStorage.status.lastError')}: {pool.lastError}
              </p>
            </div>
          )}

          {(pool?.missingCredentials.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[11px] leading-relaxed text-amber-400">
                {t('analyticsStorage.missingCredentials', {
                  vendors: (pool?.missingCredentials ?? []).map(vendorLabel).join('، '),
                })}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Primary selection ────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardContent className="p-4 space-y-3">
          <div>
            <h4 className="text-xs font-semibold text-foreground">{t('analyticsStorage.primary.title')}</h4>
            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
              {t('analyticsStorage.primary.desc')}
            </p>
          </div>

          {!isLoading && primaryCandidates.length === 0 && (
            <p className="py-4 text-center text-[11px] text-muted-foreground">
              {t('analyticsStorage.primary.noneEligible')}
            </p>
          )}

          <div className="space-y-2">
            {primaryCandidates.map((provider) => (
              <ProviderRow
                key={provider.name}
                provider={provider}
                label={vendorLabel(provider.name)}
                isPrimary={pool?.primary === provider.name}
                testResult={testResults[provider.name]}
                testing={testProvider.isPending && testProvider.variables === provider.name}
                onTest={() => runTest(provider.name)}
                onPromote={() => setPromoteTarget(provider.name)}
                promoting={setPrimary.isPending}
              />
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <ExternalLink className="h-3 w-3 shrink-0" />
            {t('analyticsStorage.credentialsNote')}
          </p>
        </CardContent>
      </Card>

      {/* ── Replicas ─────────────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-xs font-semibold text-foreground">{t('analyticsStorage.replicas.title')}</h4>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                {t('analyticsStorage.replicas.desc')}
              </p>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <Label className="text-xs">{t('analyticsStorage.replicas.replicationEnabled')}</Label>
              <Switch
                checked={pool?.replicationEnabled ?? false}
                disabled={saveSettings.isPending || !pool}
                onCheckedChange={(v) => saveSettings.mutate({ replicationEnabled: v })}
              />
            </div>
          </div>

          {!isLoading && replicaCandidates.length === 0 && (
            <p className="py-4 text-center text-[11px] text-muted-foreground">
              {t('analyticsStorage.replicas.noneEligible')}
            </p>
          )}

          <div className="space-y-2">
            {replicaCandidates.map((provider) => {
              const selected = pool?.replicas.includes(provider.name) ?? false;
              return (
                <div
                  key={provider.name}
                  className="rounded-lg border border-border bg-muted/10 p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Checkbox
                      id={`analytics-replica-${provider.name}`}
                      checked={selected}
                      disabled={setReplicas.isPending || !pool}
                      onCheckedChange={(checked) => {
                        const next = checked === true
                          ? [...(pool?.replicas ?? []), provider.name]
                          : (pool?.replicas ?? []).filter((r) => r !== provider.name);
                        setReplicas.mutate(next);
                      }}
                    />
                    <Label
                      htmlFor={`analytics-replica-${provider.name}`}
                      className="text-xs font-medium cursor-pointer"
                    >
                      {vendorLabel(provider.name)}
                    </Label>
                    <Badge variant="outline" className="h-5 text-[10px] font-mono border-border text-muted-foreground">
                      {provider.name}
                    </Badge>
                    {selected && provider.health && <HealthBadge health={provider.health} />}
                    {!provider.analyticsPrimaryEligible && (
                      <Badge variant="outline" className="h-5 text-[10px] border-border text-muted-foreground">
                        {t('analyticsStorage.replicaOnly')}
                      </Badge>
                    )}
                  </div>

                  {selected && (
                    <ReplicaDetail
                      provider={provider}
                      run={syncRun.target === provider.name ? syncRun : IDLE_SYNC}
                      onSync={(restart) => runSync(provider.name, restart)}
                      disabled={syncRun.phase === 'running'}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Advanced settings ────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardContent className="p-4 space-y-3">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 text-start"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <span className="text-xs font-semibold text-foreground flex items-center gap-2">
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              {t('analyticsStorage.advanced.title')}
            </span>
            <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')} />
          </button>

          {advancedOpen && (
            <div className="space-y-3 pt-1">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t('analyticsStorage.advanced.desc')}
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="analytics-prefix" className="text-xs">{t('analyticsStorage.advanced.prefix')}</Label>
                  <Input
                    id="analytics-prefix"
                    className="h-8 text-xs font-mono"
                    value={String(value('prefix') ?? '')}
                    onChange={(e) => setDraft((d) => ({ ...d, prefix: e.target.value }))}
                  />
                  <p className="text-[10px] text-muted-foreground">{t('analyticsStorage.advanced.prefixHint')}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="analytics-batchRows" className="text-xs">{t('analyticsStorage.advanced.batchRows')}</Label>
                  <Input
                    id="analytics-batchRows"
                    type="number"
                    className="h-8 text-xs"
                    value={String(value('batchRows') ?? '')}
                    onChange={(e) => setDraft((d) => ({ ...d, batchRows: Number(e.target.value) }))}
                  />
                  <p className="text-[10px] text-muted-foreground">{t('analyticsStorage.advanced.batchRowsHint')}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="analytics-batchBytes" className="text-xs">{t('analyticsStorage.advanced.batchBytes')}</Label>
                  <Input
                    id="analytics-batchBytes"
                    type="number"
                    className="h-8 text-xs"
                    value={String(value('batchBytes') ?? '')}
                    onChange={(e) => setDraft((d) => ({ ...d, batchBytes: Number(e.target.value) }))}
                  />
                  <p className="text-[10px] text-muted-foreground">{t('analyticsStorage.advanced.batchBytesHint')}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="analytics-flushIntervalMs" className="text-xs">{t('analyticsStorage.advanced.flushInterval')}</Label>
                  <Input
                    id="analytics-flushIntervalMs"
                    type="number"
                    className="h-8 text-xs"
                    value={String(value('flushIntervalMs') ?? '')}
                    onChange={(e) => setDraft((d) => ({ ...d, flushIntervalMs: Number(e.target.value) }))}
                  />
                  <p className="text-[10px] text-muted-foreground">{t('analyticsStorage.advanced.flushIntervalHint')}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/10 p-2.5">
                <Badge variant="outline" className="h-5 text-[10px] border-border text-muted-foreground">
                  {t('analyticsStorage.advanced.formatBadge')}
                </Badge>
                <Badge variant="outline" className="h-5 text-[10px] border-border text-muted-foreground">
                  {t('analyticsStorage.advanced.compressionBadge')}
                </Badge>
                <p className="text-[10px] text-muted-foreground">{t('analyticsStorage.advanced.formatHint')}</p>
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!dirty || saveSettings.isPending}
                  onClick={() => saveSettings.mutate({
                    prefix: draft.prefix,
                    batchRows: draft.batchRows,
                    batchBytes: draft.batchBytes,
                    flushIntervalMs: draft.flushIntervalMs,
                  })}
                >
                  {saveSettings.isPending ? t('analyticsStorage.advanced.saving') : t('analyticsStorage.advanced.save')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Promotion confirmation ───────────────────────────────── */}
      <AlertDialog open={!!promoteTarget} onOpenChange={(open) => !open && setPromoteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('analyticsStorage.promote.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('analyticsStorage.promote.desc', { vendor: vendorLabel(promoteTarget ?? '') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('analyticsStorage.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => promoteTarget && setPrimary.mutate({ name: promoteTarget })}
            >
              {t('analyticsStorage.promote.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!forcePromoteTarget} onOpenChange={(open) => !open && setForcePromoteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('analyticsStorage.forcePromote.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('analyticsStorage.forcePromote.desc', { vendor: vendorLabel(forcePromoteTarget ?? '') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('analyticsStorage.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => forcePromoteTarget && setPrimary.mutate({ name: forcePromoteTarget, force: true })}
            >
              {t('analyticsStorage.forcePromote.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function ProviderRow({
  provider, label, isPrimary, testResult, testing, onTest, onPromote, promoting,
}: {
  provider: AnalyticsProviderDto;
  label: string;
  isPrimary: boolean;
  testResult?: { ok: boolean; message: string };
  testing: boolean;
  onTest: () => void;
  onPromote: () => void;
  promoting: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={cn(
      'rounded-lg border p-3 space-y-2',
      isPrimary ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/10',
    )}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <Badge variant="outline" className="h-5 text-[10px] font-mono border-border text-muted-foreground">
          {provider.name}
        </Badge>
        {isPrimary && (
          <Badge className="h-5 text-[10px] bg-primary/15 text-primary border-primary/30 gap-1">
            <Crown className="h-3 w-3" />
            {t('analyticsStorage.primaryShort')}
          </Badge>
        )}
        {/* This vendor's GENERAL role — context only; nothing here changes it. */}
        <Badge variant="outline" className="h-5 text-[10px] border-border text-muted-foreground gap-1">
          <Database className="h-3 w-3" />
          {t(`analyticsStorage.generalRole.${provider.generalRole}` as never)}
        </Badge>

        <div className="flex-1" />

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px] gap-1"
          disabled={testing}
          onClick={onTest}
        >
          <FlaskConical className={cn('h-3 w-3', testing && 'animate-pulse')} />
          {t('analyticsStorage.test.run')}
        </Button>

        {!isPrimary && (
          <Button
            size="sm"
            className="h-7 text-[11px] gap-1"
            disabled={promoting}
            onClick={onPromote}
          >
            <ArrowRight className="h-3 w-3" />
            {t('analyticsStorage.primary.make')}
          </Button>
        )}
      </div>

      {testResult && (
        <div className={cn(
          'flex items-start gap-2 rounded-md border p-2',
          testResult.ok
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
            : 'border-destructive/30 bg-destructive/5 text-destructive',
        )}>
          {testResult.ok
            ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
          <p className="text-[11px] leading-relaxed break-all">{testResult.message}</p>
        </div>
      )}
    </div>
  );
}

function ReplicaDetail({
  provider, run, onSync, disabled,
}: {
  provider: AnalyticsProviderDto;
  run: SyncRun;
  onSync: (restart: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const report = run.report;
  const total = report?.total;

  const banner =
    run.phase === 'failed'
      ? { icon: XCircle, tone: 'border-destructive/30 bg-destructive/5 text-destructive', text: run.error ?? t('analyticsStorage.sync.failedState') }
      : run.phase === 'complete'
        ? report?.markedSynchronized
          ? { icon: CheckCircle2, tone: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400', text: t('analyticsStorage.sync.completeFull') }
          : { icon: CheckCircle2, tone: 'border-sky-500/30 bg-sky-500/5 text-sky-400', text: t('analyticsStorage.sync.completePrefix') }
        : run.phase === 'paused'
          ? { icon: AlertTriangle, tone: 'border-amber-500/30 bg-amber-500/5 text-amber-400', text: t('analyticsStorage.sync.more') }
          : run.phase === 'running'
            ? { icon: RefreshCw, tone: 'border-border bg-muted/20 text-muted-foreground', text: t('analyticsStorage.sync.running') }
            : null;

  return (
    <div className="space-y-2 border-t border-border/60 pt-2">
      <div className="grid gap-1.5 sm:grid-cols-2 text-[10px] text-muted-foreground">
        <p>
          {t('analyticsStorage.replicas.lastSync')}:{' '}
          <span className="text-foreground">
            {provider.syncedAt ? new Date(provider.syncedAt).toLocaleString() : t('analyticsStorage.never')}
          </span>
        </p>
        {provider.dirtyReason && (
          <p className="text-amber-400 break-all">
            {t('analyticsStorage.replicas.dirtyReason')}: {provider.dirtyReason}
          </p>
        )}
        {provider.lastError && (
          <p className="text-destructive break-all">
            {t('analyticsStorage.replicas.lastError')}: {provider.lastError}
          </p>
        )}
      </div>

      {banner && (
        <div className={cn('flex items-start gap-2 rounded-md border p-2', banner.tone)}>
          <banner.icon className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', run.phase === 'running' && 'animate-spin')} />
          <p className="text-[11px] leading-relaxed">{banner.text}</p>
        </div>
      )}

      {total && (
        <div className="grid grid-cols-4 gap-px rounded-md border border-border/60 bg-border/60 overflow-hidden">
          <StatCell label={t('analyticsStorage.sync.scanned')} value={String(total.scanned)} />
          <StatCell label={t('analyticsStorage.sync.copied')} value={String(total.copied)} tone="text-emerald-400" />
          <StatCell label={t('analyticsStorage.sync.skipped')} value={String(total.skipped)} tone="text-muted-foreground" />
          <StatCell
            label={t('analyticsStorage.sync.failed')}
            value={String(total.failed)}
            tone={total.failed > 0 ? 'text-destructive' : 'text-muted-foreground'}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px] gap-1"
          disabled={disabled}
          onClick={() => onSync(false)}
        >
          <Copy className="h-3 w-3" />
          {t('analyticsStorage.sync.run')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px] gap-1"
          disabled={disabled}
          onClick={() => onSync(true)}
        >
          <RefreshCw className="h-3 w-3" />
          {t('analyticsStorage.sync.restart')}
        </Button>
      </div>
    </div>
  );
}
