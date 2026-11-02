import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { aiAgentApi, type SourceSyncLog, type TrainWarning } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
import { kbTabPath } from '@/components/app/knowledge/knowledgeBaseTabs';
import {
  Database, AlertTriangle, RefreshCw, LayoutDashboard, Globe, FileText,
  MessageCircleQuestion, GraduationCap, Loader2, ShieldCheck, ShieldX,
  type LucideIcon,
} from 'lucide-react';

type TFn = ReturnType<typeof useTranslation>['t'];
type SyncLogRow = Pick<SourceSyncLog, 'id' | 'status' | 'message' | 'pages_found' | 'chunks_created' | 'created_at'>;

const SEVERITY: Record<string, string> = {
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
};

// Lookups by a value the server sends; a value missing here is shown as it comes.
const TYPE_LABEL = new Map<string, TranslationKey>([
  ['website', 'aiAgent.train.types.webPages'], ['web_page', 'aiAgent.train.types.webPages'],
  ['kb_article', 'aiAgent.train.types.kbArticles'], ['qna', 'aiAgent.train.types.qna'],
  ['learned_qna', 'aiAgent.train.types.learnedQna'], ['file', 'aiAgent.train.types.files'],
  ['business_profile', 'aiAgent.train.types.businessProfile'], ['snippet', 'aiAgent.train.types.snippets'],
]);

/** The retrieval contract's lines (server/services/ai-agent/train.ts RETRIEVAL_ALLOWED / RETRIEVAL_BLOCKED). */
const CONTRACT_LABEL = new Map<string, TranslationKey>([
  ['qna (enabled)', 'aiAgent.train.contract.qnaEnabled'],
  ['kb_article (published)', 'aiAgent.train.contract.kbPublished'],
  ['business_profile (active)', 'aiAgent.train.contract.businessProfileActive'],
  ['website / web_page chunk (status=active, embedding present)', 'aiAgent.train.contract.webChunks'],
  ['file chunk (status=active, embedding present)', 'aiAgent.train.contract.fileChunks'],
  ['learned_qna chunk (status=active, candidate approved)', 'aiAgent.train.contract.learnedQnaChunks'],
  ['kb_article (draft / unpublished)', 'aiAgent.train.contract.kbDraft'],
  ['qna (disabled)', 'aiAgent.train.contract.qnaDisabled'],
  ['learning candidate (pending / rejected)', 'aiAgent.train.contract.learningPendingRejected'],
  ['data_source (paused / failed / deleted)', 'aiAgent.train.contract.sourcesInactive'],
  ['chunk (status != active)', 'aiAgent.train.contract.chunksInactive'],
  ['cross-workspace data', 'aiAgent.train.contract.crossWorkspace'],
  ['spam conversation content', 'aiAgent.train.contract.spam'],
]);

