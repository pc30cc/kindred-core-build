import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Database, Download, Clock, HardDrive,
  Cloud, Server, FolderSync, CalendarDays, CalendarRange,
  Calendar, ArrowRightLeft,
  AlertCircle, CheckCircle, Loader2, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n';

interface BackupRecord {
  id: string;
  name: string;
  size: string;
  createdAt: string;
  destination: string;
  status: 'completed' | 'failed' | 'in_progress';
  type: 'manual' | 'scheduled';
}

const mockBackups: BackupRecord[] = [
  { id: '1', name: 'backup_2026-04-14_manual.sql.gz', size: '24.5 MB', createdAt: '2026-04-14T10:30:00Z', destination: 'local', status: 'completed', type: 'manual' },
  { id: '2', name: 'backup_2026-04-13_daily.sql.gz', size: '24.1 MB', createdAt: '2026-04-13T03:00:00Z', destination: 'cdn', status: 'completed', type: 'scheduled' },
  { id: '3', name: 'backup_2026-04-12_daily.sql.gz', size: '23.8 MB', createdAt: '2026-04-12T03:00:00Z', destination: 'ftp', status: 'completed', type: 'scheduled' },
];

function BackupTab() {
  const { t } = useTranslation();
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [schedule, setSchedule] = useState('daily');
  const [destination, setDestination] = useState('local');
  const [ftpHost, setFtpHost] = useState('');
  const [ftpPort, setFtpPort] = useState('21');
  const [ftpUser, setFtpUser] = useState('');
  const [ftpPass, setFtpPass] = useState('');
  const [ftpPath, setFtpPath] = useState('/backups');
  const [cdnProvider, setCdnProvider] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');

  const handleManualBackup = async () => {
    setIsBackingUp(true);
    await new Promise(r => setTimeout(r, 2000));
    setIsBackingUp(false);
    toast.success(t('admin.database.backupSuccess'));
  };

  const handleSaveAutoConfig = () => {
    toast.success(t('admin.database.settingsSaved'));
  };

  const statusLabel = (s: string) =>
    s === 'completed' ? t('admin.database.completed')
    : s === 'failed' ? t('admin.database.failed')
    : t('admin.database.inProgress');

  const statusColor = (s: string) =>
    s === 'completed' ? 'bg-success/20 text-success'
    : s === 'failed' ? 'bg-destructive/20 text-destructive'
    : 'bg-warning/20 text-warning';

  const destLabel = (d: string) =>
    d === 'cdn' ? 'CDN' : d === 'ftp' ? 'FTP' : t('admin.database.local');

  return (
    <div className="space-y-6">
      <Card className="bg-admin-card border-admin-border">
        <CardHeader>
          <CardTitle className="text-admin-foreground text-sm flex items-center gap-2">
            <Download className="h-4 w-4" />
            {t('admin.database.manualBackup')}
          </CardTitle>
          <CardDescription className="text-admin-muted-foreground">{t('admin.database.manualBackupDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger className="w-48 bg-admin-input border-admin-border text-admin-foreground">
                <SelectValue placeholder={t('admin.database.destination')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t('admin.database.local')}</SelectItem>
                <SelectItem value="cdn">{t('admin.database.cdnProvider')}</SelectItem>
                <SelectItem value="ftp">{t('admin.database.privateFtp')}</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleManualBackup} disabled={isBackingUp} className="gap-2">
              {isBackingUp ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {t('admin.database.backingUp')}</>
              ) : (
                <><Download className="h-4 w-4" /> {t('admin.database.startBackup')}</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-admin-card border-admin-border">
        <CardHeader>
          <CardTitle className="text-admin-foreground text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {t('admin.database.autoBackup')}
          </CardTitle>
          <CardDescription className="text-admin-muted-foreground">{t('admin.database.autoBackupDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-admin-foreground">{t('admin.database.enableAutoBackup')}</p>
              <p className="text-xs text-admin-muted-foreground">{t('admin.database.autoBackupHint')}</p>
            </div>
            <Switch checked={autoEnabled} onCheckedChange={setAutoEnabled} />
          </div>

          {autoEnabled && (
            <>
              <Separator className="bg-admin-border" />

              <div className="space-y-2">
                <Label className="text-admin-muted-foreground">{t('admin.database.schedule')}</Label>
                <div className="flex gap-2">
                  {([
                    { value: 'daily', label: t('admin.database.daily'), icon: CalendarDays },
                    { value: 'weekly', label: t('admin.database.weekly'), icon: CalendarRange },
                    { value: 'monthly', label: t('admin.database.monthly'), icon: Calendar },
                  ] as const).map(s => (
                    <Button
                      key={s.value}
                      variant={schedule === s.value ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSchedule(s.value)}
                      className="gap-1.5"
                    >
                      <s.icon className="h-3.5 w-3.5" />
                      {s.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-admin-muted-foreground">{t('admin.database.destination')}</Label>
                <Select value={destination} onValueChange={setDestination}>
                  <SelectTrigger className="bg-admin-input border-admin-border text-admin-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cdn">
                      <span className="flex items-center gap-2"><Cloud className="h-3.5 w-3.5" /> {t('admin.database.cdnProvider')}</span>
                    </SelectItem>
                    <SelectItem value="ftp">
                      <span className="flex items-center gap-2"><Server className="h-3.5 w-3.5" /> {t('admin.database.privateFtp')}</span>
                    </SelectItem>
                    <SelectItem value="local">
                      <span className="flex items-center gap-2"><HardDrive className="h-3.5 w-3.5" /> {t('admin.database.local')}</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {destination === 'cdn' && (
                <div className="space-y-3 rounded-md border border-admin-border p-4">
                  <p className="text-xs text-admin-muted-foreground font-medium">{t('admin.database.cdnProvider')}</p>
                  <Select value={cdnProvider} onValueChange={setCdnProvider}>
                    <SelectTrigger className="bg-admin-input border-admin-border text-admin-foreground">
                      <SelectValue placeholder={t('admin.database.selectCdnProvider')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bunnycdn">BunnyCDN</SelectItem>
                      <SelectItem value="arvancloud">ArvanCloud</SelectItem>
                      <SelectItem value="s3">S3 Compatible</SelectItem>
                      <SelectItem value="cloudflare">Cloudflare R2</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-admin-muted-foreground">{t('admin.database.cdnConfigHint')}</p>
                </div>
              )}

              {destination === 'ftp' && (
                <div className="space-y-3 rounded-md border border-admin-border p-4">
                  <p className="text-xs text-admin-muted-foreground font-medium">{t('admin.database.ftpSettings')}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-admin-muted-foreground">{t('admin.database.host')}</Label>
                      <Input value={ftpHost} onChange={e => setFtpHost(e.target.value)} placeholder="ftp.example.com" className="bg-admin-input border-admin-border text-admin-foreground" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-admin-muted-foreground">{t('admin.database.port')}</Label>
                      <Input value={ftpPort} onChange={e => setFtpPort(e.target.value)} placeholder="21" className="bg-admin-input border-admin-border text-admin-foreground" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-admin-muted-foreground">{t('admin.database.username')}</Label>
                      <Input value={ftpUser} onChange={e => setFtpUser(e.target.value)} placeholder="backup_user" className="bg-admin-input border-admin-border text-admin-foreground" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-admin-muted-foreground">{t('admin.database.password')}</Label>
                      <Input type="password" value={ftpPass} onChange={e => setFtpPass(e.target.value)} className="bg-admin-input border-admin-border text-admin-foreground" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-admin-muted-foreground">{t('admin.database.savePath')}</Label>
                    <Input value={ftpPath} onChange={e => setFtpPath(e.target.value)} className="bg-admin-input border-admin-border text-admin-foreground" />
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-admin-muted-foreground">{t('admin.database.retentionDays')}</Label>
                <Input type="number" value={retentionDays} onChange={e => setRetentionDays(e.target.value)} className="w-32 bg-admin-input border-admin-border text-admin-foreground" />
              </div>

              <Button onClick={handleSaveAutoConfig} className="gap-2">
                <CheckCircle className="h-4 w-4" />
                {t('admin.database.saveSettings')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="bg-admin-card border-admin-border">
        <CardHeader>
          <CardTitle className="text-admin-foreground text-sm flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            {t('admin.database.backupHistory')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {mockBackups.map(b => (
              <div key={b.id} className="flex items-center justify-between rounded-md border border-admin-border px-4 py-3">
                <div className="flex items-center gap-3">
                  <Database className="h-4 w-4 text-admin-muted-foreground" />
                  <div>
                    <p className="text-sm text-admin-foreground font-mono">{b.name}</p>
                    <p className="text-xs text-admin-muted-foreground">
                      {b.size} • {new Date(b.createdAt).toLocaleDateString()} • {destLabel(b.destination)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={statusColor(b.status)}>{statusLabel(b.status)}</Badge>
                  <Badge variant="outline" className="text-admin-muted-foreground border-admin-border">
                    {b.type === 'manual' ? t('admin.database.manual') : t('admin.database.scheduled')}
                  </Badge>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-admin-muted-foreground hover:text-admin-foreground">
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-admin-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MigrationTab() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card className="bg-admin-card border-admin-border">
        <CardHeader>
          <CardTitle className="text-admin-foreground text-sm flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            {t('admin.database.migrationTitle')}
          </CardTitle>
          <CardDescription className="text-admin-muted-foreground">{t('admin.database.migrationDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3 rounded-md border border-admin-border p-4">
            <p className="text-xs font-medium text-admin-muted-foreground">{t('admin.database.sourceDb')}</p>
            <div className="grid grid-cols-2 gap-3">
              {['Host', 'Port', 'Database', 'User'].map(field => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs text-admin-muted-foreground">{field}</Label>
                  <Input placeholder={field.toLowerCase()} className="bg-admin-input border-admin-border text-admin-foreground" disabled />
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-center">
            <ArrowRightLeft className="h-6 w-6 text-admin-muted-foreground" />
          </div>

          <div className="space-y-3 rounded-md border border-admin-border p-4">
            <p className="text-xs font-medium text-admin-muted-foreground">{t('admin.database.targetDb')}</p>
            <div className="grid grid-cols-2 gap-3">
              {['Host', 'Port', 'Database', 'User'].map(field => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs text-admin-muted-foreground">{field}</Label>
                  <Input placeholder={field.toLowerCase()} className="bg-admin-input border-admin-border text-admin-foreground" disabled />
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-md border border-warning/30 bg-warning/5 p-3">
            <AlertCircle className="h-5 w-5 text-warning shrink-0" />
            <p className="text-xs text-warning">{t('admin.database.migrationPending')}</p>
          </div>

          <Button disabled className="gap-2">
            <FolderSync className="h-4 w-4" />
            {t('admin.database.startMigration')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminDatabasePage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Database className="h-6 w-6 text-admin-accent" />
        <h1 className="text-2xl font-bold text-admin-foreground">{t('admin.database.title')}</h1>
      </div>

      <Tabs defaultValue="backup">
        <TabsList className="bg-admin-muted">
          <TabsTrigger value="backup" className="gap-1.5 data-[state=active]:bg-admin-sidebar-active data-[state=active]:text-admin-foreground">
            <Download className="h-3.5 w-3.5" />
            {t('admin.database.backupTab')}
          </TabsTrigger>
          <TabsTrigger value="migration" className="gap-1.5 data-[state=active]:bg-admin-sidebar-active data-[state=active]:text-admin-foreground">
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
