import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useKBArticles, useKBCategories, useCreateKBArticle, useUpdateKBArticle } from '@/hooks/useKnowledgeBase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import RichTextEditor from '@/components/app/knowledge/RichTextEditor';
import {
  ArrowLeft, ArrowRight, FileText,
  BarChart3, CheckCircle2, AlertCircle, MonitorSmartphone, Loader2,
} from 'lucide-react';

/** Article content is HTML (see RichTextEditor's header comment) — SEO
 * checks read tag/text signals accordingly, not markdown syntax. */
function stripHtmlForCount(html: string): string {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

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

function calcSeoScore(form: FormData) {
  const tips: { key: string; passed: boolean }[] = [];
  const seoTitle = form.title;
  tips.push({ key: 'Title length (30–70 chars)', passed: seoTitle.length >= 30 && seoTitle.length <= 70 });
  tips.push({ key: 'Excerpt length (100–170 chars)', passed: (form.excerpt || '').length >= 100 && (form.excerpt || '').length <= 170 });
  tips.push({ key: 'Clean URL slug', passed: form.slug.length > 0 && /^[a-z0-9-]+$/.test(form.slug) });
  const wordCount = stripHtmlForCount(form.content).split(/\s+/).filter(Boolean).length;
  tips.push({ key: 'Content ≥ 300 words', passed: wordCount >= 300 });
  tips.push({ key: 'Has headings (H2/H3)', passed: /<h[23][\s>]/i.test(form.content) });
  const passed = tips.filter((t) => t.passed).length;
  const total = tips.length;
  const pct = Math.round((passed / total) * 100);
  return { tips, passed, total, pct };
}

/**
 * Knowledge Base — dedicated create/edit page for a single article.
 * A full page (not an inline panel) so the editor has room to breathe and an
 * article gets its own shareable/bookmarkable URL, same as any other record
 * in the app.
 */
export default function ArticleEditorPage() {
  const { t, dir } = useTranslation();
  const rtl = dir === 'rtl';
  const BackIcon = rtl ? ArrowRight : ArrowLeft;
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const { id } = useParams<{ id?: string }>();
  const isNew = !id;
  const workspace = useCurrentWorkspace();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const activeLocales = allowedLocales.length ? allowedLocales : ['en', 'fa', 'tr'];
  const LOCALE_LABELS: Record<string, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };

  const { data: articles, isLoading: articlesLoading } = useKBArticles(workspace?.id);
  const { data: categories } = useKBCategories(workspace?.id);
  const createArticle = useCreateKBArticle(workspace?.id);
  const updateArticle = useUpdateKBArticle(workspace?.id);

  const existing = useMemo(() => articles?.find((a: any) => a.id === id), [articles, id]);

  const emptyForm: FormData = {
    title: '', slug: '', content: '', excerpt: '', locale: activeLocales[0] || 'en', status: 'draft',
    category_id: '', visible_in_widget: true,
  };
  const [form, setForm] = useState<FormData>(emptyForm);
  const [hydrated, setHydrated] = useState(isNew);

  useEffect(() => {
    if (isNew || hydrated || !existing) return;
    setForm({
      title: existing.title || '',
      slug: existing.slug || '',
      content: existing.content || '',
      excerpt: existing.excerpt || '',
      locale: existing.locale || activeLocales[0] || 'en',
      status: existing.status || 'draft',
      category_id: existing.category_id || '',
      visible_in_widget: existing.visible_in_widget !== false,
    });
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, isNew, hydrated]);

  const seoScore = useMemo(() => calcSeoScore(form), [form]);
  const wordCount = useMemo(() => stripHtmlForCount(form.content).split(/\s+/).filter(Boolean).length, [form.content]);

  const goBack = () => navigate(wsPath('/knowledge-base'));

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
    if (id) {
      await updateArticle.mutateAsync({ id, ...payload });
    } else {
      await createArticle.mutateAsync(payload);
    }
    goBack();
  };

  if (!isNew && articlesLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isNew && !articlesLoading && !existing) {
    return (
      <div className="py-16 text-center" dir={dir}>
        <p className="text-sm text-muted-foreground mb-4">{t('knowledgeBase.editor.notFound')}</p>
        <Button variant="outline" onClick={goBack} className="gap-2">
          <BackIcon className="h-4 w-4" />{t('knowledgeBase.editor.back')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in" dir={dir}>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5 shrink-0">
          <BackIcon className="w-4 h-4" />{t('knowledgeBase.editor.back')}
        </Button>
      </div>

      <div className="card-elevated">
        <div className="px-4 sm:px-6 py-4 border-b border-border flex items-center gap-2 bg-secondary/30">
          <FileText className="w-4 h-4 text-primary" />
          <h1 className="text-base font-semibold text-foreground">
            {isNew ? t('knowledgeBase.newArticle') : t('knowledgeBase.editor.editTitle')}
          </h1>
        </div>

        <div className="p-4 sm:p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {t('knowledgeBase.editor.titleLabel')} <span className="text-destructive">*</span>
              </label>
              <Input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} placeholder={t('knowledgeBase.editor.titlePlaceholder')} className="text-base" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.categoryLabel')}</label>
              <Select value={form.category_id} onValueChange={(v) => setForm((p) => ({ ...p, category_id: v }))}>
                <SelectTrigger><SelectValue placeholder={t('knowledgeBase.editor.categoryNone')} /></SelectTrigger>
                <SelectContent>
                  {categories?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.contentLabel')}</label>
            <RichTextEditor
              value={form.content}
              onChange={(html) => setForm((p) => ({ ...p, content: html }))}
              placeholder={t('knowledgeBase.editor.contentPlaceholder')}
              dir={dir}
            />
            <div className="mt-1 px-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{t('knowledgeBase.editor.wordCount', { count: String(wordCount) })}</span>
            </div>
          </div>

          <div className={`grid grid-cols-1 gap-3 ${canSwitchLanguage ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.slugLabel')}</label>
              <Input value={form.slug} onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value }))} dir="ltr" placeholder="my-article-slug" />
              <p className="text-[10px] text-muted-foreground mt-1">{t('knowledgeBase.editor.slugHint')}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('common.status')}</label>
              <Select value={form.status} onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">{t('knowledgeBase.draft')}</SelectItem>
                  <SelectItem value="published">{t('knowledgeBase.published')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {canSwitchLanguage && (
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.localeLabel')}</label>
                <Select value={form.locale} onValueChange={(v) => setForm((p) => ({ ...p, locale: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {activeLocales.map((loc) => (
                      <SelectItem key={loc} value={loc}>{LOCALE_LABELS[loc] || loc}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.excerptLabel')}</label>
            <Input value={form.excerpt} onChange={(e) => setForm((p) => ({ ...p, excerpt: e.target.value }))} placeholder={t('knowledgeBase.editor.excerptPlaceholder')} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="border border-border rounded-xl p-3.5 flex items-start gap-3 bg-secondary/20">
              <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <MonitorSmartphone className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{t('knowledgeBase.visibleInWidget')}</span>
                  <Switch checked={form.visible_in_widget} onCheckedChange={(v) => setForm((p) => ({ ...p, visible_in_widget: !!v }))} />
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">{t('knowledgeBase.visibleInWidgetHint')}</p>
              </div>
            </div>
          </div>

          <div className="border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-secondary/30 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">{t('knowledgeBase.editor.seoScore')}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${seoScore.pct >= 80 ? 'bg-success' : seoScore.pct >= 50 ? 'bg-warning' : 'bg-destructive'}`} />
                <span className={`text-xs font-bold ${seoScore.pct >= 80 ? 'text-success' : seoScore.pct >= 50 ? 'text-warning' : 'text-destructive'}`}>
                  {seoScore.pct}%
                </span>
              </div>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {seoScore.tips.map((tip) => (
                <div key={tip.key} className="flex items-center gap-2 text-xs">
                  {tip.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                  <span className={tip.passed ? 'text-foreground' : 'text-muted-foreground'}>{tip.key}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
            <Button variant="outline" onClick={goBack}>{t('common.cancel')}</Button>
            <Button onClick={handleSave} disabled={createArticle.isPending || updateArticle.isPending || !form.title}>
              {createArticle.isPending || updateArticle.isPending ? t('common.loading') : id ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
