import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, BookOpen, MessageCircleQuestion, Globe, FileText, GraduationCap, BookMarked, BookText, Upload, Trash2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';
import { isStorageCleanupIncomplete, readApiErrorCode } from '@/lib/ai-knowledge-delete';
import AiKbBuilderTab from '@/components/app/knowledge/AiKbBuilderTab';

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
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const { t, dir } = useTranslation();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

  const onPickFile = () => fileInputRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !wsId) return;
    setUploading(true);
    const toastId = toast.loading(tr('actions.uploading', 'Uploading file...'));
    try {
      await aiAgentApi.uploadAiFile(wsId, file);
      toast.success(tr('actions.uploadSuccess', 'File uploaded. Indexing will start shortly.'), { id: toastId });
      qc.invalidateQueries({ queryKey: ['ai-knowledge', wsId] });
    } catch (err: any) {
      const code = err?.body?.error || err?.message || 'upload_failed';
      toast.error(tr(`actions.error.${code}`, tr('actions.uploadError', 'Upload failed')) , { id: toastId });
    } finally {
      setUploading(false);
    }
  };
  const onDeleteFile = async (id: string) => {
    if (!confirm(tr('actions.deleteConfirm', 'Delete this file? It will be removed from AI knowledge.'))) return;
    setDeletingId(id);
    const toastId = toast.loading(tr('actions.deleting', 'Deleting file...'));
    try {
      const result = await aiAgentApi.deleteAiFile(id);
      if (isStorageCleanupIncomplete(result)) {
        toast.warning(
          tr('actions.deletePartial', 'The file was removed from the knowledge base, but storage cleanup could not be completed.'),
          { id: toastId },
        );
      } else {
        toast.success(tr('actions.deleteSuccess', 'File deleted.'), { id: toastId });
      }
      qc.invalidateQueries({ queryKey: ['ai-knowledge', wsId] });
    } catch (err: unknown) {
      const code = readApiErrorCode(err, 'delete_failed');
      toast.error(tr(`actions.error.${code}`, tr('actions.deleteError', 'Delete failed')), { id: toastId });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-8" dir={dir}>
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
            <BookOpen className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{tr('title', 'Knowledge')}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">{tr('subtitle', 'Sources your AI Agent uses to answer visitors.')}</p>
          </div>
        </div>
      </div>

      {/* Phase 6-S5 — the AI KB Builder lives on the AI Agent side only. */}
      <AiKbBuilderTab />

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="default" className="shadow-sm">
          <Link to="../../knowledge-base">
            <BookText className="h-4 w-4 me-2" />
            {tr('actions.manageArticles', 'Manage articles')}
          </Link>
        </Button>
        <Button variant="outline" onClick={onPickFile} disabled={uploading}>
          {uploading ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Upload className="h-4 w-4 me-2" />}
          {tr('actions.uploadFile', 'Upload file')}
        </Button>
        <p className="text-xs text-muted-foreground basis-full sm:basis-auto sm:ms-2">
          {tr('actions.uploadHint', 'PDF, DOCX, TXT, MD — used by your AI assistant.')}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.md,.csv,.html,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv,text/html"
          className="hidden"
          onChange={onFileChange}
        />
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
                                {new Date(updated).toLocaleDateString()}
                              </span>
                            )}
                            <Badge variant="outline" className={`text-[10px] ${TONE[s.tone]}`}>{tr(`status.${s.key}`, s.key)}</Badge>
                            {g.key === 'file' && it.source_id && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={() => onDeleteFile(it.source_id)}
                                disabled={deletingId === it.source_id}
                                title={tr('actions.delete', 'Delete')}
                              >
                                {deletingId === it.source_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                              </Button>
                            )}
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