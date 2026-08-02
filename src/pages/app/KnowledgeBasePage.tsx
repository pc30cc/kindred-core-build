import { useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useKBArticles, useKBCategories, useCreateKBArticle, useUpdateKBArticle, useDeleteKBArticle } from '@/hooks/useKnowledgeBase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Plus, Trash2, BookOpen, Search, Eye, ThumbsUp, Globe,
  FileText, Edit, X, Bold, Italic, Heading2, List, Link2, Code2, Quote, BarChart3,
  CheckCircle2, AlertCircle, MonitorSmartphone, BookMarked
} from 'lucide-react';

/**
 * Phase 6-S5 — Knowledge Base is an INDEPENDENT product.
 * This page must not import, query or depend on anything AI Agent related.
 * `used_by_ai` stays in the database but is owned by AI Agent → Knowledge
 * Sources; it is never displayed or written from here.
 */
export interface KnowledgeBaseArticleInput {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  locale: string;
  status: 'draft' | 'published' | 'archived';
  category_id: string | null;
  visible_in_widget: boolean;
}

type FormData = {
  title: string; slug: string; content: string; excerpt: string;
  locale: string; status: string; category_id: string;
  visible_in_widget: boolean;
};
const emptyForm: FormData = {
  title: '', slug: '', content: '', excerpt: '', locale: 'en', status: 'draft', category_id: '',
  visible_in_widget: true,
};

