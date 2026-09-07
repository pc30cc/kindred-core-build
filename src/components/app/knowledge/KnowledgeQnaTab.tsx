import { useEffect, useMemo, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useTranslation } from '@/i18n';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import {
  MessageCircleQuestion, Loader2, Plus, Trash2, Pencil, Save, X, Search,
  GraduationCap, CheckCircle2, HelpCircle,
} from 'lucide-react';

/**
 * Knowledge Base — Q&A tab.
 *
 * Same `ai_agent_qna` data every consumer reads: the AI assistant's
 * retrieval, the Telegram plugin's FAQ menu, and (going forward) any other
 * channel. This is the ONE place operators author it — there is no
 * per-channel copy of this content anywhere else.
 */
type QnaItem = {
  id: string;
  question: string;
  answer: string;
  locale: string;
  enabled: boolean;
};

const LOCALE_LABELS: Record<string, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };

export default function KnowledgeQnaTab() {
  const { t, dir } = useTranslation();
  const workspace = useCurrentWorkspace() as any;
  const wsId = workspace?.id;
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const activeLocales = allowedLocales.length ? allowedLocales : ['en', 'fa', 'tr'];

  const tr = (k: string, fb: string, vars?: Record<string, string>) => {
    const v = t(`aiAgent.qna.${k}` as never, vars) as unknown as string;
    return !v || v === `aiAgent.qna.${k}` ? fb : v;
  };

  const [items, setItems] = useState<QnaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [localeFilter, setLocaleFilter] = useState('all');

  const [showAdd, setShowAdd] = useState(false);
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [locale, setLocale] = useState(activeLocales[0] || 'en');
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQ, setEditQ] = useState('');
  const [editA, setEditA] = useState('');
  const [editLocale, setEditLocale] = useState('en');
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
      toast({ title: tr('loadFailed', 'Failed to load'), description: e?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (localeFilter !== 'all' && (it.locale || 'en') !== localeFilter) return false;
      if (!searchQuery) return true;
      const needle = searchQuery.toLowerCase();
      return it.question.toLowerCase().includes(needle) || it.answer.toLowerCase().includes(needle);
    });
  }, [items, localeFilter, searchQuery]);

  const enabledCount = items.filter((it) => it.enabled !== false).length;

  async function createQna() {
    if (!wsId) return;
    if (!q.trim() || !a.trim()) {
      toast({ title: tr('requiredFields', 'Question and answer are required'), variant: 'destructive' });
      return;
    }
    setCreating(true);
    try {
      await aiAgentApi.createQna(wsId, { question: q.trim(), answer: a.trim(), locale });
      setQ(''); setA(''); setShowAdd(false);
      toast({ title: tr('created', 'Q&A added') });
      refresh();
    } catch (e: any) {
      const code = e?.body?.error || e?.message;
      toast({
        title: code === 'duplicate_qna' ? tr('duplicate', 'A similar question already exists') : tr('createFailed', 'Could not add the Q&A'),
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm(tr('confirmDelete', 'Delete this Q&A?'))) return;
    setDeletingId(id);
    try {
      await aiAgentApi.deleteQna(id);
      refresh();
    } catch (e: any) {
      toast({ title: tr('deleteFailed', 'Could not delete the Q&A'), description: e?.message, variant: 'destructive' });
    } finally {
      setDeletingId(null);
    }
  }

  async function toggleEnabled(item: QnaItem) {
    setTogglingId(item.id);
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, enabled: !it.enabled } : it)));
    try {
      await aiAgentApi.updateQna(item.id, { enabled: !item.enabled });
    } catch (e: any) {
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, enabled: item.enabled } : it)));
      toast({ title: tr('updateFailed', 'Could not update the Q&A'), description: e?.message, variant: 'destructive' });
    } finally {
      setTogglingId(null);
    }
  }

  function startEdit(qi: QnaItem) {
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
      toast({ title: tr('requiredFields', 'Question and answer are required'), variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await aiAgentApi.updateQna(id, { question: editQ.trim(), answer: editA.trim(), locale: editLocale });
      toast({ title: tr('updated', 'Q&A updated') });
      cancelEdit();
      refresh();
    } catch (e: any) {
      const code = e?.body?.error || e?.message;
      toast({
        title: code === 'duplicate_qna' ? tr('duplicate', 'A similar question already exists') : tr('updateFailed', 'Could not update the Q&A'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6" dir={dir}>
      {/* Stats */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="stat-card flex flex-col items-center text-center px-2 py-3">
          <MessageCircleQuestion className="w-4 h-4 text-primary mb-1" />
          <div className="text-lg font-bold text-foreground">{items.length}</div>
          <div className="text-[11px] text-muted-foreground">{tr('stats.total', 'Q&A pairs')}</div>
        </div>
        <div className="stat-card flex flex-col items-center text-center px-2 py-3">
          <CheckCircle2 className="w-4 h-4 text-success mb-1" />
          <div className="text-lg font-bold text-foreground">{enabledCount}</div>
          <div className="text-[11px] text-muted-foreground">{tr('stats.enabled', 'Enabled')}</div>
        </div>
        <div className="stat-card flex flex-col items-center text-center px-2 py-3">
          <GraduationCap className="w-4 h-4 text-amber-500 mb-1" />
          <div className="text-lg font-bold text-foreground">{pendingCount}</div>
          <div className="text-[11px] text-muted-foreground">{tr('stats.candidates', 'Learning candidates')}</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex gap-3 flex-wrap items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="ps-9"
            placeholder={tr('search', 'Search questions and answers...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {canSwitchLanguage && (
          <Select value={localeFilter} onValueChange={setLocaleFilter}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr('allLanguages', 'All languages')}</SelectItem>
              {activeLocales.map((loc) => (
                <SelectItem key={loc} value={loc}>{LOCALE_LABELS[loc] || loc}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          className="gap-2"
          onClick={() => { setShowAdd((v) => !v); setQ(''); setA(''); setLocale(activeLocales[0] || 'en'); }}
        >
          <Plus className="w-4 h-4" />
          {tr('add', 'Add')}
        </Button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="card-elevated p-4 space-y-3">
          <div className="text-sm font-medium flex items-center gap-2">
            <Plus className="h-4 w-4" /> {tr('addTitle', 'Add Q&A')}
          </div>
          <Input placeholder={tr('questionPlaceholder', 'Question')} value={q} onChange={(e) => setQ(e.target.value)} />
          <Textarea placeholder={tr('answerPlaceholder', 'Answer')} value={a} onChange={(e) => setA(e.target.value)} rows={3} />
          <div className="flex items-center justify-between gap-2">
            {canSwitchLanguage ? (
              <Select value={locale} onValueChange={setLocale}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {activeLocales.map((loc) => (
                    <SelectItem key={loc} value={loc}>{LOCALE_LABELS[loc] || loc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : <span />}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>{tr('cancel', 'Cancel')}</Button>
              <Button size="sm" onClick={createQna} disabled={creating || !q.trim() || !a.trim()}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Plus className="h-4 w-4 me-1" />} {tr('add', 'Add')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div className="card-elevated">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{tr('title', 'Questions & Answers')}</h2>
        </div>
        {loading ? (
          <div className="p-8 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse flex items-center gap-3 px-5 py-3">
                <div className="w-8 h-8 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-muted rounded w-64" />
                  <div className="h-2.5 bg-muted rounded w-40" />
                </div>
              </div>
            ))}
          </div>
        ) : !filtered.length ? (
          <div className="py-16 text-center">
            <HelpCircle className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">
              {items.length ? tr('noMatches', 'No Q&A matches your search.') : tr('empty', 'No Q&A pairs yet.')}
            </p>
            {!items.length && (
              <p className="text-xs text-muted-foreground">{tr('emptyHint', 'Add the questions visitors ask most — the AI and every connected channel will use them.')}</p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {filtered.map((qi) => (
              <div key={qi.id} className="px-5 py-4 hover:bg-muted/30 transition-colors">
                {editingId === qi.id ? (
                  <div className="space-y-2">
                    <Input value={editQ} onChange={(e) => setEditQ(e.target.value)} placeholder={tr('questionPlaceholder', 'Question')} />
                    <Textarea value={editA} onChange={(e) => setEditA(e.target.value)} rows={3} placeholder={tr('answerPlaceholder', 'Answer')} />
                    <div className="flex items-center justify-between gap-2">
                      {canSwitchLanguage ? (
                        <Select value={editLocale} onValueChange={setEditLocale}>
                          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {activeLocales.map((loc) => (
                              <SelectItem key={loc} value={loc}>{LOCALE_LABELS[loc] || loc}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : <span />}
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
                          <X className="h-4 w-4 me-1" /> {tr('cancel', 'Cancel')}
                        </Button>
                        <Button size="sm" onClick={() => saveEdit(qi.id)} disabled={saving}>
                          {saving ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />} {tr('save', 'Save')}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">{qi.question}</span>
                        
                        {qi.enabled === false && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/40 text-amber-600">
                            {tr('disabled', 'Disabled')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap mt-1">{qi.answer}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Switch
                        checked={qi.enabled !== false}
                        disabled={togglingId === qi.id}
                        onCheckedChange={() => toggleEnabled(qi)}
                        aria-label={tr('enabledToggle', 'Enabled')}
                      />
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(qi)} title={tr('edit', 'Edit')}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => remove(qi.id)}
                        disabled={deletingId === qi.id}
                        title={tr('delete', 'Delete')}
                      >
                        {deletingId === qi.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 text-destructive" />}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
