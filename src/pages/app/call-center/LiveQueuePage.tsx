/**
 * Call Center — operator Live Desk.
 *
 * Three columns with fixed roles, never rearranged: the queue on one side,
 * the call being handled in the middle, the visitor's context on the other.
 * An operator learns where to look once and then stops looking.
 *
 * Everything done during a call (mute, camera, devices, record, transfer,
 * hang up) lives in ONE toolbar inside the media console. There is no second
 * place to look and no decorative control that does nothing.
 *
 * Every colour comes from the semantic tokens via
 * `@/features/calls/callCenterUi` — `success`, `warning`, `destructive`,
 * `info` — so the desk sits in the same light surface as the rest of the
 * product and follows the theme instead of hardcoding a palette.
 *
 * All backend vocabulary (call state, end reason, timeline event type,
 * recording state) goes through `@/features/calls/callLabels`, so the desk
 * reads in the operator's own language instead of leaking raw codes.
 */
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { VisitorNetworkCard, VisitorNetworkInline } from '@/features/visitors/VisitorNetworkCard';
import { useVisitorNetworkBatchBySession } from '@/hooks/useVisitorNetwork';
import { useGeoEnrichmentRealtime } from '@/hooks/useGeoEnrichmentRealtime';
import {
  useCallCenterQueue, useCallCenterCall, useCallCenterOverview,
  useCallCenterSettings, useCallCenterCalls,
} from '@/hooks/useCallCenter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import {
  Phone, Video, Globe, Headphones, RadioTower, Inbox, PhoneOff,
  PhoneCall, AlertTriangle, Loader2, Search, Clock, User, Mail, Smartphone,
  Copy, Check, ChevronRight, Activity, FileText, History, ArrowUp, ArrowDown,
  Disc, Timer,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link, useParams } from 'react-router-dom';
import OperatorMediaConsole, { type OperatorConnectInfo } from '@/components/call-center/OperatorMediaConsole';
import { useTranslation } from '@/i18n';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { contactDisplayName } from '@/lib/contact-display';
import { formatTime } from '@/lib/date';
import {
  callEventLabel, callStateLabel, endReasonLabel,
  recordingReasonLabel, recordingStateLabel,
} from '@/features/calls/callLabels';
import {
  RecordingStatusStrip, RecordingToolbarButton, useOperatorRecording,
} from '@/features/calls/OperatorRecordingControls';
import { TransferCallDialog } from '@/features/calls/TransferCallDialog';
import { CallNotesPanel } from '@/features/calls/CallNotesPanel';
import {
  EmptyState, LiveDot, Panel, PanelSkeleton, SectionHeading, StatusChip, ToneBar,
  TONE_DOT, TONE_TEXT, type Tone,
} from '@/features/calls/callCenterUi';

/** SLA threshold, in seconds, after which a waiting call counts as breached. */
const SLA_BREACH_SECONDS = 180;
const SLA_WARN_SECONDS = 60;

/**
 * Compact recording chip for the call header.
 *
 * Reads the per-call `metadata.recording.state` when there is one, and falls
 * back to the workspace capability so an operator still sees *why* recording
 * is unavailable before a call has any recording metadata at all.
 */
function RecordingBadge({
  capability,
  meta,
}: {
  capability?: { effective_enabled?: boolean; reason?: string } | null;
  meta?: { state?: string } | null;
}) {
  const { t } = useTranslation();
  const state = meta?.state;
  const effective = !!capability?.effective_enabled;

  let label: string;
  let tone: Tone = 'neutral';
  if (!effective) {
    label = recordingReasonLabel(t, capability?.reason);
  } else if (state === 'consent_pending') {
    label = recordingStateLabel(t, 'consent_pending'); tone = 'warning';
  } else if (state === 'recording') {
    label = recordingStateLabel(t, 'recording'); tone = 'danger';
  } else if (state === 'failed') {
    label = recordingStateLabel(t, 'failed'); tone = 'danger';
  } else if (state === 'available') {
    label = recordingStateLabel(t, 'available'); tone = 'success';
  } else if (state === 'pending' || state === 'finalizing') {
    label = recordingStateLabel(t, state); tone = 'warning';
  } else {
    label = recordingStateLabel(t, 'ready'); tone = 'success';
  }

  return (
    <StatusChip tone={tone} icon={Disc} pulse={state === 'recording'}>
      {label}
    </StatusChip>
  );
}

function urgencyTone(iso: string): Tone {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec > SLA_BREACH_SECONDS) return 'danger';
  if (sec > SLA_WARN_SECONDS) return 'warning';
  return 'success';
}

/**
 * A desk counter.
 *
 * In the cockpit these sit on the top rail and are read at a glance, so the
 * figure is large and monospaced-by-numerals and the caption sits under it.
 */
