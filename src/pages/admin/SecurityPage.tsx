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

const severityColor: Record<string, string> = {
  info: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  warn: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
  critical: 'bg-red-600/30 text-red-300 border-red-600/50',
};

const eventTypeLabels: Record<string, string> = {
  login_failed: 'Failed Login',
  rate_limited: 'Rate Limited',
  captcha_failed: 'Captcha Failed',
  ip_blocked: 'IP Blocked',
  brute_force: 'Brute Force',
  abuse_detected: 'Abuse Detected',
  suspicious_activity: 'Suspicious Activity',
};

export default function AdminSecurityPage() {
  const { data: stats, isLoading: statsLoading } = useSecurityStats();
  const { data: events, isLoading: eventsLoading } = useSecurityEvents(200);
  const { data: blockedIPs } = useBlockedIPs();
  const blockIP = useBlockIP();
  const unblockIP = useUnblockIP();
  const resolveEvent = useResolveSecurityEvent();

  const [blockIPInput, setBlockIPInput] = useState('');
  const [blockReason, setBlockReason] = useState('');

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
          <h1 className="text-2xl font-bold text-foreground">Security Center</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Real-time security monitoring, threat detection, and access control.
          </p>
        </div>
        <Badge variant="outline" className="gap-1 border-border text-muted-foreground">
          <Activity className="h-3 w-3" />
          Live Monitoring
        </Badge>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        <StatCard icon={<XCircle className="h-4 w-4 text-red-400" />} label="Failed Logins (24h)" value={stats?.failed_logins_24h ?? '—'} />
        <StatCard icon={<Clock className="h-4 w-4 text-yellow-400" />} label="Rate Limited (24h)" value={stats?.rate_limited_24h ?? '—'} />
        <StatCard icon={<Shield className="h-4 w-4 text-orange-400" />} label="Captcha Failed (24h)" value={stats?.captcha_failed_24h ?? '—'} />
        <StatCard icon={<Ban className="h-4 w-4 text-red-500" />} label="Blocked IPs" value={stats?.blocked_ips ?? '—'} />
        <StatCard icon={<AlertTriangle className="h-4 w-4 text-red-300" />} label="Unresolved Critical" value={stats?.unresolved_events ?? '—'} />
      </div>

      {stats && (stats.brute_force_24h > 0 || stats.abuse_detected_24h > 0 || stats.critical_events_24h > 0) && (
        <Card className="border-red-500/50 bg-red-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
            <div className="text-sm text-foreground">
              <strong className="text-red-400">Active Threats Detected:</strong>{' '}
              {stats.brute_force_24h > 0 && <span>{stats.brute_force_24h} brute force attempts. </span>}
              {stats.abuse_detected_24h > 0 && <span>{stats.abuse_detected_24h} abuse incidents. </span>}
              {stats.critical_events_24h > 0 && <span>{stats.critical_events_24h} critical events.</span>}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="events">
        <TabsList className="bg-muted">
          <TabsTrigger value="events" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Security Events</TabsTrigger>
          <TabsTrigger value="blocked" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Blocked IPs ({blockedIPs?.length || 0})</TabsTrigger>
          <TabsTrigger value="config" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Protection Config</TabsTrigger>
        </TabsList>

        {/* Security Events Tab */}
        <TabsContent value="events">
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-muted-foreground">Time</TableHead>
                    <TableHead className="text-muted-foreground">Event</TableHead>
                    <TableHead className="text-muted-foreground">Severity</TableHead>
                    <TableHead className="text-muted-foreground">IP</TableHead>
                    <TableHead className="text-muted-foreground">Email</TableHead>
                    <TableHead className="text-muted-foreground">Endpoint</TableHead>
                    <TableHead className="text-muted-foreground">Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eventsLoading && (
                    <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
                  )}
                  {!eventsLoading && (!events || events.length === 0) && (
                    <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      <Shield className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      No security events recorded yet
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
                          {ev.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-foreground">{ev.ip_address || '—'}</TableCell>
                      <TableCell className="text-xs text-foreground">{ev.user_email || '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{ev.endpoint || '—'}</TableCell>
                      <TableCell>
                        {ev.resolved ? (
                          <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/30">
                            <CheckCircle className="h-3 w-3 mr-1" /> Resolved
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-yellow-500/10 text-yellow-400 border-yellow-500/30">
                            <Eye className="h-3 w-3 mr-1" /> Open
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
                            Resolve
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
                <Ban className="h-4 w-4" /> IP Blocklist
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="IP address (e.g. 192.168.1.1)"
                  value={blockIPInput}
                  onChange={e => setBlockIPInput(e.target.value)}
                  className="max-w-[200px] bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
                <Input
                  placeholder="Reason"
                  value={blockReason}
                  onChange={e => setBlockReason(e.target.value)}
                  className="max-w-[300px] bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
                <Button onClick={handleBlockIP} disabled={blockIP.isPending} size="sm">
                  Block IP
                </Button>
              </div>

              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-muted-foreground">IP Address</TableHead>
                    <TableHead className="text-muted-foreground">Reason</TableHead>
                    <TableHead className="text-muted-foreground">Blocked At</TableHead>
                    <TableHead className="text-muted-foreground">Expires</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!blockedIPs || blockedIPs.length === 0) && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No blocked IPs</TableCell></TableRow>
                  )}
                  {blockedIPs?.map(ip => (
                    <TableRow key={ip.id} className="border-border hover:bg-muted/50">
                      <TableCell className="font-mono text-sm text-foreground">{ip.ip_address}</TableCell>
                      <TableCell className="text-sm text-foreground">{ip.reason}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {ip.created_at ? format(new Date(ip.created_at), 'yyyy-MM-dd HH:mm') : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-foreground">
                        {ip.blocked_until ? format(new Date(ip.blocked_until), 'yyyy-MM-dd HH:mm') : 'Permanent'}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="destructive" onClick={() => unblockIP.mutate(ip.id)}>
                          Unblock
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
                <CardTitle className="text-sm text-foreground">Rate Limiting</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label="Auth endpoints" value="5 req/min per IP" />
                <ConfigRow label="Email sending" value="10 req/min per workspace" />
                <ConfigRow label="Widget endpoints" value="300 req/min per IP" />
                <ConfigRow label="Visitor tracking" value="200 req/min per IP" />
                <ConfigRow label="Admin endpoints" value="30 req/min per IP" />
                <ConfigRow label="Global abuse" value="500 req/5min per IP" />
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center gap-2">
                <Shield className="h-5 w-5 text-admin-accent" />
                <CardTitle className="text-sm text-foreground">Brute Force Protection</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label="Detection window" value="15 minutes" />
                <ConfigRow label="Max failures" value="5 per IP+email" />
                <ConfigRow label="Lockout base" value="5 minutes" />
                <ConfigRow label="Lockout scaling" value="Progressive (2x each lock)" />
                <ConfigRow label="Captcha trigger" value="After 3 failures" />
                <ConfigRow label="IP blocking" value="After persistent abuse" />
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center gap-2">
                <Shield className="h-5 w-5 text-green-400" />
                <CardTitle className="text-sm text-foreground">Captcha Protection</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label="Provider" value="Cloudflare Turnstile (primary)" />
                <ConfigRow label="Fallback" value="Google reCAPTCHA" />
                <ConfigRow label="Enforced on" value="Signup, Login (after failures)" />
                <ConfigRow label="Verification" value="Server-side via edge function" />
                <ConfigRow label="Config source" value="app_runtime_config.captcha_provider" />
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center gap-2">
                <Activity className="h-5 w-5 text-admin-accent" />
                <CardTitle className="text-sm text-foreground">Abuse Detection</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label="Detection" value="500+ requests per 5min" />
                <ConfigRow label="Action" value="Log + flag (auto-block on repeat)" />
                <ConfigRow label="Email abuse" value="10 emails/min per workspace" />
                <ConfigRow label="Widget abuse" value="300 req/min per IP" />
                <ConfigRow label="IP blocking" value="Manual + automatic" />
                <ConfigRow label="Cache TTL" value="60s IP block check" />
              </CardContent>
            </Card>

            <Card className="bg-card border-border md:col-span-2">
              <CardHeader className="flex flex-row items-center gap-2">
                <TrendingUp className="h-5 w-5 text-admin-accent" />
                <CardTitle className="text-sm text-foreground">Security Architecture</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <ConfigRow label="RLS" value="All 23 tables have RLS enabled" />
                <ConfigRow label="Admin access" value="has_role() SECURITY DEFINER checks" />
                <ConfigRow label="Session" value="Supabase JWT + auto-refresh" />
                <ConfigRow label="Service role key" value="Server-side only — never in frontend" />
                <ConfigRow label="Input validation" value="Zod schemas on all API endpoints" />
                <ConfigRow label="CORS" value="Configurable origins, credentials enabled" />
                <ConfigRow label="Headers" value="Helmet.js security headers" />
                <ConfigRow label="Audit logging" value="All security events + provider changes" />
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
