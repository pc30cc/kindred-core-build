import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { useAuth } from '@/features/auth/AuthContext';
import { useKBArticles, useCreateKBArticle, useUpdateKBArticle, useKBLockedText, isKBArticleLocked } from '@/hooks/useKnowledgeBase';
import { KnowledgeBaseApiError } from '@/lib/knowledge-base-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import RichTextEditor from '@/components/app/knowledge/RichTextEditor';
import {
  ArrowLeft, ArrowRight, FileText,
  BarChart3, CheckCircle2, AlertCircle, Loader2, Lock,
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
  visible_in_widget: boolean;
  author_user_id?: string | null;
}

type FormData = {
  title: string; slug: string; content: string; excerpt: string;
  locale: string; status: string;
};

/** The author select's "no author shown" choice (stored as null). */
const AUTHOR_NONE = '__none';

type SeoTipId = 'titleLength' | 'excerptLength' | 'cleanSlug' | 'wordCount' | 'headings';

function calcSeoScore(form: FormData) {
  const tips: { id: SeoTipId; passed: boolean }[] = [];
  const seoTitle = form.title;
  tips.push({ id: 'titleLength', passed: seoTitle.length >= 30 && seoTitle.length <= 70 });
  tips.push({ id: 'excerptLength', passed: (form.excerpt || '').length >= 100 && (form.excerpt || '').length <= 170 });
  tips.push({ id: 'cleanSlug', passed: form.slug.length > 0 && /^[a-z0-9-]+$/.test(form.slug) });
  const wordCount = stripHtmlForCount(form.content).split(/\s+/).filter(Boolean).length;
  tips.push({ id: 'wordCount', passed: wordCount >= 300 });
  tips.push({ id: 'headings', passed: /<h[23][\s>]/i.test(form.content) });
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
  const { user } = useAuth();
  const { data: members } = useWorkspaceMembers(workspace?.id);
  const createArticle = useCreateKBArticle(workspace?.id);
  const updateArticle = useUpdateKBArticle(workspace?.id);

  const existing = useMemo(() => articles?.find((a) => a.id === id), [articles, id]);
  // Simple billing phase 4: an article over the plan's limit is read-only
  // (the server refuses the PATCH with 403 kb_article_locked).
  const locked = !isNew && isKBArticleLocked(existing);
  const lockedText = useKBLockedText();

  const emptyForm: FormData = {
    title: '', slug: '', content: '', excerpt: '', locale: activeLocales[0] || 'en', status: 'draft',
  };
  const [form, setForm] = useState<FormData>(emptyForm);
  const [hydrated, setHydrated] = useState(isNew);
  // The author shown in the widget (a workspace member, or none). Sent only
  // when changed here: a new article's default is its creator (the server's),
  // an existing one keeps what it has.
  const [authorChoice, setAuthorChoice] = useState<string | null>(null);
  const storedAuthor = isNew ? (user?.id ?? null) : (existing?.author_user_id ?? null);
  const authorValue = (() => {
    const id = authorChoice ?? storedAuthor ?? AUTHOR_NONE;
    // Someone who is no longer a member is not shown in the widget either.
    return id !== AUTHOR_NONE && members && !members.some((m) => m.user_id === id) ? AUTHOR_NONE : id;
  })();

  useEffect(() => {
    if (isNew || hydrated || !existing) return;
    setForm({
      title: existing.title || '',
      slug: existing.slug || '',
      content: existing.content || '',
      excerpt: existing.excerpt || '',
      locale: existing.locale || activeLocales[0] || 'en',
      status: existing.status || 'draft',
    });
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, isNew, hydrated]);

  const seoScore = useMemo(() => calcSeoScore(form), [form]);
  const wordCount = useMemo(() => stripHtmlForCount(form.content).split(/\s+/).filter(Boolean).length, [form.content]);
  const seoTipLabels: Record<SeoTipId, string> = {
    titleLength: t('knowledgeBase.editor.seo.titleLength'),
    excerptLength: t('knowledgeBase.editor.seo.excerptLength'),
    cleanSlug: t('knowledgeBase.editor.seo.cleanSlug'),
    wordCount: t('knowledgeBase.editor.seo.wordCount'),
    headings: t('knowledgeBase.editor.seo.headings'),
  };

  const goBack = () => navigate(wsPath('/knowledge-base'));

  /**
   * A published article is meant to be visible everywhere it's consumed
   * (public help center, chat widget, Telegram) — there is no longer a
   * separate per-article visibility toggle, so this is always true.
   */
  const handleSave = async () => {
    if (locked) return;
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
      visible_in_widget: true,
      ...(authorChoice !== null ? { author_user_id: authorChoice === AUTHOR_NONE ? null : authorChoice } : {}),
    };
    try {
      if (id) {
        await updateArticle.mutateAsync({ id, ...payload });
      } else {
        await createArticle.mutateAsync(payload);
      }
      toast({
        title: form.status === 'published'
          ? t('knowledgeBase.editor.publishedSuccess')
          : t('knowledgeBase.editor.savedSuccess'),
      });
      goBack();
    } catch (e) {
      const err = e instanceof KnowledgeBaseApiError ? e : null;
      const description =
        err?.code === 'knowledge_base_permission_denied'
          ? t('knowledgeBase.editor.permissionDenied')
          : err?.code === 'kb_article_locked'
            ? lockedText('saveBlocked')
          : err?.code === 'invalid_author'
            ? t('knowledgeBase.editor.authorInvalid')
          : err?.upgradeRequired
            ? t('knowledgeBase.editor.quotaReached')
            : undefined;
      toast({ title: t('knowledgeBase.editor.saveFailed'), description, variant: 'destructive' });
    }
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
          {locked && (
            <div data-kb-locked-notice role="status" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-foreground">
              <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
              <span>{lockedText('editorNotice')}</span>
            </div>
          )}
          {/* A locked article is shown read-only: every field is disabled. */}
          <fieldset disabled={locked} className="space-y-4 min-w-0">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              {t('knowledgeBase.editor.titleLabel')} <span className="text-destructive">*</span>
            </label>
            <Input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} placeholder={t('knowledgeBase.editor.titlePlaceholder')} className="text-base" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.contentLabel')}</label>
            {/* The editor has no read-only mode: a locked article's body can't be focused. */}
            <div className={locked ? 'pointer-events-none opacity-80' : undefined} aria-disabled={locked || undefined}>
              <RichTextEditor
                value={form.content}
                onChange={(html) => { if (!locked) setForm((p) => ({ ...p, content: html })); }}
                placeholder={t('knowledgeBase.editor.contentPlaceholder')}
                dir={dir}
              />
            </div>
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
            <label htmlFor="kb-article-author" className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.authorLabel')}</label>
            <Select value={authorValue} onValueChange={(v) => setAuthorChoice(v)}>
              <SelectTrigger id="kb-article-author" data-kb-author className="sm:max-w-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTHOR_NONE}>{t('knowledgeBase.editor.authorNone')}</SelectItem>
                {(members ?? []).map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>{m.full_name || m.email || m.user_id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground mt-1">{t('knowledgeBase.editor.authorHint')}</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('knowledgeBase.editor.excerptLabel')}</label>
            <Input value={form.excerpt} onChange={(e) => setForm((p) => ({ ...p, excerpt: e.target.value }))} placeholder={t('knowledgeBase.editor.excerptPlaceholder')} />
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
                <div key={tip.id} className="flex items-center gap-2 text-xs">
                  {tip.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                  <span className={tip.passed ? 'text-foreground' : 'text-muted-foreground'}>{seoTipLabels[tip.id]}</span>
                </div>
              ))}
            </div>
          </div>

          </fieldset>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
            <Button variant="outline" onClick={goBack}>{t('common.cancel')}</Button>
            <Button
              onClick={handleSave}
              disabled={locked || createArticle.isPending || updateArticle.isPending || !form.title}
              title={locked ? lockedText('tooltip') : undefined}
            >
              {createArticle.isPending || updateArticle.isPending
                ? t('common.loading')
                : form.status === 'published'
                  ? t('knowledgeBase.editor.publishAction')
                  : id ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
