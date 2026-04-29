import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type DataSource } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { FileText, Loader2, Trash2, Upload } from 'lucide-react';

export default function FilesPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const r = await aiAgentApi.listDataSources(wsId, 'file');
      setItems(r.items || []);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function remove(s: DataSource) {
    if (!confirm(`Delete file "${s.name}"?`)) return;
    try { await aiAgentApi.deleteDataSource(s.id); refresh(); }
    catch (e: any) { toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' }); }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <FileText className="h-5 w-5 text-primary" /> Files
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Upload documents to extend the AI's knowledge — internal guides, FAQs, policies.
            Files are indexed and used alongside your knowledge base.
          </p>
        </div>
        <Button disabled title="File upload coming soon">
          <Upload className="h-4 w-4 mr-1.5" /> Upload file
        </Button>
      </div>

      <Card className="border-dashed">
        <CardContent className="p-8 text-center space-y-3">
          <div className="mx-auto h-14 w-14 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
            <Upload className="h-6 w-6" />
          </div>
          <h3 className="text-base font-medium">File upload coming soon</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Direct file upload (TXT, Markdown, PDF) is being prepared. For now, paste content into a
            knowledge base article or a Q&amp;A entry.
          </p>
          <div className="flex justify-center gap-1.5 flex-wrap pt-2">
            <Badge variant="outline">.txt</Badge>
            <Badge variant="outline">.md</Badge>
            <Badge variant="outline" className="opacity-60">.pdf — soon</Badge>
            <Badge variant="outline" className="opacity-60">.csv — soon</Badge>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Existing file sources</h3>
          {items.map((s) => (
            <Card key={s.id}>
              <CardContent className="p-4 flex items-center gap-3">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{s.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {s.last_synced_at ? `indexed ${new Date(s.last_synced_at).toLocaleDateString()}` : 'pending'}
                  </p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => remove(s)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}