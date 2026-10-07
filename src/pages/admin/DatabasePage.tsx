import { useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  Database, Download, Server, FolderSync, ArrowRightLeft, GitCompare,
  AlertCircle, CheckCircle, Loader2, Trash2, ShieldAlert, Upload, DatabaseBackup,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DatabaseBackupsSection } from '@/components/admin/database/DatabaseBackupsSection';
import { downloadDatabaseBackup, restoreDatabaseBackup, purgeDatabase, testSelfhostTarget, streamSelfhostMigration, compareSelfhostTarget, downloadSqlDump, type DbCompareResult } from '@/lib/api';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : '');

function MaintenanceCard() {
  const { t, dir } = useTranslation();
  const isRtl = dir === 'rtl';
  const fileRef = useRef<HTMLInputElement>(null);
  const fullFileRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState<null | 'backup' | 'fullBackup' | 'restore' | 'fullRestore' | 'data' | 'full'>(null);
  const [confirmScope, setConfirmScope] = useState<null | 'data' | 'full'>(null);
  const [confirmText, setConfirmText] = useState('');

  const handleBackup = async (full = false) => {
    setBusy(full ? 'fullBackup' : 'backup');
    try {
      await downloadDatabaseBackup(full);
      toast.success(t('admin.database.backupDownloaded'));
    } catch (e) {
      toast.error(errorMessage(e) || t('admin.database.opFailed'));
    } finally {
      setBusy(null);
    }
  };


  const handleRestoreFile = async (file: File, full = false) => {
    setBusy(full ? 'fullRestore' : 'restore');
    try {
      const payload = JSON.parse(await file.text());
      const res = await restoreDatabaseBackup(payload);
      if (res.schema && res.schema.failed_count > 0) {
        toast.warning(t('admin.database.schemaPartial', { count: res.schema.failed_count }));
      } else {
        toast.success(t('admin.database.restoreDone'));
      }
    } catch (e) {
      toast.error(errorMessage(e) || t('admin.database.opFailed'));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
      if (fullFileRef.current) fullFileRef.current.value = '';
    }
  };


  const runPurge = async () => {
    if (!confirmScope) return;
    setBusy(confirmScope);
    try {
      await purgeDatabase(confirmScope);
      toast.success(t('admin.database.purgeDone'));
      setConfirmScope(null);
      setConfirmText('');
    } catch (e) {
      toast.error(errorMessage(e) || t('admin.database.opFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className={cn('text-foreground text-sm flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}>
            <ShieldAlert className="h-4 w-4" />
            {t('admin.database.maintenance')}
          </CardTitle>
          <CardDescription className="text-muted-foreground text-start">{t('admin.database.maintenanceDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className={cn('flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between', isRtl && 'sm:flex-row-reverse')}>
            <div className="text-start">
              <p className="text-sm text-foreground">{t('admin.database.downloadBackup')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.database.downloadBackupDesc')}</p>
            </div>
            <Button onClick={() => void handleBackup(false)} disabled={busy !== null} className={cn('gap-2', isRtl && 'flex-row-reverse')}>
              {busy === 'backup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {busy === 'backup' ? t('admin.database.working') : t('admin.database.downloadBackup')}
            </Button>
          </div>

          <div className={cn('flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between', isRtl && 'sm:flex-row-reverse')}>
            <div className="text-start">
              <p className="text-sm text-foreground">{t('admin.database.downloadFullBackup')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.database.downloadFullBackupDesc')}</p>
            </div>
            <Button onClick={() => void handleBackup(true)} disabled={busy !== null} className={cn('gap-2', isRtl && 'flex-row-reverse')}>
              {busy === 'fullBackup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseBackup className="h-4 w-4" />}
              {busy === 'fullBackup' ? t('admin.database.working') : t('admin.database.downloadFullBackup')}
            </Button>
          </div>

          <div className={cn('flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between', isRtl && 'sm:flex-row-reverse')}>
            <div className="text-start">
              <p className="text-sm text-foreground">{t('admin.database.restoreBackup')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.database.restoreBackupDesc')}</p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleRestoreFile(f); }}
            />
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => fileRef.current?.click()}
              className={cn('gap-2', isRtl && 'flex-row-reverse')}
            >
              {busy === 'restore' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {busy === 'restore' ? t('admin.database.working') : t('admin.database.selectBackupFile')}
            </Button>
          </div>

          <div className={cn('flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between', isRtl && 'sm:flex-row-reverse')}>
            <div className="text-start">
              <p className="text-sm text-foreground">{t('admin.database.restoreFullBackup')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.database.restoreFullBackupDesc')}</p>
            </div>
            <input
              ref={fullFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleRestoreFile(f, true); }}
            />
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => fullFileRef.current?.click()}
              className={cn('gap-2', isRtl && 'flex-row-reverse')}
            >
              {busy === 'fullRestore' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {busy === 'fullRestore' ? t('admin.database.working') : t('admin.database.selectBackupFile')}
            </Button>
          </div>


          <div className={cn('flex flex-col gap-3 rounded-md border border-warning/30 bg-warning/5 p-4 sm:flex-row sm:items-center sm:justify-between', isRtl && 'sm:flex-row-reverse')}>
            <div className="text-start">
              <p className="text-sm text-foreground">{t('admin.database.purgeData')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.database.purgeDataDesc')}</p>
            </div>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => { setConfirmScope('data'); setConfirmText(''); }}
              className={cn('gap-2 border-warning/50 text-warning hover:bg-warning/10', isRtl && 'flex-row-reverse')}
            >
              <Trash2 className="h-4 w-4" />
              {t('admin.database.purgeData')}
            </Button>
          </div>

          <div className={cn('flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between', isRtl && 'sm:flex-row-reverse')}>
            <div className="text-start">
              <p className="text-sm text-foreground">{t('admin.database.purgeAll')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.database.purgeAllDesc')}</p>
            </div>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => { setConfirmScope('full'); setConfirmText(''); }}
              className={cn('gap-2', isRtl && 'flex-row-reverse')}
            >
              <Trash2 className="h-4 w-4" />
              {t('admin.database.purgeAll')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmScope !== null} onOpenChange={open => { if (!open && busy === null) { setConfirmScope(null); setConfirmText(''); } }}>
        <DialogContent dir={dir} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-start">{t('admin.database.purgeConfirmTitle')}</DialogTitle>
            <DialogDescription className="text-start">
              {confirmScope === 'full' ? t('admin.database.purgeAllDesc') : t('admin.database.purgeDataDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-start">
            <p className="text-xs text-muted-foreground">{t('admin.database.purgeConfirmBody')}</p>
            <Input
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder={t('admin.database.confirmWord')}
              className="bg-input border-border text-foreground text-start"
            />
          </div>
          <DialogFooter className={cn('gap-2', isRtl && 'sm:flex-row-reverse')}>
            <Button variant="ghost" disabled={busy !== null} onClick={() => { setConfirmScope(null); setConfirmText(''); }}>
              {t('admin.database.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={confirmText.trim() !== 'DELETE' || busy !== null}
              onClick={runPurge}
              className={cn('gap-2', isRtl && 'flex-row-reverse')}
            >
              {busy === 'data' || busy === 'full' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {busy === 'data' || busy === 'full' ? t('admin.database.working') : t('admin.database.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BackupTab() {
  const { dir } = useTranslation();
  return (
    <div dir={dir} className="space-y-6 text-start">
      <MaintenanceCard />
      <DatabaseBackupsSection />
    </div>
  );
}

function MigrationTab() {
  const { t, dir } = useTranslation();
  const isRtl = dir === 'rtl';

  const [connectionString, setConnectionString] = useState('');
  const [includeSchema, setIncludeSchema] = useState(true);
  const [truncateTarget, setTruncateTarget] = useState(false);
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [targetInfo, setTargetInfo] = useState<{ database: string; tableCount: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const append = (line: string) => setLog(prev => [...prev.slice(-300), line]);

  const handleTest = async () => {
    setTesting(true);
    setTargetInfo(null);
    try {
      const info = await testSelfhostTarget(connectionString.trim());
      setTargetInfo({ database: info.database, tableCount: info.tableCount });
      toast.success(t('admin.database.migrationConnected', { db: info.database, tables: info.tableCount }));
    } catch (e) {
      const code = errorMessage(e);
      const known = {
        target_host_not_found: 'admin.database.target_host_not_found',
        target_connection_refused: 'admin.database.target_connection_refused',
        target_unreachable: 'admin.database.target_unreachable',
        target_auth_failed: 'admin.database.target_auth_failed',
        target_database_missing: 'admin.database.target_database_missing',
        target_tls_error: 'admin.database.target_tls_error',
        target_connect_failed: 'admin.database.target_connect_failed',
        invalid_connection_string: 'admin.database.invalid_connection_string',
        migration_backend_not_deployed: 'admin.database.migrationBackendNotDeployed',
      } as const;
      const key = known[code as keyof typeof known];
      toast.error(key ? t(key) : code || t('admin.database.opFailed'));
    } finally {
      setTesting(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setLog([]);
    try {
      await streamSelfhostMigration(
        { connectionString: connectionString.trim(), includeSchema, truncateTarget },
        event => {
          if (event.type === 'stage') append(`• ${String(event.stage)}`);
          else if (event.type === 'schemaDone') append(`• schema: ${event.applied}/${event.total} (failed ${event.failed})`);
          else if (event.type === 'tables') append(`• tables: ${event.total}`);
          else if (event.type === 'tableDone') append(`✓ ${event.table} — ${event.rows} rows${event.skipped ? ` (${event.skipped})` : ''}`);
          else if (event.type === 'warn') append(`! ${event.message}`);
          else if (event.type === 'error') append(`✗ ${event.message}`);
          else if (event.type === 'done') {
            append(`✓ ${t('admin.database.migrationDone', { tables: event.tables, rows: event.rows })}`);
            toast.success(t('admin.database.migrationDone', { tables: event.tables, rows: event.rows }));
          }
        },
      );
    } catch (e) {
      append(`✗ ${errorMessage(e) || 'error'}`);
      toast.error(errorMessage(e) || t('admin.database.migrationFailed'));
    } finally {
      setRunning(false);
    }
  };

  const canRun = connectionString.trim().length > 10 && !running && !testing;

  return (
    <div dir={dir} className="space-y-6 text-start">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className={cn('text-foreground text-sm flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}>
            <ArrowRightLeft className="h-4 w-4" />
            {t('admin.database.migrationTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground text-start">{t('admin.database.migrationDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2 text-start">
            <Label className="text-xs text-muted-foreground">{t('admin.database.migrationConnLabel')}</Label>
            <Input
              dir="ltr"
              value={connectionString}
              onChange={e => setConnectionString(e.target.value)}
              placeholder="postgresql://postgres:PASSWORD@db.example.com:5432/postgres"
              className="bg-input border-border text-foreground font-mono text-xs text-left"
              disabled={running}
            />
            <p className="text-xs text-muted-foreground">{t('admin.database.migrationConnHint')}</p>
          </div>

          <div className="space-y-3 rounded-md border border-border p-4">
            <div className={cn('flex items-center justify-between gap-3', isRtl && 'flex-row-reverse')}>
              <Label className="text-xs text-foreground">{t('admin.database.migrationIncludeSchema')}</Label>
              <Switch checked={includeSchema} onCheckedChange={setIncludeSchema} disabled={running} />
            </div>
            <Separator />
            <div className={cn('flex items-center justify-between gap-3', isRtl && 'flex-row-reverse')}>
              <Label className="text-xs text-foreground">{t('admin.database.migrationTruncate')}</Label>
              <Switch checked={truncateTarget} onCheckedChange={setTruncateTarget} disabled={running} />
            </div>
          </div>

          {targetInfo && (
            <div className={cn('flex items-center gap-3 rounded-md border border-success/30 bg-success/5 p-3', isRtl && 'flex-row-reverse')}>
              <CheckCircle className="h-4 w-4 text-success shrink-0" />
              <p className="text-xs text-success">
                {t('admin.database.migrationConnected', { db: targetInfo.database, tables: targetInfo.tableCount })}
              </p>
            </div>
          )}

          <div className={cn('flex items-center gap-3 rounded-md border border-warning/30 bg-warning/5 p-3 text-start', isRtl && 'flex-row-reverse')}>
            <AlertCircle className="h-5 w-5 text-warning shrink-0" />
            <p className="text-xs text-warning">{t('admin.database.migrationPending')}</p>
          </div>

          <div className={cn('flex flex-wrap gap-3', isRtl && 'flex-row-reverse')}>
            <Button
              variant="outline"
              onClick={() => void handleTest()}
              disabled={!canRun}
              className={cn('gap-2', isRtl && 'flex-row-reverse')}
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Server className="h-4 w-4" />}
              {testing ? t('admin.database.migrationTesting') : t('admin.database.migrationTest')}
            </Button>
            <Button onClick={() => void handleRun()} disabled={!canRun} className={cn('gap-2', isRtl && 'flex-row-reverse')}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderSync className="h-4 w-4" />}
              {running ? t('admin.database.migrationRunning') : t('admin.database.startMigration')}
            </Button>
          </div>

          {log.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t('admin.database.migrationLog')}</p>
              <pre dir="ltr" className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-left text-[11px] leading-5 text-foreground">
                {log.join('\n')}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <SqlDumpSection />

      <CompareSection connectionString={connectionString} />
    </div>
  );
}

function SqlDumpSection() {
  const { t, dir } = useTranslation();
  const isRtl = dir === 'rtl';
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await downloadSqlDump();
      toast.success(t('admin.database.dumpReady'));
    } catch (e) {
      toast.error(errorMessage(e) || t('admin.database.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className={cn('text-foreground text-sm flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}>
          <DatabaseBackup className="h-4 w-4" />
          {t('admin.database.dumpTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground text-start">{t('admin.database.dumpDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={() => void run()} disabled={busy} className={cn('gap-2', isRtl && 'flex-row-reverse')}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {busy ? t('admin.database.dumpPreparing') : t('admin.database.dumpButton')}
        </Button>
        <pre dir="ltr" className="overflow-auto rounded-md border border-border bg-muted/40 p-3 text-left text-[11px] leading-5 text-muted-foreground">
          {t('admin.database.dumpHint')}
        </pre>
      </CardContent>
    </Card>
  );
}

function DiffList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">{title} ({items.length})</p>
      <div dir="ltr" className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-left text-[11px] leading-5 font-mono text-foreground">
        {items.join('\n')}
      </div>
    </div>
  );
}

function CompareSection({ connectionString }: { connectionString: string }) {
  const { t, dir } = useTranslation();
  const isRtl = dir === 'rtl';
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DbCompareResult | null>(null);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await compareSelfhostTarget(connectionString.trim());
      setResult(res);
      if (res.identical) toast.success(t('admin.database.compareIdentical'));
      else toast.warning(t('admin.database.compareDifferent'));
    } catch (e) {
      toast.error(errorMessage(e) || t('admin.database.opFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className={cn('text-foreground text-sm flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}>
          <GitCompare className="h-4 w-4" />
          {t('admin.database.compareTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground text-start">{t('admin.database.compareDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          variant="outline"
          onClick={() => void run()}
          disabled={loading || connectionString.trim().length < 10}
          className={cn('gap-2', isRtl && 'flex-row-reverse')}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitCompare className="h-4 w-4" />}
          {loading ? t('admin.database.comparing') : t('admin.database.compareRun')}
        </Button>

        {result && (
          <div className="space-y-4">
            <div
              className={cn(
                'flex items-center gap-3 rounded-md border p-3',
                result.identical ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5',
                isRtl && 'flex-row-reverse',
              )}
            >
              {result.identical ? <CheckCircle className="h-4 w-4 text-success shrink-0" /> : <AlertCircle className="h-4 w-4 text-warning shrink-0" />}
              <p className={cn('text-xs', result.identical ? 'text-success' : 'text-warning')}>
                {result.identical ? t('admin.database.compareIdentical') : t('admin.database.compareDifferent')}
              </p>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-start">{t('admin.database.compareSection')}</th>
                    <th className="p-2 text-start">{t('admin.database.sourceDb')}</th>
                    <th className="p-2 text-start">{t('admin.database.targetDb')}</th>
                    <th className="p-2 text-start">{t('admin.database.compareMissing')}</th>
                    <th className="p-2 text-start">{t('admin.database.compareExtra')}</th>
                  </tr>
                </thead>
                <tbody className="text-foreground">
                  <tr className="border-t border-border">
                    <td className="p-2">{t('admin.database.compareTables')}</td>
                    <td className="p-2">{result.sourceTables}</td>
                    <td className="p-2">{result.targetTables}</td>
                    <td className="p-2">{result.tables.missingOnTarget.length}</td>
                    <td className="p-2">{result.tables.extraOnTarget.length}</td>
                  </tr>
                  {result.sections.map(s => (
                    <tr key={s.key} className="border-t border-border">
                      <td className="p-2">{t(`admin.database.compareKey_${s.key}` as TranslationKey)}</td>
                      <td className="p-2">{s.source}</td>
                      <td className="p-2">{s.target}</td>
                      <td className="p-2">{s.missingOnTarget.length}</td>
                      <td className="p-2">{s.extraOnTarget.length}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <td className="p-2">{t('admin.database.compareRows')}</td>
                    <td className="p-2">{result.tables.sourceRows.toLocaleString()}</td>
                    <td className="p-2">{result.tables.targetRows.toLocaleString()}</td>
                    <td className="p-2">—</td>
                    <td className="p-2">—</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <DiffList title={t('admin.database.compareMissingTables')} items={result.tables.missingOnTarget} />
            <DiffList title={t('admin.database.compareExtraTables')} items={result.tables.extraOnTarget} />
            {result.sections.map(s => (
              <div key={`d-${s.key}`} className="space-y-2">
                <DiffList
                  title={`${t(`admin.database.compareKey_${s.key}` as TranslationKey)} — ${t('admin.database.compareMissing')}`}
                  items={s.missingOnTarget}
                />
                <DiffList
                  title={`${t(`admin.database.compareKey_${s.key}` as TranslationKey)} — ${t('admin.database.compareExtra')}`}
                  items={s.extraOnTarget}
                />
              </div>
            ))}
            <DiffList
              title={t('admin.database.compareMismatchedTables')}
              items={result.tables.mismatched.map(m => {
                const parts: string[] = [`rows ${m.sourceRows} → ${m.targetRows}`];
                if (m.missingColumns.length) parts.push(`-cols: ${m.missingColumns.join(',')}`);
                if (m.extraColumns.length) parts.push(`+cols: ${m.extraColumns.join(',')}`);
                for (const tm of m.typeMismatches) parts.push(`${tm.column}: ${tm.source} → ${tm.target}`);
                return `${m.table} — ${parts.join(' | ')}`;
              })}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}


export default function AdminDatabasePage() {
  const { t, dir } = useTranslation();
  const isRtl = dir === 'rtl';

  return (
    <div dir={dir} className="space-y-6 text-start">
      <div className={cn('flex items-center gap-3', isRtl && 'flex-row-reverse justify-end')}>
        <Database className="h-6 w-6 text-admin-accent" />
        <h1 className="text-2xl font-bold text-foreground">{t('admin.database.title')}</h1>
      </div>

      <Tabs defaultValue="backup" dir={dir}>
        <TabsList className={cn('bg-muted', isRtl && 'flex-row-reverse')}>
          <TabsTrigger value="backup" className={cn('gap-1.5 data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground', isRtl && 'flex-row-reverse')}>
            <Download className="h-3.5 w-3.5" />
            {t('admin.database.backupTab')}
          </TabsTrigger>
          <TabsTrigger value="migration" className={cn('gap-1.5 data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground', isRtl && 'flex-row-reverse')}>
            <ArrowRightLeft className="h-3.5 w-3.5" />
            {t('admin.database.migrationTab')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="backup">
          <BackupTab />
        </TabsContent>

        <TabsContent value="migration">
          <MigrationTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
