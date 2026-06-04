import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterQueue, useCallCenterCall, useCallCenterOverview } from '@/hooks/useCallCenter';
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
import { useEffect, useMemo, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import {
  Phone, Video, Globe, Headphones, RadioTower, Inbox, PhoneOff, Mic, MicOff,
  CameraOff, ArrowRightLeft, PhoneCall, AlertTriangle, Disc, Square, Loader2, RefreshCw,
  Search, Clock, User, Mail, Smartphone, Copy, Check, ChevronRight, Activity,
  FileText, History, Building2, ArrowUp, ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link, useParams } from 'react-router-dom';
import OperatorMediaConsole, { type OperatorConnectInfo } from '@/components/call-center/OperatorMediaConsole';

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
  const { workspace } = useActiveWorkspace();
  const { slug } = useParams();
  const base = `/app/w/${slug}/call-center`;
  const { data, isLoading } = useCallCenterQueue(workspace?.id);
  const { data: overview } = useCallCenterOverview(workspace?.id);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [accepted, setAccepted] = useState<{
    callId: string;
    token: string;
    connect: OperatorConnectInfo;
    callType: string;
  } | null>(null);
  const { data: detail } = useCallCenterCall(workspace?.id, selectedCallId);
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  // Faster status sync while in active console
  useEffect(() => {
    if (!accepted?.callId) return;
    const t = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['call-center'] });
    }, 5000);
    return () => clearInterval(t);
  }, [accepted?.callId, qc]);

  const queue = data?.queue || [];

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
    <div className="flex flex-col h-full gap-4">
      {/* Command bar */}
      <Card className="p-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 me-2">
          <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
            <Headphones className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Live Desk</div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              <RadioTower className="h-3 w-3" /> Polling 5s
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 ms-auto">
          <StatChip label="Waiting" value={overview?.waiting_calls ?? queue.length} tone={(overview?.waiting_calls ?? 0) > 0 ? 'warn' : 'muted'} />
          <StatChip label="Active" value={overview?.active_calls ?? 0} tone={(overview?.active_calls ?? 0) > 0 ? 'ok' : 'muted'} />
          <StatChip label="Missed today" value={overview?.missed_today ?? 0} tone={(overview?.missed_today ?? 0) > 0 ? 'danger' : 'muted'} />
          <StatChip label="Provider" value={overview?.provider?.ready ? 'Ready' : 'Down'} tone={overview?.provider?.ready ? 'ok' : 'warn'} />
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_320px] gap-4 flex-1 min-h-0">
        {/* Queue column */}
        <div className="space-y-2 overflow-y-auto pr-1">
          <div className="flex items-center justify-between sticky top-0 bg-background py-1 z-10">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              <Inbox className="h-3.5 w-3.5" /> Queue ({queue.length})
            </h2>
          </div>
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && queue.length === 0 && (
            <Card className="p-6 text-center space-y-3">
              <Headphones className="h-8 w-8 mx-auto text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No calls waiting</p>
                <p className="text-xs text-muted-foreground">When a visitor calls, they'll appear here.</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button asChild size="sm" variant="outline"><Link to={`${base}/install`}>Install widget</Link></Button>
                <Button asChild size="sm" variant="ghost"><Link to={`${base}/settings`}>Open settings</Link></Button>
              </div>
            </Card>
          )}
          {queue.map((q, idx) => {
            const c = q.call_session;
            const tone = urgencyTone(q.created_at);
            const isSel = selectedCallId === q.call_session_id;
            return (
              <Card
                key={q.id}
                onClick={() => setSelectedCallId(q.call_session_id)}
                className={cn(
                  'p-3 cursor-pointer transition-all border-2',
                  isSel ? 'border-primary shadow-md' : 'border-transparent hover:border-border',
                  tone === 'warn' && !isSel && 'border-amber-500/30',
                  tone === 'danger' && !isSel && 'border-destructive/40 bg-destructive/5',
                )}
              >
                <div className="flex items-start gap-2.5">
                  <div className="rounded-lg bg-primary/10 text-primary p-1.5">
                    {q.channel === 'video' ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <div className="font-medium truncate text-sm">
                        {c?.visitor_name || c?.visitor_email || c?.visitor_phone || 'Anonymous'}
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted ms-auto">#{idx + 1}</span>
                    </div>
                    <div className={cn('text-[11px] mt-0.5',
                      tone === 'danger' ? 'text-destructive font-medium' : tone === 'warn' ? 'text-amber-600' : 'text-muted-foreground',
                    )}>
                      waiting {waitTime(q.created_at)}
                    </div>
                    {c?.subject && <div className="text-[11px] text-muted-foreground truncate mt-0.5">{c.subject}</div>}
                  </div>
                </div>
                <div className="flex gap-1.5 mt-2.5">
                  <Button variant="outline" size="sm" className="flex-1 h-7 text-xs" onClick={(e) => { e.stopPropagation(); reject(q.call_session_id); }} disabled={busy === q.call_session_id}>Reject</Button>
                  <Button size="sm" className="flex-1 h-7 text-xs" onClick={(e) => { e.stopPropagation(); accept(q.call_session_id); }} disabled={busy === q.call_session_id}>Accept</Button>
                </div>
              </Card>
            );
          })}
        </div>

        {/* Workspace column */}
        <div className="space-y-3 overflow-y-auto">
          {!detail ? (
            <Card className="p-12 text-center">
              <PhoneCall className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
              <p className="text-sm font-medium">No call selected</p>
              <p className="text-xs text-muted-foreground">Pick a call from the queue to start handling it.</p>
            </Card>
          ) : (
            <>
              <Card className="p-5 bg-gradient-to-br from-primary/5 to-transparent border-primary/20">
                <div className="flex items-start gap-4 flex-wrap">
                  <div className="h-14 w-14 rounded-full bg-primary/15 text-primary flex items-center justify-center text-lg font-semibold">
                    {(detail.call.visitor_name || detail.call.visitor_email || 'A').slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xl font-semibold leading-tight">
                      {detail.call.visitor_name || detail.call.visitor_email || detail.call.visitor_phone || 'Anonymous visitor'}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-background border">{detail.call.call_type === 'video' ? 'Video' : 'Voice'}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-background border">{detail.call.state}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-background border">{detail.call.provider || 'no provider'}</span>
                      <RecordingBadge rec={overview?.recording} meta={(detail.call as any)?.metadata?.recording} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {detail.call.state === 'pending' && (
                      <>
                        <Button variant="outline" onClick={() => reject(detail.call.id)}>Reject</Button>
                        <Button onClick={() => accept(detail.call.id)}>Accept</Button>
                      </>
                    )}
                    {isActive && !(accepted && accepted.callId === detail.call.id) && (
                      <Button variant="destructive" onClick={() => endActive(detail.call.id)}>
                        <PhoneOff className="h-4 w-4 me-1" /> End
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
                <Card className="p-5 border-dashed">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                    <div className="text-sm">
                      <div className="font-medium">Accept the call to start media</div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        The operator media console activates after you accept the call.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-4">
                    {[
                      { icon: MicOff, label: 'Mute' },
                      { icon: CameraOff, label: 'Camera' },
                      { icon: ArrowRightLeft, label: 'Transfer' },
                      { icon: PhoneOff, label: 'End' },
                    ].map((b) => (
                      <Button key={b.label} variant="outline" size="sm" disabled>
                        <b.icon className="h-3.5 w-3.5 me-1.5" />{b.label}
                      </Button>
                    ))}
                  </div>
                </Card>
              )}

              {/* Page context */}
              {(detail.call.page_url || detail.call.subject) && (
                <Card className="p-4 space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Page context</div>
                  {detail.call.subject && <div className="text-sm"><span className="text-muted-foreground">Subject: </span>{detail.call.subject}</div>}
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
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pre-call form</div>
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
        <div className="space-y-3 overflow-y-auto">
          {detail ? (
            <>
              <Card className="p-4 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contact</div>
                <div className="text-sm space-y-1">
                  <div className="font-medium">{detail.call.visitor_name || 'Anonymous'}</div>
                  {detail.call.visitor_email && <div className="text-muted-foreground">{detail.call.visitor_email}</div>}
                  {detail.call.visitor_phone && <div className="text-muted-foreground">{detail.call.visitor_phone}</div>}
                </div>
              </Card>
              <Card className="p-4 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Timeline</div>
                <ol className="space-y-1 text-xs max-h-56 overflow-y-auto">
                  {detail.events.length === 0 && <li className="text-muted-foreground">No events.</li>}
                  {detail.events.map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="text-muted-foreground shrink-0">{new Date(e.created_at).toLocaleTimeString()}</span>
                      <span className="truncate">{e.event_type}</span>
                    </li>
                  ))}
                </ol>
              </Card>
              <Card className="p-4 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Private notes</div>
                <Textarea
                  placeholder="Private call notes — coming soon"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={4}
                  disabled
                  className="text-sm"
                />
              </Card>
              <Card className="p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Previous calls</div>
                <p className="text-xs text-muted-foreground">Call history will appear here.</p>
              </Card>
            </>
          ) : (
            <Card className="p-6 text-center text-xs text-muted-foreground">Select a call to view context.</Card>
          )}
        </div>
      </div>
    </div>
  );
}
