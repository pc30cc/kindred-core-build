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
  Database, Download, Upload, Clock, HardDrive,
  Cloud, Server, FolderSync, CalendarDays, CalendarRange,
  Calendar, Play, Pause, Trash2, RefreshCw, ArrowRightLeft,
  AlertCircle, CheckCircle, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────────

interface BackupRecord {
  id: string;
  name: string;
  size: string;
  createdAt: string;
  destination: string;
  status: 'completed' | 'failed' | 'in_progress';
  type: 'manual' | 'scheduled';
}

// ─── Mock data (will be replaced by real API when server is deployed) ─

const mockBackups: BackupRecord[] = [
  { id: '1', name: 'backup_2026-04-14_manual.sql.gz', size: '24.5 MB', createdAt: '2026-04-14T10:30:00Z', destination: 'local', status: 'completed', type: 'manual' },
  { id: '2', name: 'backup_2026-04-13_daily.sql.gz', size: '24.1 MB', createdAt: '2026-04-13T03:00:00Z', destination: 'cdn', status: 'completed', type: 'scheduled' },
  { id: '3', name: 'backup_2026-04-12_daily.sql.gz', size: '23.8 MB', createdAt: '2026-04-12T03:00:00Z', destination: 'ftp', status: 'completed', type: 'scheduled' },
];

// ─── Backup Tab ──────────────────────────────────────────────────

