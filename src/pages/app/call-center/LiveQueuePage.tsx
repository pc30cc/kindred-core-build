/**
 * Call Center — operator Live Desk.
 *
 * The agent desktop: a waiting queue on one side, the call being handled in
 * the middle, and the visitor's context on the other side. Everything an
 * operator does during a call (mute, camera, devices, record, transfer,
 * hang up) lives in ONE toolbar inside the media console — there is no second
 * place to look and no decorative control that does nothing.
 *
 * All backend vocabulary (call state, end reason, timeline event type,
 * recording state) is rendered through `@/features/calls/callLabels`, so the
 * desk reads in the operator's own language instead of leaking raw codes.
 */
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { VisitorNetworkCard, VisitorNetworkInline } from '@/features/visitors/VisitorNetworkCard';
import { useVisitorNetworkBatchBySession } from '@/hooks/useVisitorNetwork';
import { useGeoEnrichmentRealtime } from '@/hooks/useGeoEnrichmentRealtime';
import {
  useCallCenterQueue, useCallCenterCall, useCallCenterOverview,
  useCallCenterSettings, useCallCenterCalls,
} from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
  Disc,
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
  let tone = 'bg-muted text-muted-foreground';
  if (!effective) {
    label = recordingReasonLabel(t, capability?.reason);
  } else if (state === 'consent_pending') {
    label = recordingStateLabel(t, 'consent_pending');
    tone = 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  } else if (state === 'recording') {
    label = recordingStateLabel(t, 'recording');
    tone = 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
  } else if (state === 'failed') {
    label = recordingStateLabel(t, 'failed');
    tone = 'bg-destructive/15 text-destructive';
  } else if (state === 'available') {
    label = recordingStateLabel(t, 'available');
    tone = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  } else if (state === 'pending' || state === 'finalizing') {
    label = recordingStateLabel(t, state);
    tone = 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  } else {
    label = recordingStateLabel(t, 'ready');
    tone = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }

  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full', tone)}>
      <Disc className={cn('h-3 w-3', state === 'recording' && 'animate-pulse')} />
      {label}
    </span>
  );
}

function urgencyTone(iso: string): 'neutral' | 'warn' | 'danger' {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec > SLA_BREACH_SECONDS) return 'danger';
  if (sec > SLA_WARN_SECONDS) return 'warn';
  return 'neutral';
}

