import { useEffect, useMemo, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCalls, useCallCenterCall } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { Phone, Video, Search, Copy, Star, Play, Download } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const STATUS = ['all', 'pending', 'ringing', 'active', 'ended', 'cancelled', 'missed', 'failed'];
const TYPES = ['all', 'audio', 'video'];

function fmtDuration(s?: number | null) {
  if (!s && s !== 0) return '—';
  const m = Math.floor(s / 60); const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtBytes(n?: number | null) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function isVideoRecording(t: string | null): boolean {
  return t === 'composite' || t === 'individual';
}

/**
 * Operator-side read-only playback row.
 * No retention, legal-hold, override, restore, adopt, or delete controls.
 * Tokenized URL is minted on demand and reused for the entire native
 * <audio>/<video> session (Range requests inherit the token).
 */
function RecordingPlaybackRow({
  workspaceId,
  callId,
  rec,
}: {
  workspaceId: string;
  callId: string;
  rec: {
    id: string;
    recording_type: string | null;
    duration_seconds: number | null;
    size_bytes: number | null;
    created_at: string;
    has_storage: boolean;
  };
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const isVideo = isVideoRecording(rec.recording_type);

  async function load() {
    if (loading || url) return;
    setLoading(true);
    try {
      const r = await callCenterApi.mintCallRecordingPlaybackToken(workspaceId, callId, rec.id);
      setUrl(r.url);
    } catch (e: any) {
      toast({ title: 'Playback unavailable', description: e?.message || 'token_mint_failed', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  async function download() {
    if (downloading || !rec.has_storage) return;
    setDownloading(true);
    try {
      const r = await callCenterApi.mintCallRecordingDownloadToken(workspaceId, callId, rec.id);
      // Navigate via a transient anchor — the streaming route honors the
      // attachment disposition embedded in the token and sets the
      // Content-Disposition header, so the browser saves the file.
      const a = document.createElement('a');
      a.href = r.url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e: any) {
      toast({ title: 'Download unavailable', description: e?.message || 'token_mint_failed', variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="rounded border bg-background/50 p-2 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{rec.id.slice(0, 8)}…</span>
        <span className="text-muted-foreground">{rec.recording_type || '—'}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{fmtDuration(rec.duration_seconds)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{fmtBytes(rec.size_bytes)}</span>
      </div>
      {!rec.has_storage ? (
        <p className="text-[11px] text-muted-foreground">Artifact is not yet available for playback.</p>
      ) : (
        <>
          {!url ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={load} disabled={loading}>
                <Play className="h-3 w-3 me-1" /> {loading ? 'Preparing…' : 'Load playback'}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={download} disabled={downloading}>
                <Download className="h-3 w-3 me-1" /> {downloading ? 'Preparing…' : 'Download'}
              </Button>
            </div>
          ) : (
            <>
              {isVideo ? (
                <video src={url} controls preload="metadata" className="w-full max-h-64 rounded bg-black" />
              ) : (
                <audio src={url} controls preload="metadata" className="w-full" />
              )}
              <div>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={download} disabled={downloading}>
                  <Download className="h-3 w-3 me-1" /> {downloading ? 'Preparing…' : 'Download'}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function RecordingsPanel({ workspaceId, callId }: { workspaceId: string; callId: string }) {
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    recordings:
      | Awaited<ReturnType<typeof callCenterApi.listCallRecordings>>['recordings']
      | null;
  }>({ loading: true, error: null, recordings: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, recordings: null });
    callCenterApi
      .listCallRecordings(workspaceId, callId)
      .then((r) => { if (!cancelled) setState({ loading: false, error: null, recordings: r.recordings }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: String(e?.message || e), recordings: null }); });
    return () => { cancelled = true; };
  }, [workspaceId, callId]);

  if (state.loading) {
    return <p className="text-[11px] text-muted-foreground">Loading recordings…</p>;
  }
  if (state.error) {
    return <p className="text-[11px] text-destructive">Failed to load recordings: {state.error}</p>;
  }
  if (!state.recordings || state.recordings.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No recording artifacts available.</p>;
  }
  return (
    <div className="space-y-2">
      {state.recordings.map((rec) => (
        <RecordingPlaybackRow key={rec.id} workspaceId={workspaceId} callId={callId} rec={rec} />
      ))}
      <p className="text-[10px] text-muted-foreground">
        Read-only playback. Retention and legal-hold management is restricted to platform administrators.
      </p>
    </div>
  );
}

function stateTone(s: string) {
  if (['active', 'ringing', 'connecting'].includes(s)) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (['ended'].includes(s)) return 'bg-muted text-muted-foreground';
  if (['missed', 'failed'].includes(s)) return 'bg-destructive/15 text-destructive';
  if (['cancelled'].includes(s)) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return 'bg-muted text-muted-foreground';
}

export default function CallsPage() {
  const { workspace } = useActiveWorkspace();
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data } = useCallCenterCalls(workspace?.id, { status: status === 'all' ? undefined : status });
  const { data: detail } = useCallCenterCall(workspace?.id, selected);

  async function endCall(id: string) {
    if (!workspace) return;
    await callCenterApi.endCall(workspace.id, id);
    qc.invalidateQueries({ queryKey: ['call-center'] });
  }

  const allCalls = data?.calls || [];
  const filtered = useMemo(() => allCalls.filter((c) => {
    if (type !== 'all' && c.call_type !== type) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!(c.visitor_name || '').toLowerCase().includes(s) &&
          !(c.visitor_email || '').toLowerCase().includes(s) &&
          !(c.visitor_phone || '').toLowerCase().includes(s)) return false;
    }
    return true;
  }), [allCalls, type, search]);

  const summary = useMemo(() => {
    let answered = 0, missed = 0, rejected = 0, totalDur = 0, durCount = 0;
    for (const c of filtered) {
      if (c.state === 'ended') answered++;
      else if (c.state === 'missed') missed++;
      else if (c.state === 'cancelled') rejected++;
      if (c.duration_seconds) { totalDur += c.duration_seconds; durCount++; }
    }
    return { answered, missed, rejected, avg: durCount ? Math.round(totalDur / durCount) : null };
  }, [filtered]);

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground me-1">Status:</div>
          {STATUS.map((s) => (
            <Button key={s} size="sm" variant={status === s ? 'default' : 'outline'} className="h-7 text-xs capitalize" onClick={() => setStatus(s)}>{s}</Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground me-1">Type:</div>
          {TYPES.map((s) => (
            <Button key={s} size="sm" variant={type === s ? 'default' : 'outline'} className="h-7 text-xs capitalize" onClick={() => setType(s)}>{s}</Button>
          ))}
          <div className="relative flex-1 min-w-[200px] ms-auto max-w-sm">
            <Search className="h-3.5 w-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8 h-8 text-sm" placeholder="Visitor, email, phone…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">Answered</div><div className="text-xl font-semibold">{summary.answered}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Missed</div><div className="text-xl font-semibold text-destructive">{summary.missed}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Rejected/Cancelled</div><div className="text-xl font-semibold">{summary.rejected}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Avg duration</div><div className="text-xl font-semibold">{summary.avg != null ? fmtDuration(summary.avg) : '—'}</div></Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b">
              <th className="text-start py-2 px-3">Visitor</th>
              <th className="text-start py-2 px-3">Type</th>
              <th className="text-start py-2 px-3">State</th>
              <th className="text-start py-2 px-3">Duration</th>
              <th className="text-start py-2 px-3">Rating</th>
              <th className="text-start py-2 px-3">Page</th>
              <th className="text-start py-2 px-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const display = c.visitor_name || c.visitor_email || c.visitor_phone || 'Anonymous';
              const initials = display.slice(0, 1).toUpperCase();
              return (
              <tr key={c.id} onClick={() => setSelected(c.id)} className="border-b cursor-pointer hover:bg-muted/40">
                <td className="py-2 px-3">
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">{initials}</div>
                    <span className="font-medium">{display}</span>
                  </div>
                </td>
                <td className="py-2 px-3">
                  <span className="inline-flex items-center gap-1 text-xs">
                    {c.call_type === 'video' ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                    {c.call_type}
                  </span>
                </td>
                <td className="py-2 px-3"><span className={cn('text-xs px-2 py-0.5 rounded-full', stateTone(c.state))}>{c.state}</span></td>
                <td className="py-2 px-3">{fmtDuration(c.duration_seconds)}</td>
                <td className="py-2 px-3">
                  {(c as any).rating ? (
                    <span className="inline-flex items-center gap-1 text-xs">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                      {(c as any).rating.rating}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground truncate max-w-[200px]">{c.page_title || c.page_url || '—'}</td>
                <td className="py-2 px-3 text-xs text-muted-foreground">{new Date(c.created_at).toLocaleString()}</td>
              </tr>
              );
            })}
            {filtered.length === 0 && (<tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">No calls match your filters.</td></tr>)}
          </tbody>
        </table>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader><SheetTitle>Call detail</SheetTitle></SheetHeader>
          {detail && (
            <div className="space-y-4 mt-4">
              <div className="space-y-2">
                <div className="text-sm font-semibold">{detail.call.visitor_name || detail.call.visitor_email || 'Anonymous'}</div>
                <div className="flex flex-wrap gap-2">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full', stateTone(detail.call.state))}>{detail.call.state}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-muted">{detail.call.call_type}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><div className="text-xs text-muted-foreground">Subject</div>{detail.call.subject || '—'}</div>
                <div><div className="text-xs text-muted-foreground">Duration</div>{fmtDuration(detail.call.duration_seconds)}</div>
                <div><div className="text-xs text-muted-foreground">End reason</div>{detail.call.end_reason || '—'}</div>
              </div>
              {detail.call.page_url && (
                <div className="text-sm"><div className="text-xs text-muted-foreground">Page</div><a href={detail.call.page_url} target="_blank" rel="noreferrer" className="underline truncate block">{detail.call.page_title || detail.call.page_url}</a></div>
              )}
              {(() => {
                const rec = (detail.call as any)?.metadata?.recording || null;
                if (!rec) return null;
                const consent = rec.consent_given;
                const consentAt = rec.consent_at ? new Date(rec.consent_at).toLocaleString() : '—';
                const state = rec.state || 'disabled';
                const artifact = rec.artifact_id ? String(rec.artifact_id) : null;
                const artifactMasked = artifact ? (artifact.length > 12 ? artifact.slice(0, 6) + '…' + artifact.slice(-4) : artifact) : null;
                return (
                  <div className="space-y-1.5 rounded-md border p-3 bg-muted/20">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recording</div>
                    <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-1">
                      <span className="text-muted-foreground">State</span><span>{state}</span>
                      <span className="text-muted-foreground">Consent</span><span>{consent ? 'Yes' : 'No'}</span>
                      <span className="text-muted-foreground">Consent at</span><span>{consentAt}</span>
                      {artifactMasked && (<><span className="text-muted-foreground">Artifact</span><span className="font-mono">{artifactMasked}</span></>)}
                    </div>
                    {workspace?.id ? (
                      <RecordingsPanel workspaceId={workspace.id} callId={detail.call.id} />
                    ) : (
                      <p className="text-[11px] text-muted-foreground">Workspace context unavailable.</p>
                    )}
                  </div>
                );
              })()}
              {(detail as any).rating && (
                <div className="space-y-2 rounded-md border p-3 bg-amber-500/5 border-amber-500/30">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Visitor rating
                  </div>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        className={cn(
                          'h-4 w-4',
                          n <= ((detail as any).rating.rating || 0)
                            ? 'fill-amber-400 text-amber-400'
                            : 'text-muted-foreground/40',
                        )}
                      />
                    ))}
                    <span className="ms-1 text-xs text-muted-foreground">
                      {(detail as any).rating.rating}/5
                    </span>
                  </div>
                  {(detail as any).rating.comment && (
                    <p className="text-sm whitespace-pre-wrap">{(detail as any).rating.comment}</p>
                  )}
                  <div className="text-[11px] text-muted-foreground">
                    {new Date((detail as any).rating.created_at).toLocaleString()}
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(detail.call.id); toast({ title: 'Call ID copied' }); }}>
                  <Copy className="h-3.5 w-3.5 me-1" /> Copy ID
                </Button>
                {['active', 'ringing', 'connecting'].includes(detail.call.state) && (
                  <Button variant="destructive" size="sm" onClick={() => endCall(detail.call.id)}>End call</Button>
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium mb-2">Timeline</h3>
                <ol className="space-y-2 text-xs">
                  {detail.events.map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="text-muted-foreground shrink-0">{new Date(e.created_at).toLocaleTimeString()}</span>
                      <span>{e.event_type}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Debug metadata</summary>
                <pre className="mt-2 bg-muted p-2 rounded overflow-x-auto">{JSON.stringify(detail.call, null, 2)}</pre>
              </details>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
