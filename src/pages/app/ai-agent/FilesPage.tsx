import { useEffect, useRef, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type DataSource } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { FileText, Loader2, RefreshCw, Pause, Play, Trash2, Upload, AlertTriangle } from 'lucide-react';

const ACCEPT = '.txt,.md,.markdown,.csv,.pdf,text/plain,text/markdown,text/csv,application/pdf';

function fmtBytes(n?: number | null) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function FilesPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [limits, setLimits] = useState<Awaited<ReturnType<typeof aiAgentApi.getAiFileLimits>> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const [r, l] = await Promise.all([
        aiAgentApi.listAiFiles(wsId),
        aiAgentApi.getAiFileLimits(wsId).catch(() => null),
      ]);
      setItems(r.items || []);
      setLimits(l);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function handleFiles(files: FileList | null) {
    if (!wsId || !files || !files.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        try {
          const r = await aiAgentApi.uploadAiFile(wsId, file);
          const warn = r.warnings?.length ? ` (${r.warnings.join(', ')})` : '';
          toast({ title: `Uploaded: ${file.name}`, description: `${r.chunks_created} chunks indexed${warn}` });
        } catch (e: any) {
          toast({ title: `Upload failed: ${file.name}`, description: e?.message || 'unknown_error', variant: 'destructive' });
        }
      }
      await refresh();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function reindex(s: DataSource) {
    setBusyId(s.id);
    try { await aiAgentApi.reindexAiFile(s.id); toast({ title: 'Reindexed' }); refresh(); }
    catch (e: any) { toast({ title: 'Reindex failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusyId(null); }
  }
  async function togglePause(s: DataSource) {
    setBusyId(s.id);
    try {
      if (s.status === 'paused') await aiAgentApi.resumeAiFile(s.id);
      else await aiAgentApi.pauseAiFile(s.id);
      refresh();
    } catch (e: any) { toast({ title: 'Action failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusyId(null); }
  }
  async function remove(s: DataSource) {
    if (!confirm(`Delete file "${s.name}"?`)) return;
    setBusyId(s.id);
    try {
      const r = await aiAgentApi.deleteAiFile(s.id);
      toast({ title: 'Deleted', description: `${r.chunks_deleted} chunks removed${r.storage_deleted ? '' : ' (storage delete failed)'}` });
      refresh();
    } catch (e: any) { toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' }); }
    finally { setBusyId(null); }
  }

  if (!wsId) return null;
  const usagePct = limits ? Math.round((limits.used / Math.max(limits.maxFiles, 1)) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <FileText className="h-5 w-5 text-primary" /> Files
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Upload TXT, Markdown, CSV, or PDF files to train the AI. Files are stored in your
            active storage provider under this workspace.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
            Upload file
          </Button>
        </div>
      </div>

      {limits && (
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div><span className="text-muted-foreground">Files:</span> <strong>{limits.used}/{limits.maxFiles}</strong> ({usagePct}%)</div>
            <div><span className="text-muted-foreground">Max size:</span> <strong>{limits.maxFileSizeMB} MB</strong></div>
            <div><span className="text-muted-foreground">Storage provider:</span> <strong>{limits.storageProvider || 'not configured'}</strong></div>
            {limits.bypass && <Badge variant="secondary">admin bypass</Badge>}
            {!limits.storageProvider && <Badge variant="destructive">storage_not_configured</Badge>}
          </CardContent>
        </Card>
      )}

      <Card
        className="border-dashed cursor-pointer hover:border-primary/60 transition-colors"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
      >
        <CardContent className="p-8 text-center space-y-3">
          <div className="mx-auto h-14 w-14 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
            <Upload className="h-6 w-6" />
          </div>
          <h3 className="text-base font-medium">Drag & drop files or click to browse</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Supported: .txt, .md, .csv, .pdf — up to {limits?.maxFileSizeMB ?? 50} MB each.
            Scanned/image-only PDFs are not OCR&apos;d.
          </p>
          <div className="flex justify-center gap-1.5 flex-wrap pt-2">
            <Badge variant="outline">.txt</Badge>
            <Badge variant="outline">.md</Badge>
            <Badge variant="outline">.csv</Badge>
            <Badge variant="outline">.pdf</Badge>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-4">
          No files yet. Upload TXT, Markdown, CSV, or PDF files to train the AI.
        </p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Indexed files</h3>
          {items.map((s) => {
            const m = (s.metadata || {}) as any;
            const statusVariant: any = s.status === 'active' ? 'default' : s.status === 'failed' ? 'destructive' : 'secondary';
            return (
              <Card key={s.id}>
                <CardContent className="p-4 flex items-center gap-3">
                  <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate">{s.name}</p>
                      <Badge variant={statusVariant}>{s.status}</Badge>
                      {m.parser && <Badge variant="outline">{m.parser}</Badge>}
                      {m.page_count ? <Badge variant="outline">{m.page_count} pages</Badge> : null}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {fmtBytes(m.size_bytes)} · {(s as any).chunks_created ?? 0} chunks · {(s as any).embedded_chunks ?? 0} embedded
                      {s.last_synced_at ? ` · indexed ${new Date(s.last_synced_at).toLocaleString()}` : ''}
                    </p>
                    {(s.last_error || m.parse_error) && (
                      <p className="text-[11px] text-destructive mt-1 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> {s.last_error || m.parse_error}
                      </p>
                    )}
                    {Array.isArray(m.warnings) && m.warnings.length > 0 && (
                      <p className="text-[11px] text-amber-600 mt-1">⚠ {m.warnings.join(', ')}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" disabled={busyId === s.id} onClick={() => reindex(s)} title="Reindex">
                      {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" disabled={busyId === s.id} onClick={() => togglePause(s)} title={s.status === 'paused' ? 'Resume' : 'Pause'}>
                      {s.status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" disabled={busyId === s.id} onClick={() => remove(s)} title="Delete">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}