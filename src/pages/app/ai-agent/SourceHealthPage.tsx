import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { formatDateTime } from '@/lib/date';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertTriangle, ShieldAlert, RefreshCw, Loader2 } from 'lucide-react';
import { isolate } from './testRunLabels';

/** One row of GET /api/ai-agent/source-health (server/services/ai-agent/sourceHealth.ts SourceHealthItem). */
interface SourceHealthRow {
  source_type: string;
  source_id: string;
  title: string;
  status: string | null;
  eligible: boolean;
  reason: string;
  active_chunks_count: number;
  embedded_chunks_count: number;
  last_indexed_at: string | null;
  last_error: string | null;
}

type SourceHealthSummary = Partial<Record<
  | 'eligible' | 'not_eligible' | 'active_chunks_total' | 'embedded_chunks_total'
  | 'qna_enabled' | 'qna_disabled' | 'learned_qna_approved' | 'learned_qna_unapproved'
  | 'files_active' | 'files_not_active' | 'websites_active' | 'websites_not_active'
  | 'web_pages_eligible' | 'web_pages_not_eligible',
  number
>>;

export default function SourceHealthPage() {
  const { workspace } = useActiveWorkspace();
  const { t } = useTranslation();
  const wsId = workspace?.id;
  const [sourceType, setSourceType] = useState<string>('');
  const [eligible, setEligible] = useState<string>('');
  const [query, setQuery] = useState('');

  const q = useQuery({
    queryKey: ['ai-agent', 'source-health', wsId, sourceType, eligible, query],
    queryFn: () => aiAgentApi.getSourceHealth(wsId!, {
      sourceType: sourceType || undefined,
      eligible: eligible === 'true' ? true : eligible === 'false' ? false : undefined,
      query: query || undefined,
      limit: 500,
    }),
    enabled: !!wsId,
  });

  const items = (q.data?.items || []) as SourceHealthRow[];
  const summary = (q.data?.summary || {}) as SourceHealthSummary;

  const reasonLabels: Record<string, string> = {
    eligible: t('aiAgent.adv.sourceHealth.reason.eligible'),
    no_active_chunks: t('aiAgent.adv.sourceHealth.reason.no_active_chunks'),
    disabled_qna: t('aiAgent.adv.sourceHealth.reason.disabled_qna'),
    candidate_not_approved: t('aiAgent.adv.sourceHealth.reason.candidate_not_approved'),
    draft_kb: t('aiAgent.adv.sourceHealth.reason.draft_kb'),
    kb_disabled_for_ai: t('aiAgent.adv.sourceHealth.reason.kb_disabled_for_ai'),
    kb_locked: t('aiAgent.adv.sourceHealth.reason.kb_locked'),
    file_not_active: t('aiAgent.adv.sourceHealth.reason.file_not_active'),
    website_not_active: t('aiAgent.adv.sourceHealth.reason.website_not_active'),
    source_missing: t('aiAgent.adv.sourceHealth.reason.source_missing'),
    embedding_missing: t('aiAgent.adv.sourceHealth.reason.embedding_missing'),
    unknown: t('aiAgent.adv.sourceHealth.reason.unknown'),
  };
  // Each source type's own statuses: Q&A enabled/disabled, a learned answer's
  // review, an article's publication, a file's or a website's sync.
  const statusLabels: Record<string, string> = {
    enabled: t('aiAgent.adv.sourceHealth.status.enabled'),
    disabled: t('aiAgent.adv.sourceHealth.status.disabled'),
    pending: t('aiAgent.adv.sourceHealth.status.pending'),
    approved: t('aiAgent.adv.sourceHealth.status.approved'),
    rejected: t('aiAgent.adv.sourceHealth.status.rejected'),
    converted_to_qna: t('aiAgent.adv.sourceHealth.status.converted_to_qna'),
    converted_to_kb: t('aiAgent.adv.sourceHealth.status.converted_to_kb'),
    draft: t('aiAgent.adv.sourceHealth.status.draft'),
    published: t('aiAgent.adv.sourceHealth.status.published'),
    archived: t('aiAgent.adv.sourceHealth.status.archived'),
    active: t('aiAgent.adv.sourceHealth.status.active'),
    paused: t('aiAgent.adv.sourceHealth.status.paused'),
    syncing: t('aiAgent.adv.sourceHealth.status.syncing'),
    failed: t('aiAgent.adv.sourceHealth.status.failed'),
    deleted: t('aiAgent.adv.sourceHealth.status.deleted'),
    stale: t('aiAgent.adv.sourceHealth.status.stale'),
    inactive: t('aiAgent.adv.sourceHealth.status.inactive'),
  };
  const typeLabels: Record<string, string> = {
    qna: t('aiAgent.codes.sourceType.qna'),
    learned_qna: t('aiAgent.codes.sourceType.learned_qna'),
    kb_article: t('aiAgent.codes.sourceType.kb_article'),
    file: t('aiAgent.codes.sourceType.file'),
    website: t('aiAgent.codes.sourceType.website'),
    web_page: t('aiAgent.codes.sourceType.web_page'),
  };
  const word = (map: Record<string, string>, code: string | null | undefined) =>
    code ? (map[code] ?? isolate(code)) : '—';
  const pair = (a?: number, b?: number) => `${a || 0} / ${b || 0}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" /> {t('aiAgent.adv.sourceHealth.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('aiAgent.adv.sourceHealth.subtitle')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 me-1.5 ${q.isFetching ? 'animate-spin' : ''}`} /> {t('aiAgent.adv.sourceHealth.refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={t('aiAgent.adv.sourceHealth.stats.eligible')} value={summary.eligible || 0} accent="ok" />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.notEligible')} value={summary.not_eligible || 0} accent="warn" />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.activeChunks')} value={summary.active_chunks_total || 0} />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.embeddedChunks')} value={summary.embedded_chunks_total || 0} />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.qna')} value={pair(summary.qna_enabled, summary.qna_disabled)} />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.learned')} value={pair(summary.learned_qna_approved, summary.learned_qna_unapproved)} />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.files')} value={pair(summary.files_active, summary.files_not_active)} />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.websites')} value={pair(summary.websites_active, summary.websites_not_active)} />
        <Stat label={t('aiAgent.adv.sourceHealth.stats.webPages')} value={pair(summary.web_pages_eligible, summary.web_pages_not_eligible)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('aiAgent.adv.sourceHealth.filters.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value)}
            aria-label={t('aiAgent.adv.sourceHealth.filters.typeLabel')}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">{t('aiAgent.adv.sourceHealth.filters.allTypes')}</option>
            <option value="qna">{typeLabels.qna}</option>
            <option value="learned_qna">{typeLabels.learned_qna}</option>
            <option value="kb_article">{typeLabels.kb_article}</option>
            <option value="file">{typeLabels.file}</option>
            <option value="website">{typeLabels.website}</option>
            <option value="web_page">{typeLabels.web_page}</option>
          </select>
          <select
            value={eligible}
            onChange={(e) => setEligible(e.target.value)}
            aria-label={t('aiAgent.adv.sourceHealth.filters.eligibilityLabel')}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">{t('aiAgent.adv.sourceHealth.filters.allEligibility')}</option>
            <option value="true">{t('aiAgent.adv.sourceHealth.filters.eligibleOnly')}</option>
            <option value="false">{t('aiAgent.adv.sourceHealth.filters.notEligibleOnly')}</option>
          </select>
          <Input
            placeholder={t('aiAgent.adv.sourceHealth.filters.search')}
            aria-label={t('aiAgent.adv.sourceHealth.filters.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 sm:col-span-2"
          />
        </CardContent>
      </Card>

      {q.isLoading ? (
        <div className="flex justify-center py-10" role="status" aria-label={t('aiAgent.adv.sourceHealth.loading')}>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">{t('aiAgent.adv.sourceHealth.empty')}</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="text-xs w-full">
              <thead className="bg-muted/40">
                <tr className="text-start">
                  <th className="py-2 px-3 text-start">{t('aiAgent.adv.sourceHealth.cols.type')}</th>
                  <th className="py-2 px-3 text-start">{t('aiAgent.adv.sourceHealth.cols.title')}</th>
                  <th className="py-2 px-3 text-start">{t('aiAgent.adv.sourceHealth.cols.status')}</th>
                  <th className="py-2 px-3 text-start">{t('aiAgent.adv.sourceHealth.cols.eligibility')}</th>
                  <th className="py-2 px-3 text-start">{t('aiAgent.adv.sourceHealth.cols.reason')}</th>
                  <th className="py-2 px-3 text-end">{t('aiAgent.adv.sourceHealth.cols.active')}</th>
                  <th className="py-2 px-3 text-end">{t('aiAgent.adv.sourceHealth.cols.embedded')}</th>
                  <th className="py-2 px-3 text-start">{t('aiAgent.adv.sourceHealth.cols.lastIndexed')}</th>
                  <th className="py-2 px-3 text-start">{t('aiAgent.adv.sourceHealth.cols.lastError')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={`${it.source_type}:${it.source_id}`} className="border-t border-border/40">
                    <td className="py-2 px-3"><Badge variant="outline">{word(typeLabels, it.source_type)}</Badge></td>
                    <td className="py-2 px-3 max-w-[280px] truncate" title={it.title} dir="auto">{it.title}</td>
                    <td className="py-2 px-3">{word(statusLabels, it.status)}</td>
                    <td className="py-2 px-3">
                      {it.eligible
                        ? <Badge className="gap-1"><CheckCircle2 className="h-3 w-3" /> {t('aiAgent.adv.sourceHealth.eligible')}</Badge>
                        : <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> {t('aiAgent.adv.sourceHealth.notEligible')}</Badge>}
                    </td>
                    <td className="py-2 px-3">{word(reasonLabels, it.reason)}</td>
                    <td className="py-2 px-3 text-end tabular-nums">{it.active_chunks_count}</td>
                    <td className="py-2 px-3 text-end tabular-nums">{it.embedded_chunks_count}</td>
                    <td className="py-2 px-3">{it.last_indexed_at ? formatDateTime(it.last_indexed_at) : '—'}</td>
                    <td className="py-2 px-3 text-destructive max-w-[220px] truncate" title={it.last_error || ''} dir={it.last_error ? 'auto' : undefined}>{it.last_error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: 'ok' | 'warn' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-xl font-semibold mt-1 tabular-nums ${accent === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : accent === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
