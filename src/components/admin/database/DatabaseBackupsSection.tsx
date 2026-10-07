/**
 * Super Admin → Database → Backup: manual and scheduled database backups
 * (pg_dump) kept on the server, on a storage vendor or on FTP, with their
 * history. API: src/lib/admin-database-backups-api.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  AlertCircle, Calendar, CalendarDays, CalendarRange, CheckCircle, Clock, Cloud, Database, Download,
  HardDrive, Loader2, Lock, PlugZap, RefreshCw, Server, ShieldCheck, Trash2,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  BackupApiError,
  deleteDatabaseBackup,
  downloadDatabaseBackupFile,
  fetchDatabaseBackups,
  runDatabaseBackup,
  saveDatabaseBackupSettings,
  testDatabaseBackupDestination,
  type BackupDestination,
  type BackupFtpInput,
  type BackupRunView,
  type BackupSchedule,
  type BackupSettingsView,
  type DatabaseBackupStatus,
} from '@/lib/admin-database-backups-api';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const POLL_MS = 4000;

interface FormState {
  enabled: boolean;
  schedule: BackupSchedule;
  hourUtc: number;
  destination: BackupDestination;
  storageProvider: string;
  retentionDays: string;
  ftpHost: string;
  ftpPort: string;
  ftpUser: string;
  ftpPass: string;
  ftpPath: string;
  ftpSecure: boolean;
  ftpVerify: boolean;
}

function defaultVendor(status: DatabaseBackupStatus): string {
  const vendors = status.storageProviders;
  return status.settings.storageProvider ?? vendors.find((v) => v.primary)?.name ?? vendors[0]?.name ?? '';
}

function formFrom(settings: BackupSettingsView, vendor: string): FormState {
  return {
    enabled: settings.enabled,
    schedule: settings.schedule,
    hourUtc: settings.hourUtc,
    destination: settings.destination,
    storageProvider: vendor,
    retentionDays: String(settings.retentionDays),
    ftpHost: settings.ftp.host,
    ftpPort: String(settings.ftp.port),
    ftpUser: settings.ftp.username,
    ftpPass: '',
    ftpPath: settings.ftp.path,
    ftpSecure: settings.ftp.secure,
    ftpVerify: settings.ftp.verifyTls,
  };
}

function ftpInput(form: FormState): BackupFtpInput {
  return {
    host: form.ftpHost.trim(),
    port: Number.parseInt(form.ftpPort, 10) || 21,
    username: form.ftpUser.trim(),
    password: form.ftpPass || undefined,
    path: form.ftpPath.trim(),
    secure: form.ftpSecure,
    verifyTls: form.ftpVerify,
  };
}

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function apiError(err: unknown): { code: string; detail?: string } {
  if (err instanceof BackupApiError) return { code: err.code, detail: err.detail };
  return { code: 'request_failed', detail: err instanceof Error ? err.message : undefined };
}

export function DatabaseBackupsSection() {
  const { t, dir } = useTranslation();
  const isRtl = dir === 'rtl';
  const [status, setStatus] = useState<DatabaseBackupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [manualDest, setManualDest] = useState<BackupDestination>('local');
  const [manualVendor, setManualVendor] = useState('');
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ run: BackupRunView; force: boolean; reason?: string } | null>(null);
  const watchedRun = useRef<string | null>(null);
  const initialized = useRef(false);

  const errText = useCallback(
    (code: string, detail?: string) => {
      const key = `admin.database.backups.errors.${code}`;
      const text = t(key as TranslationKey);
      const base = text === key ? `${t('admin.database.opFailed')} (${code})` : text;
      return detail ? `${base} — ${detail}` : base;
    },
    [t],
  );

  const runErrorText = useCallback(
    (error: string | null) => {
      if (!error) return '';
      const m = /^([a-z0-9_]+)(?::\s*([\s\S]*))?$/.exec(error);
      return m ? errText(m[1], m[2]) : error;
    },
    [errText],
  );

  const load = useCallback(async () => {
    try {
      const s = await fetchDatabaseBackups();
      setStatus(s);
      setLoadError(null);
      if (!initialized.current) {
        initialized.current = true;
        const vendor = defaultVendor(s);
        setForm(formFrom(s.settings, vendor));
        setManualDest(s.settings.destination);
        setManualVendor(vendor);
      }
      const watched = watchedRun.current;
      if (watched && !s.runs.some((r) => r.id === watched && r.status === 'running')) {
        watchedRun.current = null;
        const run = s.runs.find((r) => r.id === watched);
        if (run?.status === 'succeeded') toast.success(t('admin.database.backupSuccess'));
        else if (run?.status === 'failed') toast.error(`${t('admin.database.backups.failedToast')}: ${runErrorText(run.error)}`);
      }
    } catch (err) {
      const e = apiError(err);
      setLoadError(errText(e.code, e.detail));
    }
  }, [errText, runErrorText, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const runningId = status?.runningId ?? null;
  useEffect(() => {
    if (!runningId) return undefined;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [runningId, load]);

  const patch = (p: Partial<FormState>) => setForm((f) => (f ? { ...f, ...p } : f));

  const ftpSaved = !!status && !!status.settings.ftp.host && !!status.settings.ftp.username && status.settings.ftp.hasPassword;
  const vendors = status?.storageProviders ?? [];
  const destLabel = (d: BackupDestination | null, provider?: string | null) =>
    d === 'storage'
      ? `${t('admin.database.cdnProvider')}${provider ? ` (${provider})` : ''}`
      : d === 'ftp'
        ? 'FTP'
        : t('admin.database.local');

  const handleManualBackup = async () => {
    setStarting(true);
    try {
      const res = await runDatabaseBackup({
        destination: manualDest,
        storageProvider: manualDest === 'storage' ? manualVendor : null,
      });
      watchedRun.current = res.run.id;
      toast.success(t('admin.database.backups.started'));
      await load();
    } catch (err) {
      const e = apiError(err);
      toast.error(errText(e.code, e.detail));
    } finally {
      setStarting(false);
    }
  };

  const handleSave = async () => {
    if (!form) return;
    const retention = Number.parseInt(form.retentionDays, 10);
    if (!Number.isInteger(retention) || retention < 1 || retention > 3650) {
      toast.error(t('admin.database.backups.errors.invalid_retention'));
      return;
    }
    setSaving(true);
    try {
      const res = await saveDatabaseBackupSettings({
        enabled: form.enabled,
        schedule: form.schedule,
        hourUtc: form.hourUtc,
        destination: form.destination,
        storageProvider: form.destination === 'storage' ? form.storageProvider || null : null,
        retentionDays: retention,
        ftp: ftpInput(form),
      });
      patch({ ftpPass: '', ftpPath: res.settings.ftp.path, ftpHost: res.settings.ftp.host });
      toast.success(t('admin.database.settingsSaved'));
      await load();
    } catch (err) {
      const e = apiError(err);
      toast.error(errText(e.code, e.detail));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!form) return;
    setTesting(true);
    try {
      await testDatabaseBackupDestination({
        destination: form.destination,
        storageProvider: form.destination === 'storage' ? form.storageProvider || null : null,
        ftp: form.destination === 'ftp' ? ftpInput(form) : undefined,
      });
      toast.success(t('admin.database.backups.testOk'));
    } catch (err) {
      const e = apiError(err);
      toast.error(errText(e.code, e.detail));
    } finally {
      setTesting(false);
    }
  };

  const handleDownload = async (run: BackupRunView) => {
    setBusyId(run.id);
    try {
      await downloadDatabaseBackupFile(run.id, `${run.backupId}.dump`);
    } catch (err) {
      const e = apiError(err);
      toast.error(errText(e.code, e.detail));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const { run, force } = confirmDelete;
    setBusyId(run.id);
    try {
      await deleteDatabaseBackup(run.id, force);
      setConfirmDelete(null);
      toast.success(t('admin.database.backups.deleted'));
      await load();
    } catch (err) {
      const e = apiError(err);
      if (e.code === 'backup_artifact_delete_failed' && !force) {
        setConfirmDelete({ run, force: true, reason: e.detail ? runErrorText(e.detail) : undefined });
      } else {
        toast.error(errText(e.code, e.detail));
      }
    } finally {
      setBusyId(null);
    }
  };

  if (!status || !form) {
    return (
      <Card className="bg-card border-border">
        <CardContent className={cn('flex items-center gap-3 py-6 text-sm text-muted-foreground', isRtl && 'flex-row-reverse')}>
          {loadError ? (
            <>
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-start">{t('admin.database.backups.loadFailed')}: {loadError}</span>
              <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                {t('admin.database.backups.retry')}
              </Button>
            </>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('admin.database.working')}
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const warnings: string[] = [];
  if (!status.tools.pgDump || !status.tools.pgRestore) warnings.push(t('admin.database.backups.toolsMissing'));
  if (!status.connection) warnings.push(t('admin.database.backups.connectionMissing'));
  if (status.local.persistent === false) warnings.push(t('admin.database.backups.localNotPersistent', { dir: status.local.dir }));
  if (!status.encryptionReady) warnings.push(t('admin.database.backups.encryptionMissing'));
  const notes: string[] = [];
  if (status.connection?.credential === 'database_url') notes.push(t('admin.database.backups.appCredential'));

  const running = !!status.runningId;
  const manualBlocked =
    running ||
    starting ||
    !status.tools.pgDump ||
    !status.connection ||
    (manualDest === 'storage' && !manualVendor) ||
    (manualDest === 'ftp' && !ftpSaved) ||
    (manualDest !== 'local' && !status.encryptionReady);

  const vendorSelect = (value: string, onChange: (v: string) => void, className?: string) =>
    vendors.length ? (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className={cn('bg-input border-border text-foreground [&>span]:text-start', className)}>
          <SelectValue placeholder={t('admin.database.selectCdnProvider')} />
        </SelectTrigger>
        <SelectContent>
          {vendors.map((v) => (
            <SelectItem key={v.name} value={v.name}>
              {v.name}
              {v.primary ? ` — ${t('admin.database.backups.primary')}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <p className="text-xs text-muted-foreground">{t('admin.database.backups.noStorageVendors')}</p>
    );

  const statusBadge = (r: BackupRunView) => {
    if (r.status === 'running') return <Badge className="bg-warning/20 text-warning">{t('admin.database.inProgress')}</Badge>;
    if (r.status === 'failed') return <Badge className="bg-destructive/20 text-destructive">{t('admin.database.failed')}</Badge>;
    if (r.prunedAt) return <Badge variant="outline" className="text-muted-foreground border-border">{t('admin.database.backups.removed')}</Badge>;
    return <Badge className="bg-success/20 text-success">{t('admin.database.completed')}</Badge>;
  };

  return (
    <>
      {(warnings.length > 0 || notes.length > 0) && (
        <Card className={cn('border', warnings.length ? 'border-warning/50 bg-warning/5' : 'bg-card border-border')}>
          <CardContent className="space-y-2 py-4">
            {warnings.map((w) => (
              <p key={w} className={cn('flex items-start gap-2 text-sm text-foreground text-start', isRtl && 'flex-row-reverse')}>
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>{w}</span>
              </p>
            ))}
            {notes.map((n) => (
              <p key={n} className={cn('flex items-start gap-2 text-xs text-muted-foreground text-start', isRtl && 'flex-row-reverse')}>
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{n}</span>
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className={cn('text-foreground text-sm flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}>
            <Download className="h-4 w-4" />
            {t('admin.database.manualBackup')}
          </CardTitle>
          <CardDescription className="text-muted-foreground text-start">{t('admin.database.manualBackupDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className={cn('flex gap-4', isRtl ? 'flex-col sm:flex-row-reverse sm:items-center' : 'flex-col sm:flex-row sm:items-center')}>
            <Select value={manualDest} onValueChange={(v) => setManualDest(v as BackupDestination)}>
              <SelectTrigger className="w-full sm:w-48 bg-input border-border text-foreground [&>span]:text-start">
                <SelectValue placeholder={t('admin.database.destination')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t('admin.database.local')}</SelectItem>
                <SelectItem value="storage">{t('admin.database.cdnProvider')}</SelectItem>
                <SelectItem value="ftp">{t('admin.database.privateFtp')}</SelectItem>
              </SelectContent>
            </Select>
            {manualDest === 'storage' && vendorSelect(manualVendor, setManualVendor, 'w-full sm:w-56')}
            <Button onClick={() => void handleManualBackup()} disabled={manualBlocked} className={cn('gap-2', isRtl && 'flex-row-reverse')}>
              {running || starting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {t('admin.database.backingUp')}</>
              ) : (
                <><Download className="h-4 w-4" /> {t('admin.database.startBackup')}</>
              )}
            </Button>
          </div>
          {manualDest === 'ftp' && (
            <p className="text-xs text-muted-foreground text-start">
              {ftpSaved ? t('admin.database.backups.ftpUsesSaved') : t('admin.database.backups.ftpNotConfigured')}
            </p>
          )}
          {manualDest !== 'local' && (
            <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground text-start', isRtl && 'flex-row-reverse justify-end')}>
              <Lock className="h-3 w-3" />
              {t('admin.database.backups.encryptedNote')}
            </p>
          )}
          {manualDest === 'local' && (
            <p className="text-xs text-muted-foreground text-start">
              {t('admin.database.backups.localDir', { dir: status.local.dir, free: formatBytes(status.local.freeBytes) })}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className={cn('text-foreground text-sm flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}>
            <Clock className="h-4 w-4" />
            {t('admin.database.autoBackup')}
          </CardTitle>
          <CardDescription className="text-muted-foreground text-start">{t('admin.database.autoBackupDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className={cn('flex items-center justify-between gap-4', isRtl && 'flex-row-reverse')}>
            <div className="text-start">
              <p className="text-sm text-foreground">{t('admin.database.enableAutoBackup')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.database.autoBackupHint')}</p>
            </div>
            <Switch checked={form.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
          </div>

          {status.settings.enabled && status.nextRunAt && (
            <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground text-start', isRtl && 'flex-row-reverse justify-end')}>
              <CalendarDays className="h-3.5 w-3.5" />
              {t('admin.database.backups.nextRun', { time: new Date(status.nextRunAt).toLocaleString() })}
            </p>
          )}

          {form.enabled && (
            <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-end', isRtl && 'sm:flex-row-reverse')}>
              <div className="space-y-2">
                <Label className="text-muted-foreground text-start">{t('admin.database.schedule')}</Label>
                <div className={cn('flex flex-wrap gap-2', isRtl && 'flex-row-reverse')}>
                  {([
                    { value: 'daily', label: t('admin.database.daily'), icon: CalendarDays },
                    { value: 'weekly', label: t('admin.database.weekly'), icon: CalendarRange },
                    { value: 'monthly', label: t('admin.database.monthly'), icon: Calendar },
                  ] as const).map((s) => (
                    <Button
                      key={s.value}
                      variant={form.schedule === s.value ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => patch({ schedule: s.value })}
                      className={cn('gap-1.5', isRtl && 'flex-row-reverse')}
                    >
                      <s.icon className="h-3.5 w-3.5" />
                      {s.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground text-start">{t('admin.database.backups.hourUtc')}</Label>
                <Select value={String(form.hourUtc)} onValueChange={(v) => patch({ hourUtc: Number(v) })}>
                  <SelectTrigger className="w-32 bg-input border-border text-foreground [&>span]:text-start">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={String(h)}>{`${String(h).padStart(2, '0')}:00`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <Separator className="bg-background-border" />

          <div className="space-y-2">
            <Label className="text-muted-foreground text-start">{t('admin.database.destination')}</Label>
            <Select value={form.destination} onValueChange={(v) => patch({ destination: v as BackupDestination })}>
              <SelectTrigger className="bg-input border-border text-foreground [&>span]:text-start">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">
                  <span className={cn('flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}><HardDrive className="h-3.5 w-3.5" /> {t('admin.database.local')}</span>
                </SelectItem>
                <SelectItem value="storage">
                  <span className={cn('flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}><Cloud className="h-3.5 w-3.5" /> {t('admin.database.cdnProvider')}</span>
                </SelectItem>
                <SelectItem value="ftp">
                  <span className={cn('flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}><Server className="h-3.5 w-3.5" /> {t('admin.database.privateFtp')}</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.destination === 'storage' && (
            <div className="space-y-3 rounded-md border border-border p-4 text-start">
              <p className="text-xs text-muted-foreground font-medium">{t('admin.database.cdnProvider')}</p>
              {vendorSelect(form.storageProvider, (v) => patch({ storageProvider: v }))}
              <p className="text-xs text-muted-foreground">{t('admin.database.cdnConfigHint')}</p>
            </div>
          )}

          {form.destination === 'ftp' && (
            <div className="space-y-3 rounded-md border border-border p-4 text-start">
              <p className="text-xs text-muted-foreground font-medium">{t('admin.database.ftpSettings')}</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground text-start">{t('admin.database.host')}</Label>
                  <Input value={form.ftpHost} onChange={(e) => patch({ ftpHost: e.target.value })} placeholder="ftp.example.com" dir="ltr" className="bg-input border-border text-foreground text-start" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground text-start">{t('admin.database.port')}</Label>
                  <Input value={form.ftpPort} onChange={(e) => patch({ ftpPort: e.target.value.replace(/[^0-9]/g, '') })} placeholder="21" dir="ltr" inputMode="numeric" className="bg-input border-border text-foreground text-start" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground text-start">{t('admin.database.username')}</Label>
                  <Input value={form.ftpUser} onChange={(e) => patch({ ftpUser: e.target.value })} placeholder="backup_user" dir="ltr" autoComplete="off" className="bg-input border-border text-foreground text-start" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground text-start">{t('admin.database.password')}</Label>
                  <Input
                    type="password"
                    value={form.ftpPass}
                    onChange={(e) => patch({ ftpPass: e.target.value })}
                    placeholder={status.settings.ftp.hasPassword ? t('admin.database.backups.passwordKeep') : ''}
                    dir="ltr"
                    autoComplete="new-password"
                    className="bg-input border-border text-foreground text-start"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground text-start">{t('admin.database.savePath')}</Label>
                <Input value={form.ftpPath} onChange={(e) => patch({ ftpPath: e.target.value })} placeholder="/webyar-backups" dir="ltr" className="bg-input border-border text-foreground text-start" />
              </div>
              <div className={cn('flex items-center justify-between gap-4', isRtl && 'flex-row-reverse')}>
                <span className="text-sm text-foreground">{t('admin.database.backups.secure')}</span>
                <Switch checked={form.ftpSecure} onCheckedChange={(v) => patch({ ftpSecure: v })} />
              </div>
              {form.ftpSecure && (
                <div className={cn('flex items-center justify-between gap-4', isRtl && 'flex-row-reverse')}>
                  <span className="text-sm text-foreground">{t('admin.database.backups.verifyTls')}</span>
                  <Switch checked={form.ftpVerify} onCheckedChange={(v) => patch({ ftpVerify: v })} />
                </div>
              )}
            </div>
          )}

          {form.destination !== 'local' && (
            <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground text-start', isRtl && 'flex-row-reverse justify-end')}>
              <Lock className="h-3 w-3" />
              {t('admin.database.backups.encryptedNote')}
            </p>
          )}

          <div className="space-y-2">
            <Label className="text-muted-foreground text-start">{t('admin.database.retentionDays')}</Label>
            <Input
              type="number"
              min={1}
              max={3650}
              value={form.retentionDays}
              onChange={(e) => patch({ retentionDays: e.target.value })}
              className="w-32 bg-input border-border text-foreground text-start"
            />
            <p className="text-xs text-muted-foreground text-start">{t('admin.database.backups.retentionHint')}</p>
          </div>

          <div className={cn('flex flex-wrap gap-2', isRtl && 'flex-row-reverse')}>
            <Button onClick={() => void handleSave()} disabled={saving} className={cn('gap-2', isRtl && 'flex-row-reverse')}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              {t('admin.database.saveSettings')}
            </Button>
            <Button variant="outline" onClick={() => void handleTest()} disabled={testing} className={cn('gap-2', isRtl && 'flex-row-reverse')}>
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
              {testing ? t('admin.database.backups.testing') : t('admin.database.backups.testConnection')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className={cn('text-foreground text-sm flex items-center gap-2', isRtl && 'flex-row-reverse justify-end')}>
            <HardDrive className="h-4 w-4" />
            {t('admin.database.backupHistory')}
          </CardTitle>
          <CardDescription className="text-muted-foreground text-start">{t('admin.database.backups.restoreHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {status.runs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-start">{t('admin.database.backups.empty')}</p>
          ) : (
            <div className="space-y-2">
              {status.runs.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    'flex flex-col gap-3 rounded-md border border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between',
                    isRtl && 'lg:flex-row-reverse',
                  )}
                >
                  <div className={cn('flex min-w-0 items-start gap-3 text-start', isRtl && 'flex-row-reverse')}>
                    <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm text-foreground" dir="ltr" data-latin-digits>{r.backupId}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(r.bytes)} • {new Date(r.startedAt).toLocaleString()} • {destLabel(r.destinationType, r.storageProvider)}
                      </p>
                      {r.status === 'failed' && r.error && (
                        <p className="mt-1 break-words text-xs text-destructive">{runErrorText(r.error)}</p>
                      )}
                    </div>
                  </div>
                  <div className={cn('flex flex-wrap items-center gap-2', isRtl && 'flex-row-reverse')}>
                    {statusBadge(r)}
                    <Badge variant="outline" className="text-muted-foreground border-border">
                      {r.trigger === 'schedule' ? t('admin.database.scheduled') : t('admin.database.manual')}
                    </Badge>
                    {r.encrypted && r.status === 'succeeded' && (
                      <Badge variant="outline" className={cn('gap-1 text-muted-foreground border-border', isRtl && 'flex-row-reverse')}>
                        <Lock className="h-3 w-3" />
                        {t('admin.database.backups.encrypted')}
                      </Badge>
                    )}
                    {r.verified && !r.prunedAt && (
                      <Badge variant="outline" className={cn('gap-1 text-success border-success/40', isRtl && 'flex-row-reverse')}>
                        <ShieldCheck className="h-3 w-3" />
                        {t('admin.database.backups.verified')}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      disabled={!r.downloadable || busyId === r.id}
                      onClick={() => void handleDownload(r)}
                      title={t('admin.database.backups.download')}
                      aria-label={t('admin.database.backups.download')}
                    >
                      {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      disabled={r.status === 'running' || busyId === r.id}
                      onClick={() => setConfirmDelete({ run: r, force: false })}
                      title={t('admin.database.backups.delete')}
                      aria-label={t('admin.database.backups.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmDelete !== null} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent dir={dir} className="text-start">
          <DialogHeader>
            <DialogTitle>
              {confirmDelete?.force ? t('admin.database.backups.deleteForceTitle') : t('admin.database.backups.deleteTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirmDelete?.force
                ? t('admin.database.backups.deleteForceBody', { reason: confirmDelete.reason ?? '' })
                : t('admin.database.backups.deleteBody')}
            </DialogDescription>
          </DialogHeader>
          {confirmDelete && <p className="font-mono text-xs text-muted-foreground" dir="ltr" data-latin-digits>{confirmDelete.run.backupId}</p>}
          <DialogFooter className={cn('gap-2', isRtl && 'flex-row-reverse')}>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>{t('admin.database.cancel')}</Button>
            <Button variant="destructive" disabled={busyId !== null} onClick={() => void handleDelete()} className="gap-2">
              {busyId !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {confirmDelete?.force ? t('admin.database.backups.removeFromHistory') : t('admin.database.backups.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
