import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { MessageCircleQuestion, Loader2, Plus, GraduationCap, Trash2, Pencil, Save, X } from 'lucide-react';

export default function QnaPage() {
  const { t, dir } = useTranslation();
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
      toast({ title: t('aiAgent.qna.loadFailed'), description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function createQna() {
    if (!wsId) return;
    if (!q.trim() || !a.trim()) {
      toast({ title: t('aiAgent.qna.requiredFields'), variant: 'destructive' });
      return;
    }
    setCreating(true);
    try {
      await aiAgentApi.createQna(wsId, { question: q.trim(), answer: a.trim(), locale });
      setQ(''); setA('');
      toast({ title: t('aiAgent.qna.created') });
      refresh();
    } catch (e: any) {
      toast({ title: t('aiAgent.qna.createFailed'), description: e?.message, variant: 'destructive' });
    } finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm(t('aiAgent.qna.confirmDelete'))) return;
    try {
      await aiAgentApi.deleteQna(id);
      refresh();
    } catch (e: any) {
      toast({ title: t('aiAgent.qna.deleteFailed'), description: e?.message, variant: 'destructive' });
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
      toast({ title: t('aiAgent.qna.requiredFields'), variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await aiAgentApi.updateQna(id, { question: editQ.trim(), answer: editA.trim(), locale: editLocale });
      toast({ title: t('aiAgent.qna.updated') });
      cancelEdit();
      refresh();
    } catch (e: any) {
      toast({ title: t('aiAgent.qna.updateFailed'), description: e?.message, variant: 'destructive' });
    } finally { setSaving(false); }
  }

  if (!wsId) return null;
  return (
    <div dir={dir} className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <MessageCircleQuestion className="h-6 w-6" /> {t('aiAgent.qna.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('aiAgent.qna.subtitle')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/learning-candidates'))}>
          <GraduationCap className="h-4 w-4 me-1" /> {t('aiAgent.qna.learningCandidates')}
          {pendingCount > 0 && <Badge variant="secondary" className="ms-2">{pendingCount}</Badge>}
        </Button>
      </div>

      <Card className="p-4 space-y-3">
        <div className="text-sm font-medium flex items-center gap-2"><Plus className="h-4 w-4" /> {t('aiAgent.qna.addTitle')}</div>
        <Input placeholder={t('aiAgent.qna.questionPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Textarea placeholder={t('aiAgent.qna.answerPlaceholder')} value={a} onChange={(e) => setA(e.target.value)} rows={3} />
        <div className="flex items-center gap-2">
          <Input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder={t('aiAgent.qna.localePlaceholder')} className="w-24 h-8" dir="ltr" />
          <Button size="sm" onClick={createQna} disabled={creating || !q.trim() || !a.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Plus className="h-4 w-4 me-1" />} {t('aiAgent.qna.add')}
          </Button>
        </div>
      </Card>

      {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('aiAgent.qna.loading')}</div>}
      {!loading && items.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">{t('aiAgent.qna.empty')}</Card>
      )}
      {items.map((qi) => (
        <Card key={qi.id} className="p-4 space-y-1">
          {editingId === qi.id ? (
            <div className="space-y-2">
              <Input value={editQ} onChange={(e) => setEditQ(e.target.value)} placeholder={t('aiAgent.qna.questionPlaceholder')} />
              <Textarea value={editA} onChange={(e) => setEditA(e.target.value)} rows={3} placeholder={t('aiAgent.qna.answerPlaceholder')} />
              <div className="flex items-center gap-2">
                <Input value={editLocale} onChange={(e) => setEditLocale(e.target.value)} placeholder={t('aiAgent.qna.localePlaceholder')} className="w-24 h-8" dir="ltr" />
                <Button size="sm" onClick={() => saveEdit(qi.id)} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />} {t('aiAgent.qna.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
                  <X className="h-4 w-4 me-1" /> {t('aiAgent.qna.cancel')}
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
                  {qi.enabled === false && <Badge variant="destructive">{t('aiAgent.qna.disabled')}</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => startEdit(qi)} title={t('aiAgent.qna.edit')}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(qi.id)} title={t('aiAgent.qna.delete')}>
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