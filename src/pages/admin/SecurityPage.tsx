import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Shield, AlertTriangle, Ban, Activity, Eye, Lock,
  CheckCircle, XCircle, Clock, TrendingUp
} from 'lucide-react';
import { formatPattern as format } from '@/lib/date';
import {
  useSecurityStats,
  useSecurityEvents,
  useBlockedIPs,
  useBlockIP,
  useUnblockIP,
  useResolveSecurityEvent,
} from '@/hooks/useSecurity';
import { useTranslation } from '@/i18n';

const severityColor: Record<string, string> = {
  info: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  warn: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
  critical: 'bg-red-600/30 text-red-300 border-red-600/50',
};

export default function AdminSecurityPage() {
  const { t } = useTranslation();
  const { data: stats, isLoading: statsLoading } = useSecurityStats();
  const { data: events, isLoading: eventsLoading } = useSecurityEvents(200);
  const { data: blockedIPs } = useBlockedIPs();
  const blockIP = useBlockIP();
  const unblockIP = useUnblockIP();
  const resolveEvent = useResolveSecurityEvent();

  const [blockIPInput, setBlockIPInput] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const eventTypeLabels: Record<string, string> = {
    login_failed: t('admin.security.eventTypes.loginFailed' as any), rate_limited: t('admin.security.eventTypes.rateLimited' as any),
    captcha_failed: t('admin.security.eventTypes.captchaFailed' as any), ip_blocked: t('admin.security.eventTypes.ipBlocked' as any),
    brute_force: t('admin.security.eventTypes.bruteForce' as any), abuse_detected: t('admin.security.eventTypes.abuseDetected' as any),
    suspicious_activity: t('admin.security.eventTypes.suspiciousActivity' as any),
  };

  const handleBlockIP = () => {
    if (!blockIPInput.trim() || !blockReason.trim()) return;
    blockIP.mutate({ ip: blockIPInput.trim(), reason: blockReason.trim() });
    setBlockIPInput('');
    setBlockReason('');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('admin.security.title' as any)}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t('admin.security.subtitle' as any)}
          </p>
        </div>
        <Badge variant="outline" className="gap-1 border-border text-muted-foreground">
          <Activity className="h-3 w-3" />
          {t('admin.security.liveMonitoring' as any)}
        </Badge>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        <StatCard icon={<XCircle className="h-4 w-4 text-red-400" />} label={t('admin.security.stats.failedLogins' as any)} value={stats?.failed_logins_24h ?? '—'} />
        <StatCard icon={<Clock className="h-4 w-4 text-yellow-400" />} label={t('admin.security.stats.rateLimited' as any)} value={stats?.rate_limited_24h ?? '—'} />
        <StatCard icon={<Shield className="h-4 w-4 text-orange-400" />} label={t('admin.security.stats.captchaFailed' as any)} value={stats?.captcha_failed_24h ?? '—'} />
        <StatCard icon={<Ban className="h-4 w-4 text-red-500" />} label={t('admin.security.stats.blockedIps' as any)} value={stats?.blocked_ips ?? '—'} />
        <StatCard icon={<AlertTriangle className="h-4 w-4 text-red-300" />} label={t('admin.security.stats.unresolved' as any)} value={stats?.unresolved_events ?? '—'} />
      </div>

      {stats && (stats.brute_force_24h > 0 || stats.abuse_detected_24h > 0 || stats.critical_events_24h > 0) && (
        <Card className="border-red-500/50 bg-red-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
            <div className="text-sm text-foreground">
              <strong className="text-red-400">{t('admin.security.threats.title' as any)}</strong>{' '}
              {stats.brute_force_24h > 0 && <span>{t('admin.security.threats.bruteForce' as any, { count: stats.brute_force_24h })} </span>}
              {stats.abuse_detected_24h > 0 && <span>{t('admin.security.threats.abuse' as any, { count: stats.abuse_detected_24h })} </span>}
              {stats.critical_events_24h > 0 && <span>{t('admin.security.threats.critical' as any, { count: stats.critical_events_24h })}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="events">
        <TabsList className="bg-muted">
          <TabsTrigger value="events" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">{t('admin.security.tabs.events' as any)}</TabsTrigger>
          <TabsTrigger value="blocked" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">{t('admin.security.tabs.blocked' as any, { count: blockedIPs?.length || 0 })}</TabsTrigger>
          <TabsTrigger value="config" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">{t('admin.security.tabs.config' as any)}</TabsTrigger>
        </TabsList>

        {/* Security Events Tab */}
        <TabsContent value="events">
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-muted-foreground">{t('admin.common.time' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.event' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.severity' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">IP</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.email' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.endpoint' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.status' as any)}</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eventsLoading && (
                    <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">{t('admin.common.loading' as any)}</TableCell></TableRow>
                  )}
                  {!eventsLoading && (!events || events.length === 0) && (
                    <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      <Shield className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      {t('admin.security.emptyEvents' as any)}
                    </TableCell></TableRow>
                  )}
                  {events?.map(ev => (
                    <TableRow key={ev.id} className="border-border hover:bg-muted/50">
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {ev.created_at ? format(new Date(ev.created_at), 'MM-dd HH:mm:ss') : '—'}
                      </TableCell>
                      <TableCell className="text-sm font-medium text-foreground">
                        {eventTypeLabels[ev.event_type] || ev.event_type}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={severityColor[ev.severity] || ''}>
                          {t(`admin.security.severities.${ev.severity}` as any)}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-foreground">{ev.ip_address || '—'}</TableCell>
                      <TableCell className="text-xs text-foreground">{ev.user_email || '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{ev.endpoint || '—'}</TableCell>
                      <TableCell>
                        {ev.resolved ? (
                          <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/30">
                            <CheckCircle className="h-3 w-3 me-1" /> {t('admin.security.resolved' as any)}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-yellow-500/10 text-yellow-400 border-yellow-500/30">
                            <Eye className="h-3 w-3 me-1" /> {t('admin.security.open' as any)}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {!ev.resolved && (ev.severity === 'error' || ev.severity === 'critical') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => resolveEvent.mutate(ev.id)}
                            disabled={resolveEvent.isPending}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {t('admin.security.resolve' as any)}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Blocked IPs Tab */}
        <TabsContent value="blocked">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2 text-foreground">
                <Ban className="h-4 w-4" /> {t('admin.security.blocklist.title' as any)}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder={t('admin.security.blocklist.ipPlaceholder' as any)}
                  value={blockIPInput}
                  onChange={e => setBlockIPInput(e.target.value)}
                  className="max-w-[200px] bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
                <Input
                  placeholder={t('admin.security.blocklist.reason' as any)}
                  value={blockReason}
                  onChange={e => setBlockReason(e.target.value)}
                  className="max-w-[300px] bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
                <Button onClick={handleBlockIP} disabled={blockIP.isPending} size="sm">
                  {t('admin.security.blocklist.block' as any)}
                </Button>
              </div>

              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-muted-foreground">{t('admin.security.blocklist.ip' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.blocklist.reason' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.blocklist.blockedAt' as any)}</TableHead>
                    <TableHead className="text-muted-foreground">{t('admin.security.blocklist.expires' as any)}</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!blockedIPs || blockedIPs.length === 0) && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t('admin.security.blocklist.empty' as any)}</TableCell></TableRow>
                  )}
                  {blockedIPs?.map(ip => (
                    <TableRow key={ip.id} className="border-border hover:bg-muted/50">
                      <TableCell className="font-mono text-sm text-foreground">{ip.ip_address}</TableCell>
                      <TableCell className="text-sm text-foreground">{ip.reason}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {ip.created_at ? format(new Date(ip.created_at), 'yyyy-MM-dd HH:mm') : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-foreground">
                        {ip.blocked_until ? format(new Date(ip.blocked_until), 'yyyy-MM-dd HH:mm') : t('admin.security.blocklist.permanent' as any)}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="destructive" onClick={() => unblockIP.mutate(ip.id)}>
                          {t('admin.security.blocklist.unblock' as any)}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Protection Config Tab */}
        <TabsContent value="config">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center gap-2">
                <Lock className="h-5 w-5 text-admin-accent" />
                <CardTitle className="text-sm text-foreground">{t('admin.security.config.rateLimiting' as any)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label={t('admin.security.config.authEndpoints' as any)} value={t('admin.security.config.authLimit' as any)} />
                <ConfigRow label={t('admin.security.config.emailSending' as any)} value={t('admin.security.config.emailLimit' as any)} />
                <ConfigRow label={t('admin.security.config.widgetEndpoints' as any)} value={t('admin.security.config.widgetLimit' as any)} />
                <ConfigRow label={t('admin.security.config.visitorTracking' as any)} value={t('admin.security.config.visitorLimit' as any)} />
                <ConfigRow label={t('admin.security.config.adminEndpoints' as any)} value={t('admin.security.config.adminLimit' as any)} />
                <ConfigRow label={t('admin.security.config.globalAbuse' as any)} value={t('admin.security.config.globalLimit' as any)} />
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center gap-2">
                <Shield className="h-5 w-5 text-admin-accent" />
                <CardTitle className="text-sm text-foreground">{t('admin.security.config.bruteForceProtection' as any)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label={t('admin.security.config.detectionWindow' as any)} value={t('admin.security.config.fifteenMinutes' as any)} />
                <ConfigRow label={t('admin.security.config.maxFailures' as any)} value={t('admin.security.config.fivePerIdentity' as any)} />
                <ConfigRow label={t('admin.security.config.lockoutBase' as any)} value={t('admin.security.config.fiveMinutes' as any)} />
                <ConfigRow label={t('admin.security.config.lockoutScaling' as any)} value={t('admin.security.config.progressive' as any)} />
                <ConfigRow label={t('admin.security.config.captchaTrigger' as any)} value={t('admin.security.config.afterThree' as any)} />
                <ConfigRow label={t('admin.security.config.ipBlocking' as any)} value={t('admin.security.config.afterAbuse' as any)} />
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center gap-2">
                <Shield className="h-5 w-5 text-green-400" />
                <CardTitle className="text-sm text-foreground">{t('admin.security.config.captchaProtection' as any)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label={t('admin.security.config.provider' as any)} value={t('admin.security.config.turnstile' as any)} />
                <ConfigRow label={t('admin.security.config.fallback' as any)} value="Google reCAPTCHA" />
                <ConfigRow label={t('admin.security.config.enforcedOn' as any)} value={t('admin.security.config.signupLogin' as any)} />
                <ConfigRow label={t('admin.security.config.verification' as any)} value={t('admin.security.config.serverSide' as any)} />
                <ConfigRow label={t('admin.security.config.configSource' as any)} value="app_runtime_config.captcha_provider" />
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center gap-2">
                <Activity className="h-5 w-5 text-admin-accent" />
                <CardTitle className="text-sm text-foreground">{t('admin.security.config.abuseDetection' as any)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label={t('admin.security.config.detection' as any)} value={t('admin.security.config.detectionLimit' as any)} />
                <ConfigRow label={t('admin.common.action' as any)} value={t('admin.security.config.logFlag' as any)} />
                <ConfigRow label={t('admin.security.config.emailAbuse' as any)} value={t('admin.security.config.emailAbuseLimit' as any)} />
                <ConfigRow label={t('admin.security.config.widgetAbuse' as any)} value={t('admin.security.config.widgetLimit' as any)} />
                <ConfigRow label={t('admin.security.config.ipBlocking' as any)} value={t('admin.security.config.manualAutomatic' as any)} />
                <ConfigRow label={t('admin.security.config.cacheTtl' as any)} value={t('admin.security.config.cacheValue' as any)} />
              </CardContent>
            </Card>

            <Card className="bg-card border-border md:col-span-2">
              <CardHeader className="flex flex-row items-center gap-2">
                <TrendingUp className="h-5 w-5 text-admin-accent" />
                <CardTitle className="text-sm text-foreground">{t('admin.security.config.architecture' as any)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label="RLS" value={t('admin.security.config.rlsValue' as any)} />
                <ConfigRow label={t('admin.security.config.adminAccess' as any)} value="has_role() SECURITY DEFINER" />
                <ConfigRow label={t('admin.security.config.session' as any)} value={t('admin.security.config.sessionValue' as any)} />
                <ConfigRow label={t('admin.security.config.serviceRole' as any)} value={t('admin.security.config.serviceRoleValue' as any)} />
                <ConfigRow label={t('admin.security.config.inputValidation' as any)} value={t('admin.security.config.inputValidationValue' as any)} />
                <ConfigRow label="CORS" value={t('admin.security.config.corsValue' as any)} />
                <ConfigRow label={t('admin.security.config.headers' as any)} value={t('admin.security.config.headersValue' as any)} />
                <ConfigRow label={t('admin.security.config.auditLogging' as any)} value={t('admin.security.config.auditValue' as any)} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 flex items-center gap-3">
        {icon}
        <div>
          <p className="text-2xl font-bold text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
