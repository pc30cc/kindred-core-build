/**
 * Call Center — wallboard.
 *
 * Built to be read from across a room, in this order: is the service up, how
 * many people are waiting right now, are we meeting our targets, and what
 * needs a human. Everything is drawn from the shared call-center visual
 * language in `@/features/calls/callCenterUi`, so the dashboard, the desk and
 * the logs read as one product rather than three.
 */
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import {
  useCallCenterCapabilities,
  useCallCenterOverview, useCallCenterSettings, useCallCenterQueue,
  useCallCenterCalls, useCallCenterCallbacks, useCallCenterAgentPresence,
} from '@/hooks/useCallCenter';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  AlertCircle, CheckCircle2, Phone, PhoneCall, Clock,
  PhoneIncoming, PhoneMissed, Users, Activity, TrendingUp,
  ArrowRight, Radio, Headphones, UserCheck, Timer, Flame, Video,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { callbackStatusLabel } from '@/features/calls/callLabels';
import { CallDuration } from '@/features/calls/CallDuration';
import { formatTime } from '@/lib/date';
import {
  EmptyState, LiveDot, MetricTile, Panel, SectionHeading, StatusChip, ToneBar,
  TONE_DOT, TONE_TEXT, type Tone,
} from '@/features/calls/callCenterUi';

/** Waits longer than this are treated as a missed service target. */
const SLA_TARGET_SECONDS = 60;

function waitSeconds(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
}

/**
 * One service-level figure.
 *
 * Deliberately flatter than a MetricTile: eight of these sit in a single
 * panel, so each is a label with a number under it rather than eight nested
 * boxes competing for the same attention.
 */
