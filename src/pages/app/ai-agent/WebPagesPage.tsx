import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type DataSource, type SourceSyncLog } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Globe, Plus, RefreshCw, Trash2, Loader2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';

export default function WebPagesPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<DataSource[]>([]);
  const [domains, setDomains] = useState<Array<{ domain: string; is_primary: boolean; verified: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, SourceSyncLog[]>>({});

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const [srcs, dom] = await Promise.all([
        aiAgentApi.listDataSources(wsId, 'website'),
        aiAgentApi.getWorkspaceDomains(wsId),
      ]);
      setItems(srcs.items || []);
      setDomains(dom.domains || []);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function expand(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!logs[id]) {
      try {
        const r = await aiAgentApi.getDataSourceLogs(id);
        setLogs((l) => ({ ...l, [id]: r.items || [] }));
      } catch { /* swallow */ }
    }
  }

  async function sync(s: DataSource) {
    try { await aiAgentApi.syncDataSource(s.id); toast({ title: 'Sync queued' }); refresh();
    } catch (e: any) { toast({ title: 'Sync failed', description: e?.message, variant: 'destructive' }); }
  }
  async function remove(s: DataSource) {
    if (!confirm(`Delete website source "${s.name}"?`)) return;
    try { await aiAgentApi.deleteDataSource(s.id); refresh(); }
    catch (e: any) { toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' }); }
  }

  if (!wsId) return null;

  const primaryDomain = domains[0]?.domain || null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Globe className="h-5 w-5 text-primary" /> Web pages
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Crawl pages from your registered website and use them as AI knowledge.
            Cross-domain crawling is disabled for safety.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!primaryDomain}>
          <Plus className="h-4 w-4 mr-1.5" /> Add website source
        </Button>
      </div>

      {!primaryDomain && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">No registered workspace domain</p>
              <p className="text-muted-foreground mt-1">
                Add a domain in workspace settings before adding website sources. The AI will only crawl
                pages under your registered domain.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {primaryDomain && (
        <p className="text-xs text-muted-foreground">
          Registered domain: <span className="font-mono text-foreground">{primaryDomain}</span>
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Globe className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-medium">No website sources yet</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Add your registered domain to let the AI learn from your public pages — pricing, features, FAQs.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((s) => (
            <Card key={s.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <button onClick={() => expand(s.id)} className="text-muted-foreground hover:text-foreground mt-1">
                    {expanded === s.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{s.name}</span>
                      <StatusBadge status={s.status} />
                      <Badge variant="outline" className="text-[10px]">{s.refresh_interval}</Badge>
                    </div>
                    {s.base_url && (
                      <a href={s.base_url} target="_blank" rel="noreferrer"
                         className="text-xs text-muted-foreground hover:text-foreground font-mono break-all">
                        {s.base_url}
                      </a>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-1.5 flex gap-3 flex-wrap">
                      <span>depth {s.crawl_depth}</span>
                      <span>max {s.max_pages} pages</span>
                      <span>{s.last_synced_at ? `last synced ${new Date(s.last_synced_at).toLocaleString()}` : 'never synced'}</span>
                    </div>
                    {s.last_error && (
                      <p className="text-xs text-destructive mt-1">⚠ {s.last_error}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => sync(s)} disabled={s.status === 'syncing'}>
                      <RefreshCw className={`h-4 w-4 ${s.status === 'syncing' ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(s)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                {expanded === s.id && (
                  <div className="mt-4 ml-7 border-t pt-3">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Recent sync logs</p>
                    {(logs[s.id] || []).length === 0 ? (
                      <p className="text-xs text-muted-foreground">No logs yet.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {(logs[s.id] || []).map((l) => (
                          <div key={l.id} className="text-xs flex gap-3 items-start">
                            <Badge variant="outline" className="text-[10px]">{l.status}</Badge>
                            <span className="text-muted-foreground tabular-nums">
                              {new Date(l.created_at).toLocaleString()}
                            </span>
                            <span className="flex-1">{l.message || ''}</span>
                            {l.pages_found > 0 && <span className="text-muted-foreground">pages {l.pages_found}</span>}
                            {l.chunks_created > 0 && <span className="text-muted-foreground">chunks {l.chunks_created}</span>}
                            {l.errors > 0 && <span className="text-destructive">errors {l.errors}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <NewWebsiteDialog open={open} onOpenChange={setOpen} workspaceId={wsId}
        registeredDomain={primaryDomain} onCreated={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function StatusBadge({ status }: { status: DataSource['status'] }) {
  const cls = status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
    : status === 'syncing' ? 'bg-primary/10 text-primary border-primary/20'
    : status === 'failed' ? 'bg-destructive/10 text-destructive border-destructive/20'
    : status === 'paused' ? 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground';
  return <Badge variant="outline" className={`text-[10px] ${cls}`}>{status}</Badge>;
}

function NewWebsiteDialog({
  open, onOpenChange, workspaceId, registeredDomain, onCreated,
}: {
  open: boolean; onOpenChange: (b: boolean) => void; workspaceId: string;
  registeredDomain: string | null; onCreated: () => void;
}) {
  const [form, setForm] = useState({
    base_url: '', crawl_depth: 2, max_pages: 50,
    refresh_interval: 'manual' as 'manual' | 'daily' | 'weekly' | 'monthly',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (registeredDomain) {
      const clean = registeredDomain.replace(/^https?:\/\//, '');
      setForm((f) => ({ ...f, base_url: `https://${clean}` }));
    }
  }, [registeredDomain, open]);

  async function save() {
    setSaving(true);
    try {
      await aiAgentApi.createWebsiteSource({ workspaceId, ...form });
      onCreated();
    } catch (e: any) {
      toast({ title: 'Could not add source', description: e?.message, variant: 'destructive' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add website source</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Base URL</Label>
            <Input value={form.base_url} onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
              placeholder="https://yourdomain.com" />
            <p className="text-[11px] text-muted-foreground">
              Must be under the registered workspace domain
              {registeredDomain ? `: ${registeredDomain}` : ''}.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Crawl depth</Label>
              <Input type="number" min={1} max={5} value={form.crawl_depth}
                onChange={(e) => setForm((f) => ({ ...f, crawl_depth: parseInt(e.target.value || '2', 10) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Max pages</Label>
              <Input type="number" min={1} max={500} value={form.max_pages}
                onChange={(e) => setForm((f) => ({ ...f, max_pages: parseInt(e.target.value || '50', 10) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Refresh</Label>
              <Select value={form.refresh_interval} onValueChange={(v) => setForm((f) => ({ ...f, refresh_interval: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Add source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}