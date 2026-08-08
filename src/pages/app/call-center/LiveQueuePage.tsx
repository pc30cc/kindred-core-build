import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { VisitorNetworkCard, VisitorNetworkInline } from '@/features/visitors/VisitorNetworkCard';
import { useVisitorNetworkBatchBySession } from '@/hooks/useVisitorNetwork';
import { useGeoEnrichmentRealtime } from '@/hooks/useGeoEnrichmentRealtime';
import { useCallCenterQueue, useCallCenterCall, useCallCenterOverview, useCallCenterSettings } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { callCenterApi, type CallCenterRecordingStatus } from '@/lib/call-center-api';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import {
  Phone, Video, Globe, Headphones, RadioTower, Inbox, PhoneOff, MicOff,
  CameraOff, ArrowRightLeft, PhoneCall, AlertTriangle, Disc, Square, Loader2, RefreshCw,
  Search, Clock, User, Mail, Smartphone, Copy, Check, ChevronRight, Activity,
  FileText, History, ArrowUp, ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link, useParams } from 'react-router-dom';
import OperatorMediaConsole, { type OperatorConnectInfo } from '@/components/call-center/OperatorMediaConsole';
import { useTranslation } from '@/i18n';

function RecordingBadge({ rec, meta }: { rec?: any; meta?: any }) {
  const state = meta?.state as string | undefined;
  const effective = !!rec?.effective_enabled;
  let label = 'Recording off';
  let tone = 'bg-muted text-muted-foreground';
  if (!effective) {
    label = rec?.reason === 'provider_not_supported' ? 'Recording: provider not supported'
      : rec?.reason === 'provider_not_configured' ? 'Recording: provider not configured'
      : rec?.reason === 'workspace_disabled' ? 'Recording: off (workspace)'
      : rec?.reason === 'platform_disabled' ? 'Recording: off (platform)'
      : 'Recording off';
  } else if (state === 'consent_pending') { label = 'Awaiting consent'; tone = 'bg-amber-500/15 text-amber-700 dark:text-amber-300'; }
  else if (state === 'recording') { label = '● Recording'; tone = 'bg-rose-500/15 text-rose-700 dark:text-rose-300'; }
  else if (state === 'failed') { label = 'Recording failed'; tone = 'bg-destructive/15 text-destructive'; }
  else if (state === 'ready' || state === 'pending') { label = 'Recording configured'; tone = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'; }
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full', tone)}>
      {label}
    </span>
  );
}

