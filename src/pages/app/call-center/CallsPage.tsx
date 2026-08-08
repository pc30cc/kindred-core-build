import { useEffect, useMemo, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCalls, useCallCenterCall } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { Phone, Video, Search, Copy, Star, Play, Download, Link as LinkIcon } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { RecordingTimeline } from '@/components/recordings/RecordingTimeline';
import { useTranslation } from '@/i18n';
import { VisitorNetworkCard, VisitorNetworkInline } from '@/features/visitors/VisitorNetworkCard';
import { useVisitorNetworkBatchBySession } from '@/hooks/useVisitorNetwork';
import { useGeoEnrichmentRealtime } from '@/hooks/useGeoEnrichmentRealtime';

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
  selected,
  onToggleSelected,
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
  selected: boolean;
  onToggleSelected: (next: boolean) => void;
}) {
  const { t } = useTranslation();
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
      toast({ title: t('callCenter.calls.loadPlayback'), description: e?.message || 'token_mint_failed', variant: 'destructive' });
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
      toast({ title: t('callCenter.calls.download'), description: e?.message || 'token_mint_failed', variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  }

  async function copyShareLink() {
    if (!rec.has_storage) return;
    try {
      const r = await callCenterApi.mintCallRecordingDownloadToken(workspaceId, callId, rec.id);
      const abs = r.url.startsWith('http')
        ? r.url
        : `${window.location.origin}${r.url}`;
      await navigator.clipboard.writeText(abs);
      toast({
        title: t('callCenter.calls.shareLinkCopied'),
        description: t('callCenter.calls.shareLinkDesc'),
      });
    } catch (e: any) {
      toast({
        title: t('callCenter.calls.shareLinkFailed'),
        description: e?.message || 'token_mint_failed',
        variant: 'destructive',
      });
    }
  }

  return (
    <div className="rounded border bg-background/50 p-2 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={selected}
          disabled={!rec.has_storage}
          onCheckedChange={(v) => onToggleSelected(v === true)}
          aria-label="Select recording for bulk download"
          className="h-3.5 w-3.5"
        />
        <span className="font-mono text-muted-foreground">{rec.id.slice(0, 8)}…</span>
        <span className="text-muted-foreground">{rec.recording_type || '—'}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{fmtDuration(rec.duration_seconds)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{fmtBytes(rec.size_bytes)}</span>
      </div>
      {!rec.has_storage ? (
        <p className="text-[11px] text-muted-foreground">{t('callCenter.calls.artifactUnavailable')}</p>
      ) : (
        <>
          {!url ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={load} disabled={loading}>
                <Play className="h-3 w-3 me-1" /> {loading ? t('callCenter.calls.preparing') : t('callCenter.calls.loadPlayback')}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={download} disabled={downloading}>
                <Download className="h-3 w-3 me-1" /> {downloading ? t('callCenter.calls.preparing') : t('callCenter.calls.download')}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={copyShareLink}>
                <LinkIcon className="h-3 w-3 me-1" /> {t('callCenter.calls.copyShareLink')}
              </Button>
            </div>
          ) : (
            <>
              <RecordingTimeline
                src={url}
                kind={isVideo ? 'video' : 'audio'}
                recordingId={rec.id}
                durationHint={rec.duration_seconds}
                mediaClassName={isVideo ? 'w-full max-h-64 rounded bg-black' : 'w-full'}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={download} disabled={downloading}>
                  <Download className="h-3 w-3 me-1" /> {downloading ? t('callCenter.calls.preparing') : t('callCenter.calls.download')}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={copyShareLink}>
                  <LinkIcon className="h-3 w-3 me-1" /> {t('callCenter.calls.copyShareLink')}
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
  const { t } = useTranslation();
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    recordings:
      | Awaited<ReturnType<typeof callCenterApi.listCallRecordings>>['recordings']
      | null;
  }>({ loading: true, error: null, recordings: null });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, recordings: null });
    setSelected(new Set());
    callCenterApi
      .listCallRecordings(workspaceId, callId)
      .then((r) => { if (!cancelled) setState({ loading: false, error: null, recordings: r.recordings }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: String(e?.message || e), recordings: null }); });
    return () => { cancelled = true; };
  }, [workspaceId, callId]);

  if (state.loading) {
    return <p className="text-[11px] text-muted-foreground">{t('callCenter.calls.loadingRecordings')}</p>;
  }
  if (state.error) {
    return <p className="text-[11px] text-destructive">{t('callCenter.calls.loadRecordingsFailed')} {state.error}</p>;
  }
  if (!state.recordings || state.recordings.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{t('callCenter.calls.noRecordings')}</p>;
  }

  const recs = state.recordings;
  const selectedIds = recs.filter((r) => selected.has(r.id) && r.has_storage).map((r) => r.id);

  function toggle(id: string, next: boolean) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (next) n.add(id); else n.delete(id);
      return n;
    });
  }

  async function bulkDownload() {
    if (bulkBusy || selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await callCenterApi.mintCallRecordingBulkDownloadTokens(
        workspaceId, callId, selectedIds,
      );
      let ok = 0;
      let failed = 0;
      for (const item of r.results) {
        if ('url' in item) {
          const a = document.createElement('a');
          a.href = item.url;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
          ok++;
          // small stagger so browsers don't drop concurrent navigations
          await new Promise((res) => setTimeout(res, 120));
        } else {
          failed++;
        }
      }
      if (failed > 0) {
        toast({
          title: 'Bulk download finished with errors',
          description: `${ok} started, ${failed} failed`,
          variant: 'destructive',
        });
      } else {
        toast({ title: 'Bulk download started', description: `${ok} recording(s)` });
      }
    } catch (e: any) {
      toast({
        title: 'Bulk download unavailable',
        description: e?.message || 'bulk_token_mint_failed',
        variant: 'destructive',
      });
    } finally {
      setBulkBusy(false);
    }
  }

  async function exportArchive() {
    if (zipBusy || selectedIds.length === 0) return;
    setZipBusy(true);
    try {
      const r = await callCenterApi.exportCallRecordingsArchive(
        workspaceId, callId, selectedIds,
      );
      const href = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = r.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      if (r.excluded > 0) {
        toast({
          title: 'Archive downloaded with exclusions',
          description: `${r.included} included, ${r.excluded} excluded (see manifest.txt)`,
        });
      } else {
        toast({ title: 'Archive downloaded', description: `${r.included} recording(s)` });
      }
    } catch (e: any) {
      toast({
        title: 'Archive export failed',
        description: e?.message || 'archive_export_failed',
        variant: 'destructive',
      });
    } finally {
      setZipBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {selectedIds.length > 0
            ? t('callCenter.calls.selectedShort', { count: String(selectedIds.length) })
            : t('callCenter.calls.selectToBulk')}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={bulkDownload}
            disabled={bulkBusy || zipBusy || selectedIds.length === 0}
          >
            <Download className="h-3 w-3 me-1" />
            {bulkBusy ? t('callCenter.calls.preparing') : `${t('callCenter.calls.downloadSelected')}${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={exportArchive}
            disabled={zipBusy || bulkBusy || selectedIds.length === 0}
            title={t('callCenter.calls.downloadZip')}
          >
            <Download className="h-3 w-3 me-1" />
            {zipBusy ? t('callCenter.calls.packaging') : t('callCenter.calls.downloadZip')}
          </Button>
        </div>
      </div>
      {recs.map((rec) => (
        <RecordingPlaybackRow
          key={rec.id}
          workspaceId={workspaceId}
          callId={callId}
          rec={rec}
          selected={selected.has(rec.id)}
          onToggleSelected={(next) => toggle(rec.id, next)}
        />
      ))}
      <p className="text-[10px] text-muted-foreground">
        {t('callCenter.calls.readOnlyFooter')}
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
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [pickedCalls, setPickedCalls] = useState<Set<string>>(new Set());
  const [wsZipBusy, setWsZipBusy] = useState(false);
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

  // ONE batched network read for the whole page (list rows + detail sheet).
  const { data: networkBySession } = useVisitorNetworkBatchBySession(
    workspace?.id,
    useMemo(() => filtered.map((c) => (c as any).visitor_session_id ?? null), [filtered]),
  );
  // Refresh IP/geo once async enrichment lands (reuses the visitors channel).
  useGeoEnrichmentRealtime(workspace?.id);
  const detailProfile = (detail as any)?.call?.visitor_session_id
    ? networkBySession?.[(detail as any).call.visitor_session_id] ?? null
    : null;

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

  function toggleCallPick(id: string, next: boolean) {
    setPickedCalls((prev) => {
      const n = new Set(prev);
      if (next) n.add(id); else n.delete(id);
      return n;
    });
  }

  async function exportSelectedCallsArchive() {
    if (!workspace || wsZipBusy) return;
    const callIds = filtered.map((c) => c.id).filter((id) => pickedCalls.has(id));
    if (callIds.length === 0) return;
    setWsZipBusy(true);
    try {
      // Resolve recordings per selected call, cap items at the same server
      // ARCHIVE_LIMIT (25) so the request is rejected predictably.
      const items: Array<{ call_id: string; recording_id: string }> = [];
      const MAX_ITEMS = 25;
      let truncated = false;
      for (const cid of callIds) {
        try {
          const r = await callCenterApi.listCallRecordings(workspace.id, cid);
          for (const rec of r.recordings) {
            if (!rec.has_storage) continue;
            if (items.length >= MAX_ITEMS) { truncated = true; break; }
            items.push({ call_id: cid, recording_id: rec.id });
          }
        } catch {
          // ignore — server is the authoritative gate
        }
        if (truncated) break;
      }
      if (items.length === 0) {
        toast({
          title: 'No exportable recordings',
          description: 'Selected calls have no available recording artifacts.',
          variant: 'destructive',
        });
        return;
      }
      const r = await callCenterApi.exportWorkspaceRecordingsArchive(workspace.id, items);
      const href = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = r.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      const desc = `${r.included} included across ${r.calls} call(s)` +
        (r.excluded > 0 ? `, ${r.excluded} excluded (see manifest.txt)` : '') +
        (truncated ? ` — selection truncated to ${MAX_ITEMS} recordings` : '');
      toast({ title: 'Workspace archive downloaded', description: desc });
    } catch (e: any) {
      toast({
        title: 'Archive export failed',
        description: e?.message || 'archive_export_failed',
        variant: 'destructive',
      });
    } finally {
      setWsZipBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground me-1">{t('callCenter.calls.statusLabel')}</div>
          {STATUS.map((s) => (
            <Button key={s} size="sm" variant={status === s ? 'default' : 'outline'} className="h-7 text-xs capitalize" onClick={() => setStatus(s)}>{s}</Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground me-1">{t('callCenter.calls.typeLabel')}</div>
          {TYPES.map((s) => (
            <Button key={s} size="sm" variant={type === s ? 'default' : 'outline'} className="h-7 text-xs capitalize" onClick={() => setType(s)}>{s}</Button>
          ))}
          <div className="relative flex-1 min-w-[200px] ms-auto max-w-sm">
            <Search className="h-3.5 w-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8 h-8 text-sm" placeholder={t('callCenter.calls.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">{t('callCenter.calls.summary.answered')}</div><div className="text-xl font-semibold">{summary.answered}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">{t('callCenter.calls.summary.missed')}</div><div className="text-xl font-semibold text-destructive">{summary.missed}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">{t('callCenter.calls.summary.rejectedCancelled')}</div><div className="text-xl font-semibold">{summary.rejected}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">{t('callCenter.calls.summary.avgDuration')}</div><div className="text-xl font-semibold">{summary.avg != null ? fmtDuration(summary.avg) : '—'}</div></Card>
      </div>

      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs text-muted-foreground">
          {pickedCalls.size > 0
            ? t('callCenter.calls.selectedCount', { count: String(pickedCalls.size) })
            : t('callCenter.calls.selectHint')}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={exportSelectedCallsArchive}
          disabled={wsZipBusy || pickedCalls.size === 0}
          title={t('callCenter.calls.exportSelectedZip')}
        >
          <Download className="h-3 w-3 me-1" />
          {wsZipBusy ? t('callCenter.calls.packaging') : `${t('callCenter.calls.exportSelectedZip')}${pickedCalls.size ? ` (${pickedCalls.size})` : ''}`}
        </Button>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b">
              <th className="text-start py-2 px-3 w-8"></th>
              <th className="text-start py-2 px-3">{t('callCenter.calls.headers.visitor')}</th>
              <th className="text-start py-2 px-3">{t('callCenter.calls.headers.type')}</th>
              <th className="text-start py-2 px-3">{t('callCenter.calls.headers.state')}</th>
              <th className="text-start py-2 px-3">{t('callCenter.calls.headers.duration')}</th>
              <th className="text-start py-2 px-3">{t('callCenter.calls.headers.rating')}</th>
              <th className="text-start py-2 px-3">{t('callCenter.calls.headers.page')}</th>
              <th className="text-start py-2 px-3">{t('callCenter.calls.headers.created')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const display = c.visitor_name || c.visitor_email || c.visitor_phone || t('callCenter.common.anonymous');
              const initials = display.slice(0, 1).toUpperCase();
              return (
              <tr key={c.id} onClick={() => setSelected(c.id)} className="border-b cursor-pointer hover:bg-muted/40">
                <td className="py-2 px-3" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={pickedCalls.has(c.id)}
                    onCheckedChange={(v) => toggleCallPick(c.id, v === true)}
                    aria-label="Select call for workspace archive export"
                    className="h-3.5 w-3.5"
                  />
                </td>
                <td className="py-2 px-3">
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">{initials}</div>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{display}</div>
                      <VisitorNetworkInline
                        profile={
                          (c as any).visitor_session_id
                            ? networkBySession?.[(c as any).visitor_session_id] ?? null
                            : null
                        }
                        t={t as any}
                      />
                    </div>
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
            {filtered.length === 0 && (<tr><td colSpan={8} className="py-8 text-center text-sm text-muted-foreground">{t('callCenter.calls.noMatches')}</td></tr>)}
          </tbody>
        </table>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader><SheetTitle>{t('callCenter.calls.callDetail')}</SheetTitle></SheetHeader>
          {detail && (
            <div className="space-y-4 mt-4">
              <div className="space-y-2">
                <div className="text-sm font-semibold">{detail.call.visitor_name || detail.call.visitor_email || t('callCenter.common.anonymous')}</div>
                <div className="flex flex-wrap gap-2">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full', stateTone(detail.call.state))}>{detail.call.state}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-muted">{detail.call.call_type}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><div className="text-xs text-muted-foreground">{t('callCenter.calls.subject')}</div>{detail.call.subject || '—'}</div>
                <div><div className="text-xs text-muted-foreground">{t('callCenter.calls.headers.duration')}</div>{fmtDuration(detail.call.duration_seconds)}</div>
                <div><div className="text-xs text-muted-foreground">{t('callCenter.calls.endReason')}</div>{detail.call.end_reason || '—'}</div>
              </div>
              {detail.call.page_url && (
                <div className="text-sm"><div className="text-xs text-muted-foreground">{t('callCenter.calls.headers.page')}</div><a href={detail.call.page_url} target="_blank" rel="noreferrer" className="underline truncate block">{detail.call.page_title || detail.call.page_url}</a></div>
              )}
              {/* Same canonical IP/geo panel as Inbox / Live Queue — fed from
                  the page-level batch read, so opening the sheet costs nothing. */}
              <VisitorNetworkCard
                workspaceId={workspace?.id}
                profile={detailProfile}
                showUnknown
                t={t as any}
              />
              {(() => {
                const rec = (detail.call as any)?.metadata?.recording || null;
                const consent = rec?.consent_given;
                const consentAt = rec?.consent_at ? new Date(rec.consent_at).toLocaleString() : '—';
                const state = rec?.state || (rec ? 'disabled' : 'not_started');
                const artifact = rec?.artifact_id ? String(rec.artifact_id) : null;
                const artifactMasked = artifact ? (artifact.length > 12 ? artifact.slice(0, 6) + '…' + artifact.slice(-4) : artifact) : null;
                return (
                  <div className="space-y-1.5 rounded-md border p-3 bg-muted/20">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('callCenter.calls.recordingTitle')}</div>
                    {rec ? (
                      <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-1">
                        <span className="text-muted-foreground">{t('callCenter.calls.state')}</span><span>{state}</span>
                        <span className="text-muted-foreground">{t('callCenter.calls.consent')}</span><span>{consent ? t('callCenter.calls.yes') : t('callCenter.calls.no')}</span>
                        <span className="text-muted-foreground">{t('callCenter.calls.consentAt')}</span><span>{consentAt}</span>
                        {artifactMasked && (<><span className="text-muted-foreground">{t('callCenter.calls.artifact')}</span><span className="font-mono">{artifactMasked}</span></>)}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">{t('callCenter.calls.noRecordingMeta')}</p>
                    )}
                    {workspace?.id ? (
                      <RecordingsPanel workspaceId={workspace.id} callId={detail.call.id} />
                    ) : (
                      <p className="text-[11px] text-muted-foreground">{t('callCenter.calls.workspaceUnavailable')}</p>
                    )}
                  </div>
                );
              })()}
              {(detail as any).rating && (
                <div className="space-y-2 rounded-md border p-3 bg-amber-500/5 border-amber-500/30">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('callCenter.calls.visitorRating')}
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
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(detail.call.id); toast({ title: t('callCenter.calls.callIdCopied') }); }}>
                  <Copy className="h-3.5 w-3.5 me-1" /> {t('callCenter.calls.copyId')}
                </Button>
                {['active', 'ringing', 'connecting'].includes(detail.call.state) && (
                  <Button variant="destructive" size="sm" onClick={() => endCall(detail.call.id)}>{t('callCenter.calls.endCall')}</Button>
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium mb-2">{t('callCenter.calls.timeline')}</h3>
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
                <summary className="cursor-pointer text-muted-foreground">{t('callCenter.calls.debugMetadata')}</summary>
                <pre className="mt-2 bg-muted p-2 rounded overflow-x-auto">{JSON.stringify(detail.call, null, 2)}</pre>
              </details>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