function BackupTab() {
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
    // Will call POST /api/admin/database/backup when server is deployed
    await new Promise(r => setTimeout(r, 2000));
    setIsBackingUp(false);
    toast.success('بک‌آپ دستی با موفقیت ایجاد شد');
  };

  const handleSaveAutoConfig = () => {
    // Will call POST /api/admin/database/backup/config
    toast.success('تنظیمات بک‌آپ خودکار ذخیره شد');
  };

  return (
    <div className="space-y-6">
      {/* Manual Backup */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <Download className="h-4 w-4" />
            بک‌آپ دستی
          </CardTitle>
          <CardDescription>یک بک‌آپ فوری از دیتابیس بگیرید</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger className="w-48 bg-slate-800 border-slate-700">
                <SelectValue placeholder="محل ذخیره" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">سرور محلی</SelectItem>
                <SelectItem value="cdn">CDN Provider</SelectItem>
                <SelectItem value="ftp">FTP خصوصی</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={handleManualBackup}
              disabled={isBackingUp}
              className="gap-2"
            >
              {isBackingUp ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> در حال بک‌آپ...</>
              ) : (
                <><Download className="h-4 w-4" /> شروع بک‌آپ</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Automatic Backup Config */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            بک‌آپ خودکار
          </CardTitle>
          <CardDescription>زمان‌بندی بک‌آپ خودکار به CDN یا FTP</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-200">فعال‌سازی بک‌آپ خودکار</p>
              <p className="text-xs text-slate-500">بک‌آپ‌ها به صورت خودکار طبق زمان‌بندی اجرا می‌شوند</p>
            </div>
            <Switch checked={autoEnabled} onCheckedChange={setAutoEnabled} />
          </div>

          {autoEnabled && (
            <>
              <Separator className="bg-slate-700" />

              {/* Schedule */}
              <div className="space-y-2">
                <Label className="text-slate-300">زمان‌بندی</Label>
                <div className="flex gap-2">
                  {[
                    { value: 'daily', label: 'روزانه', icon: CalendarDays },
                    { value: 'weekly', label: 'هفتگی', icon: CalendarRange },
                    { value: 'monthly', label: 'ماهیانه', icon: Calendar },
                  ].map(s => (
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

              {/* Destination */}
              <div className="space-y-2">
                <Label className="text-slate-300">مقصد بک‌آپ</Label>
                <Select value={destination} onValueChange={setDestination}>
                  <SelectTrigger className="bg-slate-800 border-slate-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cdn">
                      <span className="flex items-center gap-2"><Cloud className="h-3.5 w-3.5" /> CDN Provider</span>
                    </SelectItem>
                    <SelectItem value="ftp">
                      <span className="flex items-center gap-2"><Server className="h-3.5 w-3.5" /> FTP خصوصی</span>
                    </SelectItem>
                    <SelectItem value="local">
                      <span className="flex items-center gap-2"><HardDrive className="h-3.5 w-3.5" /> سرور محلی</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* CDN Config */}
              {destination === 'cdn' && (
                <div className="space-y-3 rounded-md border border-slate-700 p-4">
                  <p className="text-xs text-slate-400 font-medium">اتصال به CDN Provider فعال</p>
                  <Select value={cdnProvider} onValueChange={setCdnProvider}>
                    <SelectTrigger className="bg-slate-800 border-slate-700">
                      <SelectValue placeholder="انتخاب CDN Provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bunnycdn">BunnyCDN</SelectItem>
                      <SelectItem value="arvancloud">ArvanCloud</SelectItem>
                      <SelectItem value="s3">S3 Compatible</SelectItem>
                      <SelectItem value="cloudflare">Cloudflare R2</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">
                    از تنظیمات CDN در بخش Providers استفاده می‌شود
                  </p>
                </div>
              )}

              {/* FTP Config */}
              {destination === 'ftp' && (
                <div className="space-y-3 rounded-md border border-slate-700 p-4">
                  <p className="text-xs text-slate-400 font-medium">تنظیمات FTP</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-slate-400">Host</Label>
                      <Input value={ftpHost} onChange={e => setFtpHost(e.target.value)} placeholder="ftp.example.com" className="bg-slate-800 border-slate-700" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-slate-400">Port</Label>
                      <Input value={ftpPort} onChange={e => setFtpPort(e.target.value)} placeholder="21" className="bg-slate-800 border-slate-700" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-slate-400">Username</Label>
                      <Input value={ftpUser} onChange={e => setFtpUser(e.target.value)} placeholder="backup_user" className="bg-slate-800 border-slate-700" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-slate-400">Password</Label>
                      <Input type="password" value={ftpPass} onChange={e => setFtpPass(e.target.value)} className="bg-slate-800 border-slate-700" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-slate-400">مسیر ذخیره</Label>
                    <Input value={ftpPath} onChange={e => setFtpPath(e.target.value)} className="bg-slate-800 border-slate-700" />
                  </div>
                </div>
              )}

              {/* Retention */}
              <div className="space-y-2">
                <Label className="text-slate-300">مدت نگهداری بک‌آپ (روز)</Label>
                <Input
                  type="number"
                  value={retentionDays}
                  onChange={e => setRetentionDays(e.target.value)}
                  className="w-32 bg-slate-800 border-slate-700"
                />
              </div>

              <Button onClick={handleSaveAutoConfig} className="gap-2">
                <CheckCircle className="h-4 w-4" />
                ذخیره تنظیمات
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Backup History */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            تاریخچه بک‌آپ‌ها
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {mockBackups.map(b => (
              <div key={b.id} className="flex items-center justify-between rounded-md border border-slate-700 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Database className="h-4 w-4 text-slate-400" />
                  <div>
                    <p className="text-sm text-slate-200 font-mono">{b.name}</p>
                    <p className="text-xs text-slate-500">
                      {b.size} • {new Date(b.createdAt).toLocaleString('fa-IR')} •{' '}
                      {b.destination === 'cdn' ? 'CDN' : b.destination === 'ftp' ? 'FTP' : 'محلی'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    className={
                      b.status === 'completed'
                        ? 'bg-green-900 text-green-300'
                        : b.status === 'failed'
                        ? 'bg-red-900 text-red-300'
                        : 'bg-yellow-900 text-yellow-300'
                    }
                  >
                    {b.status === 'completed' ? 'موفق' : b.status === 'failed' ? 'ناموفق' : 'در حال اجرا'}
                  </Badge>
                  <Badge variant="outline" className="text-slate-400 border-slate-600">
                    {b.type === 'manual' ? 'دستی' : 'خودکار'}
                  </Badge>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-white">
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-red-400">
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

// ─── Migration Tab ───────────────────────────────────────────────

function MigrationTab() {
  return (
    <div className="space-y-6">
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            انتقال دیتابیس به دیتابیس
          </CardTitle>
          <CardDescription>انتقال مستقیم داده‌ها بین دو دیتابیس</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Source */}
          <div className="space-y-3 rounded-md border border-slate-700 p-4">
            <p className="text-xs font-medium text-slate-400">دیتابیس مبدا</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Host</Label>
                <Input placeholder="db.source.com" className="bg-slate-800 border-slate-700" disabled />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Port</Label>
                <Input placeholder="5432" className="bg-slate-800 border-slate-700" disabled />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Database</Label>
                <Input placeholder="postgres" className="bg-slate-800 border-slate-700" disabled />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">User</Label>
                <Input placeholder="postgres" className="bg-slate-800 border-slate-700" disabled />
              </div>
            </div>
          </div>

          <div className="flex justify-center">
            <ArrowRightLeft className="h-6 w-6 text-slate-500" />
          </div>

          {/* Target */}
          <div className="space-y-3 rounded-md border border-slate-700 p-4">
            <p className="text-xs font-medium text-slate-400">دیتابیس مقصد</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Host</Label>
                <Input placeholder="db.target.com" className="bg-slate-800 border-slate-700" disabled />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Port</Label>
                <Input placeholder="5432" className="bg-slate-800 border-slate-700" disabled />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Database</Label>
                <Input placeholder="postgres" className="bg-slate-800 border-slate-700" disabled />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">User</Label>
                <Input placeholder="postgres" className="bg-slate-800 border-slate-700" disabled />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-md border border-yellow-800 bg-yellow-950/30 p-3">
            <AlertCircle className="h-5 w-5 text-yellow-500 shrink-0" />
            <p className="text-xs text-yellow-300">
              این بخش در حال توسعه است و به زودی تکمیل خواهد شد. قابلیت انتقال مستقیم دیتابیس بین سرورها در نسخه بعدی فعال می‌شود.
            </p>
          </div>

          <Button disabled className="gap-2">
            <FolderSync className="h-4 w-4" />
            شروع انتقال (به زودی)
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────

export default function AdminDatabasePage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Database className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold text-white">مدیریت دیتابیس</h1>
      </div>

      <Tabs defaultValue="backup" dir="rtl">
        <TabsList className="bg-slate-800">
          <TabsTrigger value="backup" className="gap-1.5 data-[state=active]:bg-slate-700">
            <Download className="h-3.5 w-3.5" />
            بک‌آپ
          </TabsTrigger>
          <TabsTrigger value="migration" className="gap-1.5 data-[state=active]:bg-slate-700">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            انتقال دیتابیس
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