// Sync-log statuses, worker codes and messages, in the Overview page's words (aiAgent.overview.*).
const SYNC_STATUS = new Map<string, TranslationKey>([
  ['queued', 'aiAgent.overview.syncStatus.queued'],
  ['started', 'aiAgent.overview.syncStatus.started'],
  ['running', 'aiAgent.overview.syncStatus.running'],
  ['completed', 'aiAgent.overview.syncStatus.completed'],
  ['failed', 'aiAgent.overview.syncStatus.failed'],
  ['partial', 'aiAgent.overview.syncStatus.partial'],
  ['cancelled', 'aiAgent.overview.syncStatus.cancelled'],
  ['skipped', 'aiAgent.overview.syncStatus.skipped'],
  ['file_upload_received', 'aiAgent.overview.syncStatus.file_upload_received'],
  ['file_stored', 'aiAgent.overview.syncStatus.file_stored'],
  ['file_job_queued', 'aiAgent.overview.syncStatus.file_job_queued'],
  ['file_job_started', 'aiAgent.overview.syncStatus.file_job_started'],
  ['file_job_retry_queued', 'aiAgent.overview.syncStatus.file_job_retry_queued'],
  ['file_job_failed_non_retryable', 'aiAgent.overview.syncStatus.file_job_failed_non_retryable'],
  ['file_ingest_skipped_source_deleted', 'aiAgent.overview.syncStatus.file_ingest_skipped_source_deleted'],
  ['file_ingest_skipped_source_paused', 'aiAgent.overview.syncStatus.file_ingest_skipped_source_paused'],
  ['file_ingest_skipped_job_cancelled', 'aiAgent.overview.syncStatus.file_ingest_skipped_job_cancelled'],
  ['file_ingest_completion_skipped_job_cancelled', 'aiAgent.overview.syncStatus.file_ingest_completion_skipped_job_cancelled'],
  ['file_ingest_finalization_aborted', 'aiAgent.overview.syncStatus.file_ingest_finalization_aborted'],
]);
const SYNC_CODE = new Map<string, TranslationKey>([
  ['download_failed', 'aiAgent.overview.syncCode.download_failed'],
  ['storage_temporary_failure', 'aiAgent.overview.syncCode.storage_temporary_failure'],
  ['embedder_temporary_failure', 'aiAgent.overview.syncCode.embedder_temporary_failure'],
  ['source_paused', 'aiAgent.overview.syncCode.source_paused'],
  ['source_deleted', 'aiAgent.overview.syncCode.source_deleted'],
  ['source_cancelled', 'aiAgent.overview.syncCode.source_cancelled'],
  ['job_cancelled', 'aiAgent.overview.syncCode.job_cancelled'],
  ['file_ingest_failed', 'aiAgent.overview.syncCode.file_ingest_failed'],
  ['sync_file_ingestion_disabled', 'aiAgent.overview.syncCode.sync_file_ingestion_disabled'],
  ['unsupported_file_type', 'aiAgent.overview.syncCode.unsupported_file_type'],
  ['file_too_large', 'aiAgent.overview.syncCode.file_too_large'],
  ['parse_failed', 'aiAgent.overview.syncCode.parse_failed'],
  ['empty_document', 'aiAgent.overview.syncCode.empty_document'],
  ['missing', 'aiAgent.overview.syncCode.missing'],
  ['unknown', 'aiAgent.overview.syncCode.unknown'],
]);
const SYNC_MESSAGE = new Map<string, TranslationKey>([
  ['Worker started', 'aiAgent.overview.syncMessage.worker_started'],
  ['Sync completed', 'aiAgent.overview.syncMessage.sync_completed'],
  ['Sync job queued', 'aiAgent.overview.syncMessage.sync_queued'],
  ['Sync job queued (admin bypass)', 'aiAgent.overview.syncMessage.sync_queued_admin'],
  ['Retry sync job queued', 'aiAgent.overview.syncMessage.retry_queued'],
  ['Retry sync job queued (admin bypass)', 'aiAgent.overview.syncMessage.retry_queued_admin'],
  ['Original stored', 'aiAgent.overview.syncMessage.original_stored'],
  ['Ingestion job queued', 'aiAgent.overview.syncMessage.ingestion_queued'],
]);
const SYNC_MESSAGE_PREFIX: Array<[RegExp, TranslationKey, 'name' | 'value']> = [
  [/^Upload accepted:\s*(.+)$/i, 'aiAgent.overview.syncMessage.upload_accepted', 'name'],
  [/^Crawl failed:\s*(.+)$/i, 'aiAgent.overview.syncMessage.crawl_failed', 'value'],
  [/^job_status=(.+)$/i, 'aiAgent.overview.syncMessage.job_status', 'value'],
  [/^source_status=(.+)$/i, 'aiAgent.overview.syncMessage.source_status', 'value'],
  [/^complete_lost_race:(.+)$/i, 'aiAgent.overview.syncMessage.complete_lost_race', 'value'],
  [/^fail_lost_race:(.+)$/i, 'aiAgent.overview.syncMessage.fail_lost_race', 'value'],
];

