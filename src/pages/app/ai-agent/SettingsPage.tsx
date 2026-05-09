import { useState, useEffect, useRef } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Sparkles, Bot, Loader2, Upload, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

export default function AiAgentSettingsPage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useAiAgentSettings(workspace?.id);
  const update = useUpdateAiAgentSettings(workspace?.id);
  const [form, setForm] = useState<any>(null);
  const [generating, setGenerating] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (data?.settings) setForm(data.settings); }, [data]);

  if (isLoading || !form) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const set = (patch: any) => setForm({ ...form, ...patch });

  const onSave = async () => {
    try {
      await update.mutateAsync({
        agent_name: form.agent_name,
        agent_logo_url: form.agent_logo_url,
        business_description: form.business_description,
        answer_guidance: form.answer_guidance,
        welcome_message: form.welcome_message,
        fallback_message: form.fallback_message,
        answer_only_from_kb: form.answer_only_from_kb,
        allowed_locales: form.allowed_locales,
        show_sources_to_operator: form.show_sources_to_operator,
      });
      toast.success('Settings saved');
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    }
  };

  const onGenerate = async () => {
    if (!workspace?.id) return;
    setGenerating(true);
    try {
      const r = await aiAgentApi.generateBusinessDescription(workspace.id);
      set({ business_description: r.description });
      toast.success(r.source === 'ai' ? 'Generated' : 'Generated (offline stub)');
    } catch (e: any) {
      toast.error(e?.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const onPickAvatar = () => fileInputRef.current?.click();

  const onAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !workspace?.id) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      toast.error('Only PNG, JPG, WebP or GIF images are supported');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image is too large (max 5 MB)');
      return;
    }
    setUploadingAvatar(true);
    try {
      const r = await aiAgentApi.uploadAvatar(workspace.id, file);
      set({ agent_logo_url: r.avatar_url });
      toast.success('Avatar updated');
    } catch (err: any) {
      toast.error(err?.message || 'Upload failed');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const onRemoveAvatar = async () => {
    if (!workspace?.id) return;
    setUploadingAvatar(true);
    try {
      await aiAgentApi.removeAvatar(workspace.id);
      set({ agent_logo_url: null });
      toast.success('Avatar removed');
    } catch (err: any) {
      toast.error(err?.message || 'Remove failed');
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure how the AI agent presents itself and answers visitors.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">Identity</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Avatar</Label>
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden border">
                    {form.agent_logo_url
                      ? <img src={form.agent_logo_url} alt="" className="h-full w-full object-cover" />
                      : <Bot className="h-7 w-7 text-primary" />}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={onPickAvatar} disabled={uploadingAvatar}>
                      {uploadingAvatar ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <Upload className="h-3.5 w-3.5 me-1.5" />}
                      {form.agent_logo_url ? 'Change' : 'Upload'}
                    </Button>
                    {form.agent_logo_url && (
                      <Button size="sm" variant="ghost" onClick={onRemoveAvatar} disabled={uploadingAvatar}>
                        <Trash2 className="h-3.5 w-3.5 me-1.5" /> Remove
                      </Button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={onAvatarSelected}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">PNG, JPG, WebP or GIF. Max 5 MB.</p>
              </div>
              <div>
                <Label>Agent name</Label>
                <Input value={form.agent_name} onChange={(e) => set({ agent_name: e.target.value })} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Business description</CardTitle>
                <Button size="sm" variant="outline" onClick={onGenerate} disabled={generating}>
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  <span className="ms-1.5">Generate with AI</span>
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={6}
                maxLength={2000}
                placeholder="Describe what your business does and how it helps customers."
                value={form.business_description || ''}
                onChange={(e) => set({ business_description: e.target.value })}
              />
              <p className="text-xs text-muted-foreground mt-2">{(form.business_description?.length || 0)}/2000</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Answer behavior</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Answer guidance</Label>
                <Select value={form.answer_guidance} onValueChange={(v) => set({ answer_guidance: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="conservative">Conservative — only when sources are clear</SelectItem>
                    <SelectItem value="balanced">Balanced — answer when likely enough</SelectItem>
                    <SelectItem value="creative">Creative — more flexible</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Answer only from Knowledge Base</p>
                  <p className="text-xs text-muted-foreground">Recommended. Hands off when no match is found.</p>
                </div>
                <Switch checked={form.answer_only_from_kb} onCheckedChange={(v) => set({ answer_only_from_kb: v })} />
              </div>
              <div>
                <Label>Welcome message</Label>
                <Input value={form.welcome_message || ''} onChange={(e) => set({ welcome_message: e.target.value || null })} placeholder="Hi! How can I help?" />
              </div>
              <div>
                <Label>Fallback message</Label>
                <Input value={form.fallback_message} onChange={(e) => set({ fallback_message: e.target.value })} />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={onSave} disabled={update.isPending}>
              {update.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" />}
              Save changes
            </Button>
          </div>
        </div>

        <div>
          <Card className="sticky top-6 bg-gradient-to-br from-primary/5 to-primary/0 border-primary/20">
            <CardHeader><CardTitle className="text-base">Live preview</CardTitle></CardHeader>
            <CardContent>
              <div className="rounded-xl bg-background border border-border/60 shadow-sm p-4 space-y-3">
                <div className="flex items-center gap-2.5 pb-3 border-b">
                  <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                    {form.agent_logo_url ? <img src={form.agent_logo_url} alt="" className="h-full w-full object-cover" /> : <Bot className="h-4 w-4 text-primary" />}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{form.agent_name}</p>
                    <p className="text-[11px] text-success">● Online</p>
                  </div>
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-sm px-3 py-2 text-sm max-w-[85%]">
                  {form.welcome_message || `Hi! I'm ${form.agent_name}. How can I help today?`}
                </div>
                <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-3 py-2 text-sm max-w-[85%] ms-auto">
                  How do I get started?
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-sm px-3 py-2 text-sm max-w-[85%]">
                  Sure — let me check our knowledge base for you.
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}