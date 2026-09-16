import { useEffect, useMemo, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCapabilities } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { callCenterApi } from '@/lib/call-center-api';
import { toast } from '@/hooks/use-toast';
import { Play, Download, Link as LinkIcon, Mic, Video, AlertCircle } from 'lucide-react';
import { RecordingTimeline } from '@/components/recordings/RecordingTimeline';
import { formatDateTime } from '@/lib/date';
import { useTranslation } from '@/i18n';
import { recordingTypeLabel } from '@/features/calls/callLabels';

type WorkspaceRec = Awaited<
  ReturnType<typeof callCenterApi.listWorkspaceRecordings>
>['recordings'][number];

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

function RecordingRow({
  workspaceId,
  rec,
}: {
  workspaceId: string;
  rec: WorkspaceRec;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const isVideo = isVideoRecording(rec.recording_type);

  async function load() {
    if (loading || url || !rec.has_storage) return;
    setLoading(true);
    try {
      const r = await callCenterApi.mintCallRecordingPlaybackToken(workspaceId, rec.call_id, rec.id);
      setUrl(r.url);
    } catch (e: any) {
      toast({
        title: t('callCenter.calls.loadPlayback'),
        description: e?.message || 'token_mint_failed',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }

  async function download() {
    if (downloading || !rec.has_storage) return;
    setDownloading(true);
    try {
      const r = await callCenterApi.mintCallRecordingDownloadToken(workspaceId, rec.call_id, rec.id);
      const a = document.createElement('a');
      a.href = r.url; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e: any) {
      toast({
        title: t('callCenter.calls.download'),
        description: e?.message || 'token_mint_failed',
        variant: 'destructive',
      });
    } finally {
      setDownloading(false);
    }
  }

  async function share() {
    if (!rec.has_storage) return;
    try {
      const r = await callCenterApi.mintCallRecordingDownloadToken(workspaceId, rec.call_id, rec.id);
      const abs = r.url.startsWith('http') ? r.url : `${window.location.origin}${r.url}`;
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

  const visitor =
    rec.call?.visitor_name?.trim() ||
    rec.call?.visitor_email?.trim() ||
    t('callCenter.recordingsPage.anonymous');
  const when = formatDateTime(rec.created_at);

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <div className="h-8 w-8 rounded bg-muted flex items-center justify-center text-muted-foreground">
          {isVideo ? <Video className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{visitor}</div>
          <div className="text-xs text-muted-foreground">
            {when} · {recordingTypeLabel(t, rec.recording_type)} · {fmtDuration(rec.duration_seconds)} · {fmtBytes(rec.size_bytes)}
          </div>
        </div>
        {!rec.has_storage ? (
          <span className="text-[11px] text-muted-foreground">{t('callCenter.calls.artifactUnavailable')}</span>
        ) : !url ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={load} disabled={loading}>
              <Play className="h-3 w-3 me-1" /> {loading ? t('callCenter.calls.preparing') : t('callCenter.calls.loadPlayback')}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={download} disabled={downloading}>
              <Download className="h-3 w-3 me-1" /> {downloading ? t('callCenter.calls.preparing') : t('callCenter.calls.download')}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={share}>
              <LinkIcon className="h-3 w-3 me-1" /> {t('callCenter.calls.copyShareLink')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={download} disabled={downloading}>
              <Download className="h-3 w-3 me-1" /> {downloading ? t('callCenter.calls.preparing') : t('callCenter.calls.download')}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={share}>
              <LinkIcon className="h-3 w-3 me-1" /> {t('callCenter.calls.copyShareLink')}
            </Button>
          </div>
        )}
      </div>
      {url && (
        <RecordingTimeline
          src={url}
          kind={isVideo ? 'video' : 'audio'}
          recordingId={rec.id}
          durationHint={rec.duration_seconds}
          mediaClassName={isVideo ? 'w-full max-h-64 rounded bg-black' : 'w-full'}
        />
      )}
    </Card>
  );
}

export default function RecordingsPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { data: caps } = useCallCenterCapabilities(workspace?.id);
  const [filter, setFilter] = useState<'all' | 'audio' | 'video'>('all');
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    recordings: WorkspaceRec[] | null;
  }>({ loading: true, error: null, recordings: null });

  const recordingOn =
    !!caps?.recording?.enabled_by_platform && !!caps?.recording?.enabled_by_plan;

  useEffect(() => {
    if (!workspace?.id || !recordingOn) return;
    let cancelled = false;
    setState({ loading: true, error: null, recordings: null });
    callCenterApi
      .listWorkspaceRecordings(workspace.id, { limit: 100 })
      .then((r) => { if (!cancelled) setState({ loading: false, error: null, recordings: r.recordings }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: String(e?.message || e), recordings: null }); });
    return () => { cancelled = true; };
  }, [workspace?.id, recordingOn]);

  const filtered = useMemo(() => {
    if (!state.recordings) return [];
    return state.recordings.filter((r) => {
      if (filter === 'all') return true;
      const v = isVideoRecording(r.recording_type);
      return filter === 'video' ? v : !v;
    });
  }, [state.recordings, filter]);

  if (!recordingOn) {
    return (
      <Card className="p-6 flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 text-warning" />
        <div>
          <h2 className="font-semibold">{t('callCenter.recordingsPage.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t('callCenter.recordingsPage.disabledByPlatform')}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('callCenter.recordingsPage.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('callCenter.recordingsPage.subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'audio', 'video'] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setFilter(f)}
          >
            {t(`callCenter.recordingsPage.filters.${f}` as any)}
          </Button>
        ))}
      </div>

      {state.loading && (
        <p className="text-sm text-muted-foreground">{t('callCenter.calls.loadingRecordings')}</p>
      )}
      {state.error && (
        <Card className="p-3 text-sm text-destructive border-destructive/40 bg-destructive/5">
          {t('callCenter.recordingsPage.loadFailed')}: {state.error}
        </Card>
      )}
      {!state.loading && !state.error && filtered.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground text-center">
          {t('callCenter.recordingsPage.empty')}
        </Card>
      )}

      <div className="space-y-2">
        {workspace && filtered.map((rec) => (
          <RecordingRow key={rec.id} workspaceId={workspace.id} rec={rec} />
        ))}
      </div>
    </div>
  );
}