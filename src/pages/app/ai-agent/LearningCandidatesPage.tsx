import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation, type TranslationKey } from '@/i18n';
import { aiAgentApi, type LearningCandidate } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { Check, X, FileText, Loader2, RefreshCw, GraduationCap, Save } from 'lucide-react';
import { formatDateTime } from '@/lib/date';

type Tab = 'pending' | 'approved' | 'rejected' | 'converted';
type ListStatus = Parameters<typeof aiAgentApi.listLearningCandidates>[1];
type Stats = Awaited<ReturnType<typeof aiAgentApi.getLearningCandidateStats>>;

function errorText(e: unknown): string | undefined {
  return e instanceof Error ? e.message : undefined;
}
function textOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function useLabels() {
  const { t } = useTranslation();
  const tr = (key: string, params?: Record<string, string>) => t(`aiAgent.learning.${key}` as TranslationKey, params);
  const enumLabel = (group: 'status' | 'source' | 'reason', value?: string | null) => {
    if (!value) return '';
    const label = tr(`${group}.${value}`);
    return label.includes('aiAgent.learning') ? value.replace(/_/g, ' ') : label;
  };
  return { tr, enumLabel };
}

export default function LearningCandidatesPage() {
  const { dir } = useTranslation();
  const { tr, enumLabel } = useLabels();
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id;
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<LearningCandidate[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const status = tab === 'converted' ? 'converted_to_qna' : tab;
      const [c, s] = await Promise.all([
        aiAgentApi.listLearningCandidates(wsId, status as ListStatus),
        aiAgentApi.getLearningCandidateStats(wsId),
      ]);
      let list = c.items || [];
      if (tab === 'converted') {
        const kb = await aiAgentApi.listLearningCandidates(wsId, 'converted_to_kb');
        list = [...list, ...(kb.items || [])];
      }
      setItems(list);
      setStats(s);
    } catch (e: unknown) {
      toast({ title: tr('loadFailed'), description: errorText(e), variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh reads wsId and tab
  }, [wsId, tab]);

  async function generate() {
    if (!wsId) return;
    setGenerating(true);
    try {
      const r = await aiAgentApi.generateLearningCandidates(wsId);
      toast({
        title: tr('scanDone'),
        description: tr('scanSummary', { created: String(r.created), skipped: String(r.skipped), scanned: String(r.scanned) }),
      });
      refresh();
    } catch (e: unknown) {
      toast({ title: tr('scanFailed'), description: errorText(e), variant: 'destructive' });
    } finally { setGenerating(false); }
  }

  if (!wsId) return null;
  const emptyKey = tab === 'pending' ? 'emptyPending' : tab === 'approved' ? 'emptyApproved' : tab === 'converted' ? 'emptyConverted' : 'emptyRejected';

  return (
    <div dir={dir} className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <GraduationCap className="h-6 w-6" /> {tr('title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{tr('subtitle')}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {stats && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{tr('statsPending')}: {stats.pending}</Badge>
            <Badge variant="outline">{tr('statsApproved')}: {stats.approved}</Badge>
            <Badge variant="outline">{tr('statsQna')}: {stats.converted_to_qna}</Badge>
            <Badge variant="outline">{tr('statsKb')}: {stats.converted_to_kb}</Badge>
            <Badge variant="outline">{tr('statsRejected')}: {stats.rejected}</Badge>
          </div>
        )}
        <Button size="sm" variant="outline" onClick={generate} disabled={generating}>
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <RefreshCw className="h-3.5 w-3.5 me-1" />}
          {generating ? tr('scanning') : tr('scan')}
        </Button>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="pending">{tr('tabPending')}</TabsTrigger>
          <TabsTrigger value="approved">{tr('tabApproved')}</TabsTrigger>
          <TabsTrigger value="converted">{tr('tabConverted')}</TabsTrigger>
          <TabsTrigger value="rejected">{tr('tabRejected')}</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="space-y-3">
          {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {tr('loading')}</div>}
          {!loading && items.length === 0 && (
            <Card className="p-6 text-sm text-muted-foreground">{tr(emptyKey)}</Card>
          )}
          {items.map((c) => (
            <CandidateRow key={c.id} candidate={c} onChanged={refresh} readOnly={tab !== 'pending' && tab !== 'approved'} tr={tr} enumLabel={enumLabel} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CandidateRow({ candidate, onChanged, readOnly, tr, enumLabel }: {
  candidate: LearningCandidate;
  onChanged: () => void;
  readOnly?: boolean;
  tr: (key: string, params?: Record<string, string>) => string;
  enumLabel: (group: 'status' | 'source' | 'reason', value?: string | null) => string;
}) {
  const [question, setQuestion] = useState(candidate.question_text);
  const [answer, setAnswer] = useState(candidate.suggested_answer ?? candidate.answer_text);
  const [locale, setLocale] = useState(candidate.locale ?? 'en');
  const [busy, setBusy] = useState<null | 'qna' | 'kb' | 'reject' | 'learned' | 'kbpub'>(null);
  const [saving, setSaving] = useState(false);
  const wsPath = useWorkspacePath();
  const meta: Record<string, unknown> = candidate.metadata || {};
  const reason = textOrUndefined((candidate as { reason?: unknown }).reason) || textOrUndefined(meta.reason);
  const pageUrl = textOrUndefined((meta.page_context as { current_page_url?: unknown } | null | undefined)?.current_page_url);
  const answerEmpty = !answer || !answer.trim();
  const questionEmpty = !question || !question.trim();

  async function saveEdits() {
    setSaving(true);
    try {
      await aiAgentApi.patchLearningCandidate(candidate.id, { question_text: question, suggested_answer: answer, locale });
      toast({ title: tr('updated') });
      onChanged();
    } catch (e: unknown) {
      toast({ title: tr('updateFailed'), description: errorText(e), variant: 'destructive' });
    } finally { setSaving(false); }
  }

  async function approveLearned() {
    setBusy('learned');
    try {
      await aiAgentApi.approveLearningCandidateAsLearned(candidate.id, { final_answer: answer, question, locale });
      toast({ title: tr('approved') });
      onChanged();
    } catch (e: unknown) { toast({ title: tr('approveFailed'), description: errorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function convertQna() {
    setBusy('qna');
    try {
      await aiAgentApi.convertLearningCandidateToQna(candidate.id, { question, answer, locale });
      toast({ title: tr('convertedQna') });
      onChanged();
    } catch (e: unknown) { toast({ title: tr('convertFailed'), description: errorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function convertKbDraft() {
    setBusy('kb');
    try {
      await aiAgentApi.convertLearningCandidateToKbV2(candidate.id, { title: question.slice(0, 120), answer, locale, publish: false });
      toast({ title: tr('convertedKb') });
      onChanged();
    } catch (e: unknown) { toast({ title: tr('convertFailed'), description: errorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function convertKbPub() {
    setBusy('kbpub');
    try {
      await aiAgentApi.convertLearningCandidateToKbV2(candidate.id, { title: question.slice(0, 120), answer, locale, publish: true });
      toast({ title: tr('publishedKb') });
      onChanged();
    } catch (e: unknown) { toast({ title: tr('publishFailed'), description: errorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function reject() {
    setBusy('reject');
    try {
      await aiAgentApi.rejectLearningCandidate(candidate.id);
      toast({ title: tr('rejected') });
      onChanged();
    } catch (e: unknown) { toast({ title: tr('rejectFailed'), description: errorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{enumLabel('source', candidate.source_type)}</Badge>
        {reason && <Badge variant="secondary">{enumLabel('reason', reason)}</Badge>}
        {candidate.locale && <Badge variant="outline">{candidate.locale}</Badge>}
        <Badge variant="outline">{enumLabel('status', candidate.status)}</Badge>
        <span>{formatDateTime(candidate.created_at)}</span>
        {candidate.conversation_id && (
          // Workspace URLs are /<slug>/…, never the workspace id.
          <Link to={wsPath(`/inbox?c=${candidate.conversation_id}`)} className="underline">{tr('viewConversation')}</Link>
        )}
        {pageUrl && <a href={pageUrl} target="_blank" rel="noreferrer" className="underline truncate max-w-[260px]">{pageUrl}</a>}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">{tr('question')}</label>
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} disabled={readOnly} />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">{tr('answer')}</label>
        <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} disabled={readOnly} />
        {answerEmpty && !readOnly && (
          <p className="text-xs text-destructive">{tr('answerRequired')}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium">{tr('locale')}</label>
        <Input value={locale} onChange={(e) => setLocale(e.target.value)} className="w-24 h-8" disabled={readOnly} />
      </div>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={saveEdits} disabled={saving || answerEmpty || questionEmpty}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <Save className="h-3.5 w-3.5 me-1" />}
            {tr('saveEdits')}
          </Button>
          <Button size="sm" onClick={approveLearned} disabled={!!busy || answerEmpty}>
            {busy === 'learned' ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <GraduationCap className="h-3.5 w-3.5 me-1" />}
            {tr('approveLearned')}
          </Button>
          <Button size="sm" onClick={convertQna} disabled={!!busy || answerEmpty}>
            {busy === 'qna' ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <Check className="h-3.5 w-3.5 me-1" />}
            {tr('convertQna')}
          </Button>
          <Button size="sm" variant="outline" onClick={convertKbDraft} disabled={!!busy || answerEmpty}>
            {busy === 'kb' ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <FileText className="h-3.5 w-3.5 me-1" />}
            {tr('kbDraft')}
          </Button>
          <Button size="sm" variant="outline" onClick={convertKbPub} disabled={!!busy || answerEmpty}>
            {busy === 'kbpub' ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <FileText className="h-3.5 w-3.5 me-1" />}
            {tr('kbPublish')}
          </Button>
          <Button size="sm" variant="ghost" onClick={reject} disabled={!!busy}>
            {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <X className="h-3.5 w-3.5 me-1" />}
            {tr('reject')}
          </Button>
        </div>
      )}
    </Card>
  );
}
