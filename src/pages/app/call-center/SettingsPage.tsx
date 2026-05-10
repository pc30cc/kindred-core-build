import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterSettings, useUpdateCallCenterSettings } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEffect, useState, useRef } from 'react';
import { toast } from '@/hooks/use-toast';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';

export default function CallCenterSettingsPage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useCallCenterSettings(workspace?.id);
  const update = useUpdateCallCenterSettings(workspace?.id);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [s, setS] = useState<any>(null);

  useEffect(() => { if (data?.settings) setS({ ...data.settings }); }, [data?.settings]);
  if (isLoading || !s) return <p className="text-sm text-muted-foreground">Loading…</p>;

  async function save() {
    if (!workspace) return;
    await update.mutateAsync({
      enabled: s.enabled, display_name: s.display_name,
      voice_enabled: s.voice_enabled, video_enabled: s.video_enabled,
      callback_enabled: s.callback_enabled, pre_call_form_enabled: s.pre_call_form_enabled,
      offline_behavior: s.offline_behavior, recording_enabled: s.recording_enabled,
      recording_consent_required: s.recording_consent_required, routing_mode: s.routing_mode,
      widget_position: s.widget_position, business_hours: s.business_hours,
    });
    toast({ title: 'Saved' });
  }

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !workspace) return;
    if (f.size > 2 * 1024 * 1024) { toast({ title: 'Max 2MB', variant: 'destructive' }); return; }
    try {
      const r = await callCenterApi.uploadAvatar(workspace.id, f);
      toast({ title: 'Avatar uploaded' });
      setS((p: any) => ({ ...p, avatar_url: r.avatar_url, avatar_storage_path: r.avatar_storage_path }));
      qc.invalidateQueries({ queryKey: ['call-center', 'settings'] });
    } catch (err: any) {
      toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Card className="p-5 space-y-4">
        <h2 className="font-semibold">General</h2>
        <div className="flex items-center justify-between">
          <div><Label>Enabled</Label><p className="text-xs text-muted-foreground">Turn the standalone Call Center on/off.</p></div>
          <Switch checked={!!s.enabled} onCheckedChange={(v) => setS({ ...s, enabled: v })} />
        </div>
        <div>
          <Label>Display name</Label>
          <Input value={s.display_name || ''} onChange={(e) => setS({ ...s, display_name: e.target.value })} placeholder="Support" />
        </div>
        <div className="flex items-center gap-3">
          {s.avatar_url && <img src={s.avatar_url} alt="" className="h-12 w-12 rounded-full object-cover border" />}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onAvatar} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>Upload avatar</Button>
          <span className="text-xs text-muted-foreground">PNG/JPEG/WebP, max 2MB</span>
        </div>
        <div>
          <Label>Widget position</Label>
          <Select value={s.widget_position || 'right'} onValueChange={(v) => setS({ ...s, widget_position: v })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="right">Right</SelectItem>
              <SelectItem value="left">Left</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Channels</h2>
        {[
          ['voice_enabled', 'Voice calls'],
          ['video_enabled', 'Video calls'],
          ['callback_enabled', 'Callback requests'],
          ['pre_call_form_enabled', 'Show pre-call form'],
        ].map(([k, label]) => (
          <div key={k} className="flex items-center justify-between">
            <Label>{label}</Label>
            <Switch checked={!!s[k as string]} onCheckedChange={(v) => setS({ ...s, [k as string]: v })} />
          </div>
        ))}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Offline behavior</h2>
        <Select value={s.offline_behavior || 'show_callback'} onValueChange={(v) => setS({ ...s, offline_behavior: v })}>
          <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hide">Hide widget</SelectItem>
            <SelectItem value="show_callback">Show callback request</SelectItem>
            <SelectItem value="show_message">Show offline message</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Business hours editor coming soon.</p>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Recording</h2>
        <div className="flex gap-2 items-start text-xs p-3 rounded bg-warning/10 border border-warning/30">
          <AlertCircle className="h-4 w-4 text-warning mt-0.5" />
          <span>Recording provider is not implemented yet. These toggles configure intent only.</span>
        </div>
        <div className="flex items-center justify-between">
          <Label>Recording enabled</Label>
          <Switch checked={!!s.recording_enabled} onCheckedChange={(v) => setS({ ...s, recording_enabled: v })} />
        </div>
        <div className="flex items-center justify-between">
          <Label>Recording consent required</Label>
          <Switch checked={!!s.recording_consent_required} onCheckedChange={(v) => setS({ ...s, recording_consent_required: v })} />
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Routing</h2>
        <Select value={s.routing_mode || 'round_robin'} onValueChange={(v) => setS({ ...s, routing_mode: v })}>
          <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="round_robin">Round robin</SelectItem>
            <SelectItem value="broadcast">Broadcast to all available</SelectItem>
            <SelectItem value="least_busy">Least busy</SelectItem>
          </SelectContent>
        </Select>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={update.isPending}>Save changes</Button>
      </div>
    </div>
  );
}