function DeskStat({
  label, value, icon: Icon, tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: Tone;
}) {
  return (
    <div className="flex min-w-[92px] items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2 ring-1 ring-border/60">
      {Icon && <Icon className={cn('h-4 w-4 shrink-0 opacity-80', TONE_TEXT[tone])} />}
      <div className="leading-tight">
        <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={cn('text-base font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</div>
      </div>
    </div>
  );
}

/** `m:ss` elapsed clock — locale-neutral by design so column widths stay stable. */
function clock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}
function elapsedSince(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="opacity-60 transition-opacity hover:opacity-100"
      title={copied ? t('callCenter.desk.copied') : t('callCenter.desk.copy')}
      aria-label={t('callCenter.desk.copy')}
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/** Earlier calls from the same visitor — the context an operator opens with. */
function VisitorCallHistory({
  workspaceId,
  currentCallId,
  sessionId,
  email,
  phone,
  logHref,
}: {
  workspaceId: string | undefined;
  currentCallId: string;
  sessionId: string | null;
  email: string | null;
  phone: string | null;
  logHref: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useCallCenterCalls(workspaceId);

  const history = useMemo(() => {
    const all = data?.calls || [];
    return all
      .filter((c) => {
        if (c.id === currentCallId) return false;
        if (sessionId && c.visitor_session_id === sessionId) return true;
        if (email && c.visitor_email === email) return true;
        if (phone && c.visitor_phone === phone) return true;
        return false;
      })
      .slice(0, 8);
  }, [data, currentCallId, sessionId, email, phone]);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">{t('callCenter.history.loading')}</p>;
  }
  if (history.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('callCenter.history.empty')}</p>;
  }

  return (
    <div className="space-y-1.5">
      <ul className="space-y-1">
        {history.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-xs">
            {c.call_type === 'video'
              ? <Video className="h-3 w-3 shrink-0 text-muted-foreground" />
              : <Phone className="h-3 w-3 shrink-0 text-muted-foreground" />}
            <span className="truncate">{callStateLabel(t, c.state)}</span>
            <span className="ms-auto shrink-0 tabular-nums text-muted-foreground">
              {c.duration_seconds ? clock(c.duration_seconds) : t('callCenter.history.noDuration')}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(c.created_at)}</span>
          </li>
        ))}
      </ul>
      <Button asChild size="sm" variant="ghost" className="h-6 px-1 text-[11px]">
        <Link to={logHref}>{t('callCenter.history.viewAll')}</Link>
      </Button>
    </div>
  );
}