function StatChip({
  label, value, icon: Icon, tone = 'muted',
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'primary';
}) {
  const map = {
    muted: 'bg-muted/60 text-foreground ring-border',
    primary: 'bg-primary/10 text-primary ring-primary/20',
    ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20',
    warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/20',
    danger: 'bg-destructive/10 text-destructive ring-destructive/20',
  } as const;
  return (
    <div className={cn('rounded-lg px-3 py-2 ring-1 flex items-center gap-2.5 min-w-[110px]', map[tone])}>
      {Icon && <Icon className="h-4 w-4 opacity-80" />}
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm font-semibold tabular-nums">{value}</div>
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
      className="opacity-60 hover:opacity-100 transition-opacity"
      title={copied ? t('callCenter.desk.copied') : t('callCenter.desk.copy')}
      aria-label={t('callCenter.desk.copy')}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
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
        const cc = c as unknown as { visitor_session_id?: string | null };
        if (sessionId && cc.visitor_session_id === sessionId) return true;
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
              ? <Video className="h-3 w-3 text-muted-foreground shrink-0" />
              : <Phone className="h-3 w-3 text-muted-foreground shrink-0" />}
            <span className="truncate">{callStateLabel(t, c.state)}</span>
            <span className="text-muted-foreground tabular-nums ms-auto shrink-0">
              {c.duration_seconds ? clock(c.duration_seconds) : t('callCenter.history.noDuration')}
            </span>
            <span className="text-muted-foreground shrink-0">{formatTime(c.created_at)}</span>
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
    <div className="flex flex-col h-full gap-4">
      {/* Command bar */}
      <Card className="p-3 flex flex-wrap items-center gap-3 bg-gradient-to-r from-primary/5 via-background to-background border-primary/10">
        <div className="flex items-center gap-2.5 me-2">
          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center ring-1 ring-primary/20">
            <Headphones className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">{t('callCenter.queue.liveDesk')}</div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <RadioTower className="h-3 w-3" /> {t('callCenter.queue.livePolling')}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 ms-auto">
          <StatChip label={t('callCenter.queue.chips.waiting')} icon={Inbox}
            value={overview?.waiting_calls ?? rawQueue.length}
            tone={(overview?.waiting_calls ?? 0) > 0 ? 'warn' : 'muted'} />
          <StatChip label={t('callCenter.queue.chips.active')} icon={Activity}
            value={overview?.active_calls ?? 0}
            tone={(overview?.active_calls ?? 0) > 0 ? 'ok' : 'muted'} />
          <StatChip label={t('callCenter.queue.chips.longestWait')} icon={Clock}
            value={queueStats.count > 0 ? clock(queueStats.longest) : '—'}
            tone={queueStats.longest > SLA_BREACH_SECONDS ? 'danger'
              : queueStats.longest > SLA_WARN_SECONDS ? 'warn' : 'muted'} />
          <StatChip label={t('callCenter.queue.chips.slaBreached')} icon={AlertTriangle}
            value={queueStats.breached}
            tone={queueStats.breached > 0 ? 'danger' : 'muted'} />
          <StatChip label={t('callCenter.queue.chips.missedToday')} icon={PhoneOff}
            value={overview?.missed_today ?? 0}
            tone={(overview?.missed_today ?? 0) > 0 ? 'danger' : 'muted'} />
          <StatChip label={t('callCenter.queue.chips.today')} icon={PhoneCall}
            value={overview?.today_calls ?? 0} tone="primary" />
          <StatChip label={t('callCenter.queue.chips.callsService')} icon={RadioTower}
            value={overview?.provider?.ready ? t('callCenter.queue.chips.ready') : t('callCenter.queue.chips.down')}
            tone={overview?.provider?.ready ? 'ok' : 'danger'} />
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)_340px] gap-4 flex-1 min-h-0">
        {/* Queue column */}
        <Card className="flex flex-col overflow-hidden p-0">
          <div className="px-3 pt-3 pb-2 border-b bg-muted/30">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                <Inbox className="h-3.5 w-3.5" />
                {t('callCenter.queue.queueTitle')}
                <Badge variant="secondary" className="ms-1 h-5 px-1.5 text-[10px]">
                  {queue.length}
                  {queue.length !== rawQueue.length && <span className="opacity-60">/{rawQueue.length}</span>}
                </Badge>
              </h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon" variant="ghost" className="h-6 w-6"
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
            </div>
            <div className="relative mb-2">
              <Search className="h-3.5 w-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('callCenter.queue.searchPlaceholder')}
                className="h-8 ps-8 text-xs"
              />
            </div>
            <div className="flex gap-1">
              {([
                { k: 'all', label: t('callCenter.queue.filterAll'), count: rawQueue.length },
                { k: 'voice', label: t('callCenter.queue.filterVoice'), count: queueStats.voice, icon: Phone },
                { k: 'video', label: t('callCenter.queue.filterVideo'), count: queueStats.video, icon: Video },
              ] as const).map((opt) => {
                const OptIcon = (opt as { icon?: React.ComponentType<{ className?: string }> }).icon;
                return (
                <button
                  key={opt.k}
                  onClick={() => setChannelFilter(opt.k)}
                  className={cn(
                    'flex-1 inline-flex items-center justify-center gap-1.5 text-[11px] py-1 rounded-md border transition-colors',
                    channelFilter === opt.k
                      ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                      : 'border-transparent text-muted-foreground hover:bg-muted',
                  )}
                >
                  {OptIcon ? <OptIcon className="h-3 w-3" /> : null}
                  {opt.label}
                  <span className="text-[10px] opacity-60">{opt.count}</span>
                </button>
                );
              })}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {isLoading && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-24 rounded-lg bg-muted/40 animate-pulse" />
              ))}
            </div>
          )}
          {!isLoading && queue.length === 0 && rawQueue.length === 0 && (
            <Card className="p-6 text-center space-y-3">
              <Headphones className="h-8 w-8 mx-auto text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{t('callCenter.queue.noCallsWaiting')}</p>
                <p className="text-xs text-muted-foreground">{t('callCenter.queue.noCallsHint')}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button asChild size="sm" variant="outline"><Link to={`${base}/install`}>{t('callCenter.queue.installWidget')}</Link></Button>
                <Button asChild size="sm" variant="ghost"><Link to={`${base}/settings`}>{t('callCenter.queue.openSettings')}</Link></Button>
              </div>
            </Card>
          )}
          {!isLoading && queue.length === 0 && rawQueue.length > 0 && (
            <div className="text-xs text-muted-foreground text-center p-6">
              {t('callCenter.queue.noMatches')}
            </div>
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
                  'group relative rounded-lg border bg-card cursor-pointer transition-all overflow-hidden',
                  isSel
                    ? 'border-primary shadow-sm ring-1 ring-primary/30'
                    : 'border-border hover:border-primary/40 hover:shadow-sm',
                  tone === 'danger' && !isSel && 'border-destructive/40',
                )}
              >
                {/* Urgency stripe */}
                <div className={cn(
                  'absolute start-0 top-0 bottom-0 w-1',
                  tone === 'danger' ? 'bg-destructive' : tone === 'warn' ? 'bg-amber-500' : 'bg-emerald-500',
                )} />
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
                      <div className={cn(
                        'absolute -bottom-0.5 -end-0.5 h-4 w-4 rounded-full flex items-center justify-center ring-2 ring-card',
                        isVideo ? 'bg-indigo-500 text-white' : 'bg-emerald-500 text-white',
                      )}>
                        {isVideo ? <Video className="h-2.5 w-2.5" /> : <Phone className="h-2.5 w-2.5" />}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <div className="font-medium truncate text-sm">{name}</div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted ms-auto tabular-nums">#{idx + 1}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <div className={cn(
                          'text-[11px] tabular-nums font-medium flex items-center gap-1',
                          tone === 'danger' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                        )}>
                          <Clock className="h-3 w-3" />
                          {clock(waitSec)}
                        </div>
                        {q.priority > 0 && (
                          <Badge variant="outline" className="h-4 px-1 text-[9px]">P{q.priority}</Badge>
                        )}
                        {isAccepted && (
                          <Badge className="h-4 px-1 text-[9px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
                            {t('callCenter.queue.onCallBadge')}
                          </Badge>
                        )}
                      </div>
                      {c?.subject && (
                        <div className="text-[11px] text-muted-foreground truncate mt-1">{c.subject}</div>
                      )}
                      {c?.page_title && (
                        <div className="text-[10px] text-muted-foreground truncate mt-0.5 flex items-center gap-1">
                          <Globe className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{c.page_title}</span>
                        </div>
                      )}
                      <div className="mt-0.5 truncate">
                        <VisitorNetworkInline
                          profile={
                            c?.visitor_session_id
                              ? networkBySession?.[c.visitor_session_id] ?? null
                              : null
                          }
                          t={t}
                          locale={locale}
                        />
                      </div>
                    </div>
                  </div>
                  {/* SLA bar */}
                  <div className="mt-2.5 h-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        'h-full transition-all',
                        tone === 'danger' ? 'bg-destructive' : tone === 'warn' ? 'bg-amber-500' : 'bg-emerald-500',
                      )}
                      style={{ width: `${slaPct}%` }}
                    />
                  </div>
                  <div className="flex gap-1.5 mt-2.5">
                    <Button
                      variant="outline" size="sm" className="flex-1 h-7 text-xs"
                      onClick={(e) => { e.stopPropagation(); reject(q.call_session_id); }}
                      disabled={busy === q.call_session_id || isAccepted}
                    >
                      {t('callCenter.desk.decline')}
                    </Button>
                    <Button
                      size="sm" className="flex-1 h-7 text-xs"
                      onClick={(e) => { e.stopPropagation(); accept(q.call_session_id); }}
                      disabled={busy === q.call_session_id || isAccepted}
                    >
                      {busy === q.call_session_id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : isAccepted ? t('callCenter.queue.onCall') : (<><PhoneCall className="h-3 w-3 me-1" />{t('callCenter.desk.answer')}</>)}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </Card>

        {/* Active call column */}
        <div className="space-y-3 overflow-y-auto min-h-0">
          {!detail ? (
            <Card className="p-16 text-center border-dashed">
              <div className="h-16 w-16 rounded-full bg-primary/5 mx-auto flex items-center justify-center mb-4 ring-1 ring-primary/10">
                <PhoneCall className="h-7 w-7 text-primary/60" />
              </div>
              <p className="text-base font-semibold">{t('callCenter.queue.noCallSelected')}</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
                {t('callCenter.queue.noCallSelectedHint')}
              </p>
            </Card>
          ) : (
            <>
              <Card className="p-5 bg-gradient-to-br from-primary/5 via-card to-card border-primary/20 overflow-hidden relative">
                {detail.call.state === 'ringing' && (
                  <div className="absolute top-0 inset-x-0 h-0.5 bg-amber-500 animate-pulse" />
                )}
                <div className="flex items-start gap-4 flex-wrap">
                  <div className="relative shrink-0">
                    <ContactAvatar
                      name={visitorLabel}
                      email={detail.call.visitor_email}
                      os={selectedProfile?.device?.os}
                      device={selectedProfile?.device?.device}
                      countryCode={selectedProfile?.geo?.country_code}
                      size="lg"
                    />
                    <div className={cn(
                      'absolute -bottom-0.5 -end-0.5 h-5 w-5 rounded-full flex items-center justify-center ring-2 ring-card',
                      detail.call.call_type === 'video' ? 'bg-indigo-500 text-white' : 'bg-emerald-500 text-white',
                    )}>
                      {detail.call.call_type === 'video' ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xl font-semibold leading-tight truncate">{visitorLabel}</div>
                    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
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
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      <Badge variant="secondary">
                        {detail.call.call_type === 'video'
                          ? t('callCenter.queue.videoLabel')
                          : t('callCenter.queue.voiceLabel')}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          detail.call.state === 'active' && 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10',
                          detail.call.state === 'ringing' && 'border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/10',
                          detail.call.state === 'ended' && 'border-muted text-muted-foreground',
                        )}
                      >
                        {callStateLabel(t, detail.call.state)}
                      </Badge>
                      <RecordingBadge capability={overview?.recording} meta={recordingMeta} />
                      {detail.call.end_reason && (
                        <Badge variant="outline" className="text-muted-foreground">
                          {endReasonLabel(t, detail.call.end_reason)}
                        </Badge>
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
                            ? <Loader2 className="h-4 w-4 animate-spin me-1.5" />
                            : <PhoneCall className="h-4 w-4 me-1.5" />}
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
                          <PhoneOff className="h-4 w-4 me-1.5" /> {t('callCenter.queue.end')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Card>

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
                <Card className="p-4 space-y-3 border-primary/30">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <div className="flex-1">
                      <div className="text-sm font-semibold">{t('callCenter.desk.wrapUp')}</div>
                      <p className="text-xs text-muted-foreground">{t('callCenter.desk.wrapUpHint')}</p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setWrapUpCallId(null)}>
                      {t('callCenter.desk.closeWrapUp')}
                    </Button>
                  </div>
                  <CallNotesPanel workspaceId={workspace?.id} callId={detail.call.id} compact />
                </Card>
              ) : (
                <Card className="p-5 border-dashed bg-muted/20 flex items-start gap-3">
                  <div className="h-8 w-8 rounded-full bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  <div className="text-sm flex-1">
                    <div className="font-semibold">{t('callCenter.queue.mediaIdle')}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('callCenter.queue.mediaIdleHint')}
                    </p>
                  </div>
                  {detail.call.state === 'pending' && (
                    <Button size="sm" onClick={() => accept(detail.call.id)} disabled={busy === detail.call.id}>
                      <PhoneCall className="h-3.5 w-3.5 me-1.5" /> {t('callCenter.queue.acceptNow')}
                    </Button>
                  )}
                </Card>
              )}
            </>
          )}
        </div>

        {/* Context column */}
        <Card className="flex flex-col overflow-hidden p-0 min-h-0">
          {detail ? (
            <Tabs value={contextTab} onValueChange={(v) => setContextTab(v as typeof contextTab)} className="flex flex-col h-full">
              <TabsList className="grid grid-cols-3 m-2 mb-0">
                <TabsTrigger value="contact" className="text-xs gap-1.5"><User className="h-3.5 w-3.5" />{t('callCenter.queue.contact')}</TabsTrigger>
                <TabsTrigger value="timeline" className="text-xs gap-1.5"><History className="h-3.5 w-3.5" />{t('callCenter.queue.timeline')}</TabsTrigger>
                <TabsTrigger value="notes" className="text-xs gap-1.5"><FileText className="h-3.5 w-3.5" />{t('callCenter.queue.notes')}</TabsTrigger>
              </TabsList>
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                <TabsContent value="contact" className="m-0 space-y-3">
                  <div className="space-y-2.5">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t('callCenter.queue.name')}</div>
                      <div className="text-sm font-medium">{detail.call.visitor_name || t('callCenter.common.anonymous')}</div>
                    </div>
                    {detail.call.visitor_email && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t('callCenter.queue.email')}</div>
                        <div className="text-sm flex items-center gap-1.5 group">
                          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          <a href={`mailto:${detail.call.visitor_email}`} className="hover:underline truncate">{detail.call.visitor_email}</a>
                          <CopyButton text={detail.call.visitor_email} />
                        </div>
                      </div>
                    )}
                    {detail.call.visitor_phone && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t('callCenter.queue.phone')}</div>
                        <div className="text-sm flex items-center gap-1.5 group">
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
                          <div className="text-sm flex items-center gap-1.5">
                            <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <a href={detail.call.page_url} target="_blank" rel="noreferrer" className="underline truncate">
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
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">{t('callCenter.history.title')}</div>
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
                    <p className="text-xs text-muted-foreground text-center py-6">{t('callCenter.queue.noEvents')}</p>
                  ) : (
                    <ol className="relative space-y-3 ps-4 before:absolute before:start-1 before:top-1.5 before:bottom-1.5 before:w-px before:bg-border">
                      {detail.events.map((e) => (
                        <li key={e.id} className="relative">
                          <span className="absolute -start-[14px] top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
                          <div className="text-[10px] text-muted-foreground tabular-nums">{formatTime(e.created_at)}</div>
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
            <div className="p-8 text-center text-xs text-muted-foreground">
              <ChevronRight className="h-5 w-5 mx-auto mb-2 opacity-40" />
              {t('callCenter.queue.selectCallToView')}
            </div>
          )}
        </Card>
      </div>
    </div>
    </TooltipProvider>
  );
}
