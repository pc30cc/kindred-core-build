import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type TopicRecord, type TopicDetectionResult, type TopicAction } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Tags, Plus, Pencil, Trash2, Loader2, Beaker, Sparkles } from 'lucide-react';

const ACTIONS: { value: TopicAction; label: string }[] = [
  { value: 'label_only', label: 'Label only' },
  { value: 'route', label: 'Route conversation' },
  { value: 'trigger_workflow', label: 'Trigger workflow' },
  { value: 'suggest_reply', label: 'Suggest reply' },
];

export default function TopicDetectionPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<TopicRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TopicRecord | null>(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<TopicDetectionResult | null>(null);
  const [testing, setTesting] = useState(false);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try { setItems((await aiAgentApi.listTopics(wsId)).items || []); }
    catch (e: any) { toast({ title: 'Failed to load topics', description: e?.message, variant: 'destructive' }); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function toggle(t: TopicRecord) {
    try {
      await aiAgentApi.updateTopic(t.id, { enabled: !t.enabled });
      setItems((it) => it.map((x) => x.id === t.id ? { ...x, enabled: !t.enabled } : x));
    } catch (e: any) { toast({ title: 'Update failed', description: e?.message, variant: 'destructive' }); }
  }
  async function remove(t: TopicRecord) {
    if (!confirm(`Delete topic "${t.name}"?`)) return;
    try { await aiAgentApi.deleteTopic(t.id); setItems((it) => it.filter((x) => x.id !== t.id)); }
    catch (e: any) { toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' }); }
  }
  async function seed() {
    if (!wsId) return;
    try { const r = await aiAgentApi.seedDefaultTopics(wsId); toast({ title: `Added ${r.created} default topics` }); refresh(); }
    catch (e: any) { toast({ title: 'Seeding failed', description: e?.message, variant: 'destructive' }); }
  }
  async function runTest() {
    if (!wsId || !testText.trim()) return;
    setTesting(true); setTestResult(null);
    try { setTestResult(await aiAgentApi.testTopics({ workspaceId: wsId, text: testText })); }
    catch (e: any) { toast({ title: 'Test failed', description: e?.message, variant: 'destructive' }); }
    finally { setTesting(false); }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Tags className="h-5 w-5 text-primary" /> Topic detection
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Auto-classify visitor messages into topics for routing, workflows, and analytics.
            Detection runs locally with multilingual keyword + example matching — no LLM calls.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">v1 active</Badge>
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" /> Add topic
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6">
        <div className="space-y-3">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : items.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center space-y-4">
                <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                  <Tags className="h-7 w-7" />
                </div>
                <div>
                  <h2 className="text-lg font-medium">No topics yet</h2>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                    Start from a curated multilingual default set (Pricing, Sales, Support, Billing, …)
                    or create your own.
                  </p>
                </div>
                <div className="flex justify-center gap-2 pt-2">
                  <Button variant="outline" onClick={seed}>
                    <Sparkles className="h-4 w-4 mr-1.5" /> Add default topics
                  </Button>
                  <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
                    <Plus className="h-4 w-4 mr-1.5" /> New topic
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            items.map((t) => (
              <Card key={t.id} className={t.enabled ? '' : 'opacity-60'}>
                <CardContent className="p-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{t.name}</span>
                      <Badge variant="outline" className="text-[10px]">{t.slug}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{ACTIONS.find(a => a.value === t.action)?.label}</Badge>
                      {t.system && <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">default</Badge>}
                      <span className="text-[11px] text-muted-foreground">conf ≥ {Math.round((t.confidence_threshold ?? 0.65) * 100)}%</span>
                    </div>
                    {t.description && <p className="text-xs text-muted-foreground mt-1">{t.description}</p>}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(t.keywords || []).slice(0, 8).map((k) => (
                        <Badge key={k} variant="outline" className="text-[10px]">{k}</Badge>
                      ))}
                      {(t.keywords || []).length > 8 && (
                        <span className="text-[11px] text-muted-foreground">+{(t.keywords || []).length - 8} more</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={t.enabled} onCheckedChange={() => toggle(t)} />
                    <Button variant="ghost" size="icon" onClick={() => { setEditing(t); setDialogOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(t)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit sticky top-4">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Beaker className="h-4 w-4 text-primary" /> Test detection
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea rows={4} value={testText} onChange={(e) => setTestText(e.target.value)}
              placeholder='Try: "قیمت پلن چنده؟", "fiyat nedir", "talk to a human"' />
            <Button onClick={runTest} disabled={testing || !testText.trim()} className="w-full">
              {testing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Beaker className="h-4 w-4 mr-1.5" />}
              Detect topics
            </Button>
            {testResult && (
              <div className="space-y-2 pt-2 border-t">
                <p className="text-[11px] text-muted-foreground">Language: <span className="font-mono">{testResult.language}</span></p>
                {testResult.detectedTopics.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{testResult.explanation}</p>
                ) : testResult.detectedTopics.map((d) => (
                  <div key={d.id} className="rounded border p-2 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{d.name}</span>
                      <Badge variant="secondary" className="text-[10px]">{Math.round(d.confidence * 100)}%</Badge>
                    </div>
                    <div className="text-[11px] text-muted-foreground">action: {d.action}</div>
                    {d.matchedKeywords.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {d.matchedKeywords.slice(0, 6).map((k) => <Badge key={k} variant="outline" className="text-[10px]">{k}</Badge>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <TopicDialog
        open={dialogOpen} onOpenChange={setDialogOpen}
        editing={editing} workspaceId={wsId}
        onSaved={() => { setDialogOpen(false); refresh(); }} />
    </div>
  );
}

function TopicDialog({ open, onOpenChange, editing, workspaceId, onSaved }: {
  open: boolean; onOpenChange: (b: boolean) => void;
  editing: TopicRecord | null; workspaceId: string; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: '', description: '', keywords: '', examples: '',
    confidence_threshold: 0.65, action: 'label_only' as TopicAction, enabled: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name,
        description: editing.description || '',
        keywords: (editing.keywords || []).join(', '),
        examples: (editing.examples || []).join('\n'),
        confidence_threshold: editing.confidence_threshold ?? 0.65,
        action: editing.action,
        enabled: editing.enabled,
      });
    } else {
      setForm({ name: '', description: '', keywords: '', examples: '', confidence_threshold: 0.65, action: 'label_only', enabled: true });
    }
  }, [editing, open]);

  async function save() {
    if (!form.name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        keywords: form.keywords.split(',').map((s) => s.trim()).filter(Boolean),
        examples: form.examples.split('\n').map((s) => s.trim()).filter(Boolean),
        confidence_threshold: Number(form.confidence_threshold),
        action: form.action,
        enabled: form.enabled,
      };
      if (editing) await aiAgentApi.updateTopic(editing.id, payload as any);
      else await aiAgentApi.createTopic({ workspaceId, ...payload });
      onSaved();
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'destructive' }); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{editing ? 'Edit topic' : 'New topic'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Pricing" />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label>Keywords</Label>
            <Textarea rows={3} value={form.keywords} onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
              placeholder="comma-separated, multilingual: price, fiyat, قیمت" />
          </div>
          <div className="space-y-1.5">
            <Label>Example phrases</Label>
            <Textarea rows={3} value={form.examples} onChange={(e) => setForm((f) => ({ ...f, examples: e.target.value }))}
              placeholder="one per line" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Action</Label>
              <Select value={form.action} onValueChange={(v) => setForm((f) => ({ ...f, action: v as TopicAction }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ACTIONS.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Confidence threshold</Label>
              <Input type="number" min={0} max={1} step={0.05} value={form.confidence_threshold}
                onChange={(e) => setForm((f) => ({ ...f, confidence_threshold: parseFloat(e.target.value) || 0 }))} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.enabled} onCheckedChange={(b) => setForm((f) => ({ ...f, enabled: b }))} />
            <span className="text-sm">Enabled</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editing ? 'Save changes' : 'Create topic'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}