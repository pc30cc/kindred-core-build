import { useActiveWorkspace } from '@/hooks/useWorkspace';
import {
  useCallCenterCapabilities,
  useCallCenterOverview, useCallCenterSettings, useCallCenterQueue,
  useCallCenterCalls, useCallCenterCallbacks, useCallCenterAgentPresence,
} from '@/hooks/useCallCenter';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  AlertCircle, CheckCircle2, Phone, PhoneCall, Clock,
  PhoneIncoming, PhoneMissed, Users, Activity, TrendingUp,
  ArrowRight, Radio, Headphones, UserCheck, Timer, Flame,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { callbackStatusLabel } from '@/features/calls/callLabels';
import { CallDuration } from '@/features/calls/CallDuration';

function StatCard({ icon: Icon, label, value, tone = 'default' }: { icon: any; label: string; value: React.ReactNode; tone?: 'default' | 'warn' | 'danger' | 'ok' }) {
  const map: Record<string, string> = {
    default: 'bg-card',
    warn: 'bg-amber-500/5 border-amber-500/30',
    danger: 'bg-destructive/5 border-destructive/30',
    ok: 'bg-emerald-500/5 border-emerald-500/30',
  };
  return (
    <Card className={cn('p-4 flex items-start gap-3', map[tone])}>
      <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold leading-tight mt-0.5">{value}</div>
      </div>
    </Card>
  );
}

function waitSeconds(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
}

