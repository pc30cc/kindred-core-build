import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { MessageCircleQuestion, Loader2, Plus, GraduationCap, Trash2, Pencil, Save, X } from 'lucide-react';

export default function QnaPage() {
  const workspace = useCurrentWorkspace() as any;
  const wsId = workspace?.id;
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [locale, setLocale] = useState('en');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQ, setEditQ] = useState('');
  const [editA, setEditA] = useState('');
  const [editLocale, setEditLocale] = useState('en');
  const [saving, setSaving] = useState(false);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const [list, stats] = await Promise.all([
        aiAgentApi.listQna(wsId),
        aiAgentApi.getLearningCandidateStats(wsId).catch(() => null),
      ]);
      setItems(list.items || []);
      setPendingCount((stats as any)?.pending || 0);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function createQna() {
    if (!wsId) return;
    if (!q.trim() || !a.trim()) {
      toast({ title: 'Question and answer are required', variant: 'destructive' });
      return;
    }
    setCreating(true);
    try {
      await aiAgentApi.createQna(wsId, { question: q.trim(), answer: a.trim(), locale });
      setQ(''); setA('');
      toast({ title: 'Q&A added' });
      refresh();
    } catch (e: any) {
      toast({ title: 'Create failed', description: e?.message, variant: 'destructive' });
    } finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this Q&A?')) return;
    try {
      await aiAgentApi.deleteQna(id);
      refresh();
    } catch (e: any) {
      toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' });
    }
  }

  function startEdit(qi: any) {
    setEditingId(qi.id);
    setEditQ(qi.question || '');
    setEditA(qi.answer || '');
    setEditLocale(qi.locale || 'en');
  }
  function cancelEdit() {
    setEditingId(null);
    setEditQ(''); setEditA(''); setEditLocale('en');
  }
  async function saveEdit(id: string) {
    if (!editQ.trim() || !editA.trim()) {
      toast({ title: 'Question and answer are required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await aiAgentApi.updateQna(id, { question: editQ.trim(), answer: editA.trim(), locale: editLocale });
      toast({ title: 'Q&A updated' });
      cancelEdit();
      refresh();
    } catch (e: any) {
      toast({ title: 'Update failed', description: e?.message, variant: 'destructive' });
    } finally { setSaving(false); }
  }

  if (!wsId) return null;
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <MessageCircleQuestion className="h-6 w-6" /> Questions & Answers
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Curated Q&A pairs the AI prefers when answering visitors.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/learning-candidates'))}>
          <GraduationCap className="h-4 w-4 mr-1" /> Learning Candidates
          {pendingCount > 0 && <Badge variant="secondary" className="ml-2">{pendingCount}</Badge>}
        </Button>
      </div>

      <Card className="p-4 space-y-3">
        <div className="text-sm font-medium flex items-center gap-2"><Plus className="h-4 w-4" /> Add Q&A</div>
        <Input placeholder="Question" value={q} onChange={(e) => setQ(e.target.value)} />
        <Textarea placeholder="Answer" value={a} onChange={(e) => setA(e.target.value)} rows={3} />
        <div className="flex items-center gap-2">
          <Input value={locale} onChange={(e) => setLocale(e.target.value)} className="w-24 h-8" />
          <Button size="sm" onClick={createQna} disabled={creating || !q.trim() || !a.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />} Add
          </Button>
        </div>
      </Card>

      {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
      {!loading && items.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">No Q&A pairs yet.</Card>
      )}
      {items.map((qi) => (
        <Card key={qi.id} className="p-4 space-y-1">
          {editingId === qi.id ? (
            <div className="space-y-2">
              <Input value={editQ} onChange={(e) => setEditQ(e.target.value)} placeholder="Question" />
              <Textarea value={editA} onChange={(e) => setEditA(e.target.value)} rows={3} placeholder="Answer" />
              <div className="flex items-center gap-2">
                <Input value={editLocale} onChange={(e) => setEditLocale(e.target.value)} className="w-24 h-8" />
                <Button size="sm" onClick={() => saveEdit(qi.id)} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Save
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="text-sm font-medium">{qi.question}</div>
                <div className="text-sm text-muted-foreground whitespace-pre-wrap mt-1">{qi.answer}</div>
                <div className="flex gap-2 mt-2">
                  <Badge variant="outline">{qi.locale || 'en'}</Badge>
                  {qi.enabled === false && <Badge variant="destructive">disabled</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => startEdit(qi)} title="Edit">
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(qi.id)} title="Delete">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}