function RecordingControlBar({ workspaceId, callId, callConnected }: { workspaceId: string; callId: string; callConnected: boolean }) {
  const qc = useQueryClient();
  const { data: status, refetch, isFetching } = useQuery<CallCenterRecordingStatus>({
    queryKey: ['call-center', 'recording-status', workspaceId, callId],
    queryFn: () => callCenterApi.getRecordingStatus(workspaceId, callId),
    enabled: !!callId,
    refetchInterval: 4000,
  });
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);

  const cap = status?.capability;
  const state = status?.recording_state || 'disabled';
  const effective = !!cap?.effective_enabled;
  const consentOk = !cap?.consent_required || !!status?.consent_given;
  const isRecording = state === 'recording';
  const isPending = state === 'pending';
  const isFinalizing = state === 'finalizing';
  const isAvailable = state === 'available';
  const isReady = effective && consentOk && (state === 'disabled' || state === 'failed');

  let label = 'Recording disabled';
  let tone = 'text-muted-foreground';
  if (!effective) {
    label = cap?.reason === 'provider_not_supported' ? 'Provider not supported'
      : cap?.reason === 'provider_not_configured' ? 'Provider not configured'
      : cap?.reason === 'workspace_disabled' ? 'Disabled (workspace)'
      : cap?.reason === 'platform_disabled' ? 'Disabled (platform)'
      : 'Recording disabled';
  } else if (!consentOk) { label = 'Consent missing'; tone = 'text-amber-600'; }
  else if (isRecording) { label = '● Recording'; tone = 'text-rose-600'; }
  else if (isPending) { label = 'Starting…'; tone = 'text-amber-600'; }
  else if (isFinalizing) { label = 'Finalizing…'; tone = 'text-amber-600'; }
  else if (isAvailable) { label = 'Recording captured'; tone = 'text-emerald-600'; }
  else if (state === 'failed') { label = 'Failed: ' + (status?.last_error || 'recording_failed'); tone = 'text-destructive'; }
  else if (isReady) { label = 'Ready to record'; tone = 'text-emerald-600'; }

  // Allow start only from a clean/disabled/failed state — not from available, recording, pending, or finalizing.
  const canStart =
    effective && consentOk && callConnected && busy === null
    && (state === 'disabled' || state === 'failed');
  const canStop = (isRecording || isPending) && busy === null;

  async function start() {
    setBusy('start');
    try {
      await callCenterApi.startRecording(workspaceId, callId, 'composite');
      await refetch();
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: any) {
      const code = String(e?.message || '');
      const friendly =
        code.includes('recording_consent_missing') ? 'Visitor consent is required.'
        : code.includes('provider_not_configured') ? 'Provider egress is not configured.'
        : code.includes('provider_not_supported') ? 'Provider does not support recording.'
        : code.includes('room_not_ready') ? 'Call room is not ready yet.'
        : code.includes('recording_disabled') ? 'Recording is disabled.'
        : 'Could not start recording.';
      toast({ title: 'Start recording failed', description: friendly, variant: 'destructive' });
    } finally { setBusy(null); }
  }
  async function stop() {
    setBusy('stop');
    try {
      await callCenterApi.stopRecording(workspaceId, callId);
      await refetch();
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: any) {
      toast({ title: 'Stop recording failed', description: String(e?.message || ''), variant: 'destructive' });
    } finally { setBusy(null); }
  }

  return (
    <Card className="p-3 flex flex-wrap items-center gap-2">
      <Disc className={cn('h-4 w-4', isRecording ? 'text-rose-600 animate-pulse' : 'text-muted-foreground')} />
      <div className="text-sm">
        <div className={cn('font-medium', tone)}>{label}</div>
        {status?.recording_id_masked && (
          <div className="text-[10px] text-muted-foreground font-mono">id: {status.recording_id_masked}</div>
        )}
      </div>
      <div className="ms-auto flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching} title="Refresh status">
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
        </Button>
        {canStop ? (
          <Button size="sm" variant="destructive" onClick={stop} disabled={busy !== null}>
            {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <Square className="h-3.5 w-3.5 me-1.5" />}
            Stop recording
          </Button>
        ) : (
          <Button size="sm" onClick={start} disabled={!canStart}>
            {busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <Disc className="h-3.5 w-3.5 me-1.5" />}
            Start recording
          </Button>
        )}
      </div>
      {state === 'available' && (
        <p className="basis-full text-[11px] text-muted-foreground">
          Recording artifact captured. Playback/download will be added later.
        </p>
      )}
    </Card>
  );
}

function waitTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function urgencyTone(iso: string): 'neutral' | 'warn' | 'danger' {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec > 180) return 'danger';
  if (sec > 60) return 'warn';
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

