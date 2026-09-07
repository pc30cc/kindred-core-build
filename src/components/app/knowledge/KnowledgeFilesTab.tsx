import { useEffect, useRef, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { aiAgentApi, type DataSource } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { FileText, Loader2, RefreshCw, Pause, Play, Trash2, Upload, AlertTriangle, Eye, ScrollText, Search } from 'lucide-react';

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

function fmtBytes(n?: number | null) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Knowledge Base — Files tab. Uploads TXT/MD/CSV/PDF sources that only feed
 * AI retrieval (no public rendering, unlike Articles) — same `ai_agent_sources`
 * data and `/api/ai-agent/files/*` endpoints previously exposed at the
 * standalone /ai-agent/files page.
 */
export default function KnowledgeFilesTab() {
  const workspace = useCurrentWorkspace() as any;
  const wsId = workspace?.id as string | undefined;
  const { t, dir } = useTranslation();
  const tr = (k: string, fb: string, vars?: Record<string, string>) => {
    const v = t(`knowledgeBase.files.${k}` as never, vars) as unknown as string;
    return !v || v === `knowledgeBase.files.${k}` ? fb : v;
  };

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

  function errorLabel(code?: string): string {
    return code ? tr(`error.${code}`, tr('error.default', 'Unknown error')) : tr('error.default', 'Unknown error');
  }

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
      toast({ title: tr('loadFailed', 'Failed to load'), description: e?.message, variant: 'destructive' });
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
    const timer = setInterval(() => { refresh(); }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function handleFiles(files: FileList | null) {
    if (!wsId || !files || !files.length) return;
    if (limits && !limits.storageReady) {
      toast({ title: tr('storageNotReady', 'Storage not ready'), description: errorLabel(limits.storageError || 'storage_not_ready'), variant: 'destructive' });
      return;
    }
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!SUPPORTED_EXT.includes(ext)) {
          toast({ title: tr('skipped', 'Skipped: {{name}}', { name: file.name }), description: errorLabel('unsupported_file_type'), variant: 'destructive' });
          continue;
        }
        const cap = limits?.effectiveMaxFileSizeMB ?? 25;
        if (file.size / (1024 * 1024) > cap) {
          toast({ title: tr('tooLarge', 'Too large: {{name}}', { name: file.name }), description: tr('maxSize', 'Max {{size}} MB', { size: String(cap) }), variant: 'destructive' });
          continue;
        }
        const mime = inferMime(file);
        const tagged = file.type ? file : new File([file], file.name, { type: mime });
        try {
          const r = await aiAgentApi.uploadAiFile(wsId, tagged);
          toast({ title: tr('queued', 'Queued: {{name}}', { name: file.name }), description: tr('queuedHint', 'Job {{id}}… running in background', { id: r.jobId.slice(0, 8) }) });
        } catch (e: any) {
          toast({ title: tr('uploadFailed', 'Upload failed: {{name}}', { name: file.name }), description: errorLabel(e?.message), variant: 'destructive' });
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
    try { await aiAgentApi.reindexAiFile(s.id); toast({ title: tr('reindexQueued', 'Reindex queued') }); refresh(); }
    catch (e: any) { toast({ title: tr('reindexFailed', 'Reindex failed'), description: e?.message, variant: 'destructive' }); }
    finally { setBusyId(null); }
  }
  async function togglePause(s: DataSource) {
    setBusyId(s.id);
    try {
      if (s.status === 'paused') await aiAgentApi.resumeAiFile(s.id);
      else await aiAgentApi.pauseAiFile(s.id);
      refresh();
    } catch (e: any) { toast({ title: tr('actionFailed', 'Action failed'), description: e?.message, variant: 'destructive' }); }
    finally { setBusyId(null); }
  }
  async function remove(s: DataSource) {
    if (!confirm(tr('deleteConfirm', 'Delete file "{{name}}"?', { name: s.name }))) return;
    setBusyId(s.id);
    try {
      const r = await aiAgentApi.deleteAiFile(s.id);
      toast({ title: tr('deleted', 'Deleted'), description: tr('deletedHint', '{{count}} chunks removed', { count: String(r.chunks_deleted) }) + (r.storage_deleted ? '' : ` ${tr('storageDeleteFailed', '(storage delete failed)')}`) });
      refresh();
    } catch (e: any) { toast({ title: tr('deleteFailed', 'Delete failed'), description: e?.message, variant: 'destructive' }); }
    finally { setBusyId(null); }
  }
  async function openPreview(s: DataSource) {
    setPreviewOpen(true); setPreviewData(null);
    try { setPreviewData(await aiAgentApi.getAiFilePreview(s.id)); }
    catch (e: any) { toast({ title: tr('previewFailed', 'Preview failed'), description: e?.message, variant: 'destructive' }); setPreviewOpen(false); }
  }
  async function openLogs(s: DataSource) {
    setLogsOpen(true); setLogsData(null);
    try { setLogsData(await aiAgentApi.getAiFileLogs(s.id)); }
    catch (e: any) { toast({ title: tr('logsFailed', 'Logs failed'), description: e?.message, variant: 'destructive' }); setLogsOpen(false); }
  }

  if (!wsId) return null;
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
    <div className="space-y-6" dir={dir}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-2xl">
          {tr('subtitle', 'Upload TXT, Markdown, CSV, or PDF files to train the AI. Files are stored in your active storage provider under this workspace.')}
        </p>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={uploading || !storageReady} className="gap-2">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {tr('uploadFile', 'Upload file')}
          </Button>
        </div>
      </div>

      {limits && (
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div><span className="text-muted-foreground">{tr('stat.files', 'Files')}:</span> <strong>{limits.used}/{limits.maxFiles}</strong></div>
            <div><span className="text-muted-foreground">{tr('stat.maxSize', 'Max size')}:</span> <strong>{limits.effectiveMaxFileSizeMB} MB</strong></div>
            <div><span className="text-muted-foreground">{tr('stat.storageProvider', 'Storage provider')}:</span> <strong>{limits.storageProvider || tr('stat.notConfigured', 'not configured')}</strong></div>
            {limits.storageReady
              ? <Badge variant="default">{tr('stat.storageReady', 'storage ready')}</Badge>
              : <Badge variant="destructive">{errorLabel(limits.storageError || 'storage_not_ready')}</Badge>}
            {limits.bypass && <Badge variant="secondary">{tr('stat.adminBypass', 'admin bypass')}</Badge>}
          </CardContent>
        </Card>
      )}

      {limits && !limits.storageReady && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 text-sm flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-destructive">{tr('storageNotReadyTitle', 'Storage provider is not ready')}</p>
              <p className="text-muted-foreground mt-0.5">
                {errorLabel(limits.storageError || 'storage_not_ready')} {tr('storageNotReadyHint', 'Configure the active Storage Provider in admin settings before uploading AI files.')}
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
          <h3 className="text-base font-medium">{tr('dropzoneTitle', 'Drag & drop files or click to browse')}</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            {tr('dropzoneHint', 'Supported: .txt, .md, .csv, .pdf — up to {{size}} MB each. Scanned/image-only PDFs are not OCR’d.', { size: String(effectiveMax) })}
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
        <p className="text-center text-sm text-muted-foreground py-4">{tr('empty', 'No files yet. Upload TXT, Markdown, CSV, or PDF files to train the AI.')}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-muted-foreground me-2">{tr('title', 'Files')}</h3>
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="h-3.5 w-3.5 absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tr('searchPlaceholder', 'Search filename…')}
                className="h-8 ps-7 text-xs"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tr('status.all', 'All statuses')}</SelectItem>
                <SelectItem value="active">{tr('status.active', 'Active')}</SelectItem>
                <SelectItem value="queued">{tr('status.queued', 'Queued')}</SelectItem>
                <SelectItem value="running">{tr('status.running', 'Running')}</SelectItem>
                <SelectItem value="syncing">{tr('status.syncing', 'Syncing')}</SelectItem>
                <SelectItem value="failed">{tr('status.failed', 'Failed')}</SelectItem>
                <SelectItem value="paused">{tr('status.paused', 'Paused')}</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground ms-auto">{tr('countOf', '{{shown}} of {{total}}', { shown: String(filteredItems.length), total: String(items.length) })}</span>
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
                      <Badge variant={statusVariant}>{tr(`status.${s.status}`, s.status)}</Badge>
                      {jobStatus && jobStatus !== 'completed' && (
                        <Badge variant={jobStatus === 'failed' ? 'destructive' : 'outline'}>{tr('job', 'job: {{status}}', { status: jobStatus })}</Badge>
                      )}
                      {m.parser && <Badge variant="outline">{m.parser}</Badge>}
                      {m.page_count ? <Badge variant="outline">{tr('pages', '{{count}} pages', { count: String(m.page_count) })}</Badge> : null}
                      {m.storage_provider && <Badge variant="outline">{m.storage_provider}</Badge>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {fmtBytes(m.size_bytes)} · {tr('chunks', '{{count}} chunks', { count: String((s as any).chunks_created ?? 0) })} · {tr('embedded', '{{count}} embedded', { count: String((s as any).embedded_chunks ?? 0) })}
                      {s.last_synced_at ? ` · ${tr('indexedAt', 'indexed {{date}}', { date: new Date(s.last_synced_at).toLocaleString() })}` : ''}
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
                    <Button variant="ghost" size="icon" onClick={() => openPreview(s)} title={tr('preview', 'Preview')}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => openLogs(s)} title={tr('logs', 'Logs')}>
                      <ScrollText className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" disabled={busyId === s.id} onClick={() => reindex(s)} title={tr('reindex', 'Reindex')}>
                      {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" disabled={busyId === s.id} onClick={() => togglePause(s)} title={s.status === 'paused' ? tr('resume', 'Resume') : tr('pause', 'Pause')}>
                      {s.status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" disabled={busyId === s.id} onClick={() => remove(s)} title={tr('delete', 'Delete')}>
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
        <DialogContent className="max-w-2xl" dir={dir}>
          <DialogHeader>
            <DialogTitle>{tr('previewTitle', 'Preview · {{name}}', { name: previewData?.file_name || '…' })}</DialogTitle>
            <DialogDescription>
              {previewData ? (
                <>{tr('status.label', 'Status')}: {tr(`status.${previewData.status}`, previewData.status)}{previewData.parser ? ` · ${previewData.parser}` : ''}{previewData.page_count ? ` · ${tr('pages', '{{count}} pages', { count: String(previewData.page_count) })}` : ''}{previewData.text_length ? ` · ${tr('charsTotal', '{{count}} chars total', { count: String(previewData.text_length) })}` : ''}</>
              ) : tr('loading', 'Loading…')}
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
                <p className="text-xs text-muted-foreground">{tr('noPreview', 'No preview available.')}</p>
              )}
            </div>
          ) : <Loader2 className="h-5 w-5 animate-spin mx-auto" />}
        </DialogContent>
      </Dialog>

      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-w-2xl" dir={dir}>
          <DialogHeader>
            <DialogTitle>{tr('logsTitle', 'Ingestion logs')}</DialogTitle>
            <DialogDescription>{tr('logsSubtitle', 'Latest 100 events for this file.')}</DialogDescription>
          </DialogHeader>
          {logsData ? (
            <div className="space-y-3 max-h-[60vh] overflow-auto">
              {logsData.jobs.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-1.5">{tr('recentJobs', 'Recent jobs')}</h4>
                  <div className="space-y-1">
                    {logsData.jobs.map((j) => (
                      <div key={j.id} className="text-xs flex items-center gap-2">
                        <Badge variant={j.status === 'failed' ? 'destructive' : j.status === 'completed' ? 'default' : 'secondary'}>
                          {tr(`status.${j.status}`, j.status)}
                        </Badge>
                        <code className="text-[10px]">{j.id.slice(0, 8)}</code>
                        <span className="text-muted-foreground">{tr('attempts', 'attempts:{{n}}', { n: String(j.attempts) })}</span>
                        <span className="text-muted-foreground ms-auto">{new Date(j.created_at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1.5">{tr('events', 'Events')}</h4>
                <div className="space-y-1">
                  {logsData.items.map((l) => (
                    <div key={l.id} className="text-xs border-b border-border/40 pb-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{l.status}</Badge>
                        <span className="text-muted-foreground ms-auto">{new Date(l.created_at).toLocaleString()}</span>
                      </div>
                      {l.message && <p className="text-muted-foreground mt-0.5">{l.message}</p>}
                    </div>
                  ))}
                  {logsData.items.length === 0 && <p className="text-xs text-muted-foreground">{tr('noEvents', 'No events yet.')}</p>}
                </div>
              </div>
            </div>
          ) : <Loader2 className="h-5 w-5 animate-spin mx-auto" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
