import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, BookOpen, MessageCircleQuestion, Globe, FileText, GraduationCap, BookMarked } from 'lucide-react';

const FRIENDLY_REASONS: Record<string, string> = {
  disabled_qna: 'Disabled Q&A',
  draft_kb: 'Draft article',
  file_not_active: 'File not active',
  website_not_active: 'Website not active',
  candidate_not_approved: 'Learned answer not approved',
  no_active_chunks: 'Not indexed yet',
  embedding_missing: 'Processing not complete',
  source_missing: 'Source missing',
};

function friendlyReason(code?: string | null) {
  if (!code) return null;
  return FRIENDLY_REASONS[code] || 'Needs attention';
}

function statusLabel(item: any): { label: string; tone: 'green' | 'amber' | 'red' | 'muted' | 'blue' } {
  if (item.eligible === true) return { label: 'Ready', tone: 'green' };
  const r = item.reason || item.last_reason;
  if (r === 'no_active_chunks' || r === 'embedding_missing') return { label: 'Indexing', tone: 'blue' };
  if (r === 'disabled_qna' || r === 'file_not_active' || r === 'website_not_active') return { label: 'Disabled', tone: 'muted' };
  if (r === 'draft_kb' || r === 'candidate_not_approved') return { label: 'Needs attention', tone: 'amber' };
  if (r === 'source_missing') return { label: 'Failed', tone: 'red' };
  return { label: 'Needs attention', tone: 'amber' };
}

const TONE: Record<string, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  red: 'bg-destructive/10 text-destructive border-destructive/40',
  muted: 'bg-muted text-muted-foreground border-border',
  blue: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
};

const SOURCE_GROUPS: Array<{ key: string; title: string; icon: any }> = [
  { key: 'qna', title: 'Q&A', icon: MessageCircleQuestion },
  { key: 'website', title: 'Website Pages', icon: Globe },
  { key: 'file', title: 'Files', icon: FileText },
  { key: 'kb_article', title: 'KB Articles', icon: BookMarked },
  { key: 'learning_candidate', title: 'Learned Answers', icon: GraduationCap },
];

export default function KnowledgePage() {
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const wsId = workspace?.id;

  const health = useQuery({
    queryKey: ['ai-knowledge', wsId],
    queryFn: () => aiAgentApi.getSourceHealth(wsId!, { limit: 200 }),
    enabled: !!wsId,
    staleTime: 30_000,
  });

  const items: any[] = (health.data?.items || health.data?.sources || []) as any[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <BookOpen className="h-5 w-5 text-primary" /> Knowledge
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Sources your AI Agent uses to answer visitors. Add or update content to improve answers.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/qna'))}>Manage Q&A</Button>
        <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/web-pages'))}>Manage Web Pages</Button>
        <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/files'))}>Manage Files</Button>
        <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/settings/knowledge-base'))}>KB Articles</Button>
        <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/learning-candidates'))}>Learned Answers</Button>
      </div>

      {health.isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-4">
          {SOURCE_GROUPS.map((g) => {
            const groupItems = items.filter((it) => (it.source_type || it.kind) === g.key);
            return (
              <Card key={g.key}>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <g.icon className="h-4 w-4 text-muted-foreground" /> {g.title}
                    <Badge variant="outline" className="ml-2 text-[10px]">{groupItems.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {groupItems.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No {g.title.toLowerCase()} yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {groupItems.slice(0, 25).map((it: any, idx: number) => {
                        const s = statusLabel(it);
                        const updated = it.updated_at || it.last_indexed_at;
                        const friendly = friendlyReason(it.reason || it.last_reason);
                        return (
                          <div key={(it.source_id || it.id || idx) + ''} className="flex items-center gap-2 py-1.5 border-b last:border-b-0 text-sm">
                            <span className="flex-1 truncate font-medium">{it.title || it.name || '(untitled)'}</span>
                            {friendly && s.tone !== 'green' && (
                              <span className="text-[11px] text-muted-foreground hidden md:inline">{friendly}</span>
                            )}
                            {updated && (
                              <span className="text-[11px] text-muted-foreground tabular-nums hidden sm:inline">
                                {new Date(updated).toLocaleDateString()}
                              </span>
                            )}
                            <Badge variant="outline" className={`text-[10px] ${TONE[s.tone]}`}>{s.label}</Badge>
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