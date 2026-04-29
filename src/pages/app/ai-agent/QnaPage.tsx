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
import { MessageCircleQuestion, Sparkles, Check, X, FileText, Loader2 } from 'lucide-react';

export default function QnaPage() {
  const { workspace } = useCurrentWorkspace();
  const wsId = workspace?.id;
  const [tab, setTab] = useState<'qna' | 'learning'>('qna');
  const [qnaItems, setQnaItems] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<LearningCandidate[]>([]);
  const [stats, setStats] = useState<{ pending: number; converted_to_qna: number; converted_to_kb: number; rejected: number } | null>(null);
  const [loading, setLoading] = useState(false);

  async function refreshAll() {
    if (!wsId) return;
    setLoading(true);
    try {
      const [q, c, s] = await Promise.all([
        aiAgentApi.listQna(wsId),
        aiAgentApi.listLearningCandidates(wsId, 'pending'),
        aiAgentApi.getLearningCandidateStats(wsId),
      ]);
      setQnaItems(q.items || []);
      setCandidates(c.items || []);
      setStats(s as any);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refreshAll(); /* eslint-disable-next-line */ }, [wsId]);

  if (!wsId) return null;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <MessageCircleQuestion className="h-6 w-6" /> Questions & Answers
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Curated Q&A pairs the AI prefers, plus learning candidates collected from operator replies.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="qna">Q&A ({qnaItems.length})</TabsTrigger>
          <TabsTrigger value="learning" className="gap-1">
            <Sparkles className="h-3.5 w-3.5" /> Learning candidates
            {stats?.pending ? <Badge variant="secondary" className="ml-1">{stats.pending}</Badge> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="qna" className="space-y-3">
          {qnaItems.length === 0 ? (
            <Card className="p-6 text-sm text-muted-foreground">No Q&A pairs yet. Approve a learning candidate to seed your first one.</Card>
          ) : qnaItems.map((q: any) => (
            <Card key={q.id} className="p-4 space-y-1">
              <div className="text-sm font-medium">{q.question}</div>
              <div className="text-sm text-muted-foreground whitespace-pre-wrap">{q.answer}</div>
              <div className="flex gap-2 mt-2">
                <Badge variant="outline">{q.locale || 'en'}</Badge>
                {q.enabled === false && <Badge variant="destructive">disabled</Badge>}
              </div>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="learning" className="space-y-3">
          {stats && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">Pending: {stats.pending}</Badge>
              <Badge variant="outline">→ Q&A: {stats.converted_to_qna}</Badge>
              <Badge variant="outline">→ KB: {stats.converted_to_kb}</Badge>
              <Badge variant="outline">Rejected: {stats.rejected}</Badge>
            </div>
          )}
          {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
          {!loading && candidates.length === 0 && (
            <Card className="p-6 text-sm text-muted-foreground">
              No pending learning candidates. When the AI hands off and an operator replies with a useful answer, a candidate appears here for your review.
            </Card>
          )}
          {candidates.map((c) => (
            <CandidateRow key={c.id} candidate={c} onChanged={refreshAll} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CandidateRow({ candidate, onChanged }: { candidate: LearningCandidate; onChanged: () => void }) {
  const [question, setQuestion] = useState(candidate.question_text);
  const [answer, setAnswer] = useState(candidate.suggested_answer ?? candidate.answer_text);
  const [locale, setLocale] = useState(candidate.locale ?? 'en');
  const [busy, setBusy] = useState<null | 'qna' | 'kb' | 'reject'>(null);

  async function approve() {
    setBusy('qna');
    try {
      await aiAgentApi.approveLearningCandidateAsQna(candidate.id, { question, answer, locale });
      toast({ title: 'Approved as Q&A' });
      onChanged();
    } catch (e: any) {
      toast({ title: 'Approve failed', description: e?.message, variant: 'destructive' });
    } finally { setBusy(null); }
  }
  async function convertKb() {
    setBusy('kb');
    try {
      await aiAgentApi.convertLearningCandidateToKb(candidate.id, { title: question.slice(0, 120), answer, locale });
      toast({ title: 'Converted to KB draft' });
      onChanged();
    } catch (e: any) {
      toast({ title: 'Convert failed', description: e?.message, variant: 'destructive' });
    } finally { setBusy(null); }
  }
  async function reject() {
    setBusy('reject');
    try {
      await aiAgentApi.rejectLearningCandidate(candidate.id);
      toast({ title: 'Rejected' });
      onChanged();
    } catch (e: any) {
      toast({ title: 'Reject failed', description: e?.message, variant: 'destructive' });
    } finally { setBusy(null); }
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{candidate.source_type}</Badge>
        {candidate.locale && <Badge variant="outline">{candidate.locale}</Badge>}
        <span>{new Date(candidate.created_at).toLocaleString()}</span>
        {candidate.conversation_id && (
          <a href={`/app/w/${candidate.workspace_id}/inbox?c=${candidate.conversation_id}`} className="underline">view conversation</a>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">Visitor question</label>
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">Operator answer</label>
        <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium">Locale</label>
        <Input value={locale} onChange={(e) => setLocale(e.target.value)} className="w-24 h-8" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={approve} disabled={!!busy}>
          {busy === 'qna' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />}
          Approve as Q&A
        </Button>
        <Button size="sm" variant="outline" onClick={convertKb} disabled={!!busy}>
          {busy === 'kb' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
          Convert to KB draft
        </Button>
        <Button size="sm" variant="ghost" onClick={reject} disabled={!!busy}>
          {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <X className="h-3.5 w-3.5 mr-1" />}
          Reject
        </Button>
      </div>
    </Card>
  );
}
