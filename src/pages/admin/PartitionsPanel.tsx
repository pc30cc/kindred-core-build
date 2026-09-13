/**
 * Super Admin → Data Retention → Partitions.
 *
 * Diagnostics plus two SAFE actions only: create missing future partitions
 * (idempotent, additive) and validate the layout. There is intentionally no
 * "drop partition" control — removing old partitions goes through the
 * retention workflow, and the dry-run preview below is the only partition
 * lifecycle surface in this phase.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CalendarPlus, ShieldCheck, FlaskConical, RefreshCw } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import {
  getPartitionDiagnostics, ensurePartitions, validatePartitionLayout, previewPartitionRetention,
  type PartitionHealthDto, type PartitionInventoryDto, type PartitionRetentionCandidateDto,
  type RetentionPolicyDto,
} from '@/lib/api';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const healthVariant = (h: string) => (h === 'ok' ? 'default' : h === 'attention' ? 'secondary' : 'destructive');

export default function PartitionsPanel({ policies }: { policies: RetentionPolicyDto[] }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [tables, setTables] = useState<PartitionHealthDto[]>([]);
  const [partitions, setPartitions] = useState<PartitionInventoryDto[]>([]);
  const [preview, setPreview] = useState<Record<string, PartitionRetentionCandidateDto[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getPartitionDiagnostics();
      setTables(data.tables);
      setPartitions(data.partitions);
    } catch {
      toast.error(t('admin.retention.partitions.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const doEnsure = async (table?: string) => {
    setBusy(table || 'all');
    try {
      const { created } = await ensurePartitions(table);
      const names = created.flatMap((c) => c.partitions);
      toast.success(t('admin.retention.partitions.ensured' as any, { count: names.length }));
      await load();
    } catch {
      toast.error(t('admin.retention.partitions.ensureFailed'));
    } finally { setBusy(null); }
  };

  const doValidate = async () => {
    setBusy('validate');
    try {
      const result = await validatePartitionLayout();
      setTables(result.tables);
      if (result.ok) toast.success(t('admin.retention.partitions.layoutOk'));
      else toast.error(t('admin.retention.partitions.layoutIssues' as any, { count: result.alerts.length }));
    } catch {
      toast.error(t('admin.retention.partitions.loadFailed'));
    } finally { setBusy(null); }
  };

  const doPreview = async (parentTable: string) => {
    const policy = policies.find((p) => p.table_name === parentTable);
    if (!policy) { toast.error(t('admin.retention.partitions.noPolicy')); return; }
    setBusy(`preview:${parentTable}`);
    try {
      const { candidates } = await previewPartitionRetention(policy.policy_key);
      setPreview((prev) => ({ ...prev, [parentTable]: candidates }));
      if (candidates.length === 0) toast.success(t('admin.retention.partitions.previewEmpty'));
    } catch {
      toast.error(t('admin.retention.partitions.previewFailed'));
    } finally { setBusy(null); }
  };

  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;

  if (tables.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('admin.retention.partitions.none')}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy === 'all'} onClick={() => void doEnsure()}>
          <CalendarPlus className="me-2 h-4 w-4" />{t('admin.retention.partitions.ensureAll')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy === 'validate'} onClick={() => void doValidate()}>
          <ShieldCheck className="me-2 h-4 w-4" />{t('admin.retention.partitions.validate')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="me-2 h-4 w-4" />{t('admin.retention.partitions.refresh')}
        </Button>
      </div>

      {tables.map((tbl) => {
        const rows = partitions.filter((p) => p.parent_table === tbl.parent_table);
        const candidates = preview[tbl.parent_table];
        const policy = policies.find((p) => p.table_name === tbl.parent_table);
        return (
          <Card key={tbl.parent_table}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <code className="text-sm">{tbl.parent_table}</code>
                    <Badge variant={healthVariant(tbl.health)}>
                      {t(`admin.retention.partitions.health.${tbl.health}` as any)}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {t('admin.retention.partitions.summary' as any, {
                      key: tbl.partition_key,
                      count: tbl.partition_count,
                      rows: tbl.total_rows,
                      size: formatBytes(tbl.total_bytes),
                    })}
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={busy === tbl.parent_table}
                    onClick={() => void doEnsure(tbl.parent_table)}>
                    <CalendarPlus className="me-2 h-4 w-4" />{t('admin.retention.partitions.ensureOne')}
                  </Button>
                  {policy && (
                    <Button size="sm" variant="ghost" disabled={busy === `preview:${tbl.parent_table}`}
                      onClick={() => void doPreview(tbl.parent_table)}>
                      <FlaskConical className="me-2 h-4 w-4" />{t('admin.retention.partitions.dryRun')}
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.current')}</dt>
                  <dd className="font-mono text-xs">{tbl.current_partition || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.next')}</dt>
                  <dd>
                    <Badge variant={tbl.next_partition_ready ? 'default' : 'destructive'}>
                      {tbl.next_partition_ready
                        ? t('admin.retention.partitions.ready')
                        : t('admin.retention.partitions.notReady')}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.oldest')}</dt>
                  <dd className="font-mono text-xs">{tbl.oldest_partition || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.newest')}</dt>
                  <dd className="font-mono text-xs">{tbl.newest_partition || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.largest')}</dt>
                  <dd className="font-mono text-xs">{tbl.largest_partition || '—'} ({formatBytes(tbl.largest_bytes)})</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.defaultRows')}</dt>
                  <dd className={tbl.default_rows > 0 ? 'font-semibold text-destructive' : ''}>{tbl.default_rows}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.policy')}</dt>
                  <dd className="text-xs">{policy ? policy.policy_key : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('admin.retention.partitions.cleanup')}</dt>
                  <dd className="text-xs">
                    {policy?.enabled
                      ? t('admin.retention.partitions.cleanupEnabled')
                      : t('admin.retention.partitions.cleanupDisabled')}
                  </dd>
                </div>
              </dl>

              {tbl.issues.length > 0 && (
                <ul className="list-inside list-disc rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                  {tbl.issues.map((code) => (
                    <li key={code}>{t(`admin.retention.partitions.issues.${code}` as any)}</li>
                  ))}
                </ul>
              )}

              {candidates && candidates.length > 0 && (
                <div className="rounded-md border border-border/60 p-3 text-xs">
                  <div className="mb-2 font-medium">{t('admin.retention.partitions.previewTitle')}</div>
                  <ul className="space-y-1">
                    {candidates.map((c) => (
                      <li key={c.partition_name} className="font-mono">
                        {c.partition_name} — {c.est_rows} · {formatBytes(c.est_bytes)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-muted-foreground">{t('admin.retention.partitions.previewNote')}</p>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start">{t('admin.retention.partitions.columns.partition')}</th>
                      <th className="p-2 text-start">{t('admin.retention.partitions.columns.range')}</th>
                      <th className="p-2 text-start">{t('admin.retention.partitions.columns.rows')}</th>
                      <th className="p-2 text-start">{t('admin.retention.partitions.columns.size')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.partition_name} className="border-b last:border-0">
                        <td className="p-2 font-mono text-xs">
                          {p.partition_name}
                          {p.is_default && <Badge variant="outline" className="ms-2">DEFAULT</Badge>}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {p.is_default
                            ? t('admin.retention.partitions.catchAll')
                            : `${p.range_start?.slice(0, 10)} → ${p.range_end?.slice(0, 10)}`}
                        </td>
                        <td className="p-2">{p.est_rows}</td>
                        <td className="p-2">{formatBytes(p.total_bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
