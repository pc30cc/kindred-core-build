import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
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

const ACTION_VALUES: TopicAction[] = ['label_only', 'route', 'trigger_workflow', 'suggest_reply'];

/** The topic detector (server/services/ai-agent/topics/detector.ts) always
 * explains its result in English, regardless of workspace locale. Map the
 * two fixed strings it can return to the localized equivalent; anything
 * else (future variants) is shown as-is. */
function localizeExplanation(explanation: string, t: (k: any, p?: any) => string): string {
  if (explanation === 'No topic matched the visitor message above its confidence threshold.') {
    return t('aiAgent.topics.test.noMatch');
  }
  const m = explanation.match(/^Matched (\d+) topic\(s\) deterministically using keyword \+ example signals \(no LLM\)\.$/);
  if (m) return t('aiAgent.topics.test.matched', { count: m[1] });
  return explanation;
}

export default function TopicDetectionPage() {
  const { t } = useTranslation();
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<TopicRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TopicRecord | null>(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<TopicDetectionResult | null>(null);
  const [testing, setTesting] = useState(false);

  const ACTIONS: { value: TopicAction; label: string }[] = ACTION_VALUES.map((value) => ({
    value, label: t(`aiAgent.topics.actions.${value}` as any),
  }));

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try { setItems((await aiAgentApi.listTopics(wsId)).items || []); }
    catch (e: any) { toast({ title: t('aiAgent.topics.toast.loadFailed'), description: e?.message, variant: 'destructive' }); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function toggle(t2: TopicRecord) {
    try {
      await aiAgentApi.updateTopic(t2.id, { enabled: !t2.enabled });
      setItems((it) => it.map((x) => x.id === t2.id ? { ...x, enabled: !t2.enabled } : x));
    } catch (e: any) { toast({ title: t('aiAgent.topics.toast.updateFailed'), description: e?.message, variant: 'destructive' }); }
  }
  async function remove(t2: TopicRecord) {
    if (!confirm(t('aiAgent.topics.confirmDelete', { name: t2.name }))) return;
    try { await aiAgentApi.deleteTopic(t2.id); setItems((it) => it.filter((x) => x.id !== t2.id)); }
    catch (e: any) { toast({ title: t('aiAgent.topics.toast.deleteFailed'), description: e?.message, variant: 'destructive' }); }
  }
  async function seed() {
    if (!wsId) return;
    try { const r = await aiAgentApi.seedDefaultTopics(wsId); toast({ title: t('aiAgent.topics.toast.seeded', { count: r.created }) }); refresh(); }
    catch (e: any) { toast({ title: t('aiAgent.topics.toast.seedFailed'), description: e?.message, variant: 'destructive' }); }
  }
  async function runTest() {
    if (!wsId || !testText.trim()) return;
    setTesting(true); setTestResult(null);
    try { setTestResult(await aiAgentApi.testTopics({ workspaceId: wsId, text: testText })); }
    catch (e: any) { toast({ title: t('aiAgent.topics.toast.testFailed'), description: e?.message, variant: 'destructive' }); }
    finally { setTesting(false); }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Tags className="h-5 w-5 text-primary" /> {t('aiAgent.topics.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            {t('aiAgent.topics.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">{t('aiAgent.topics.badgeActive')}</Badge>
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" /> {t('aiAgent.topics.addTopic')}
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
                  <h2 className="text-lg font-medium">{t('aiAgent.topics.empty.title')}</h2>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                    {t('aiAgent.topics.empty.description')}
                  </p>
                </div>
                <div className="flex justify-center gap-2 pt-2">
                  <Button variant="outline" onClick={seed}>
                    <Sparkles className="h-4 w-4 mr-1.5" /> {t('aiAgent.topics.empty.addDefault')}
                  </Button>
                  <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
                    <Plus className="h-4 w-4 mr-1.5" /> {t('aiAgent.topics.empty.newTopic')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            items.map((topic) => (
              <Card key={topic.id} className={topic.enabled ? '' : 'opacity-60'}>
                <CardContent className="p-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{topic.name}</span>
                      <Badge variant="outline" className="text-[10px]">{topic.slug}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{ACTIONS.find(a => a.value === topic.action)?.label}</Badge>
                      {topic.system && <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">{t('aiAgent.topics.card.default')}</Badge>}
                      <span className="text-[11px] text-muted-foreground">{t('aiAgent.topics.card.confidenceMin', { pct: Math.round((topic.confidence_threshold ?? 0.65) * 100) })}</span>
                    </div>
                    {topic.description && <p className="text-xs text-muted-foreground mt-1">{topic.description}</p>}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(topic.keywords || []).slice(0, 8).map((k) => (
                        <Badge key={k} variant="outline" className="text-[10px]">{k}</Badge>
                      ))}
                      {(topic.keywords || []).length > 8 && (
                        <span className="text-[11px] text-muted-foreground">{t('aiAgent.topics.card.moreKeywords', { count: (topic.keywords || []).length - 8 })}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={topic.enabled} onCheckedChange={() => toggle(topic)} />
                    <Button variant="ghost" size="icon" onClick={() => { setEditing(topic); setDialogOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(topic)}>
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
              <Beaker className="h-4 w-4 text-primary" /> {t('aiAgent.topics.test.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea rows={4} value={testText} onChange={(e) => setTestText(e.target.value)}
              placeholder={t('aiAgent.topics.test.placeholder')} />
            <Button onClick={runTest} disabled={testing || !testText.trim()} className="w-full">
              {testing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Beaker className="h-4 w-4 mr-1.5" />}
              {t('aiAgent.topics.test.button')}
            </Button>
            {testResult && (
              <div className="space-y-2 pt-2 border-t">
                <p className="text-[11px] text-muted-foreground">{t('aiAgent.topics.test.language', { lang: testResult.language })}</p>
                {testResult.detectedTopics.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{localizeExplanation(testResult.explanation, t)}</p>
                ) : testResult.detectedTopics.map((d) => (
                  <div key={d.id} className="rounded border p-2 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{d.name}</span>
                      <Badge variant="secondary" className="text-[10px]">{Math.round(d.confidence * 100)}%</Badge>
                    </div>
                    <div className="text-[11px] text-muted-foreground">{t('aiAgent.topics.test.actionLabel', { action: d.action })}</div>
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
  const { t } = useTranslation();
  const ACTIONS: { value: TopicAction; label: string }[] = ACTION_VALUES.map((value) => ({
    value, label: t(`aiAgent.topics.actions.${value}` as any),
  }));
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
    if (!form.name.trim()) { toast({ title: t('aiAgent.topics.toast.nameRequired'), variant: 'destructive' }); return; }
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
    } catch (e: any) { toast({ title: t('aiAgent.topics.toast.saveFailed'), description: e?.message, variant: 'destructive' }); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{editing ? t('aiAgent.topics.dialog.editTitle') : t('aiAgent.topics.dialog.newTitle')}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('aiAgent.topics.dialog.name')}</Label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('aiAgent.topics.dialog.namePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('aiAgent.topics.dialog.description')}</Label>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder={t('aiAgent.topics.dialog.descriptionPlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('aiAgent.topics.dialog.keywords')}</Label>
            <Textarea rows={3} value={form.keywords} onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
              placeholder={t('aiAgent.topics.dialog.keywordsPlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('aiAgent.topics.dialog.examples')}</Label>
            <Textarea rows={3} value={form.examples} onChange={(e) => setForm((f) => ({ ...f, examples: e.target.value }))}
              placeholder={t('aiAgent.topics.dialog.examplesPlaceholder')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t('aiAgent.topics.dialog.action')}</Label>
              <Select value={form.action} onValueChange={(v) => setForm((f) => ({ ...f, action: v as TopicAction }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ACTIONS.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('aiAgent.topics.dialog.confidenceThreshold')}</Label>
              <Input type="number" min={0} max={1} step={0.05} value={form.confidence_threshold}
                onChange={(e) => setForm((f) => ({ ...f, confidence_threshold: parseFloat(e.target.value) || 0 }))} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.enabled} onCheckedChange={(b) => setForm((f) => ({ ...f, enabled: b }))} />
            <span className="text-sm">{t('aiAgent.topics.dialog.enabled')}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('aiAgent.topics.dialog.cancel')}</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editing ? t('aiAgent.topics.dialog.saveChanges') : t('aiAgent.topics.dialog.createTopic')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}