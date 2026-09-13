/**
 * Super Admin → System / Data Retention.
 *
 * Read-only for permanent (financial/core) policies: the Edit/Run controls
 * are not even rendered for them, and the server refuses the request anyway
 * (server/services/retention/retentionService.ts) — the UI is the last line
 * of defence here, never the only one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ShieldCheck, Play, FlaskConical, Pencil, RefreshCw, Database, Archive } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import {
  listRetentionPolicies, listRetentionRuns, runRetentionPolicy, updateRetentionPolicy,
  getSeoStorageMetrics, runSeoStorageBackfill,
  type RetentionPolicyDto, type RetentionRunDto,
} from '@/lib/api';
import PartitionsPanel from './PartitionsPanel';

const PROTECTED_CATEGORIES = new Set(['financial', 'core']);
const isProtected = (p: RetentionPolicyDto) => PROTECTED_CATEGORIES.has(p.category) || p.retention_mode === 'permanent';

export default function RetentionPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState<RetentionPolicyDto[]>([]);
  const [archiveAdapter, setArchiveAdapter] = useState<string>('unavailable');
  const [runs, setRuns] = useState<RetentionRunDto[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number> | null>(null);
  const [editing, setEditing] = useState<RetentionPolicyDto | null>(null);
  const [confirming, setConfirming] = useState<RetentionPolicyDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { policies: list, archiveAdapter: adapter } = await listRetentionPolicies();
      setPolicies(list);
      setArchiveAdapter(adapter);
    } catch (err) {
      const msg = (err as Error).message;
      toast.error(msg === 'retention_backend_not_deployed' ? t('admin.retention.notDeployed' as any) : t('admin.retention.loadFailed' as any));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const loadRuns = useCallback(async () => {
    try { setRuns((await listRetentionRuns()).runs); } catch { /* surfaced by the policies load */ }
  }, []);

  const loadMetrics = useCallback(async () => {
    try { setMetrics((await getSeoStorageMetrics()).metrics as Record<string, number>); } catch { /* optional panel */ }
  }, []);

  const doRun = async (policy: RetentionPolicyDto, dryRun: boolean) => {
    setBusy(policy.policy_key);
    try {
      const { outcome } = await runRetentionPolicy(policy.policy_key, dryRun);
      if (dryRun) toast.success(t('admin.retention.dryRunDone' as any, { matched: outcome.rowsMatched }));
      else toast.success(t('admin.retention.runDone' as any, { deleted: outcome.rowsDeleted }));
      await Promise.all([load(), loadRuns()]);
    } catch {
      toast.error(t('admin.retention.runFailed' as any));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const windowLabel = (p: RetentionPolicyDto) => {
    if (p.retention_mode === 'permanent') return '—';
    if (p.retention_mode === 'latest_n_runs') return t('admin.retention.keepRuns' as any, { count: p.keep_last_n ?? 0 });
    const days = p.retention_mode === 'archive_then_delete' ? p.archive_after_days : p.hot_retention_days;
    return t('admin.retention.days' as any, { count: days ?? 0 });
  };

  const grouped = useMemo(() => {
    const map = new Map<string, RetentionPolicyDto[]>();
    for (const p of policies) {
      const arr = map.get(p.category) || [];
      arr.push(p);
      map.set(p.category, arr);
    }
    return Array.from(map.entries());
  }, [policies]);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><ShieldCheck className="h-6 w-6 text-primary" />{t('admin.retention.title' as any)}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('admin.retention.description' as any)}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="me-2 h-4 w-4" />{t('admin.retention.actions.history' as any)}</Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm">
        <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{t('admin.retention.archiveAdapter' as any)}:</span>
        {archiveAdapter === 'unavailable' ? (
          <span className="text-muted-foreground">{t('admin.retention.archiveUnavailable' as any)}</span>
        ) : (
          <code className="rounded bg-background px-1.5 py-0.5 text-xs">{archiveAdapter}</code>
        )}
      </div>


      <Tabs defaultValue="policies" onValueChange={(v) => { if (v === 'runs') void loadRuns(); if (v === 'seo') void loadMetrics(); }}>
        <TabsList>
          <TabsTrigger value="policies">{t('admin.retention.tabs.policies' as any)}</TabsTrigger>
          <TabsTrigger value="runs">{t('admin.retention.tabs.runs' as any)}</TabsTrigger>
          <TabsTrigger value="partitions">{t('admin.retention.tabs.partitions' as any)}</TabsTrigger>
          <TabsTrigger value="seo">{t('admin.retention.tabs.seoStorage' as any)}</TabsTrigger>
        </TabsList>

        <TabsContent value="partitions">
          <PartitionsPanel policies={policies} />
        </TabsContent>

        <TabsContent value="policies" className="space-y-4">
          {loading && <Skeleton className="h-64 w-full rounded-xl" />}
          {!loading && grouped.map(([category, items]) => (
            <Card key={category}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t(`admin.retention.categories.${category}` as any)}</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-3 text-start">{t('admin.retention.columns.policy' as any)}</th>
                      <th className="p-3 text-start">{t('admin.retention.columns.table' as any)}</th>
                      <th className="p-3 text-start">{t('admin.retention.columns.mode' as any)}</th>
                      <th className="p-3 text-start">{t('admin.retention.columns.window' as any)}</th>
                      <th className="p-3 text-start">{t('admin.retention.columns.enabled' as any)}</th>
                      <th className="p-3 text-start">{t('admin.retention.columns.lastRun' as any)}</th>
                      <th className="p-3 text-start">{t('admin.retention.columns.lastRows' as any)}</th>
                      <th className="p-3 text-end">{t('admin.retention.columns.actions' as any)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((p) => (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="p-3 font-medium">{p.policy_key}</td>
                        <td className="p-3"><code className="text-xs">{p.table_name}</code></td>
                        <td className="p-3">{t(`admin.retention.modes.${p.retention_mode}` as any)}</td>
                        <td className="p-3">{windowLabel(p)}</td>
                        <td className="p-3">
                          {isProtected(p)
                            ? <Badge variant="secondary" title={t('admin.retention.protectedHint' as any)}>{t('admin.retention.protected' as any)}</Badge>
                            : <Badge variant={p.enabled ? 'default' : 'outline'}>{p.enabled ? '✓' : '—'}</Badge>}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">
                          {p.last_run_at ? new Date(p.last_run_at).toLocaleString() : t('admin.retention.never' as any)}
                          {p.last_error && <div className="text-destructive">{p.last_error}</div>}
                        </td>
                        <td className="p-3">{p.last_rows_deleted ?? 0}</td>
                        <td className="p-3">
                          {!isProtected(p) && (
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="ghost" onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                              <Button size="sm" variant="ghost" disabled={busy === p.policy_key} onClick={() => void doRun(p, true)}>
                                <FlaskConical className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" disabled={busy === p.policy_key || !p.enabled} onClick={() => setConfirming(p)}>
                                <Play className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="runs">
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-start">{t('admin.retention.columns.policy' as any)}</th>
                    <th className="p-3 text-start">{t('admin.retention.columns.started' as any)}</th>
                    <th className="p-3 text-start">{t('admin.retention.columns.status' as any)}</th>
                    <th className="p-3 text-start">{t('admin.retention.columns.matched' as any)}</th>
                    <th className="p-3 text-start">{t('admin.retention.columns.deleted' as any)}</th>
                    <th className="p-3 text-start">{t('admin.retention.columns.archived' as any)}</th>
                    <th className="p-3 text-start">{t('admin.retention.columns.trigger' as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">{t('admin.retention.noRuns' as any)}</td></tr>}
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{r.policy_key}</td>
                      <td className="p-3 text-xs">{new Date(r.started_at).toLocaleString()}</td>
                      <td className="p-3">
                        <Badge variant={r.status === 'failed' ? 'destructive' : r.status === 'completed' ? 'default' : 'secondary'}>
                          {t(`admin.retention.statuses.${r.status}` as any)}
                        </Badge>
                        {r.dry_run && <span className="ms-2 text-xs text-muted-foreground">dry-run</span>}
                      </td>
                      <td className="p-3">{r.rows_matched}</td>
                      <td className="p-3">{r.rows_deleted}</td>
                      <td className="p-3">{r.rows_archived}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.triggered_by}{r.error ? ` — ${r.error}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="seo">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4" />{t('admin.retention.seo.title' as any)}</CardTitle>
              <CardDescription>{t('admin.retention.seo.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {([
                  ['seo.uniqueUrls', 'unique_urls'],
                  ['seo.memberships', 'crawl_memberships'],
                  ['seo.observations', 'full_observations'],
                  ['seo.changed', 'changed_observations'],
                  ['seo.unchanged', 'unchanged_memberships'],
                  ['seo.rowsAvoided', 'rows_avoided'],
                  ['seo.legacyPages', 'legacy_seo_pages'],
                  ['seo.legacyLinks', 'legacy_seo_links'],
                ] as const).map(([key, metric]) => (
                  <div key={metric} className="rounded-lg border border-border/60 p-3">
                    <p className="text-xs text-muted-foreground">{t(`admin.retention.${key}` as any)}</p>
                    <p className="text-xl font-semibold">{metrics ? Number(metrics[metric] ?? 0).toLocaleString() : '—'}</p>
                  </div>
                ))}
                <div className="rounded-lg border border-border/60 p-3">
                  <p className="text-xs text-muted-foreground">{t('admin.retention.seo.dedupRatio' as any)}</p>
                  <p className="text-xl font-semibold">{metrics ? `${Math.round(Number(metrics.deduplication_ratio ?? 0) * 100)}%` : '—'}</p>
                </div>
              </div>
              <Button
                variant="outline"
                disabled={busy === 'backfill'}
                onClick={async () => {
                  setBusy('backfill');
                  try {
                    const { result } = await runSeoStorageBackfill(25);
                    toast.success(t('admin.retention.seo.backfillDone' as any, { crawls: result.crawlsProcessed, urls: result.urlsCreated }));
                    await loadMetrics();
                  } catch { toast.error(t('admin.retention.seo.backfillFailed' as any)); }
                  finally { setBusy(null); }
                }}
              >
                {t('admin.retention.seo.backfill' as any)}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.retention.edit.title' as any)}</DialogTitle>
            <DialogDescription>{editing?.policy_key}</DialogDescription>
          </DialogHeader>
          {editing && <EditForm policy={editing} onDone={async () => { setEditing(null); await load(); }} />}
        </DialogContent>
      </Dialog>

      {/* Run confirmation */}
      <Dialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.retention.confirm.title' as any)}</DialogTitle>
            <DialogDescription>{t('admin.retention.confirm.body' as any, { table: confirming?.table_name || '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>{t('admin.retention.actions.cancel' as any)}</Button>
            <Button variant="destructive" onClick={() => confirming && void doRun(confirming, false)}>
              {t('admin.retention.confirm.confirm' as any)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditForm({ policy, onDone }: { policy: RetentionPolicyDto; onDone: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(policy.enabled);
  const [days, setDays] = useState(String(policy.hot_retention_days ?? ''));
  const [keepN, setKeepN] = useState(String(policy.keep_last_n ?? ''));
  const [batch, setBatch] = useState(String(policy.batch_size));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = { enabled, batch_size: Number(batch) };
      if (policy.retention_mode === 'rolling') patch.hot_retention_days = Number(days);
      if (policy.retention_mode === 'latest_n_runs') patch.keep_last_n = Number(keepN);
      if (policy.retention_mode === 'archive_then_delete') patch.archive_after_days = Number(days);
      await updateRetentionPolicy(policy.policy_key, patch);
      toast.success(t('admin.retention.edit.saved' as any));
      await onDone();
    } catch {
      toast.error(t('admin.retention.edit.saveFailed' as any));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label>{t('admin.retention.edit.enabled' as any)}</Label>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>
      {policy.retention_mode !== 'latest_n_runs' && (
        <div className="space-y-1">
          <Label>{t('admin.retention.edit.hotRetentionDays' as any)}</Label>
          <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} dir="ltr" />
        </div>
      )}
      {policy.retention_mode === 'latest_n_runs' && (
        <div className="space-y-1">
          <Label>{t('admin.retention.edit.keepLastN' as any)}</Label>
          <Input type="number" min={1} value={keepN} onChange={(e) => setKeepN(e.target.value)} dir="ltr" />
        </div>
      )}
      <div className="space-y-1">
        <Label>{t('admin.retention.edit.batchSize' as any)}</Label>
        <Input type="number" min={100} max={50000} value={batch} onChange={(e) => setBatch(e.target.value)} dir="ltr" />
      </div>
      <DialogFooter>
        <Button disabled={saving} onClick={() => void save()}>{t('admin.retention.actions.save' as any)}</Button>
      </DialogFooter>
    </div>
  );
}