function calcSeoScore(form: FormData) {
  const tips: { key: string; passed: boolean }[] = [];
  const seoTitle = form.title;
  tips.push({ key: 'Title length (30–70 chars)', passed: seoTitle.length >= 30 && seoTitle.length <= 70 });
  tips.push({ key: 'Excerpt length (100–170 chars)', passed: (form.excerpt || '').length >= 100 && (form.excerpt || '').length <= 170 });
  tips.push({ key: 'Clean URL slug', passed: form.slug.length > 0 && /^[a-z0-9-]+$/.test(form.slug) });
  const wordCount = form.content.split(/\s+/).filter(Boolean).length;
  tips.push({ key: 'Content ≥ 300 words', passed: wordCount >= 300 });
  tips.push({ key: 'Has headings (H2/H3)', passed: /^#{2,3}\s/m.test(form.content) });
  const passed = tips.filter(t => t.passed).length;
  const total = tips.length;
  const pct = Math.round((passed / total) * 100);
  return { tips, passed, total, pct };
}

export default function KnowledgeBasePage() {
  const { t, dir } = useTranslation();
  const workspace = useCurrentWorkspace();
  const [locale, setLocale] = useState('en');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<'editor' | 'preview'>('editor');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: articles, isLoading } = useKBArticles(workspace?.id, locale, statusFilter);
  const { data: categories } = useKBCategories(workspace?.id, locale);
  const createArticle = useCreateKBArticle(workspace?.id);
  const updateArticle = useUpdateKBArticle();
  const deleteArticle = useDeleteKBArticle();

  const [form, setForm] = useState<FormData>(emptyForm);

  const handleSave = async () => {
    const slug = form.slug || form.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    // NOTE: `used_by_ai` is intentionally NOT part of the payload so editing
    // an article never overwrites the AI-consumption flag.
    const payload: KnowledgeBaseArticleInput = {
      title: form.title,
      slug,
      content: form.content,
      excerpt: form.excerpt,
      locale: form.locale,
      status: form.status as KnowledgeBaseArticleInput['status'],
      category_id: form.category_id || null,
      visible_in_widget: form.visible_in_widget,
    };
    if (editId) {
      await updateArticle.mutateAsync({ id: editId, ...payload });
    } else {
      await createArticle.mutateAsync(payload);
    }
    setForm(emptyForm);
    setShowEditor(false);
    setEditId(null);
  };

  const openEdit = (article: any) => {
    setEditId(article.id);
    setForm({
      title: article.title || '',
      slug: article.slug || '',
      content: article.content || '',
      excerpt: article.excerpt || '',
      locale: article.locale || locale,
      status: article.status || 'draft',
      category_id: article.category_id || '',
      visible_in_widget: article.visible_in_widget !== false,
    });
    setEditorTab('editor');
    setShowEditor(true);
  };

  const insertMd = useCallback((before: string, after: string = '', placeholder = '') => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = form.content.slice(start, end) || placeholder;
    const newContent = form.content.slice(0, start) + before + selected + after + form.content.slice(end);
    setForm(p => ({ ...p, content: newContent }));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(start + before.length, start + before.length + selected.length); }, 0);
  }, [form.content]);

  const filtered = articles?.filter(a =>
    !searchQuery || a.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalViews = 0; // Placeholder — data model can be extended
  const publishedCount = articles?.filter((a: any) => a.status === 'published').length ?? 0;
  const seoScore = useMemo(() => calcSeoScore(form), [form]);
  const wordCount = form.content.split(/\s+/).filter(Boolean).length;

  const statusBadge: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    published: 'bg-success/15 text-success border border-success/20',
    archived: 'bg-warning/15 text-warning border border-warning/20',
  };

  return (
    <div className="space-y-6 animate-fade-in" dir={dir}>
      {/* Hero header */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
              <BookMarked className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t('knowledgeBase.title')}</h1>
              <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">
                {t('knowledgeBase.subtitle')}
              </p>
            </div>
          </div>
          {(
            <Button onClick={() => { setShowEditor(true); setEditId(null); setForm(emptyForm); setEditorTab('editor'); }} className="gap-2 shadow-md shadow-primary/20">
              <Plus className="w-4 h-4" />
              <span>{t('knowledgeBase.newArticle')}</span>
            </Button>
          )}
        </div>

      </div>


      {/* Stats */}
      <div className="grid grid-cols-4 gap-2.5">
        <div className="stat-card flex flex-col items-center text-center px-2 py-3">
          <BookOpen className="w-4 h-4 text-primary mb-1" />
          <div className="text-lg font-bold text-foreground">{articles?.length ?? 0}</div>
          <div className="text-[11px] text-muted-foreground">Articles</div>
        </div>
        <div className="stat-card flex flex-col items-center text-center px-2 py-3">
          <Eye className="w-4 h-4 text-info mb-1" />
          <div className="text-lg font-bold text-foreground">{totalViews}</div>
          <div className="text-[11px] text-muted-foreground">Views</div>
        </div>
        <div className="stat-card flex flex-col items-center text-center px-2 py-3">
          <ThumbsUp className="w-4 h-4 text-success mb-1" />
          <div className="text-lg font-bold text-foreground">0</div>
          <div className="text-[11px] text-muted-foreground">Helpful</div>
        </div>
        <div className="stat-card flex flex-col items-center text-center px-2 py-3">
          <Globe className="w-4 h-4 text-warning mb-1" />
          <div className="text-lg font-bold text-foreground">{publishedCount}</div>
          <div className="text-[11px] text-muted-foreground">{t('knowledgeBase.published')}</div>
        </div>
      </div>

      {/* ═══════ Professional Editor ═══════ */}
      {showEditor && (
        <div className="card-elevated">
          <div className="px-4 sm:px-6 py-3 border-b border-border flex items-center justify-between bg-secondary/30">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">{editId ? 'Edit Article' : t('knowledgeBase.newArticle')}</h3>
            </div>
            <button onClick={() => { setShowEditor(false); setEditId(null); }} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 sm:p-6 space-y-4">
            {/* Title & Category */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Title <span className="text-destructive">*</span></label>
                <Input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="Article title" className="text-base" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Category</label>
                <Select value={form.category_id} onValueChange={v => setForm(p => ({ ...p, category_id: v }))}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    {categories?.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Content Editor with Toolbar */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-muted-foreground">Content</label>
                <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
                  <button onClick={() => setEditorTab('editor')} className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${editorTab === 'editor' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>
                    Editor
                  </button>
                  <button onClick={() => setEditorTab('preview')} className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${editorTab === 'preview' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>
                    Preview
                  </button>
                </div>
              </div>

              {editorTab === 'editor' ? (
                <div className="border border-border rounded-xl overflow-hidden">
                  {/* Markdown Toolbar */}
                  <div className="flex items-center gap-0.5 px-2 py-1.5 bg-secondary/50 border-b border-border flex-wrap">
                    {[
                      { icon: Bold, action: () => insertMd('**', '**', 'bold'), tip: 'Bold' },
                      { icon: Italic, action: () => insertMd('*', '*', 'italic'), tip: 'Italic' },
                      { icon: Heading2, action: () => insertMd('\n## ', '\n', 'Heading'), tip: 'Heading' },
                      { icon: List, action: () => insertMd('\n- ', '\n'), tip: 'List' },
                      { icon: Link2, action: () => insertMd('[', '](https://)', 'link'), tip: 'Link' },
                      { icon: Code2, action: () => insertMd('\n```\n', '\n```\n', 'code'), tip: 'Code' },
                      { icon: Quote, action: () => insertMd('\n> ', '\n', 'quote'), tip: 'Quote' },
                    ].map(({ icon: Icon, action, tip }) => (
                      <button key={tip} onClick={action} title={tip}
                        className="p-1.5 rounded-md hover:bg-card text-muted-foreground hover:text-foreground transition-colors">
                        <Icon className="w-4 h-4" />
                      </button>
                    ))}
                  </div>
                  <textarea
                    ref={textareaRef}
                    placeholder="Write your article content in Markdown..."
                    value={form.content}
                    onChange={e => setForm(p => ({ ...p, content: e.target.value }))}
                    className="w-full bg-card px-4 py-3 text-sm text-foreground min-h-[240px] sm:min-h-[300px] resize-y font-mono leading-relaxed focus:outline-none placeholder:text-muted-foreground/50"
                    dir={dir}
                  />
                  <div className="px-3 py-1.5 bg-secondary/30 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{wordCount} words</span>
                    <span>{form.content.length} chars</span>
                  </div>
                </div>
              ) : (
                <div className="border border-border rounded-xl p-4 sm:p-6 min-h-[240px] sm:min-h-[300px] bg-card">
                  <div className="prose prose-sm max-w-none text-foreground">
                    {form.content || <em className="text-muted-foreground">No content yet</em>}
                  </div>
                </div>
              )}
            </div>

            {/* Slug, Status, Locale */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Slug</label>
                <Input value={form.slug} onChange={e => setForm(p => ({ ...p, slug: e.target.value }))} dir="ltr" placeholder="my-article-slug" />
                <p className="text-[10px] text-muted-foreground mt-1">Used in URL. Auto-generated if empty.</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('common.status')}</label>
                <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">{t('knowledgeBase.draft')}</SelectItem>
                    <SelectItem value="published">{t('knowledgeBase.published')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Locale</label>
                <Select value={form.locale} onValueChange={v => setForm(p => ({ ...p, locale: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="fa">فارسی</SelectItem>
                    <SelectItem value="tr">Türkçe</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Excerpt (SEO description) */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Excerpt / Meta Description</label>
              <Input value={form.excerpt} onChange={e => setForm(p => ({ ...p, excerpt: e.target.value }))} placeholder="Brief description for search results" />
            </div>

            {/* Visibility & AI usage (KB unification — Phase 2) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="border border-border rounded-xl p-3.5 flex items-start gap-3 bg-secondary/20">
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <MonitorSmartphone className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{t('knowledgeBase.visibleInWidget') || 'Show in help center / widget'}</span>
                    <Switch checked={form.visible_in_widget} onCheckedChange={(v) => setForm(p => ({ ...p, visible_in_widget: !!v }))} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{t('knowledgeBase.visibleInWidgetHint') || 'Make this article available to visitors in the public help center.'}</p>
                </div>
              </div>
              <div className="border border-border rounded-xl p-3.5 flex items-start gap-3 bg-secondary/20">
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{t('knowledgeBase.usedByAi') || 'Use as AI knowledge source'}</span>
                    <Switch checked={form.used_by_ai} onCheckedChange={(v) => setForm(p => ({ ...p, used_by_ai: !!v }))} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{t('knowledgeBase.usedByAiHint') || 'Allow the AI assistant to retrieve and cite this article.'}</p>
                </div>
              </div>
            </div>

            {/* SEO Score */}
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-secondary/30 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-primary" />
                  <span className="text-xs font-semibold text-foreground">SEO Score</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${seoScore.pct >= 80 ? 'bg-success' : seoScore.pct >= 50 ? 'bg-warning' : 'bg-destructive'}`} />
                  <span className={`text-xs font-bold ${seoScore.pct >= 80 ? 'text-success' : seoScore.pct >= 50 ? 'text-warning' : 'text-destructive'}`}>
                    {seoScore.pct}%
                  </span>
                </div>
              </div>
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {seoScore.tips.map(tip => (
                  <div key={tip.key} className="flex items-center gap-2 text-xs">
                    {tip.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                    <span className={tip.passed ? 'text-foreground' : 'text-muted-foreground'}>{tip.key}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
              <Button variant="outline" onClick={() => { setShowEditor(false); setEditId(null); }}>{t('common.cancel')}</Button>
              <Button onClick={handleSave} disabled={createArticle.isPending || updateArticle.isPending || !form.title}>
                {createArticle.isPending || updateArticle.isPending ? t('common.loading') : editId ? t('common.save') : t('common.create')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="ps-9"
            placeholder={t('knowledgeBase.searchArticles')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <Select value={locale} onValueChange={setLocale}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="fa">فارسی</SelectItem>
            <SelectItem value="tr">Türkçe</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="draft">{t('knowledgeBase.draft')}</SelectItem>
            <SelectItem value="published">{t('knowledgeBase.published')}</SelectItem>
            <SelectItem value="archived">{t('knowledgeBase.archived')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Article List */}
      <div className="card-elevated">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">All Articles</h2>
        </div>
        {isLoading ? (
          <div className="p-8 space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse flex items-center gap-3 px-5 py-3">
                <div className="w-8 h-8 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-muted rounded w-48" />
                  <div className="h-2.5 bg-muted rounded w-32" />
                </div>
              </div>
            ))}
          </div>
        ) : !filtered?.length ? (
          <div className="py-16 text-center">
            <BookOpen className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">{t('knowledgeBase.noArticles')}</p>
            <p className="text-xs text-muted-foreground">Create your first article to get started</p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {filtered.map(article => (
              <div key={article.id} className="px-5 py-3.5 hover:bg-muted/30 transition-colors flex items-center gap-4">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-foreground truncate">{article.title}</span>
                    <Badge className={`text-[10px] px-1.5 py-0 ${statusBadge[article.status]}`}>{article.status}</Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{article.locale}</Badge>
                    {(article as any).visible_in_widget === false && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/40 text-amber-600">
                        {t('knowledgeBase.hiddenFromWidget')}
                      </Badge>
                    )}
                    {(article as any).used_by_ai === false && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-muted-foreground/40 text-muted-foreground">
                        <Bot className="h-3 w-3 me-1" />{t('knowledgeBase.aiDisabled')}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {(article as any).knowledge_base_categories?.name || 'Uncategorized'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(article)} title="Edit article">
                    <Edit className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteArticle.mutate(article.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