/**
 * A warning in the Overview page's words (aiAgent.overview.warning.*), read
 * from the server's message (server/services/ai-agent/train.ts). A code or a
 * message shape not known here keeps the server's text. `detail` is the
 * source's own error, when the server gave one.
 */
function warningText(t: TFn, w: TrainWarning): { text: string; detail?: string } {
  const msg = w.message;
  const count = msg.match(/^(\d+) /)?.[1];
  switch (w.code) {
    case 'no_knowledge_sources': return { text: t('aiAgent.overview.warning.no_knowledge_sources') };
    case 'no_embedded_chunks': return { text: t('aiAgent.overview.warning.no_embedded_chunks') };
    case 'no_qna': return { text: t('aiAgent.overview.warning.no_qna') };
    case 'failed_embeddings':
      if (count) return { text: t('aiAgent.overview.warning.failed_embeddings', { count }) };
      break;
    case 'learning_candidates_pending':
      if (count) return { text: t('aiAgent.overview.warning.learning_candidates_pending', { count }) };
      break;
    case 'only_draft_kb':
      if (count) return { text: t('aiAgent.overview.warning.only_draft_kb', { count }) };
      break;
    case 'website_not_synced': {
      const m = msg.match(/^Website source "([\s\S]*)" has not been synced yet\.$/);
      if (m) return { text: t('aiAgent.overview.warning.website_not_synced', { name: m[1] }) };
      break;
    }
    case 'source_failed': {
      const m = msg.match(/^Source "([\s\S]*?)" sync failed(?:: ([\s\S]*))?\.$/);
      if (m) return { text: t('aiAgent.overview.warning.source_failed', { name: m[1] }), detail: m[2] };
      break;
    }
    default:
      break;
  }
  return { text: msg };
}

/**
 * The assistant's sync status: counts, warnings, quick actions, sync logs,
 * the retrieval rules and the index. `embedded`: inside the Knowledge Base's
 * status tab (KnowledgeStatusTab.tsx), whose hero and tab name the page, so
 * it has no header of its own.
 */
