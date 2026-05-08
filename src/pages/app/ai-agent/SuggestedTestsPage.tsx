/**
 * Pass E9 — Suggested regression test cases UI.
 *
 * Workspace-scoped review queue. Operator roles can generate suggestions
 * (from elsewhere in the app); only owners/admins can accept/reject/delete.
 * Accepting a suggestion creates a real `ai_agent_test_cases` row.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { aiAgentApi, type SuggestedTestCase, type SuggestedTestCaseStatus } from '@/lib/ai-agent-api';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Check, Trash2, X, FlaskConical } from 'lucide-react';

type TabKey = 'pending' | 'converted' | 'rejected' | 'all';
const BEHAVIORS = ['answer', 'no_answer', 'handoff', 'clarification'] as const;
const SOURCE_TYPES = ['', 'qna', 'learned_qna', 'kb_article', 'web_page', 'file', 'business_profile'] as const;

interface ReviewForm {
  id: string;
  name: string;
  input_message: string;
  expected_behavior: string;
  expected_source_type: string;
  expected_contains: string;
  expected_not_contains: string;
  min_confidence: string;
}

function toForm(s: SuggestedTestCase): ReviewForm {
  return {
    id: s.id,
    name: s.name,
    input_message: s.input_message,
    expected_behavior: s.expected_behavior,
    expected_source_type: s.expected_source_type || '',
    expected_contains: (s.expected_contains || []).join('\n'),
    expected_not_contains: (s.expected_not_contains || []).join('\n'),
    min_confidence: s.min_confidence != null ? String(s.min_confidence) : '',
  };
}

function StatusBadge({ s }: { s: SuggestedTestCaseStatus }) {
  const v = s === 'converted' ? 'default' : s === 'rejected' ? 'destructive' : 'secondary';
  return <Badge variant={v as any}>{s}</Badge>;
}

export default function SuggestedTestsPage() {
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>('pending');
  const [form, setForm] = useState<ReviewForm | null>(null);

  const list = useQuery({
    queryKey: ['ai-agent', 'suggested-tc', wsId, tab],
    queryFn: () => aiAgentApi.listSuggestedTestCases(wsId!, tab),
    enabled: !!wsId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ai-agent', 'suggested-tc', wsId] });

  const acceptMut = useMutation({
    mutationFn: ({ id, overrides }: { id: string; overrides: Partial<SuggestedTestCase> }) =>
      aiAgentApi.acceptSuggestedTestCase(id, overrides),
    onSuccess: (r) => { setForm(null); invalidate(); toast({ title: 'Test case created', description: `id ${r.test_case_id.slice(0, 8)}…` }); },
    onError: (e: any) => toast({ title: 'Accept failed', description: e?.message, variant: 'destructive' }),
  });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => aiAgentApi.rejectSuggestedTestCase(id, reason),
    onSuccess: () => { invalidate(); toast({ title: 'Rejected' }); },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => aiAgentApi.deleteSuggestedTestCase(id),
    onSuccess: () => { invalidate(); toast({ title: 'Deleted' }); },
  });

  const items = list.data?.items || [];
  const counts = useMemo(() => {
    const map = { pending: 0, converted: 0, rejected: 0, all: items.length };
    for (const it of items) (map as any)[it.status] = ((map as any)[it.status] || 0) + 1;
    return map;
  }, [items]);

  return (
    <div className="space-y-6 p-1">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-primary" /> Suggested Tests
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Drafts created from negative AI Assist feedback and failed test runs. Review and convert
          into real test cases. No changes are applied until you accept.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="converted">Converted</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader><CardTitle className="text-sm">{tab} ({items.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="p-6 text-muted-foreground text-sm">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No suggestions in this tab. Generate one from{' '}
              <Link className="text-primary hover:underline" to={wsPath('/ai-agent/operator-assist-analytics')}>Assist Analytics</Link>{' '}
              (worst runs) or a failed test run detail page.
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {items.map((s) => (
                <div key={s.id} className="p-4 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="outline">{s.expected_behavior}</Badge>
                      {s.expected_source_type && <Badge variant="secondary">{s.expected_source_type}</Badge>}
                      <Badge variant="outline" className="text-[10px]">{s.source_type}</Badge>
                      <StatusBadge s={s.status} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{s.input_message}</p>
                    {s.reason && <p className="text-xs text-muted-foreground italic mt-1">Reason: {s.reason}</p>}
                    {s.metadata?.converted_test_case_id && (
                      <p className="text-xs mt-1">
                        Converted to:{' '}
                        <Link className="text-primary hover:underline" to={wsPath('/ai-agent/test-cases')}>
                          {String(s.metadata.converted_test_case_id).slice(0, 8)}…
                        </Link>
                      </p>
                    )}
                  </div>
                  {s.status === 'pending' && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => setForm(toForm(s))}>
                        <Check className="h-3.5 w-3.5 mr-1" /> Accept
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => {
                        const reason = prompt('Reject reason (optional):') || '';
                        rejectMut.mutate({ id: s.id, reason });
                      }}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm('Delete this suggestion?')) deleteMut.mutate(s.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                  {s.status !== 'pending' && (
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm('Delete this suggestion?')) deleteMut.mutate(s.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Review & save as test case</DialogTitle></DialogHeader>
          {form && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Input message">
                <Textarea value={form.input_message} onChange={(e) => setForm({ ...form, input_message: e.target.value })} rows={3} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Expected behavior">
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_behavior} onChange={(e) => setForm({ ...form, expected_behavior: e.target.value })}>
                    {BEHAVIORS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </Field>
                <Field label="Expected source type">
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_source_type} onChange={(e) => setForm({ ...form, expected_source_type: e.target.value })}>
                    {SOURCE_TYPES.map((s) => <option key={s} value={s}>{s || '(any)'}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Min confidence (0–1)">
                <Input value={form.min_confidence} onChange={(e) => setForm({ ...form, min_confidence: e.target.value })} placeholder="0.6" />
              </Field>
              <Field label="Expected contains (one per line)">
                <Textarea value={form.expected_contains} onChange={(e) => setForm({ ...form, expected_contains: e.target.value })} rows={3} />
              </Field>
              <Field label="Expected NOT contains (one per line)">
                <Textarea value={form.expected_not_contains} onChange={(e) => setForm({ ...form, expected_not_contains: e.target.value })} rows={2} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button
              disabled={!form?.name || !form?.input_message || acceptMut.isPending}
              onClick={() => {
                if (!form) return;
                const overrides: Partial<SuggestedTestCase> = {
                  name: form.name,
                  input_message: form.input_message,
                  expected_behavior: form.expected_behavior as any,
                  expected_source_type: form.expected_source_type || null,
                  expected_contains: form.expected_contains.split('\n').map((s) => s.trim()).filter(Boolean),
                  expected_not_contains: form.expected_not_contains.split('\n').map((s) => s.trim()).filter(Boolean),
                  min_confidence: form.min_confidence ? Number(form.min_confidence) : null,
                };
                acceptMut.mutate({ id: form.id, overrides });
              }}
            >
              {acceptMut.isPending ? 'Saving…' : 'Save as test case'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* counts hint */}
      <p className="text-xs text-muted-foreground">
        Pending {counts.pending} · Converted {counts.converted} · Rejected {counts.rejected}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}