function formatWait(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${r.toString().padStart(2, '0')}` : `0:${r.toString().padStart(2, '0')}`;
}

function CopyButton({ text }: { text: string }) {
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
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export default function LiveQueuePage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { slug } = useParams();
  const base = `/app/w/${slug}/call-center`;
  const { data, isLoading } = useCallCenterQueue(workspace?.id);
  const { data: overview } = useCallCenterOverview(workspace?.id);
  const { data: settingsBundle } = useCallCenterSettings(workspace?.id);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
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
  const { data: detail } = useCallCenterCall(workspace?.id, selectedCallId);
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  // Operator-side new-call notification sound. Plays a short chime whenever
  // a fresh entry appears in the queue (governed by platform setting).
  const knownCallIdsRef = useRef<{ set: Set<string>; primed: boolean }>({ set: new Set(), primed: false });
  useEffect(() => {
    const enabled = (settingsBundle as any)?.platform?.operator_new_call_sound_enabled !== false;
    if (!enabled) return;
    const ids = (data?.queue || []).map((q: any) => q.call_session_id).filter(Boolean) as string[];
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
      const C = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!C) return;
      const ctx = new C();
      if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch { /* */ } }
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
      setTimeout(() => { try { ctx.close(); } catch { /* */ } }, 1200);
    } catch { /* swallow */ }
  }, [data?.queue, settingsBundle]);

  // Faster status sync while in active console
  useEffect(() => {
    if (!accepted?.callId) return;
    const t = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['call-center'] });
    }, 5000);
    return () => clearInterval(t);
  }, [accepted?.callId, qc]);

  const rawQueue = data?.queue || [];
  const queue = useMemo(() => {
    const q = (rawQueue as any[]).filter((entry) => {
      const c = entry.call_session;
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
      (rawQueue as any[]).map(
        (q) => q.call_session?.visitor_session_id || q.visitor_session_id || null,
      ),
    [rawQueue],
  );
  const { data: networkBySession } = useVisitorNetworkBatchBySession(workspace?.id, queueSessionIds);
  const selectedSessionId =
    (detail as any)?.call?.visitor_session_id ||
    (rawQueue as any[]).find((q) => q.call_session_id === selectedCallId)?.call_session
      ?.visitor_session_id ||
    null;
  const selectedProfile = selectedSessionId ? networkBySession?.[selectedSessionId] ?? null : null;

  // Queue analytics
  const queueStats = useMemo(() => {
    if (rawQueue.length === 0) return { count: 0, longest: 0, avg: 0, voice: 0, video: 0, breached: 0 };
    const now = Date.now();
    const waits = rawQueue.map((q: any) => Math.floor((now - new Date(q.created_at).getTime()) / 1000));
    const longest = Math.max(...waits);
    const avg = Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);
    const voice = rawQueue.filter((q: any) => (q.channel || 'voice') !== 'video').length;
    const video = rawQueue.length - voice;
    const breached = waits.filter((w) => w > 180).length;
    return { count: rawQueue.length, longest, avg, voice, video, breached };
  }, [rawQueue]);

  // Auto-select first queue item — done in effect, not during render
  useEffect(() => {
    // While a call is accepted, keep selection pinned to it so the media
    // console stays mounted even after the queue removes the accepted entry.
    if (accepted?.callId) {
      if (selectedCallId !== accepted.callId) setSelectedCallId(accepted.callId);
      return;
    }
    if (queue.length === 0) {
      if (selectedCallId) setSelectedCallId(null);
      return;
    }
    const stillThere = selectedCallId && queue.some((q) => q.call_session_id === selectedCallId);
    if (!stillThere) {
      const next = queue[0]?.call_session_id ?? null;
      setSelectedCallId(next);
    }
  }, [queue, selectedCallId, accepted?.callId]);

  async function accept(callId: string) {
    if (!workspace) return;
    setBusy(callId);
    try {
      const r = await callCenterApi.acceptCall(workspace.id, callId);
      const connect = (r as any).connect as OperatorConnectInfo | undefined;
      const callType = ((detail?.call?.call_type as string) || 'voice');
      if (connect && r.token) {
        setAccepted({ callId, token: r.token, connect, callType });
        setSelectedCallId(callId);
        if (!connect.supported) {
          toast({
            title: 'Accepted, but media not available',
            description: connect.reason || 'Provider client not configured.',
            variant: 'destructive',
          });
        }
      }
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: any) {
      toast({ title: 'Accept failed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  }
  async function reject(callId: string) {
    if (!workspace) return;
    setBusy(callId);
    try {
      await callCenterApi.rejectCall(workspace.id, callId);
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: any) {
      toast({ title: 'Reject failed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  }
  async function endActive(callId: string) {
    if (!workspace) return;
    await callCenterApi.endCall(workspace.id, callId);
    qc.invalidateQueries({ queryKey: ['call-center'] });
  }

  async function endFromConsole() {
    const id = accepted?.callId;
    if (!id || !workspace) { setAccepted(null); return; }
    // Backend-first; throw on failure so console shows Retry.
    await callCenterApi.endCall(workspace.id, id);
    qc.invalidateQueries({ queryKey: ['call-center'] });
    // Do NOT clear `accepted` here — OperatorMediaConsole will show
    // the "Call ended" state briefly and call onEndedConfirmed.
  }

  async function reconnectFromConsole(): Promise<{ token: string; connect: OperatorConnectInfo } | null> {
    if (!workspace || !accepted?.callId) return null;
    const r = await callCenterApi.acceptCall(workspace.id, accepted.callId);
    const c = (r as any).connect as OperatorConnectInfo | undefined;
    if (!c || !r.token) return null;
    setAccepted({ callId: accepted.callId, token: r.token, connect: c, callType: accepted.callType });
    return { token: r.token, connect: c };
  }

  const meta = (detail?.call as any)?.metadata || {};
  const preCall = meta?.pre_call_form || meta?.preCallForm || null;
  const isActive = detail && ['active', 'ringing', 'connecting'].includes(detail.call.state);

  // Detect external end from backend state for the active console call
  const externalEndedReason = useMemo<
    'ended_by_visitor' | 'ended_by_operator' | 'cancelled' | 'failed' | null
  >(() => {
    if (!accepted || !detail || detail.call.id !== accepted.callId) return null;
    const s = detail.call.state;
    const reason = (detail.call as any).end_reason as string | null | undefined;
    if (s === 'ended') {
      if (reason === 'visitor_ended' || reason === 'visitor_cancelled') return 'ended_by_visitor';
      if (reason === 'operator_ended') return 'ended_by_operator';
      return 'ended_by_visitor';
    }
    if (s === 'cancelled') return 'cancelled';
    if (s === 'missed' || s === 'failed') return 'failed';
    return null;
  }, [accepted, detail]);

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
            value={queueStats.count > 0
              ? `${Math.floor(queueStats.longest / 60)}:${(queueStats.longest % 60).toString().padStart(2, '0')}`
              : '—'}
            tone={queueStats.longest > 180 ? 'danger' : queueStats.longest > 60 ? 'warn' : 'muted'} />
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
                const OptIcon = (opt as any).icon as React.ComponentType<{ className?: string }> | undefined;
                return (
                <button
                  key={opt.k}
                  onClick={() => setChannelFilter(opt.k as any)}
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
          {!isLoading && queue.length === 0 && (
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
          {queue.map((q: any, idx: number) => {
            const c = q.call_session;
            const tone = urgencyTone(q.created_at);
            const isSel = selectedCallId === q.call_session_id;
            const isAccepted = accepted?.callId === q.call_session_id;
            const waitSec = Math.floor((Date.now() - new Date(q.created_at).getTime()) / 1000);
            const slaPct = Math.min(100, (waitSec / 180) * 100);
            const isVideo = q.channel === 'video' || c?.call_type === 'video';
            const name = c?.visitor_name || c?.visitor_email || c?.visitor_phone || t('callCenter.common.anonymous');
            const initial = name.slice(0, 1).toUpperCase();
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
                      <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 text-primary flex items-center justify-center text-sm font-semibold ring-1 ring-primary/15">
                        {initial}
                      </div>
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
                          {formatWait(q.created_at)}
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
                          t={t as any}
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
                      {t('callCenter.queue.reject')}
                    </Button>
                    <Button
                      size="sm" className="flex-1 h-7 text-xs"
                      onClick={(e) => { e.stopPropagation(); accept(q.call_session_id); }}
                      disabled={busy === q.call_session_id || isAccepted}
                    >
                      {busy === q.call_session_id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : isAccepted ? t('callCenter.queue.onCall') : (<><PhoneCall className="h-3 w-3 me-1" />{t('callCenter.queue.accept')}</>)}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </Card>

        {/* Workspace column */}
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
                    <div className="h-16 w-16 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 text-primary flex items-center justify-center text-xl font-semibold ring-2 ring-primary/15">
                      {(detail.call.visitor_name || detail.call.visitor_email || 'A').slice(0, 1).toUpperCase()}
                    </div>
                    <div className={cn(
                      'absolute -bottom-0.5 -end-0.5 h-5 w-5 rounded-full flex items-center justify-center ring-2 ring-card',
                      detail.call.call_type === 'video' ? 'bg-indigo-500 text-white' : 'bg-emerald-500 text-white',
                    )}>
                      {detail.call.call_type === 'video' ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xl font-semibold leading-tight truncate">
                      {detail.call.visitor_name || detail.call.visitor_email || detail.call.visitor_phone || t('callCenter.common.anonymousVisitor')}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                      {detail.call.visitor_email && (
                        <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{detail.call.visitor_email}</span>
                      )}
                      {detail.call.visitor_phone && (
                        <span className="inline-flex items-center gap-1"><Smartphone className="h-3 w-3" />{detail.call.visitor_phone}</span>
                      )}
                      <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />
                        {new Date(detail.call.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      <Badge variant="secondary" className="capitalize">{detail.call.call_type === 'video' ? t('callCenter.queue.videoLabel') : t('callCenter.queue.voiceLabel')}</Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          'capitalize',
                          detail.call.state === 'active' && 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10',
                          detail.call.state === 'ringing' && 'border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/10',
                          detail.call.state === 'ended' && 'border-muted text-muted-foreground',
                        )}
                      >
                        {detail.call.state}
                      </Badge>
                      <RecordingBadge rec={overview?.recording} meta={(detail.call as any)?.metadata?.recording} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {detail.call.state === 'pending' && (
                      <>
                        <Button variant="outline" onClick={() => reject(detail.call.id)}>{t('callCenter.queue.reject')}</Button>
                        <Button onClick={() => accept(detail.call.id)}>
                          <PhoneCall className="h-4 w-4 me-1.5" />{t('callCenter.queue.accept')}
                        </Button>
                      </>
                    )}
                    {isActive && !(accepted && accepted.callId === detail.call.id) && (
                      <Button variant="destructive" onClick={() => endActive(detail.call.id)}>
                        <PhoneOff className="h-4 w-4 me-1.5" /> {t('callCenter.queue.end')}
                      </Button>
                    )}
                  </div>
                </div>
              </Card>

              {/* Media console */}
              {accepted && accepted.callId === detail.call.id ? (
                <>
                <OperatorMediaConsole
                  callId={accepted.callId}
                  callType={accepted.callType}
                  connect={accepted.connect}
                  token={accepted.token}
                  visitorName={detail.call.visitor_name || detail.call.visitor_email || detail.call.visitor_phone || null}
                  onEnd={endFromConsole}
                  onReconnect={reconnectFromConsole}
                  externalEndedReason={externalEndedReason}
                  onEndedConfirmed={() => setAccepted(null)}
                />
                {workspace && (
                  <RecordingControlBar
                    workspaceId={workspace.id}
                    callId={accepted.callId}
                    callConnected={['active', 'ringing', 'connecting'].includes(detail.call.state)}
                  />
                )}
                </>
              ) : (
                <Card className="p-6 border-dashed bg-muted/20">
                  <div className="flex items-start gap-3">
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
                      <Button size="sm" onClick={() => accept(detail.call.id)}>
                        <PhoneCall className="h-3.5 w-3.5 me-1.5" /> {t('callCenter.queue.acceptNow')}
                      </Button>
                    )}
                  </div>
                  <Separator className="my-4" />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { icon: MicOff, label: t('callCenter.queue.mute') },
                      { icon: CameraOff, label: t('callCenter.queue.camera') },
                      { icon: ArrowRightLeft, label: t('callCenter.queue.transfer') },
                      { icon: PhoneOff, label: t('callCenter.queue.end') },
                    ].map((b) => (
                      <div key={b.label} className="flex items-center justify-center gap-1.5 h-9 text-xs rounded-md border border-dashed text-muted-foreground">
                        <b.icon className="h-3.5 w-3.5" />{b.label}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Page context */}
              {(detail.call.page_url || detail.call.subject) && (
                <Card className="p-4 space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('callCenter.queue.pageContext')}</div>
                  {detail.call.subject && <div className="text-sm"><span className="text-muted-foreground">{t('callCenter.queue.subjectLabel')}: </span>{detail.call.subject}</div>}
                  {detail.call.page_url && (
                    <div className="text-sm flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                      <a href={detail.call.page_url} target="_blank" rel="noreferrer" className="underline truncate">
                        {detail.call.page_title || detail.call.page_url}
                      </a>
                    </div>
                  )}
                </Card>
              )}

              {/* Pre-call form */}
              {preCall && typeof preCall === 'object' && (
                <Card className="p-4 space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('callCenter.queue.preCallForm')}</div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {Object.entries(preCall).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground capitalize">{k}</dt>
                        <dd className="truncate">{String(v ?? '—')}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              )}
            </>
          )}
        </div>

        {/* Context column */}
        <Card className="flex flex-col overflow-hidden p-0 min-h-0">
          {detail ? (
            <Tabs value={contextTab} onValueChange={(v) => setContextTab(v as any)} className="flex flex-col h-full">
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
                    t={t as any}
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
                              <dt className="text-muted-foreground capitalize">{k}</dt>
                              <dd className="truncate font-medium">{String(v ?? '—')}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </>
                  )}
                  <Separator />
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">{t('callCenter.queue.previousCalls')}</div>
                    <p className="text-xs text-muted-foreground">{t('callCenter.queue.previousCallsHint')}</p>
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
                          <div className="text-[10px] text-muted-foreground tabular-nums">{new Date(e.created_at).toLocaleTimeString()}</div>
                          <div className="text-xs font-medium">{e.event_type.replace(/_/g, ' ')}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </TabsContent>

                <TabsContent value="notes" className="m-0">
                  <Textarea
                    placeholder={t('callCenter.queue.notesPlaceholder')}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={10}
                    disabled
                    className="text-sm resize-none"
                  />
                  <p className="text-[11px] text-muted-foreground mt-2">
                    {t('callCenter.queue.notesFooter')}
                  </p>
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