function LevelStat({
  label, value, tone = 'neutral',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn('mt-1 text-xl font-semibold leading-none tabular-nums', TONE_TEXT[tone])}>
        {value}
      </div>
    </div>
  );
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

  let statusTone: Tone = 'success';
  let statusText = t('callCenter.overview.operationsLive');
  if (!platformOk) { statusTone = 'danger'; statusText = t('callCenter.overview.serviceDisabled'); }
  else if (!wsEnabled) { statusTone = 'warning'; statusText = t('callCenter.overview.workspaceOffline'); }
  else if (!providerReady) { statusTone = 'warning'; statusText = t('callCenter.overview.callsServiceDegraded'); }

  const queue = queueData?.queue || [];
  const recentQueue = queue.slice(0, 6);
  const calls = callsData?.calls || [];
  const recentMissed = calls.filter((c) => c.state === 'missed').slice(0, 4);
  const callbacks = callbacksData?.callbacks || [];
  const pendingCallbacks = callbacks
    .filter((c) => c.status === 'requested' || c.status === 'pending' || c.status === 'in_progress')
    .slice(0, 4);

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
    const breached = waits.filter((w) => w > SLA_TARGET_SECONDS).length;
    const todayCompleted = calls.filter((c) => c.state === 'completed');
    const avgHandle = todayCompleted.length > 0
      ? Math.round(todayCompleted.reduce((s, c) => s + (c.duration_seconds || 0), 0) / todayCompleted.length)
      : 0;
    const answered = calls.filter((c) => c.state === 'completed' || c.state === 'in_progress' || c.state === 'active').length;
    const totalToday = overview?.today_calls ?? calls.length;
    const answerRate = totalToday > 0 ? Math.round((answered / totalToday) * 100) : 100;
    return { longest, avg, breached, avgHandle, answerRate };
  }, [queue, calls, overview?.today_calls]);

  const presenceRows: Array<{ label: string; value: number; tone: Tone }> = [
    { label: t('callCenter.overview.presence.available'), value: agentStats.available, tone: 'success' },
    { label: t('callCenter.overview.presence.onCallBusy'), value: agentStats.busy, tone: 'primary' },
    { label: t('callCenter.overview.presence.away'), value: agentStats.away, tone: 'warning' },
    { label: t('callCenter.overview.presence.offline'), value: agentStats.offline, tone: 'neutral' },
  ];

  return (
    <div className="space-y-5">
      {/* ── Status banner ─────────────────────────────────────────────
          The one line that answers "is the phone working?", with the two
          ways into the module sitting beside it. */}
      <Panel
        flush
        className={cn(
          'relative overflow-hidden border-transparent ring-1',
          statusTone === 'success' && 'bg-success/[0.07] ring-success/20',
          statusTone === 'warning' && 'bg-warning/[0.08] ring-warning/25',
          statusTone === 'danger' && 'bg-destructive/[0.08] ring-destructive/25',
        )}
      >
        <div className="flex flex-wrap items-center gap-4 p-4">
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ring-1',
              statusTone === 'success' && 'bg-success/15 text-success ring-success/25',
              statusTone === 'warning' && 'bg-warning/15 text-warning ring-warning/25',
              statusTone === 'danger' && 'bg-destructive/15 text-destructive ring-destructive/25',
            )}
          >
            {statusTone === 'success' ? <Radio className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <LiveDot tone={statusTone} pulse={statusTone === 'success'} />
              {t('callCenter.overview.liveWallboard')}
            </div>
            <div className="mt-0.5 truncate text-xl font-semibold leading-tight">{statusText}</div>
          </div>
          <div className="flex items-center gap-2">
            {callbackOn && (
              <Button asChild variant="outline" size="sm">
                <Link to="callbacks">
                  {t('callCenter.overview.callbacksLink')}
                  <ArrowRight className="ms-1 h-3 w-3 rtl:rotate-180" />
                </Link>
              </Button>
            )}
            <Button asChild size="sm">
              <Link to="queue">
                <Headphones className="me-1.5 h-4 w-4" />
                {t('callCenter.overview.openLiveDesk')}
              </Link>
            </Button>
          </div>
        </div>
      </Panel>

      {/* ── Primary KPIs ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <MetricTile
          label={t('callCenter.overview.kpi.waiting')} icon={Clock}
          value={overview?.waiting_calls ?? queue.length}
          tone={(overview?.waiting_calls ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <MetricTile
          label={t('callCenter.overview.kpi.active')} icon={PhoneIncoming}
          value={overview?.active_calls ?? 0}
          tone={(overview?.active_calls ?? 0) > 0 ? 'success' : 'neutral'}
        />
        <MetricTile
          label={t('callCenter.overview.kpi.missedToday')} icon={PhoneMissed}
          value={overview?.missed_today ?? 0}
          tone={(overview?.missed_today ?? 0) > 0 ? 'danger' : 'neutral'}
        />
        <MetricTile
          label={t('callCenter.overview.kpi.totalToday')} icon={Phone}
          value={overview?.today_calls ?? 0}
        />
        {callbackOn && (
          <MetricTile
            label={t('callCenter.overview.kpi.pendingCallbacks')} icon={PhoneCall}
            value={overview?.callbacks_pending ?? 0}
            tone={(overview?.callbacks_pending ?? 0) > 0 ? 'warning' : 'neutral'}
          />
        )}
        <MetricTile
          label={t('callCenter.overview.kpi.agentsAvailable')} icon={UserCheck}
          value={
            <span className="inline-flex items-baseline">
              {agentStats.available}
              <span className="text-[0.5em] font-normal opacity-60">/{agentStats.total}</span>
            </span>
          }
          tone={agentStats.available > 0 ? 'success' : 'warning'}
        />
      </div>

      {/* ── Service level + presence ───────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <SectionHeading
            icon={Timer}
            title={t('callCenter.overview.serviceLevel')}
            action={
              <StatusChip tone="success" dot pulse>
                {t('callCenter.overview.live')}
              </StatusChip>
            }
          />
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4">
            <LevelStat
              label={t('callCenter.overview.metrics.longestWait')}
              value={<CallDuration seconds={slaStats.longest} unitScale={0.45} />}
              tone={slaStats.longest > SLA_TARGET_SECONDS ? 'danger' : 'neutral'}
            />
            <LevelStat
              label={t('callCenter.overview.metrics.avgWait')}
              value={<CallDuration seconds={slaStats.avg} unitScale={0.45} />}
            />
            <LevelStat
              label={t('callCenter.overview.metrics.slaBreached')}
              value={slaStats.breached}
              tone={slaStats.breached > 0 ? 'danger' : 'neutral'}
            />
            <LevelStat
              label={t('callCenter.overview.metrics.answerRate')}
              value={`${slaStats.answerRate}%`}
              tone={slaStats.answerRate >= 90 ? 'success' : slaStats.answerRate >= 70 ? 'warning' : 'danger'}
            />
            <LevelStat
              label={t('callCenter.overview.metrics.avgHandleTime')}
              value={<CallDuration seconds={slaStats.avgHandle} unitScale={0.45} />}
            />
            <LevelStat
              label={t('callCenter.overview.metrics.utilization')}
              value={`${agentStats.utilization}%`}
            />
            <LevelStat label={t('callCenter.overview.metrics.inConversation')} value={agentStats.busy} />
            <LevelStat
              label={t('callCenter.overview.metrics.awayOffline')}
              value={agentStats.away + agentStats.offline}
            />
          </div>
        </Panel>

        <Panel>
          <SectionHeading
            icon={Users}
            title={t('callCenter.overview.agentPresence')}
            count={agentStats.total || undefined}
            action={
              <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                <Link to="settings">{t('callCenter.overview.manage')}</Link>
              </Button>
            }
          />
          <div className="mt-4 space-y-2.5">
            {presenceRows.map((row) => (
              <div key={row.label}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', TONE_DOT[row.tone])} />
                    {row.label}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{row.value}</span>
                </div>
                <ToneBar
                  tone={row.tone}
                  value={agentStats.total > 0 ? (row.value / agentStats.total) * 100 : 0}
                />
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* ── Live queue + what needs a human ─────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel flush className="overflow-hidden">
          <div className="border-b border-border/60 p-4">
            <SectionHeading
              icon={Activity}
              title={t('callCenter.overview.liveQueue')}
              count={queue.length || undefined}
              action={
                <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                  <Link to="queue">
                    {t('callCenter.overview.open')}
                    <ArrowRight className="ms-1 h-3 w-3 rtl:rotate-180" />
                  </Link>
                </Button>
              }
            />
          </div>
          {recentQueue.length === 0 ? (
            <EmptyState icon={CheckCircle2} title={t('callCenter.overview.queueClear')} />
          ) : (
            <ul className="divide-y divide-border/60">
              {recentQueue.map((q) => {
                const wait = waitSeconds(q.created_at);
                const breached = wait > SLA_TARGET_SECONDS;
                const isVideo = q.channel === 'video';
                return (
                  <li key={q.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1',
                        isVideo ? 'bg-info/10 text-info ring-info/20' : 'bg-primary/10 text-primary ring-primary/20',
                      )}
                    >
                      {isVideo ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {q.call_session?.visitor_name || q.call_session?.visitor_email || t('callCenter.common.anonymous')}
                      </div>
                      {q.call_session?.subject && (
                        <div className="truncate text-xs text-muted-foreground">{q.call_session.subject}</div>
                      )}
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs tabular-nums',
                        breached ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {breached && <Flame className="h-3 w-3" />}
                      <CallDuration seconds={wait} unitScale={0.8} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel flush className="overflow-hidden">
          <div className="border-b border-border/60 p-4">
            <SectionHeading
              icon={TrendingUp}
              tone={recentMissed.length > 0 || pendingCallbacks.length > 0 ? 'warning' : 'success'}
              title={t('callCenter.overview.needsAttention')}
              count={(recentMissed.length + pendingCallbacks.length) || undefined}
            />
          </div>
          {recentMissed.length === 0 && pendingCallbacks.length === 0 ? (
            <EmptyState icon={CheckCircle2} title={t('callCenter.overview.nothingPending')} />
          ) : (
            <div className="p-4 pt-3">
              {recentMissed.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('callCenter.overview.missedCallsTitle')}
                  </div>
                  <ul className="divide-y divide-border/60">
                    {recentMissed.map((c) => (
                      <li key={c.id} className="flex items-center gap-2 py-2 text-sm">
                        <PhoneMissed className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        <span className="flex-1 truncate">
                          {c.visitor_name || c.visitor_email || t('callCenter.common.anonymous')}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatTime(c.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {callbackOn && pendingCallbacks.length > 0 && (
                <div className={cn(recentMissed.length > 0 && 'mt-4')}>
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('callCenter.overview.pendingCallbacksTitle')}
                  </div>
                  <ul className="divide-y divide-border/60">
                    {pendingCallbacks.map((c) => (
                      <li key={c.id}>
                        <Link
                          to={`callbacks?focus=${c.id}`}
                          className="-mx-2 flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/50"
                        >
                          <PhoneCall className="h-3.5 w-3.5 shrink-0 text-primary" />
                          <span className="flex-1 truncate">
                            {(c.metadata as { name?: string } | null)?.name
                              || c.contact_phone
                              || c.contact_email
                              || t('callCenter.common.anonymous')}
                          </span>
                          <StatusChip tone="warning">{callbackStatusLabel(t, c.status)}</StatusChip>
                          <ArrowRight className="h-3 w-3 text-muted-foreground rtl:rotate-180" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