export default function TrainPage({ embedded = false }: { embedded?: boolean }) {
  const { workspace, isLoading: workspaceLoading } = useActiveWorkspace();
  const wsId = workspace?.id;
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useTranslation();

  const overview = useQuery({
    queryKey: ['ai-train-overview', wsId],
    queryFn: () => aiAgentApi.getTrainOverview(wsId!),
    enabled: !!wsId,
    staleTime: 15_000,
  });

  const rebuild = useMutation({
    mutationFn: () => aiAgentApi.rebuildKnowledgeIndex(wsId!),
    onSuccess: (r) => {
      toast({
        title: t('aiAgent.train.rebuilt'),
        description: t('aiAgent.train.rebuildSummary', { embeddings: r.embeddingsGenerated, sources: r.sourcesProcessed }),
      });
      qc.invalidateQueries({ queryKey: ['ai-train-overview', wsId] });
    },
    onError: (e) => toast({ title: t('aiAgent.train.rebuildFailed'), description: e?.message, variant: 'destructive' }),
  });

  const fromMap = (map: Map<string, TranslationKey>, raw: string): string | undefined => {
    const key = map.get(raw);
    return key ? t(key) : undefined;
  };
  const typeText = (sourceType: string) => fromMap(TYPE_LABEL, sourceType) ?? sourceType;
  const statusText = (status: string) => fromMap(SYNC_STATUS, status) ?? status;
  /** A worker code (download_failed, source_paused…) in words, when known. */
  const codeText = (code: string) => fromMap(SYNC_CODE, code) ?? fromMap(SYNC_STATUS, code) ?? code;
  const messageText = (raw: string | null | undefined): string => {
    const msg = (raw || '').trim();
    if (!msg) return '';
    const exact = fromMap(SYNC_MESSAGE, msg);
    if (exact) return exact;
    for (const [re, key, param] of SYNC_MESSAGE_PREFIX) {
      const hit = msg.match(re);
      if (!hit) continue;
      const value = param === 'value' ? codeText(hit[1].trim()) : hit[1].trim();
      return t(key, { [param]: value });
    }
    return /^[a-z0-9_]+$/.test(msg) ? codeText(msg) : msg;
  };
  /** A model or provider name; the server's "noop" means there is none. */
  const indexValue = (value: string) => (
    value === 'noop' ? t('aiAgent.train.index.none') : <span className="font-mono" dir="ltr">{value}</span>
  );

  if (overview.isLoading || workspaceLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  const data = overview.data;
  if (!data) return <p className="text-sm text-muted-foreground">{t('aiAgent.train.noData')}</p>;
  const c = data.counts;
  const ki = data.knowledgeIndex;
  const refreshButton = (
    <Button variant="outline" size="sm" className="shrink-0" onClick={() => overview.refetch()} disabled={overview.isFetching}>
      <RefreshCw className={`h-3.5 w-3.5 me-1.5 ${overview.isFetching ? 'animate-spin' : ''}`} />{t('aiAgent.train.refresh')}
    </Button>
  );

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted-foreground">{t('aiAgent.train.subtitle')}</p>
          {refreshButton}
        </div>
      ) : (
        <AiPageHeader
          icon={Database}
          accent="cyan"
          title={t('aiAgent.train.title')}
          subtitle={t('aiAgent.train.subtitle')}
          actions={refreshButton}
        />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={t('aiAgent.train.stats.totalSources')} value={String(c.totalSources)} hint={t('aiAgent.train.stats.activeHint', { count: c.activeSources })} />
        <Stat label={t('aiAgent.train.stats.activeChunks')} value={String(c.activeChunks)} hint={t('aiAgent.train.stats.embeddedHint', { count: c.embeddedChunks })} />
        <Stat label={t('aiAgent.train.stats.qna')} value={`${c.qnaEnabled}/${c.qnaEnabled + c.qnaDisabled}`} hint={t('aiAgent.train.stats.qnaHint')} />
        <Stat label={t('aiAgent.train.stats.kbArticles')} value={`${c.kbPublished}/${c.kbPublished + c.kbDraft}`} hint={t('aiAgent.train.stats.kbHint')} />
        <Stat label={t('aiAgent.train.stats.failedSources')} value={String(c.failedSources)} />
        <Stat label={t('aiAgent.train.stats.failedEmbeddings')} value={String(c.failedEmbeddings)} />
        <Stat label={t('aiAgent.train.stats.pendingLearning')} value={String(c.learningPending)} />
        <Stat label={t('aiAgent.train.stats.lastSync')} value={data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : '—'} />
      </div>

      {data.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> {t('aiAgent.train.warnings')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.warnings.map((w, i) => {
              const { text, detail } = warningText(t, w);
              return (
                <div key={`${w.code}-${i}`} dir="auto" className={`rounded-md border px-3 py-2 text-sm ${SEVERITY[w.severity] || ''}`}>
                  {text}
                  {detail && <span className="block text-xs opacity-80 mt-0.5"><bdi>{codeText(detail)}</bdi></span>}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('aiAgent.train.quickActions')}</CardTitle>
          <CardDescription>{t('aiAgent.train.quickActionsDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {/* Each is a tab of the Knowledge Base, where knowledge is managed. */}
          <Action icon={MessageCircleQuestion} label={t('aiAgent.train.action.addQna')} onClick={() => navigate(wsPath(kbTabPath('qna')))} />
          <Action icon={Globe} label={t('aiAgent.train.action.addWebPage')} onClick={() => navigate(wsPath(kbTabPath('web')))} />
          <Action icon={FileText} label={t('aiAgent.train.action.uploadFile')} onClick={() => navigate(wsPath(kbTabPath('files')))} />
          <Action icon={GraduationCap} label={t('aiAgent.train.action.reviewLearning')} onClick={() => navigate(wsPath(kbTabPath('learning')))} />
          <Action icon={RefreshCw} label={t('aiAgent.train.action.rebuildIndex')} onClick={() => rebuild.mutate()} loading={rebuild.isPending} />
          <Action icon={LayoutDashboard} label={t('aiAgent.train.action.openOverview')} onClick={() => navigate(wsPath('/ai-agent/overview'))} />
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">{t('aiAgent.train.sourcesByType')}</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.sourcesByType.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('aiAgent.train.noSources')}</p>
            ) : data.sourcesByType.map((s) => (
              <div key={s.source_type} className="flex items-center gap-2 text-sm py-1.5 border-b last:border-b-0">
                <Badge variant="outline" className="text-[10px] shrink-0">{typeText(s.source_type)}</Badge>
                <span className="flex-1 text-xs text-muted-foreground">{t('aiAgent.train.sourceCounts', { active: s.active, paused: s.paused, failed: s.failed })}</span>
                <span className="tabular-nums text-xs">{s.total}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">{t('aiAgent.train.recentSyncLogs')}</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.recentSyncLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('aiAgent.train.noSyncs')}</p>
            ) : (data.recentSyncLogs as unknown as SyncLogRow[]).slice(0, 8).map((l) => (
              <div key={l.id} className="flex items-start gap-2 text-xs py-1.5 border-b last:border-b-0">
                <Badge variant="outline" className="text-[10px] shrink-0">{statusText(l.status)}</Badge>
                <span className="flex-1 truncate">
                  <bdi>{messageText(l.message) || t('aiAgent.train.syncSummary', { pages: l.pages_found, chunks: l.chunks_created })}</bdi>
                </span>
                <span className="tabular-nums text-muted-foreground shrink-0">{new Date(l.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-500" /> {t('aiAgent.train.contract.title')}
          </CardTitle>
          <CardDescription>{t('aiAgent.train.contract.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-4 text-xs">
          <div>
            <p className="font-medium text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> {t('aiAgent.train.contract.allowed')}</p>
            <ul className="space-y-1 text-muted-foreground list-disc list-inside">
              {data.retrievalContract.allowed.map((s) => <li key={s}>{fromMap(CONTRACT_LABEL, s) ?? s}</li>)}
            </ul>
          </div>
          <div>
            <p className="font-medium text-destructive mb-1.5 flex items-center gap-1.5"><ShieldX className="h-3.5 w-3.5" /> {t('aiAgent.train.contract.blocked')}</p>
            <ul className="space-y-1 text-muted-foreground list-disc list-inside">
              {data.retrievalContract.blocked.map((s) => <li key={s}>{fromMap(CONTRACT_LABEL, s) ?? s}</li>)}
            </ul>
          </div>
        </CardContent>
      </Card>

      {ki && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('aiAgent.train.index.title')}</CardTitle>
            <CardDescription>
              {t('aiAgent.train.index.provider')} {indexValue(ki.embeddingProvider || 'noop')}
              {' · '}{t('aiAgent.train.index.model')} {indexValue(ki.embeddingModel || '—')}
              {' · '}{t('aiAgent.train.index.available')} {ki.embeddingProviderAvailable ? t('aiAgent.train.index.yes') : t('aiAgent.train.index.no')}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {Object.entries(ki.bySourceType).length === 0 ? t('aiAgent.train.index.empty') : (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(ki.bySourceType).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="text-[10px]">{typeText(k)}: {v}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold mt-1 tabular-nums">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Action({ icon: Icon, label, onClick, loading }: { icon: LucideIcon; label: string; onClick: () => void; loading?: boolean }) {
  return (
    <Button variant="outline" className="justify-start h-auto py-2.5 whitespace-normal text-start" onClick={onClick} disabled={loading}>
      {loading ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Icon className="h-4 w-4 me-2 text-primary" />}
      <span className="text-sm">{label}</span>
    </Button>
  );
}
