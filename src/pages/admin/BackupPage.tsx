/**
 * Super Admin → System / Backup & Recovery.
 *
 * Read-focused by design. The only actions exposed are "run a backup now" and
 * "verify the latest backup", both of which are queued for the host-side agent.
 * There is NO restore button: restoring production is a controlled operational
 * procedure documented in docs/BACKUP_AND_DISASTER_RECOVERY.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertTriangle, CheckCircle2, CloudUpload, Database, HardDriveDownload,
  RefreshCw, ShieldCheck, Timer,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import {
  getBackupOverview, listBackupRuns, listRestoreDrills, requestBackupCommand,
  type BackupOverviewDto, type BackupRunDto, type RestoreDrillDto,
} from '@/lib/api';

const fmtBytes = (n: number | null | undefined) => {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

export default function BackupPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'fa' ? 'fa-IR' : i18n.language === 'tr' ? 'tr-TR' : 'en-GB';
  const fmtTime = (v: string | null | undefined) =>
    v ? new Date(v).toLocaleString(locale, { timeZone: 'Asia/Tehran' }) : '—';
  const fmtDuration = (s: number | null | undefined) => {
    if (s == null) return '—';
    if (s < 90) return t('admin.backup.secondsAgo' as never, { count: Math.round(s) }) as string;
    if (s < 5400) return t('admin.backup.minutesAgo' as never, { count: Math.round(s / 60) }) as string;
    if (s < 172800) return t('admin.backup.hoursAgo' as never, { count: Math.round(s / 3600) }) as string;
    return t('admin.backup.daysAgo' as never, { count: Math.round(s / 86400) }) as string;
  };

  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<BackupOverviewDto | null>(null);
  const [runs, setRuns] = useState<BackupRunDto[]>([]);
  const [drills, setDrills] = useState<RestoreDrillDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await getBackupOverview());
    } catch (err) {
      const msg = (err as Error).message;
      toast.error(
        msg === 'backup_backend_not_deployed'
          ? (t('admin.backup.notDeployed' as never) as string)
          : (t('admin.backup.loadFailed' as never) as string),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const loadRuns = useCallback(async () => {
    try { setRuns((await listBackupRuns()).runs); } catch { /* surfaced by overview */ }
  }, []);
  const loadDrills = useCallback(async () => {
    try { setDrills((await listRestoreDrills()).drills); } catch { /* surfaced by overview */ }
  }, []);

  const queue = async (command: 'run_base_backup' | 'run_logical_backup' | 'verify_latest_backup') => {
    setBusy(command);
    try {
      await requestBackupCommand(command);
      toast.success(t('admin.backup.queued' as never) as string);
    } catch {
      toast.error(t('admin.backup.queueFailed' as never) as string);
    } finally {
      setBusy(null);
    }
  };

  const healthBadge = (state: 'ok' | 'attention' | 'critical' | undefined) => {
    if (state === 'ok') return <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />{t('admin.backup.health.ok' as never) as string}</Badge>;
    if (state === 'attention') return <Badge variant="outline" className="gap-1"><AlertTriangle className="h-3 w-3" />{t('admin.backup.health.attention' as never) as string}</Badge>;
    return <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" />{t('admin.backup.health.critical' as never) as string}</Badge>;
  };

  const kindLabel = (k: string) => t(`admin.backup.kind.${k}` as never) as string;

  if (loading && !overview) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const wal = overview?.wal ?? null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <ShieldCheck className="h-6 w-6 text-primary" />
            {t('admin.backup.title' as never) as string}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('admin.backup.description' as never) as string}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {healthBadge(overview?.health)}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Alerts */}
      {overview && overview.alerts.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t('admin.backup.alertsTitle' as never) as string}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.alerts.map((a, idx) => (
              <div key={`${a.code}-${idx}`} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={a.severity === 'critical' ? 'destructive' : 'outline'}>{kindLabel(a.scope)}</Badge>
                <span>{t(`admin.backup.alert.${a.code}` as never) as string}</span>
                {a.detail && <span className="text-muted-foreground">({a.detail})</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Recovery objectives */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1"><Timer className="h-3.5 w-3.5" />{t('admin.backup.rpo' as never) as string}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{fmtDuration(overview?.pitr.rpo_actual_seconds ?? null)}</div>
            <p className="text-xs text-muted-foreground">
              {t('admin.backup.target' as never) as string}: {fmtDuration(overview?.pitr.rpo_target_seconds ?? null)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('admin.backup.pitrWindow' as never) as string}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">{fmtTime(overview?.pitr.window_start)}</div>
            <div className="text-xs text-muted-foreground">→ {fmtTime(overview?.pitr.window_end)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('admin.backup.walHealth' as never) as string}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">
              {wal ? `${wal.archive_mode} · ${wal.wal_level}` : '—'}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin.backup.walArchived' as never, { count: wal?.archived_count ?? 0 }) as string}
              {wal?.failed_count ? ` · ${t('admin.backup.walFailed' as never, { count: wal.failed_count }) as string}` : ''}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t('admin.backup.lastDrill' as never) as string}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">{fmtTime(overview?.lastDrills?.[0]?.finished_at ?? null)}</div>
            <p className="text-xs text-muted-foreground">
              {overview?.lastDrills?.[0]
                ? `${t(`admin.backup.drillKind.${overview.lastDrills[0].drill_kind}` as never) as string} · ${t(`admin.backup.drillStatus.${overview.lastDrills[0].status}` as never) as string}`
                : (t('admin.backup.drillNever' as never) as string)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Safe actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('admin.backup.actionsTitle' as never) as string}</CardTitle>
          <CardDescription>{t('admin.backup.actionsNote' as never) as string}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void queue('run_base_backup')}>
            <Database className="h-4 w-4" />{t('admin.backup.runBase' as never) as string}
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void queue('run_logical_backup')}>
            <CloudUpload className="h-4 w-4" />{t('admin.backup.runLogical' as never) as string}
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void queue('verify_latest_backup')}>
            <ShieldCheck className="h-4 w-4" />{t('admin.backup.verifyLatest' as never) as string}
          </Button>
        </CardContent>
      </Card>

      <Tabs defaultValue="latest" onValueChange={(v) => { if (v === 'runs') void loadRuns(); if (v === 'drills') void loadDrills(); }}>
        <TabsList>
          <TabsTrigger value="latest">{t('admin.backup.tabs.latest' as never) as string}</TabsTrigger>
          <TabsTrigger value="runs">{t('admin.backup.tabs.runs' as never) as string}</TabsTrigger>
          <TabsTrigger value="drills">{t('admin.backup.tabs.drills' as never) as string}</TabsTrigger>
        </TabsList>

        <TabsContent value="latest" className="mt-4 space-y-3">
          {(overview?.latest ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">{t('admin.backup.noBackups' as never) as string}</p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {(overview?.latest ?? []).map((row) => {
              const dest = overview?.destinations.find((d) => d.kind === row.kind);
              return (
                <Card key={row.kind}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      <span className="flex items-center gap-2"><HardDriveDownload className="h-4 w-4" />{kindLabel(row.kind)}</span>
                      <Badge variant={row.status === 'succeeded' ? 'secondary' : 'destructive'}>
                        {t(`admin.backup.status.${row.status}` as never) as string}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('admin.backup.finishedAt' as never) as string}</span><span>{fmtTime(row.finished_at)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('admin.backup.age' as never) as string}</span><span>{fmtDuration(row.age_seconds)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('admin.backup.size' as never) as string}</span><span>{fmtBytes(row.bytes)}</span></div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('admin.backup.verification' as never) as string}</span>
                      <span>{t(`admin.backup.verify.${row.verification_status}` as never) as string}{row.verified_at ? ` · ${fmtTime(row.verified_at)}` : ''}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('admin.backup.destination' as never) as string}</span>
                      <span className="flex items-center gap-1">
                        {dest?.offsite
                          ? <Badge variant="secondary">{t('admin.backup.offsite' as never) as string}</Badge>
                          : <Badge variant="destructive">{t('admin.backup.onServer' as never) as string}</Badge>}
                        {row.encrypted && <Badge variant="outline">{t('admin.backup.encrypted' as never) as string}</Badge>}
                      </span>
                    </div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('admin.backup.lastRestoreTested' as never) as string}</span><span>{fmtTime(row.last_restore_tested_at)}</span></div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {(overview?.schedule ?? []).length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t('admin.backup.nextScheduled' as never) as string}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                {overview!.schedule.map((s) => (
                  <div key={s.kind} className="flex justify-between">
                    <span className="text-muted-foreground">{kindLabel(s.kind)}</span>
                    <span>{fmtTime(s.next_run_at)}{s.cron ? ` · ${s.cron}` : ''}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          {runs.length === 0
            ? <p className="text-sm text-muted-foreground">{t('admin.backup.noBackups' as never) as string}</p>
            : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-start">
                    <tr>
                      <th className="p-2 text-start">{t('admin.backup.col.kind' as never) as string}</th>
                      <th className="p-2 text-start">{t('admin.backup.col.backupId' as never) as string}</th>
                      <th className="p-2 text-start">{t('admin.backup.col.status' as never) as string}</th>
                      <th className="p-2 text-start">{t('admin.backup.col.finished' as never) as string}</th>
                      <th className="p-2 text-start">{t('admin.backup.col.size' as never) as string}</th>
                      <th className="p-2 text-start">{t('admin.backup.col.lsn' as never) as string}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="p-2">{kindLabel(r.kind)}</td>
                        <td className="p-2 font-mono text-xs">{r.backup_id}</td>
                        <td className="p-2">
                          <Badge variant={r.status === 'succeeded' ? 'secondary' : r.status === 'failed' ? 'destructive' : 'outline'}>
                            {t(`admin.backup.status.${r.status}` as never) as string}
                          </Badge>
                        </td>
                        <td className="p-2">{fmtTime(r.finished_at)}</td>
                        <td className="p-2">{fmtBytes(r.bytes)}</td>
                        <td className="p-2 font-mono text-xs">{r.lsn || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </TabsContent>

        <TabsContent value="drills" className="mt-4 space-y-3">
          {drills.length === 0
            ? <p className="text-sm text-muted-foreground">{t('admin.backup.drillNever' as never) as string}</p>
            : drills.map((d) => (
              <Card key={d.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>{t(`admin.backup.drillKind.${d.drill_kind}` as never) as string}</span>
                    <Badge variant={d.status === 'passed' ? 'secondary' : d.status === 'failed' ? 'destructive' : 'outline'}>
                      {t(`admin.backup.drillStatus.${d.status}` as never) as string}
                    </Badge>
                  </CardTitle>
                  <CardDescription>{d.environment} · {fmtTime(d.finished_at)}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {d.target_time && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('admin.backup.targetTime' as never) as string}</span>
                      <span>{fmtTime(d.target_time)}</span>
                    </div>
                  )}
                  {d.notes && <p className="text-muted-foreground">{d.notes}</p>}
                </CardContent>
              </Card>
            ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
