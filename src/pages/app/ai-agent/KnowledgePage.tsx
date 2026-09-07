import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, BookOpen, MessageCircleQuestion, Globe, FileText, GraduationCap, BookMarked, BookText } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatDate } from '@/lib/date';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';

function statusKey(item: any): { key: 'ready' | 'indexing' | 'disabled' | 'needsAttention' | 'failed'; tone: 'green' | 'amber' | 'red' | 'muted' | 'blue' } {
  if (item.eligible === true) return { key: 'ready', tone: 'green' };
  const r = item.reason || item.last_reason;
  if (r === 'no_active_chunks' || r === 'embedding_missing') return { key: 'indexing', tone: 'blue' };
  if (r === 'disabled_qna' || r === 'file_not_active' || r === 'website_not_active' || r === 'kb_disabled_for_ai') return { key: 'disabled', tone: 'muted' };
  if (r === 'draft_kb' || r === 'candidate_not_approved') return { key: 'needsAttention', tone: 'amber' };
  if (r === 'source_missing') return { key: 'failed', tone: 'red' };
  return { key: 'needsAttention', tone: 'amber' };
}

const TONE: Record<string, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  red: 'bg-destructive/10 text-destructive border-destructive/40',
  muted: 'bg-muted text-muted-foreground border-border',
  blue: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
};

const SOURCE_GROUPS: Array<{ key: 'qna' | 'website' | 'file' | 'kb_article' | 'learning_candidate'; icon: any; tone: string }> = [
  { key: 'qna', icon: MessageCircleQuestion, tone: 'bg-amber-500/10 text-amber-600 ring-amber-500/20' },
  { key: 'website', icon: Globe, tone: 'bg-sky-500/10 text-sky-600 ring-sky-500/20' },
  { key: 'file', icon: FileText, tone: 'bg-violet-500/10 text-violet-600 ring-violet-500/20' },
  { key: 'kb_article', icon: BookMarked, tone: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20' },
  { key: 'learning_candidate', icon: GraduationCap, tone: 'bg-rose-500/10 text-rose-600 ring-rose-500/20' },
];

export default function KnowledgePage() {
  const wsPath = useWorkspacePath();
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const { t, dir } = useTranslation();
  const tr = (k: string, fb: string, vars?: Record<string, string>) => {
    const v = t(`aiAgent.knowledge.${k}` as any, vars);
    return !v || v === `aiAgent.knowledge.${k}` ? fb : v;
  };

  const health = useQuery({
    queryKey: ['ai-knowledge', wsId],
    queryFn: () => aiAgentApi.knowledgeCustomerSummary(wsId!),
    enabled: !!wsId,
    staleTime: 30_000,
  });

  const items: any[] = (health.data?.items || []) as any[];

  return (
    <div className="space-y-8" dir={dir}>
      <AiPageHeader icon={BookOpen} accent="cyan" title={tr('title', 'Knowledge')} subtitle={tr('subtitle', 'Sources your AI Agent uses to answer visitors.')} />

      {/* Articles, Q&A and files are all authored in the unified Knowledge
          Base page (Articles / Q&A / Files tabs, including the AI
          website-scan builder) — this page only reports RAG indexing
          status for every source type. Website crawl sources are managed
          on their own dedicated page (linked from here) since crawling
          isn't authored content. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="default" className="shadow-sm">
          <Link to={wsPath('/knowledge-base')}>
            <BookText className="h-4 w-4 me-2" />
            {tr('actions.manageArticles', 'Manage articles & Q&A')}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={`${wsPath('/knowledge-base')}?tab=files`}>
            <FileText className="h-4 w-4 me-2" />
            {tr('actions.manageFiles', 'Manage files')}
          </Link>
        </Button>
      </div>

      {health.isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid gap-4">
          {SOURCE_GROUPS.map((g) => {
            const groupItems = items.filter((it) => (it.source_type || it.kind) === g.key);
            const title = tr(`source.${g.key}`, g.key);
            return (
              <Card key={g.key} className="overflow-hidden border-border/60 hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2.5">
                    <span className={`h-8 w-8 rounded-lg flex items-center justify-center ring-1 ${g.tone}`}>
                      <g.icon className="h-4 w-4" />
                    </span>
                    <span className="flex-1">{title}</span>
                    <Badge variant="outline" className="text-[10px] tabular-nums">{groupItems.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {groupItems.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">{tr('empty', `No ${title} yet.`, { type: title })}</p>
                  ) : (
                    <div className="space-y-1">
                      {groupItems.slice(0, 25).map((it: any, idx: number) => {
                        const s = statusKey(it);
                        const updated = it.updated_at || it.last_indexed_at;
                        const code = it.reason || it.last_reason;
                        const friendly = code ? tr(`reason.${code}`, tr('reason.default', 'Needs attention')) : null;
                        return (
                          <div key={(it.source_id || it.id || idx) + ''} className="flex items-center gap-2 py-2 px-2 -mx-2 rounded-md text-sm hover:bg-accent/40 transition-colors border-b border-border/40 last:border-b-0">
                            <span className="flex-1 truncate font-medium">{it.title || it.name || tr('untitled', '(untitled)')}</span>
                            {friendly && s.tone !== 'green' && (
                              <span className="text-[11px] text-muted-foreground hidden md:inline">{friendly}</span>
                            )}
                            {updated && (
                              <span className="text-[11px] text-muted-foreground tabular-nums hidden sm:inline">
                                {formatDate(updated)}
                              </span>
                            )}
                            <Badge variant="outline" className={`text-[10px] ${TONE[s.tone]}`}>{tr(`status.${s.key}`, s.key)}</Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}