export default function LiveQueuePage() {
  const { t, locale } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { slug } = useParams();
  const base = `/${slug}/call-center`;
  const { data, isLoading } = useCallCenterQueue(workspace?.id);
  const { data: overview } = useCallCenterOverview(workspace?.id);
  const { data: settingsBundle } = useCallCenterSettings(workspace?.id);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<'all' | 'voice' | 'video'>('all');
  const [sortMode, setSortMode] = useState<'wait_desc' | 'wait_asc'>('wait_desc');
  const [contextTab, setContextTab] = useState<'contact' | 'timeline' | 'notes'>('contact');
  const [accepted, setAccepted] = useState<{
    callId: string;
    token: string;
    connect: OperatorConnectInfo;
    callType: string;
  } | null>(null);
  /** The call whose wrap-up card is open after the console unmounts. */
  const [wrapUpCallId, setWrapUpCallId] = useState<string | null>(null);
  const { data: detail } = useCallCenterCall(workspace?.id, selectedCallId);
  const [, force] = useState(0);
  useEffect(() => { const timer = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(timer); }, []);

  const transferEnabled = (settingsBundle as { platform?: { call_transfer_enabled?: boolean } } | undefined)
    ?.platform?.call_transfer_enabled !== false;

  // Operator-side new-call notification sound. Plays a short chime whenever
  // a fresh entry appears in the queue (governed by platform setting).
  const knownCallIdsRef = useRef<{ set: Set<string>; primed: boolean }>({ set: new Set(), primed: false });
  useEffect(() => {
    const enabled = (settingsBundle as { platform?: { operator_new_call_sound_enabled?: boolean } } | undefined)
      ?.platform?.operator_new_call_sound_enabled !== false;
    if (!enabled) return;
    const ids = (data?.queue || []).map((q) => q.call_session_id).filter(Boolean) as string[];
    const r = knownCallIdsRef.current;
    if (!r.primed) {
      r.primed = true;
      ids.forEach((id) => r.set.add(id));
      return;
    }
    const fresh = ids.filter((id) => !r.set.has(id));
    ids.forEach((id) => r.set.add(id));
    if (fresh.length === 0) return;
    // Play a soft two-tone chime via Web Audio.
    try {
      const C = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return;
      const ctx = new C();
      if (ctx.state === 'suspended' && ctx.resume) { try { void ctx.resume(); } catch { /* */ } }
      const t0 = ctx.currentTime;
      [{ f: 880, at: 0 }, { f: 1175, at: 0.18 }].forEach((n) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.f, t0 + n.at);
        g.gain.setValueAtTime(0.0001, t0 + n.at);
        g.gain.exponentialRampToValueAtTime(0.15, t0 + n.at + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + 0.32);
        osc.connect(g).connect(ctx.destination);
        osc.start(t0 + n.at);
        osc.stop(t0 + n.at + 0.4);
      });
      setTimeout(() => { try { void ctx.close(); } catch { /* */ } }, 1200);
    } catch { /* swallow */ }
  }, [data?.queue, settingsBundle]);

  // Faster status sync while in active console
  useEffect(() => {
    if (!accepted?.callId) return;
    const timer = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['call-center'] });
    }, 5000);
    return () => clearInterval(timer);
  }, [accepted?.callId, qc]);

  const rawQueue = data?.queue || [];
  const queue = useMemo(() => {
    const q = rawQueue.filter((entry) => {
      const c = entry.call_session ?? null;
      if (channelFilter !== 'all') {
        const ch = entry.channel || (c?.call_type === 'video' ? 'video' : 'voice');
        if (channelFilter === 'video' && ch !== 'video') return false;
        if (channelFilter === 'voice' && ch === 'video') return false;
      }
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const hay = [
          c?.visitor_name, c?.visitor_email, c?.visitor_phone, c?.subject, c?.page_title, c?.page_url,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    q.sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return sortMode === 'wait_desc' ? ta - tb : tb - ta;
    });
    return q;
  }, [rawQueue, channelFilter, search, sortMode]);

  // ONE batched network read for the whole page (queue rows + the selected
  // call's detail panel) — never one request per row.
  const queueSessionIds = useMemo(
    () =>
      rawQueue.map(
        (q) =>
          q.call_session?.visitor_session_id
          || (q as { visitor_session_id?: string | null }).visitor_session_id
          || null,
      ),
    [rawQueue],
  );
  const { data: networkBySession } = useVisitorNetworkBatchBySession(workspace?.id, queueSessionIds);
  // Refresh IP/geo once async enrichment lands (reuses the visitors channel).
  useGeoEnrichmentRealtime(workspace?.id);
  const selectedSessionId =
    (detail?.call as { visitor_session_id?: string | null } | undefined)?.visitor_session_id
    || rawQueue.find((q) => q.call_session_id === selectedCallId)?.call_session?.visitor_session_id
    || null;
  const selectedProfile = selectedSessionId ? networkBySession?.[selectedSessionId] ?? null : null;

  // Queue analytics
  const queueStats = useMemo(() => {
    if (rawQueue.length === 0) return { count: 0, longest: 0, avg: 0, voice: 0, video: 0, breached: 0 };
    const waits = rawQueue.map((q) => elapsedSince(q.created_at));
    const longest = Math.max(...waits);
    const avg = Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);
    const voice = rawQueue.filter((q) => (q.channel || 'voice') !== 'video').length;
    const video = rawQueue.length - voice;
    const breached = waits.filter((w) => w > SLA_BREACH_SECONDS).length;
    return { count: rawQueue.length, longest, avg, voice, video, breached };
  }, [rawQueue]);

  // Auto-select first queue item — done in effect, not during render
  useEffect(() => {
    // While a call is accepted (or its wrap-up is open), keep the selection
    // pinned so the media console / wrap-up stays mounted even after the
    // queue drops the entry.
    const pinned = accepted?.callId || wrapUpCallId;
    if (pinned) {
      if (selectedCallId !== pinned) setSelectedCallId(pinned);
      return;
    }
    if (queue.length === 0) {
      if (selectedCallId) setSelectedCallId(null);
      return;
    }
    const stillThere = selectedCallId && queue.some((q) => q.call_session_id === selectedCallId);
    if (!stillThere) {
      setSelectedCallId(queue[0]?.call_session_id ?? null);
    }
  }, [queue, selectedCallId, accepted?.callId, wrapUpCallId]);

  const activeCallId = accepted?.callId ?? null;
  const callIsConnected = !!detail && ['active', 'ringing', 'connecting'].includes(detail.call.state);
  const recording = useOperatorRecording(workspace?.id, activeCallId, callIsConnected);

  async function accept(callId: string) {
    if (!workspace) return;
    setBusy(callId);
    try {
      const r = await callCenterApi.acceptCall(workspace.id, callId);
      const connect = (r as { connect?: OperatorConnectInfo }).connect;
      // The queue row is the authoritative source for the call type at accept
      // time — `detail` may still be pointing at a different selection.
      const queued = rawQueue.find((q) => q.call_session_id === callId)?.call_session;
      const callType = queued?.call_type || detail?.call?.call_type || 'voice';
      if (connect && r.token) {
        setWrapUpCallId(null);
        setAccepted({ callId, token: r.token, connect, callType });
        setSelectedCallId(callId);
        if (!connect.supported) {
          toast({
            title: t('callCenter.desk.acceptedNoMedia'),
            description: connect.reason || t('callCenter.desk.acceptedNoMediaHint'),
            variant: 'destructive',
          });
        }
      }
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: unknown) {
      toast({
        title: t('callCenter.desk.acceptFailed'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally { setBusy(null); }
  }

  async function reject(callId: string) {
    if (!workspace) return;
    setBusy(callId);
    try {
      await callCenterApi.rejectCall(workspace.id, callId);
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: unknown) {
      toast({
        title: t('callCenter.desk.rejectFailed'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally { setBusy(null); }
  }

  async function endActive(callId: string) {
    if (!workspace) return;
    try {
      await callCenterApi.endCall(workspace.id, callId);
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: unknown) {
      toast({
        title: t('callCenter.desk.endFailed'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  }

  const endFromConsole = useCallback(async () => {
    const id = accepted?.callId;
    if (!id || !workspace) { setAccepted(null); return; }
    // Backend-first; throw on failure so the console shows Retry.
    await callCenterApi.endCall(workspace.id, id);
    qc.invalidateQueries({ queryKey: ['call-center'] });
    // Do NOT clear `accepted` here — OperatorMediaConsole shows the
    // "Call ended" state briefly and then calls onEndedConfirmed.
  }, [accepted?.callId, workspace, qc]);

  const reconnectFromConsole = useCallback(async (): Promise<{ token: string; connect: OperatorConnectInfo } | null> => {
    if (!workspace || !accepted?.callId) return null;
    const r = await callCenterApi.acceptCall(workspace.id, accepted.callId);
    const c = (r as { connect?: OperatorConnectInfo }).connect;
    if (!c || !r.token) return null;
    setAccepted({ callId: accepted.callId, token: r.token, connect: c, callType: accepted.callType });
    return { token: r.token, connect: c };
  }, [workspace, accepted?.callId, accepted?.callType]);

  const callMeta = (detail?.call as { metadata?: Record<string, unknown> } | undefined)?.metadata || {};
  const preCall = (callMeta.pre_call_form || callMeta.preCallForm) as Record<string, unknown> | null;
  const recordingMeta = callMeta.recording as { state?: string } | undefined;
  const isActive = !!detail && ['active', 'ringing', 'connecting'].includes(detail.call.state);

  // Detect external end from backend state for the active console call
  const externalEndedReason = useMemo<
    'ended_by_visitor' | 'ended_by_operator' | 'cancelled' | 'failed' | null
  >(() => {
    if (!accepted || !detail || detail.call.id !== accepted.callId) return null;
    const s = detail.call.state;
    const reason = (detail.call as { end_reason?: string | null }).end_reason;
    if (s === 'ended') {
      if (reason === 'visitor_ended' || reason === 'visitor_cancelled') return 'ended_by_visitor';
      if (reason === 'operator_ended') return 'ended_by_operator';
      return 'ended_by_visitor';
    }
    if (s === 'cancelled') return 'cancelled';
    if (s === 'missed' || s === 'failed') return 'failed';
    return null;
  }, [accepted, detail]);

  const visitorLabel = detail
    ? detail.call.visitor_name
      || detail.call.visitor_email
      || detail.call.visitor_phone
      || t('callCenter.common.anonymousVisitor')
    : '';
  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex h-full flex-col gap-3">
      {/* ── Top rail ───────────────────────────────────────────────────
          Identity of the room on the left, the numbers that decide what an
          operator does next on the right. Everything else on this page is
          about ONE call; this strip is about the whole floor. */}
      <Panel flush className="relative overflow-hidden border-border/60">
        <div className="pointer-events-none absolute -top-16 -end-10 h-40 w-40 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Headphones className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold">{t('callCenter.queue.liveDesk')}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <LiveDot tone="success" pulse />
                <RadioTower className="h-3 w-3" />
                {t('callCenter.queue.livePolling')}
              </div>
            </div>
          </div>

          <div className="ms-auto flex flex-wrap gap-1.5">
            <DeskStat
              label={t('callCenter.queue.chips.waiting')} icon={Inbox}
              value={overview?.waiting_calls ?? rawQueue.length}
              tone={(overview?.waiting_calls ?? 0) > 0 ? 'warning' : 'neutral'}
            />
            <DeskStat
              label={t('callCenter.queue.chips.active')} icon={Activity}
              value={overview?.active_calls ?? 0}
              tone={(overview?.active_calls ?? 0) > 0 ? 'success' : 'neutral'}
            />
            <DeskStat
              label={t('callCenter.queue.chips.longestWait')} icon={Timer}
              value={queueStats.count > 0 ? clock(queueStats.longest) : '—'}
              tone={queueStats.longest > SLA_BREACH_SECONDS ? 'danger'
                : queueStats.longest > SLA_WARN_SECONDS ? 'warning' : 'neutral'}
            />
            <DeskStat
              label={t('callCenter.queue.chips.slaBreached')} icon={AlertTriangle}
              value={queueStats.breached}
              tone={queueStats.breached > 0 ? 'danger' : 'neutral'}
            />
            <DeskStat
              label={t('callCenter.queue.chips.missedToday')} icon={PhoneOff}
              value={overview?.missed_today ?? 0}
              tone={(overview?.missed_today ?? 0) > 0 ? 'danger' : 'neutral'}
            />
            <DeskStat
              label={t('callCenter.queue.chips.today')} icon={PhoneCall}
              value={overview?.today_calls ?? 0} tone="primary"
            />
            <DeskStat
              label={t('callCenter.queue.chips.callsService')} icon={RadioTower}
              value={overview?.provider?.ready ? t('callCenter.queue.chips.ready') : t('callCenter.queue.chips.down')}
              tone={overview?.provider?.ready ? 'success' : 'danger'}
            />
          </div>
        </div>
      </Panel>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[340px_minmax(0,1fr)_340px]">
        {/* ── Queue ──────────────────────────────────────────────────── */}
        <Panel flush className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border/60 bg-muted/20 px-3 pb-2 pt-3">
            <SectionHeading
              icon={Inbox}
              title={t('callCenter.queue.queueTitle')}
              count={
                queue.length !== rawQueue.length
                  ? `${queue.length}/${rawQueue.length}`
                  : queue.length || undefined
              }
              action={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon" variant="ghost" className="h-7 w-7"
                      onClick={() => setSortMode((m) => (m === 'wait_desc' ? 'wait_asc' : 'wait_desc'))}
                      aria-label={sortMode === 'wait_desc'
                        ? t('callCenter.queue.sortLongestFirst')
                        : t('callCenter.queue.sortNewestFirst')}
                    >
                      {sortMode === 'wait_desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {sortMode === 'wait_desc' ? t('callCenter.queue.sortLongestFirst') : t('callCenter.queue.sortNewestFirst')}
                  </TooltipContent>
                </Tooltip>
              }
            />
            <div className="relative mt-2.5">
              <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('callCenter.queue.searchPlaceholder')}
                className="h-8 ps-8 text-xs"
              />
            </div>
            {/* Channel filter as a segmented track rather than three loose
                buttons — it is one choice, so it reads as one control. */}
            <div className="mt-2 flex rounded-lg bg-muted/60 p-0.5 ring-1 ring-border/60">
              {([
                { k: 'all', label: t('callCenter.queue.filterAll'), count: rawQueue.length },
                { k: 'voice', label: t('callCenter.queue.filterVoice'), count: queueStats.voice, icon: Phone },
                { k: 'video', label: t('callCenter.queue.filterVideo'), count: queueStats.video, icon: Video },
              ] as const).map((opt) => {
                const OptIcon = (opt as { icon?: React.ComponentType<{ className?: string }> }).icon;
                const on = channelFilter === opt.k;
                return (
                  <button
                    key={opt.k}
                    onClick={() => setChannelFilter(opt.k)}
                    className={cn(
                      'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-[11px] transition-all',
                      on
                        ? 'bg-card font-semibold text-foreground shadow-[var(--shadow-card)]'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {OptIcon ? <OptIcon className="h-3 w-3" /> : null}
                    {opt.label}
                    <span className="tabular-nums opacity-60">{opt.count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {isLoading && <PanelSkeleton rows={3} />}

            {!isLoading && queue.length === 0 && rawQueue.length === 0 && (
              <EmptyState
                icon={Headphones}
                title={t('callCenter.queue.noCallsWaiting')}
                hint={t('callCenter.queue.noCallsHint')}
                action={
                  <>
                    <Button asChild size="sm" variant="outline">
                      <Link to={`${base}/install`}>{t('callCenter.queue.installWidget')}</Link>
                    </Button>
                    <Button asChild size="sm" variant="ghost">
                      <Link to={`${base}/settings`}>{t('callCenter.queue.openSettings')}</Link>
                    </Button>
                  </>
                }
              />
            )}
            {!isLoading && queue.length === 0 && rawQueue.length > 0 && (
              <p className="p-6 text-center text-xs text-muted-foreground">
                {t('callCenter.queue.noMatches')}
              </p>
            )}

            {queue.map((q, idx) => {
              const c = q.call_session ?? null;
              const tone = urgencyTone(q.created_at);
              const isSel = selectedCallId === q.call_session_id;
              const isAccepted = accepted?.callId === q.call_session_id;
              const waitSec = elapsedSince(q.created_at);
              const slaPct = Math.min(100, (waitSec / SLA_BREACH_SECONDS) * 100);
              const isVideo = q.channel === 'video' || c?.call_type === 'video';
              const net = c?.visitor_session_id ? networkBySession?.[c.visitor_session_id] ?? null : null;
              // Same identity rule as the rest of the app: stable, geo-aware label.
              const name =
                c?.visitor_name ||
                c?.visitor_email ||
                c?.visitor_phone ||
                contactDisplayName(
                  null,
                  c?.contact_id ?? c?.visitor_session_id ?? q.call_session_id,
                  t,
                  net?.geo,
                  locale,
                );
              return (
                <div
                  key={q.id}
                  onClick={() => setSelectedCallId(q.call_session_id)}
                  className={cn(
                    'group relative cursor-pointer overflow-hidden rounded-xl border bg-card transition-all',
                    isSel
                      ? 'border-primary/60 shadow-[var(--shadow-glow)]'
                      : 'border-border/70 hover:border-primary/40 hover:bg-muted/30',
                  )}
                >
                  {/* Urgency edge */}
                  <span className={cn('absolute inset-y-0 start-0 w-[3px]', TONE_DOT[tone])} />

                  <div className="p-3 ps-3.5">
                    <div className="flex items-start gap-2.5">
                      <div className="relative">
                        <ContactAvatar
                          name={name}
                          email={c?.visitor_email}
                          os={net?.device?.os}
                          device={net?.device?.device}
                          countryCode={net?.geo?.country_code}
                          size="sm"
                        />
                        <span
                          className={cn(
                            'absolute -bottom-0.5 -end-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-card',
                            isVideo ? 'bg-info text-info-foreground' : 'bg-success text-success-foreground',
                          )}
                        >
                          {isVideo ? <Video className="h-2.5 w-2.5" /> : <Phone className="h-2.5 w-2.5" />}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <div className="truncate text-sm font-medium">{name}</div>
                          <span className="ms-auto rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                            #{idx + 1}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span
                            className={cn(
                              'flex items-center gap-1 text-[11px] font-medium tabular-nums',
                              TONE_TEXT[tone],
                            )}
                          >
                            <Clock className="h-3 w-3" />
                            {clock(waitSec)}
                          </span>
                          {q.priority > 0 && (
                            <StatusChip tone="info" className="h-4 px-1.5 text-[9px]">P{q.priority}</StatusChip>
                          )}
                          {isAccepted && (
                            <StatusChip tone="success" dot pulse className="h-4 px-1.5 text-[9px]">
                              {t('callCenter.queue.onCallBadge')}
                            </StatusChip>
                          )}
                        </div>
                        {c?.subject && (
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">{c.subject}</div>
                        )}
                        {c?.page_title && (
                          <div className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                            <Globe className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate">{c.page_title}</span>
                          </div>
                        )}
                        <div className="mt-0.5 truncate">
                          <VisitorNetworkInline
                            profile={c?.visitor_session_id ? networkBySession?.[c.visitor_session_id] ?? null : null}
                            t={t}
                            locale={locale}
                          />
                        </div>
                      </div>
                    </div>

                    <ToneBar className="mt-2.5" tone={tone} value={slaPct} />

                    <div className="mt-2.5 flex gap-1.5">
                      <Button
                        variant="outline" size="sm" className="h-7 flex-1 text-xs"
                        onClick={(e) => { e.stopPropagation(); reject(q.call_session_id); }}
                        disabled={busy === q.call_session_id || isAccepted}
                      >
                        {t('callCenter.desk.decline')}
                      </Button>
                      <Button
                        size="sm" className="h-7 flex-1 text-xs"
                        onClick={(e) => { e.stopPropagation(); accept(q.call_session_id); }}
                        disabled={busy === q.call_session_id || isAccepted}
                      >
                        {busy === q.call_session_id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : isAccepted
                            ? t('callCenter.queue.onCall')
                            : (<><PhoneCall className="me-1 h-3 w-3" />{t('callCenter.desk.answer')}</>)}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* ── The call ───────────────────────────────────────────────── */}
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {!detail ? (
            <Panel flush className="border-dashed">
              <EmptyState
                className="py-20"
                icon={PhoneCall}
                title={t('callCenter.queue.noCallSelected')}
                hint={t('callCenter.queue.noCallSelectedHint')}
              />
            </Panel>
          ) : (
            <>
              <Panel
                flush
                glow={isActive}
                className="relative overflow-hidden"
              >
                {detail.call.state === 'ringing' && (
                  <span className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-warning" />
                )}
                <div className="flex flex-wrap items-start gap-4 p-4">
                  <div className="relative shrink-0">
                    <ContactAvatar
                      name={visitorLabel}
                      email={detail.call.visitor_email}
                      os={selectedProfile?.device?.os}
                      device={selectedProfile?.device?.device}
                      countryCode={selectedProfile?.geo?.country_code}
                      size="lg"
                    />
                    <span
                      className={cn(
                        'absolute -bottom-0.5 -end-0.5 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-card',
                        detail.call.call_type === 'video'
                          ? 'bg-info text-info-foreground'
                          : 'bg-success text-success-foreground',
                      )}
                    >
                      {detail.call.call_type === 'video' ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xl font-semibold leading-tight">{visitorLabel}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {detail.call.visitor_email && (
                        <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{detail.call.visitor_email}</span>
                      )}
                      {detail.call.visitor_phone && (
                        <span className="inline-flex items-center gap-1"><Smartphone className="h-3 w-3" />{detail.call.visitor_phone}</span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {t('callCenter.desk.startedAt')} {formatTime(detail.call.created_at)}
                      </span>
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <StatusChip tone="neutral" icon={detail.call.call_type === 'video' ? Video : Phone}>
                        {detail.call.call_type === 'video'
                          ? t('callCenter.queue.videoLabel')
                          : t('callCenter.queue.voiceLabel')}
                      </StatusChip>
                      <StatusChip
                        tone={
                          detail.call.state === 'active' ? 'success'
                            : detail.call.state === 'ringing' ? 'warning'
                            : detail.call.state === 'missed' || detail.call.state === 'failed' ? 'danger'
                            : 'neutral'
                        }
                        dot
                        pulse={detail.call.state === 'active' || detail.call.state === 'ringing'}
                      >
                        {callStateLabel(t, detail.call.state)}
                      </StatusChip>
                      <RecordingBadge capability={overview?.recording} meta={recordingMeta} />
                      {detail.call.end_reason && (
                        <StatusChip tone="neutral">{endReasonLabel(t, detail.call.end_reason)}</StatusChip>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {detail.call.state === 'pending' && (
                      <>
                        <Button variant="outline" onClick={() => reject(detail.call.id)}>
                          {t('callCenter.desk.decline')}
                        </Button>
                        <Button onClick={() => accept(detail.call.id)} disabled={busy === detail.call.id}>
                          {busy === detail.call.id
                            ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                            : <PhoneCall className="me-1.5 h-4 w-4" />}
                          {busy === detail.call.id ? t('callCenter.desk.answering') : t('callCenter.desk.answer')}
                        </Button>
                      </>
                    )}
                    {isActive && !(accepted && accepted.callId === detail.call.id) && (
                      <>
                        <TransferCallDialog
                          workspaceId={workspace?.id}
                          callId={detail.call.id}
                          enabled={transferEnabled}
                        />
                        <Button variant="destructive" onClick={() => endActive(detail.call.id)}>
                          <PhoneOff className="me-1.5 h-4 w-4" /> {t('callCenter.queue.end')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Panel>

              {/* Media console — every live control lives in its toolbar. */}
              {accepted && accepted.callId === detail.call.id ? (
                <OperatorMediaConsole
                  callId={accepted.callId}
                  callType={accepted.callType}
                  connect={accepted.connect}
                  token={accepted.token}
                  visitorName={detail.call.visitor_name || detail.call.visitor_email || detail.call.visitor_phone || null}
                  onEnd={endFromConsole}
                  onReconnect={reconnectFromConsole}
                  externalEndedReason={externalEndedReason}
                  onEndedConfirmed={() => {
                    setWrapUpCallId(accepted.callId);
                    setAccepted(null);
                  }}
                  toolbarSlot={({ isLive }) => (
                    <>
                      <RecordingToolbarButton rec={recording} />
                      {isLive && (
                        <TransferCallDialog
                          workspaceId={workspace?.id}
                          callId={accepted.callId}
                          enabled={transferEnabled}
                          variant="console"
                        />
                      )}
                    </>
                  )}
                  statusSlot={
                    // Only take a row of the operator's screen when recording
                    // is actually in play: available for this call, already
                    // captured, or failed and needing attention. A workspace
                    // with recording switched off gets no strip at all.
                    recording.effective || recording.hasArtifact || recording.state === 'failed'
                      ? <RecordingStatusStrip rec={recording} recordingsHref={`${base}/recordings`} />
                      : null
                  }
                />
              ) : wrapUpCallId === detail.call.id ? (
                /* Wrap-up — the few seconds after hang-up when an operator
                   records what the call was about. */
                <Panel glow className="space-y-3">
                  <SectionHeading
                    icon={FileText}
                    title={t('callCenter.desk.wrapUp')}
                    hint={t('callCenter.desk.wrapUpHint')}
                    action={
                      <Button size="sm" variant="ghost" onClick={() => setWrapUpCallId(null)}>
                        {t('callCenter.desk.closeWrapUp')}
                      </Button>
                    }
                  />
                  <CallNotesPanel workspaceId={workspace?.id} callId={detail.call.id} compact />
                </Panel>
              ) : (
                <Panel className="border-dashed bg-muted/20">
                  <SectionHeading
                    icon={AlertTriangle}
                    tone="warning"
                    title={t('callCenter.queue.mediaIdle')}
                    hint={t('callCenter.queue.mediaIdleHint')}
                    action={
                      detail.call.state === 'pending' ? (
                        <Button size="sm" onClick={() => accept(detail.call.id)} disabled={busy === detail.call.id}>
                          <PhoneCall className="me-1.5 h-3.5 w-3.5" /> {t('callCenter.queue.acceptNow')}
                        </Button>
                      ) : undefined
                    }
                  />
                </Panel>
              )}
            </>
          )}
        </div>

        {/* ── Context ────────────────────────────────────────────────── */}
        <Panel flush className="flex min-h-0 flex-col overflow-hidden">
          {detail ? (
            <Tabs value={contextTab} onValueChange={(v) => setContextTab(v as typeof contextTab)} className="flex h-full flex-col">
              <TabsList className="m-2 mb-0 grid grid-cols-3">
                <TabsTrigger value="contact" className="gap-1.5 text-xs"><User className="h-3.5 w-3.5" />{t('callCenter.queue.contact')}</TabsTrigger>
                <TabsTrigger value="timeline" className="gap-1.5 text-xs"><History className="h-3.5 w-3.5" />{t('callCenter.queue.timeline')}</TabsTrigger>
                <TabsTrigger value="notes" className="gap-1.5 text-xs"><FileText className="h-3.5 w-3.5" />{t('callCenter.queue.notes')}</TabsTrigger>
              </TabsList>
              <div className="flex-1 space-y-3 overflow-y-auto p-3">
                <TabsContent value="contact" className="m-0 space-y-3">
                  <div className="space-y-2.5">
                    <div>
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('callCenter.queue.name')}</div>
                      <div className="text-sm font-medium">{detail.call.visitor_name || t('callCenter.common.anonymous')}</div>
                    </div>
                    {detail.call.visitor_email && (
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('callCenter.queue.email')}</div>
                        <div className="group flex items-center gap-1.5 text-sm">
                          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          <a href={`mailto:${detail.call.visitor_email}`} className="truncate hover:underline">{detail.call.visitor_email}</a>
                          <CopyButton text={detail.call.visitor_email} />
                        </div>
                      </div>
                    )}
                    {detail.call.visitor_phone && (
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('callCenter.queue.phone')}</div>
                        <div className="group flex items-center gap-1.5 text-sm">
                          <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                          <a href={`tel:${detail.call.visitor_phone}`} className="hover:underline">{detail.call.visitor_phone}</a>
                          <CopyButton text={detail.call.visitor_phone} />
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Same canonical IP/geo panel as the Inbox — resolved from
                      the call's own visitor session, never from the contact's
                      newest one. */}
                  <VisitorNetworkCard
                    workspaceId={workspace?.id}
                    profile={selectedProfile}
                    showUnknown
                    t={t}
                    locale={locale}
                  />
                  {(detail.call.page_url || detail.call.subject) && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('callCenter.queue.pageContext')}</div>
                        {detail.call.subject && (
                          <div className="text-sm"><span className="text-muted-foreground">{t('callCenter.queue.subjectLabel')}: </span>{detail.call.subject}</div>
                        )}
                        {detail.call.page_url && (
                          <div className="flex items-center gap-1.5 text-sm">
                            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <a href={detail.call.page_url} target="_blank" rel="noreferrer" className="truncate underline">
                              {detail.call.page_title || detail.call.page_url}
                            </a>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {preCall && typeof preCall === 'object' && Object.keys(preCall).length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('callCenter.queue.preCallForm')}</div>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                          {Object.entries(preCall).map(([k, v]) => (
                            <div key={k} className="contents">
                              {/* Pre-call fields are workspace-authored, so their
                                  labels are shown exactly as configured — only the
                                  empty-value placeholder is ours to localize. */}
                              <dt className="text-muted-foreground">{k}</dt>
                              <dd className="truncate font-medium">
                                {v === null || v === undefined || v === '' ? '—' : String(v)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </>
                  )}
                  <Separator />
                  <div>
                    <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">{t('callCenter.history.title')}</div>
                    <VisitorCallHistory
                      workspaceId={workspace?.id}
                      currentCallId={detail.call.id}
                      sessionId={selectedSessionId}
                      email={detail.call.visitor_email}
                      phone={detail.call.visitor_phone}
                      logHref={`${base}/calls`}
                    />
                  </div>
                </TabsContent>

                <TabsContent value="timeline" className="m-0">
                  {detail.events.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">{t('callCenter.queue.noEvents')}</p>
                  ) : (
                    <ol className="relative space-y-3 ps-4 before:absolute before:start-1 before:top-1.5 before:bottom-1.5 before:w-px before:bg-border">
                      {detail.events.map((e) => (
                        <li key={e.id} className="relative">
                          <span className="absolute -start-[14px] top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card" />
                          <div className="text-[10px] tabular-nums text-muted-foreground">{formatTime(e.created_at)}</div>
                          <div className="text-xs font-medium">{callEventLabel(t, e.event_type)}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </TabsContent>

                <TabsContent value="notes" className="m-0">
                  <CallNotesPanel workspaceId={workspace?.id} callId={detail.call.id} />
                </TabsContent>
              </div>
            </Tabs>
          ) : (
            <EmptyState
              className="h-full"
              icon={ChevronRight}
              title={t('callCenter.queue.selectCallToView')}
            />
          )}
        </Panel>
      </div>
    </div>
    </TooltipProvider>
  );
}
