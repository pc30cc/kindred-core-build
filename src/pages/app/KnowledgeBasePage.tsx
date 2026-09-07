import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useKBArticles, useDeleteKBArticle } from '@/hooks/useKnowledgeBase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import KnowledgeQnaTab from '@/components/app/knowledge/KnowledgeQnaTab';
import KnowledgeFilesTab from '@/components/app/knowledge/KnowledgeFilesTab';
import {
  Plus, Trash2, BookOpen, Search, Eye, ThumbsUp, Globe,
  FileText, Edit, BookMarked, MessageCircleQuestion, Sparkles,
} from 'lucide-react';

/**
 * Knowledge Base — the ONE place operators author content. Articles and Q&A
 * live here as tabs; every consumer (AI retrieval, the chat widget, the
 * Telegram plugin's FAQ/help-article menu) reads the SAME rows — there is no
 * per-surface copy of this content anywhere else.
 *
 * Creating/editing an article and the AI-powered "scan my website" builder
 * are each their own dedicated page (ArticleEditorPage, AiBuilderPage) —
 * this page is only the two tabbed lists. The AI builder is gated by its
 * own plan entitlement (`ai_kb_builder`); everything on THIS page (articles,
 * Q&A) has no AI dependency and stays fully usable on any plan.
 */
export default function KnowledgeBasePage() {
  const { t, dir } = useTranslation();
  const workspace = useCurrentWorkspace();
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const activeTab = tabParam === 'qna' || tabParam === 'files' ? tabParam : 'articles';
  const setActiveTab = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'qna' || value === 'files') next.set('tab', value); else next.delete('tab');
    setParams(next, { replace: true });
  };
  // The platform's active region/language mode decides which article
  // languages exist here — a single-language platform must not offer a
  // language picker or let articles be authored in a language visitors on
  // this platform can never see.
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const activeLocales = allowedLocales.length ? allowedLocales : ['en', 'fa', 'tr'];
  const LOCALE_LABELS: Record<string, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };
  const [locale, setLocale] = useState(activeLocales[0] || 'en');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // The list must never hide articles just because they were authored in a
  // language the platform no longer offers for NEW content — a Turkish
  // article on a now-Persian-only platform still exists and still needs to
  // be visible/editable/deletable.
  const listLocale = canSwitchLanguage ? locale : undefined;
  const { data: articles, isLoading } = useKBArticles(workspace?.id, listLocale, statusFilter);
  const deleteArticle = useDeleteKBArticle(workspace?.id);

  const filtered = articles?.filter((a) =>
    !searchQuery || a.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalViews = 0; // Placeholder — data model can be extended
  const publishedCount = articles?.filter((a: any) => a.status === 'published').length ?? 0;

  const statusBadge: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    published: 'bg-success/15 text-success border border-success/20',
    archived: 'bg-warning/15 text-warning border border-warning/20',
  };
  const statusLabel: Record<string, string> = {
    draft: t('knowledgeBase.draft'),
    published: t('knowledgeBase.published'),
    archived: t('knowledgeBase.archived'),
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
          {activeTab === 'articles' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => navigate(wsPath('/knowledge-base/ai-builder'))} className="gap-2">
                <Sparkles className="w-4 h-4" />
                <span>{t('knowledgeBase.aiBuilder.cta')}</span>
              </Button>
              <Button onClick={() => navigate(wsPath('/knowledge-base/articles/new'))} className="gap-2 shadow-md shadow-primary/20">
                <Plus className="w-4 h-4" />
                <span>{t('knowledgeBase.newArticle')}</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Big, unmistakable section switch — Articles vs Q&A are different
          content types with different consumers; this must never read as
          a minor filter toggle. */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="h-auto w-full sm:w-auto gap-2 rounded-2xl bg-muted/60 p-2">
          <TabsTrigger
            value="articles"
            className="flex-1 sm:flex-initial gap-2.5 rounded-xl px-6 py-3.5 text-base font-bold data-[state=active]:shadow-md"
          >
            <BookOpen className="w-5 h-5" /> {t('knowledgeBase.tabs.articles')}
          </TabsTrigger>
          <TabsTrigger
            value="qna"
            className="flex-1 sm:flex-initial gap-2.5 rounded-xl px-6 py-3.5 text-base font-bold data-[state=active]:shadow-md"
          >
            <MessageCircleQuestion className="w-5 h-5" /> {t('knowledgeBase.tabs.qna')}
          </TabsTrigger>
          <TabsTrigger
            value="files"
            className="flex-1 sm:flex-initial gap-2.5 rounded-xl px-6 py-3.5 text-base font-bold data-[state=active]:shadow-md"
          >
            <FileText className="w-5 h-5" /> {t('knowledgeBase.tabs.files')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="articles" className="space-y-6 mt-0">
          {/* Stats */}
          <div className="grid grid-cols-4 gap-2.5">
            <div className="stat-card flex flex-col items-center text-center px-2 py-3">
              <BookOpen className="w-4 h-4 text-primary mb-1" />
              <div className="text-lg font-bold text-foreground">{articles?.length ?? 0}</div>
              <div className="text-[11px] text-muted-foreground">{t('knowledgeBase.stats.articles')}</div>
            </div>
            <div className="stat-card flex flex-col items-center text-center px-2 py-3">
              <Eye className="w-4 h-4 text-info mb-1" />
              <div className="text-lg font-bold text-foreground">{totalViews}</div>
              <div className="text-[11px] text-muted-foreground">{t('knowledgeBase.stats.views')}</div>
            </div>
            <div className="stat-card flex flex-col items-center text-center px-2 py-3">
              <ThumbsUp className="w-4 h-4 text-success mb-1" />
              <div className="text-lg font-bold text-foreground">0</div>
              <div className="text-[11px] text-muted-foreground">{t('knowledgeBase.stats.helpful')}</div>
            </div>
            <div className="stat-card flex flex-col items-center text-center px-2 py-3">
              <Globe className="w-4 h-4 text-warning mb-1" />
              <div className="text-lg font-bold text-foreground">{publishedCount}</div>
              <div className="text-[11px] text-muted-foreground">{t('knowledgeBase.published')}</div>
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-3 flex-wrap">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="ps-9"
                placeholder={t('knowledgeBase.searchArticles')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            {canSwitchLanguage && (
              <Select value={locale} onValueChange={setLocale}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {activeLocales.map((loc) => (
                    <SelectItem key={loc} value={loc}>{LOCALE_LABELS[loc] || loc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('knowledgeBase.status.all')}</SelectItem>
                <SelectItem value="draft">{t('knowledgeBase.draft')}</SelectItem>
                <SelectItem value="published">{t('knowledgeBase.published')}</SelectItem>
                <SelectItem value="archived">{t('knowledgeBase.archived')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Article List */}
          <div className="card-elevated">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">{t('knowledgeBase.allArticles')}</h2>
            </div>
            {isLoading ? (
              <div className="p-8 space-y-3">
                {[1, 2, 3].map((i) => (
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
                <p className="text-xs text-muted-foreground">{t('knowledgeBase.noArticlesHint')}</p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {filtered.map((article) => (
                  <div key={article.id} className="px-5 py-3.5 hover:bg-muted/30 transition-colors flex items-center gap-4">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <FileText className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-foreground truncate">{article.title}</span>
                        <Badge className={`text-[10px] px-1.5 py-0 ${statusBadge[article.status]}`}>{statusLabel[article.status] || article.status}</Badge>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">{LOCALE_LABELS[article.locale] || article.locale}</Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {(article as any).knowledge_base_categories?.name || 'Uncategorized'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(wsPath(`/knowledge-base/articles/${article.id}`))} title={t('common.edit')}>
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteArticle.mutate(article.id)} title={t('common.delete')}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="qna" className="mt-0">
          <KnowledgeQnaTab />
        </TabsContent>

        <TabsContent value="files" className="mt-0">
          <KnowledgeFilesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
