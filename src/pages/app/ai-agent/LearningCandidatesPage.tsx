import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type LearningCandidate } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { Sparkles, Check, X, FileText, Loader2, RefreshCw, GraduationCap } from 'lucide-react';

type Tab = 'pending' | 'approved' | 'rejected' | 'converted';

export default function LearningCandidatesPage() {
  const workspace = useCurrentWorkspace() as any;
  const wsId = workspace?.id;
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<LearningCandidate[]>([]);
  const [stats, setStats] = useState<{ pending: number; approved: number; converted_to_qna: number; converted_to_kb: number; rejected: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const status = tab === 'converted' ? 'converted_to_qna' : tab;
      const [c, s] = await Promise.all([
        aiAgentApi.listLearningCandidates(wsId, status as any),
        aiAgentApi.getLearningCandidateStats(wsId),
      ]);
      let list = c.items || [];
      if (tab === 'converted') {
        const kb = await aiAgentApi.listLearningCandidates(wsId, 'converted_to_kb');
        list = [...list, ...(kb.items || [])];
      }
      setItems(list);
      setStats(s as any);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId, tab]);

  async function generate() {
    if (!wsId) return;
    setGenerating(true);
    try {
      const r = await aiAgentApi.generateLearningCandidates(wsId);
      toast({ title: 'Scan complete', description: `${r.created} created · ${r.skipped} skipped (scanned ${r.scanned})` });
      refresh();
    } catch (e: any) {
      toast({ title: 'Generate failed', description: e?.message, variant: 'destructive' });
    } finally { setGenerating(false); }
  }

  if (!wsId) return null;
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <GraduationCap className="h-6 w-6" /> Learning Candidates
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review questions the AI couldn't confidently answer. Pending candidates are NEVER used by the AI until you approve them.
        </p>
      </div>
      <div className="flex items-center justify-between">
        {stats && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">Pending: {stats.pending}</Badge>
            <Badge variant="outline">Approved: {stats.approved}</Badge>
            <Badge variant="outline">→ Q&A: {stats.converted_to_qna}</Badge>
            <Badge variant="outline">→ KB: {stats.converted_to_kb}</Badge>
            <Badge variant="outline">Rejected: {stats.rejected}</Badge>
          </div>
        )}
        <Button size="sm" variant="outline" onClick={generate} disabled={generating}>
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
          Scan recent runs
        </Button>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="converted">Converted</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="space-y-3">
          {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
          {!loading && items.length === 0 && (
            <Card className="p-6 text-sm text-muted-foreground">No {tab} candidates.</Card>
          )}
          {items.map((c) => (
            <CandidateRow key={c.id} candidate={c} onChanged={refresh} readOnly={tab !== 'pending' && tab !== 'approved'} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CandidateRow({ candidate, onChanged, readOnly }: { candidate: LearningCandidate; onChanged: () => void; readOnly?: boolean }) {
  const [question, setQuestion] = useState(candidate.question_text);
  const [answer, setAnswer] = useState(candidate.suggested_answer ?? candidate.answer_text);
  const [locale, setLocale] = useState(candidate.locale ?? 'en');
  const [busy, setBusy] = useState<null | 'qna' | 'kb' | 'reject' | 'learned' | 'kbpub'>(null);
  const reason = ((candidate as any).reason as string | undefined) || ((candidate.metadata as any)?.reason as string | undefined);
  const pageUrl = (candidate.metadata as any)?.page_context?.current_page_url as string | undefined;
  const answerEmpty = !answer || !answer.trim();

  async function approveLearned() {
    setBusy('learned');
    try {
      await aiAgentApi.approveLearningCandidateAsLearned(candidate.id, { final_answer: answer, question, locale });
      toast({ title: 'Approved as learned answer' });
      onChanged();
    } catch (e: any) { toast({ title: 'Approve failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function convertQna() {
    setBusy('qna');
    try {
      await aiAgentApi.convertLearningCandidateToQna(candidate.id, { question, answer, locale });
      toast({ title: 'Converted to Q&A' });
      onChanged();
    } catch (e: any) { toast({ title: 'Convert failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function convertKbDraft() {
    setBusy('kb');
    try {
      await aiAgentApi.convertLearningCandidateToKbV2(candidate.id, { title: question.slice(0, 120), answer, locale, publish: false });
      toast({ title: 'Converted to KB draft' });
      onChanged();
    } catch (e: any) { toast({ title: 'Convert failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function convertKbPub() {
    setBusy('kbpub');
    try {
      await aiAgentApi.convertLearningCandidateToKbV2(candidate.id, { title: question.slice(0, 120), answer, locale, publish: true });
      toast({ title: 'Published as KB article' });
      onChanged();
    } catch (e: any) { toast({ title: 'Publish failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  async function reject() {
    setBusy('reject');
    try {
      await aiAgentApi.rejectLearningCandidate(candidate.id);
      toast({ title: 'Rejected' });
      onChanged();
    } catch (e: any) { toast({ title: 'Reject failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusy(null); }
  }
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{candidate.source_type}</Badge>
        {reason && <Badge variant="secondary">{reason}</Badge>}
        {candidate.locale && <Badge variant="outline">{candidate.locale}</Badge>}
        <Badge variant="outline">{candidate.status}</Badge>
        <span>{new Date(candidate.created_at).toLocaleString()}</span>
        {candidate.conversation_id && (
          <a href={`/app/w/${candidate.workspace_id}/inbox?c=${candidate.conversation_id}`} className="underline">view conversation</a>
        )}
        {pageUrl && <a href={pageUrl} target="_blank" rel="noreferrer" className="underline truncate max-w-[260px]">{pageUrl}</a>}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">Visitor question</label>
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} disabled={readOnly} />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">Operator answer</label>
        <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} disabled={readOnly} />
        {answerEmpty && !readOnly && (
          <p className="text-xs text-destructive">Answer is required to approve, convert, or publish.</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium">Locale</label>
        <Input value={locale} onChange={(e) => setLocale(e.target.value)} className="w-24 h-8" disabled={readOnly} />
      </div>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={approveLearned} disabled={!!busy || answerEmpty}>
            {busy === 'learned' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <GraduationCap className="h-3.5 w-3.5 mr-1" />}
            Approve (learned)
          </Button>
          <Button size="sm" onClick={convertQna} disabled={!!busy || answerEmpty}>
            {busy === 'qna' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />}
            Convert to Q&A
          </Button>
          <Button size="sm" variant="outline" onClick={convertKbDraft} disabled={!!busy || answerEmpty}>
            {busy === 'kb' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
            KB draft
          </Button>
          <Button size="sm" variant="outline" onClick={convertKbPub} disabled={!!busy || answerEmpty}>
            {busy === 'kbpub' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
            KB publish
          </Button>
          <Button size="sm" variant="ghost" onClick={reject} disabled={!!busy}>
            {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <X className="h-3.5 w-3.5 mr-1" />}
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}