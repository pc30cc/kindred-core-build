import { useEffect, useRef, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type DataSource } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { FileText, Loader2, RefreshCw, Pause, Play, Trash2, Upload, AlertTriangle, Eye, ScrollText, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const ACCEPT = '.txt,.md,.markdown,.csv,.pdf,text/plain,text/markdown,text/csv,application/pdf';
const SUPPORTED_EXT = ['txt', 'md', 'markdown', 'csv', 'pdf'];

function inferMime(file: File): string {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'txt': return 'text/plain';
    case 'md':
    case 'markdown': return 'text/markdown';
    case 'csv': return 'text/csv';
    case 'pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

function errorLabel(code?: string): string {
  switch (code) {
    case 'unsupported_file_type': return 'File type not supported. Use TXT, MD, CSV, or PDF.';
    case 'file_size_limit_reached': return 'File exceeds the allowed size limit.';
    case 'no_text_extracted': return 'This PDF has no extractable text. OCR is not enabled.';
    case 'pdf_encrypted_or_unreadable': return 'PDF is encrypted or unreadable.';
    case 'pdf_parse_failed': return 'Failed to parse PDF (file may be corrupted).';
    case 'storage_not_ready':
    case 'storage_not_configured': return 'Storage provider is not ready. Configure Storage Provider before uploading AI files.';
    case 'local_storage_public_url_unconfigured': return 'Local storage requires a public URL.';
    case 'parse_failed': return 'Parsing failed.';
    case 'index_failed': return 'Indexing failed.';
    case 'download_failed': return 'Could not read the stored file.';
    default: return code || 'Unknown error';
  }
}

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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<Awaited<ReturnType<typeof aiAgentApi.getAiFilePreview>> | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsData, setLogsData] = useState<Awaited<ReturnType<typeof aiAgentApi.getAiFileLogs>> | null>(null);

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

  // Poll while any source is queued/syncing so the user sees worker progress.
  useEffect(() => {
    const hasPending = items.some((s) => {
      const m = (s.metadata || {}) as any;
      return s.status === 'syncing' || m.job_status === 'queued' || m.job_status === 'running';
    });
    if (!hasPending) return;
    const t = setInterval(() => { refresh(); }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function handleFiles(files: FileList | null) {
    if (!wsId || !files || !files.length) return;
    if (limits && !limits.storageReady) {
      toast({ title: 'Storage not ready', description: errorLabel(limits.storageError || 'storage_not_ready'), variant: 'destructive' });
      return;
    }
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!SUPPORTED_EXT.includes(ext)) {
          toast({ title: `Skipped: ${file.name}`, description: errorLabel('unsupported_file_type'), variant: 'destructive' });
          continue;
        }
        const cap = limits?.effectiveMaxFileSizeMB ?? 25;
        if (file.size / (1024 * 1024) > cap) {
          toast({ title: `Too large: ${file.name}`, description: `Max ${cap} MB`, variant: 'destructive' });
          continue;
        }
        // Re-tag File with inferred mime when browser left it empty.
        const mime = inferMime(file);
        const tagged = file.type ? file : new File([file], file.name, { type: mime });
        try {
          const r = await aiAgentApi.uploadAiFile(wsId, tagged);
          toast({ title: `Queued: ${file.name}`, description: `Job ${r.jobId.slice(0, 8)}… running in background` });
        } catch (e: any) {
          toast({ title: `Upload failed: ${file.name}`, description: errorLabel(e?.message), variant: 'destructive' });
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
    try { await aiAgentApi.reindexAiFile(s.id); toast({ title: 'Reindex queued' }); refresh(); }
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
  async function openPreview(s: DataSource) {
    setPreviewOpen(true); setPreviewData(null);
    try { setPreviewData(await aiAgentApi.getAiFilePreview(s.id)); }
    catch (e: any) { toast({ title: 'Preview failed', description: e?.message, variant: 'destructive' }); setPreviewOpen(false); }
  }
  async function openLogs(s: DataSource) {
    setLogsOpen(true); setLogsData(null);
    try { setLogsData(await aiAgentApi.getAiFileLogs(s.id)); }
    catch (e: any) { toast({ title: 'Logs failed', description: e?.message, variant: 'destructive' }); setLogsOpen(false); }
  }

  if (!wsId) return null;
  const usagePct = limits ? Math.round((limits.used / Math.max(limits.maxFiles, 1)) * 100) : 0;
  const storageReady = !limits || limits.storageReady;
  const effectiveMax = limits?.effectiveMaxFileSizeMB ?? 25;
  const filteredItems = items.filter((s) => {
    if (statusFilter !== 'all') {
      const m = (s.metadata || {}) as any;
      if (statusFilter === 'queued' || statusFilter === 'running') {
        if ((m.job_status || '') !== statusFilter) return false;
      } else if (s.status !== statusFilter) return false;
    }
    if (search.trim() && !(s.name || '').toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

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
          <Button onClick={() => fileInputRef.current?.click()} disabled={uploading || !storageReady}>
            {uploading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
            Upload file
          </Button>
        </div>
      </div>

      {limits && (
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div><span className="text-muted-foreground">Files:</span> <strong>{limits.used}/{limits.maxFiles}</strong> ({usagePct}%)</div>
            <div><span className="text-muted-foreground">Max size:</span> <strong>{limits.effectiveMaxFileSizeMB} MB</strong> <span className="text-muted-foreground">(plan {limits.maxFileSizeMB} MB · transport {limits.transportMaxFileSizeMB} MB)</span></div>
            <div><span className="text-muted-foreground">Storage provider:</span> <strong>{limits.storageProvider || 'not configured'}</strong></div>
            {limits.storageReady
              ? <Badge variant="default">storage ready</Badge>
              : <Badge variant="destructive">{limits.storageError || 'storage not ready'}</Badge>}
            {limits.bypass && <Badge variant="secondary">admin bypass</Badge>}
          </CardContent>
        </Card>
      )}

      {limits && !limits.storageReady && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 text-sm flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-destructive">Storage provider is not ready</p>
              <p className="text-muted-foreground mt-0.5">
                {errorLabel(limits.storageError || 'storage_not_ready')} Configure the active Storage Provider in admin settings before uploading AI files.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card
        className={`border-dashed transition-colors ${storageReady ? 'cursor-pointer hover:border-primary/60' : 'opacity-60 cursor-not-allowed'}`}
        onClick={() => storageReady && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); if (storageReady) handleFiles(e.dataTransfer.files); }}
      >
        <CardContent className="p-8 text-center space-y-3">
          <div className="mx-auto h-14 w-14 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
            <Upload className="h-6 w-6" />
          </div>
          <h3 className="text-base font-medium">Drag & drop files or click to browse</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Supported: .txt, .md, .csv, .pdf — up to {effectiveMax} MB each.
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
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-muted-foreground mr-2">Files</h3>
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search filename…"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="syncing">Syncing</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground ml-auto">{filteredItems.length} of {items.length}</span>
          </div>
          {filteredItems.map((s) => {
            const m = (s.metadata || {}) as any;
            const statusVariant: any = s.status === 'active' ? 'default' : s.status === 'failed' ? 'destructive' : 'secondary';
            const jobStatus = m.job_status as string | undefined;
            return (
              <Card key={s.id}>
                <CardContent className="p-4 flex items-center gap-3">
                  <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate">{s.name}</p>
                      <Badge variant={statusVariant}>{s.status}</Badge>
                      {jobStatus && jobStatus !== 'completed' && (
                        <Badge variant={jobStatus === 'failed' ? 'destructive' : 'outline'}>job: {jobStatus}</Badge>
                      )}
                      {m.parser && <Badge variant="outline">{m.parser}</Badge>}
                      {m.page_count ? <Badge variant="outline">{m.page_count} pages</Badge> : null}
                      {m.storage_provider && <Badge variant="outline">{m.storage_provider}</Badge>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {fmtBytes(m.size_bytes)} · {(s as any).chunks_created ?? 0} chunks · {(s as any).embedded_chunks ?? 0} embedded
                      {s.last_synced_at ? ` · indexed ${new Date(s.last_synced_at).toLocaleString()}` : ''}
                    </p>
                    {(s.last_error || m.parse_error) && (
                      <p className="text-[11px] text-destructive mt-1 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> {errorLabel(s.last_error || m.parse_error)}
                      </p>
                    )}
                    {Array.isArray(m.warnings) && m.warnings.length > 0 && (
                      <p className="text-[11px] text-amber-600 mt-1">⚠ {m.warnings.join(', ')}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => openPreview(s)} title="Preview">
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => openLogs(s)} title="Logs">
                      <ScrollText className="h-4 w-4" />
                    </Button>
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

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Preview · {previewData?.file_name || '…'}</DialogTitle>
            <DialogDescription>
              {previewData ? (
                <>Status: {previewData.status}{previewData.parser ? ` · ${previewData.parser}` : ''}{previewData.page_count ? ` · ${previewData.page_count} pages` : ''}{previewData.text_length ? ` · ${previewData.text_length} chars total` : ''}</>
              ) : 'Loading…'}
            </DialogDescription>
          </DialogHeader>
          {previewData ? (
            <div className="space-y-3">
              {previewData.last_error && (
                <p className="text-xs text-destructive">⚠ {errorLabel(previewData.last_error)}</p>
              )}
              {previewData.warnings.length > 0 && (
                <p className="text-xs text-amber-600">⚠ {previewData.warnings.join(', ')}</p>
              )}
              {previewData.text_preview ? (
                <pre className="text-xs bg-muted p-3 rounded max-h-[50vh] overflow-auto whitespace-pre-wrap">
                  {previewData.text_preview}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">No preview available.</p>
              )}
            </div>
          ) : <Loader2 className="h-5 w-5 animate-spin mx-auto" />}
        </DialogContent>
      </Dialog>

      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Ingestion logs</DialogTitle>
            <DialogDescription>Latest 100 events for this file.</DialogDescription>
          </DialogHeader>
          {logsData ? (
            <div className="space-y-3 max-h-[60vh] overflow-auto">
              {logsData.jobs.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-1.5">Recent jobs</h4>
                  <div className="space-y-1">
                    {logsData.jobs.map((j) => (
                      <div key={j.id} className="text-xs flex items-center gap-2">
                        <Badge variant={j.status === 'failed' ? 'destructive' : j.status === 'completed' ? 'default' : 'secondary'}>
                          {j.status}
                        </Badge>
                        <code className="text-[10px]">{j.id.slice(0, 8)}</code>
                        <span className="text-muted-foreground">attempts:{j.attempts}</span>
                        <span className="text-muted-foreground ml-auto">{new Date(j.created_at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1.5">Events</h4>
                <div className="space-y-1">
                  {logsData.items.map((l) => (
                    <div key={l.id} className="text-xs border-b border-border/40 pb-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{l.status}</Badge>
                        <span className="text-muted-foreground ml-auto">{new Date(l.created_at).toLocaleString()}</span>
                      </div>
                      {l.message && <p className="text-muted-foreground mt-0.5">{l.message}</p>}
                    </div>
                  ))}
                  {logsData.items.length === 0 && <p className="text-xs text-muted-foreground">No events yet.</p>}
                </div>
              </div>
            </div>
          ) : <Loader2 className="h-5 w-5 animate-spin mx-auto" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}