export default function CallCenterOverviewPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { data: overview } = useCallCenterOverview(workspace?.id);
  const { data: settings } = useCallCenterSettings(workspace?.id);
  const { data: queueData } = useCallCenterQueue(workspace?.id);
  const { data: callsData } = useCallCenterCalls(workspace?.id);
  const { data: callbacksData } = useCallCenterCallbacks(workspace?.id);
  const { data: presenceData } = useCallCenterAgentPresence(workspace?.id);
  const { data: caps } = useCallCenterCapabilities(workspace?.id);
  const callbackOn = caps?.platform_callback_enabled !== false;

  const platformOk = !!settings?.platform?.call_center_enabled;
  const wsEnabled = !!settings?.settings?.enabled;
  const providerReady = !!overview?.provider?.ready;

  let statusTone: 'ok' | 'warn' | 'danger' = 'ok';
  let statusText = t('callCenter.overview.operationsLive');
  if (!platformOk) { statusTone = 'danger'; statusText = t('callCenter.overview.serviceDisabled'); }
  else if (!wsEnabled) { statusTone = 'warn'; statusText = t('callCenter.overview.workspaceOffline'); }
  else if (!providerReady) { statusTone = 'warn'; statusText = t('callCenter.overview.callsServiceDegraded'); }

  const queue = queueData?.queue || [];
  const recentQueue = queue.slice(0, 6);
  const calls = callsData?.calls || [];
  const recentMissed = calls.filter((c) => c.state === 'missed').slice(0, 4);
  const callbacks = callbacksData?.callbacks || [];
  const pendingCallbacks = callbacks.filter((c) => c.status === 'pending' || c.status === 'in_progress').slice(0, 4);

  const presence = presenceData?.presence || [];
  const agentStats = useMemo(() => {
    const available = presence.filter((p) => p.status === 'available').length;
    const busy = presence.filter((p) => p.status === 'busy' || p.active_call_count > 0).length;
    const away = presence.filter((p) => p.status === 'away').length;
    const offline = presence.filter((p) => p.status === 'offline').length;
    const total = presence.length;
    const utilization = total > 0 ? Math.round((busy / total) * 100) : 0;
    return { available, busy, away, offline, total, utilization };
  }, [presence]);

  // SLA metrics
  const slaStats = useMemo(() => {
    const now = Date.now();
    const waits = queue.map((q) => Math.floor((now - new Date(q.created_at).getTime()) / 1000));
    const longest = waits.length > 0 ? Math.max(...waits) : 0;
    const avg = waits.length > 0 ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
    const breached = waits.filter((w) => w > 60).length;
    const todayCompleted = calls.filter((c) => c.state === 'completed');
    const avgHandle = todayCompleted.length > 0
      ? Math.round(todayCompleted.reduce((s, c) => s + (c.duration_seconds || 0), 0) / todayCompleted.length)
      : 0;
    const answered = calls.filter((c) => c.state === 'completed' || c.state === 'in_progress' || c.state === 'active').length;
    const totalToday = overview?.today_calls ?? calls.length;
    const answerRate = totalToday > 0 ? Math.round((answered / totalToday) * 100) : 100;
    return { longest, avg, breached, avgHandle, answerRate };
  }, [queue, calls, overview?.today_calls]);

  return (
    <div className="space-y-6">
      {/* Wallboard header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className={cn(
            'h-10 w-10 rounded-xl flex items-center justify-center',
            statusTone === 'ok' && 'bg-emerald-500/10 text-emerald-500',
            statusTone === 'warn' && 'bg-amber-500/10 text-amber-500',
            statusTone === 'danger' && 'bg-destructive/10 text-destructive',
          )}>
            {statusTone === 'ok'
              ? <Radio className="h-5 w-5 animate-pulse" />
              : <AlertCircle className="h-5 w-5" />}
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('callCenter.overview.liveWallboard')}</div>
            <div className="text-xl font-semibold leading-tight">{statusText}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {callbackOn && (
            <Button asChild variant="outline" size="sm"><Link to="callbacks">{t('callCenter.overview.callbacksLink')} <ArrowRight className="h-3 w-3 ms-1" /></Link></Button>
          )}
          <Button asChild size="sm"><Link to="queue"><Headphones className="h-4 w-4 me-1" /> {t('callCenter.overview.openLiveDesk')}</Link></Button>
        </div>
      </div>

      {/* Primary KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard icon={Clock} label={t('callCenter.overview.kpi.waiting')} value={overview?.waiting_calls ?? queue.length} tone={(overview?.waiting_calls ?? 0) > 0 ? 'warn' : 'default'} />
        <StatCard icon={PhoneIncoming} label={t('callCenter.overview.kpi.active')} value={overview?.active_calls ?? 0} tone={(overview?.active_calls ?? 0) > 0 ? 'ok' : 'default'} />
        <StatCard icon={PhoneMissed} label={t('callCenter.overview.kpi.missedToday')} value={overview?.missed_today ?? 0} tone={(overview?.missed_today ?? 0) > 0 ? 'danger' : 'default'} />
        <StatCard icon={Phone} label={t('callCenter.overview.kpi.totalToday')} value={overview?.today_calls ?? 0} />
        {callbackOn && (
          <StatCard icon={PhoneCall} label={t('callCenter.overview.kpi.pendingCallbacks')} value={overview?.callbacks_pending ?? 0} tone={(overview?.callbacks_pending ?? 0) > 0 ? 'warn' : 'default'} />
        )}
        <StatCard icon={UserCheck} label={t('callCenter.overview.kpi.agentsAvailable')} value={`${agentStats.available}/${agentStats.total}`} tone={agentStats.available > 0 ? 'ok' : 'warn'} />
      </div>

      {/* SLA + agent utilization */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">{t('callCenter.overview.serviceLevel')}</h3>
            </div>
            <span className="text-xs text-muted-foreground">{t('callCenter.overview.live')}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.longestWait')}</div>
              <div className={cn('text-2xl font-semibold mt-1', slaStats.longest > 60 && 'text-destructive')}>
                <CallDuration seconds={slaStats.longest} />
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.avgWait')}</div>
              <div className="text-2xl font-semibold mt-1"><CallDuration seconds={slaStats.avg} /></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.slaBreached')}</div>
              <div className={cn('text-2xl font-semibold mt-1', slaStats.breached > 0 && 'text-destructive')}>
                {slaStats.breached}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.answerRate')}</div>
              <div className="text-2xl font-semibold mt-1">{slaStats.answerRate}%</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.avgHandleTime')}</div>
              <div className="text-2xl font-semibold mt-1"><CallDuration seconds={slaStats.avgHandle} /></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.utilization')}</div>
              <div className="text-2xl font-semibold mt-1">{agentStats.utilization}%</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.inConversation')}</div>
              <div className="text-2xl font-semibold mt-1">{agentStats.busy}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('callCenter.overview.metrics.awayOffline')}</div>
              <div className="text-2xl font-semibold mt-1">{agentStats.away + agentStats.offline}</div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">{t('callCenter.overview.agentPresence')}</h3>
            </div>
            <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
              <Link to="settings">{t('callCenter.overview.manage')}</Link>
            </Button>
          </div>
          <div className="space-y-2">
            {[
              { label: t('callCenter.overview.presence.available'), value: agentStats.available, dot: 'bg-emerald-500' },
              { label: t('callCenter.overview.presence.onCallBusy'), value: agentStats.busy, dot: 'bg-primary' },
              { label: t('callCenter.overview.presence.away'), value: agentStats.away, dot: 'bg-amber-500' },
              { label: t('callCenter.overview.presence.offline'), value: agentStats.offline, dot: 'bg-muted-foreground/40' },
            ].map((row) => {
              const pct = agentStats.total > 0 ? (row.value / agentStats.total) * 100 : 0;
              return (
                <div key={row.label}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="flex items-center gap-2">
                      <span className={cn('h-2 w-2 rounded-full', row.dot)} />
                      {row.label}
                    </span>
                    <span className="text-muted-foreground tabular-nums">{row.value}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className={cn('h-full', row.dot)} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Live queue + activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">{t('callCenter.overview.liveQueue')}</h3>
              {queue.length > 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">{queue.length}</span>}
            </div>
            <Button asChild size="sm" variant="ghost" className="h-7 text-xs"><Link to="queue">{t('callCenter.overview.open')} <ArrowRight className="h-3 w-3 ms-1" /></Link></Button>
          </div>
          {recentQueue.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <CheckCircle2 className="h-6 w-6 mx-auto mb-2 text-emerald-500/70" />
              {t('callCenter.overview.queueClear')}
            </div>
          ) : (
            <ul className="divide-y">
              {recentQueue.map((q) => {
                const wait = Math.floor((Date.now() - new Date(q.created_at).getTime()) / 1000);
                const breached = wait > 60;
                return (
                  <li key={q.id} className="py-2.5 flex items-center gap-3 text-sm">
                    {q.channel === 'video'
                      ? <PhoneIncoming className="h-4 w-4 text-primary shrink-0" />
                      : <Phone className="h-4 w-4 text-primary shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {q.call_session?.visitor_name || q.call_session?.visitor_email || t('callCenter.common.anonymous')}
                      </div>
                      {q.call_session?.subject && (
                        <div className="text-xs text-muted-foreground truncate">{q.call_session.subject}</div>
                      )}
                    </div>
                    <span className={cn(
                      'text-xs tabular-nums px-2 py-0.5 rounded',
                      breached ? 'bg-destructive/10 text-destructive' : 'bg-muted',
                    )}>
                      {breached && <Flame className="inline h-3 w-3 me-1" />}
                      <CallDuration seconds={waitSeconds(q.created_at)} unitScale={0.8} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">{t('callCenter.overview.needsAttention')}</h3>
            </div>
          </div>
          {recentMissed.length === 0 && pendingCallbacks.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <CheckCircle2 className="h-6 w-6 mx-auto mb-2 text-emerald-500/70" />
              {t('callCenter.overview.nothingPending')}
            </div>
          ) : (
            <div className="space-y-4">
              {recentMissed.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{t('callCenter.overview.missedCallsTitle')}</div>
                  <ul className="divide-y">
                    {recentMissed.map((c) => (
                      <li key={c.id} className="py-2 flex items-center gap-2 text-sm">
                        <PhoneMissed className="h-3.5 w-3.5 text-destructive shrink-0" />
                        <span className="flex-1 truncate">{c.visitor_name || c.visitor_email || t('callCenter.common.anonymous')}</span>
                        <span className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleTimeString()}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {callbackOn && pendingCallbacks.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{t('callCenter.overview.pendingCallbacksTitle')}</div>
                  <ul className="divide-y">
                    {pendingCallbacks.map((c) => (
                      <li key={c.id}>
                        <Link
                          to={`callbacks?focus=${c.id}`}
                          className="py-2 flex items-center gap-2 text-sm hover:bg-muted/40 rounded px-2 -mx-2 transition"
                        >
                          <PhoneCall className="h-3.5 w-3.5 text-primary shrink-0" />
                          <span className="flex-1 truncate">{(c.metadata as any)?.name || c.contact_phone || c.contact_email || t('callCenter.common.anonymous')}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">{callbackStatusLabel(t, c.status)}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}