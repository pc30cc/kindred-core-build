import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterSettings, useUpdateCallCenterSettings } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useEffect, useMemo, useState, useRef } from 'react';
import { toast } from '@/hooks/use-toast';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, RotateCcw, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCallCenterDepartments } from '@/hooks/useCallCenter';
import { Link, useParams } from 'react-router-dom';

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 space-y-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {children}
    </Card>
  );
}

function Row({ label, hint, locked, children }: { label: string; hint?: string; locked?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <Label>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {locked && <p className="text-xs text-amber-600 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{locked}</p>}
      </div>
      <div className={cn(locked && 'opacity-50 pointer-events-none')}>{children}</div>
    </div>
  );
}

export default function CallCenterSettingsPage() {
  const { workspace } = useActiveWorkspace();
  const { slug } = useParams();
  const { data, isLoading } = useCallCenterSettings(workspace?.id);
  const update = useUpdateCallCenterSettings(workspace?.id);
  const { data: deptsData } = useCallCenterDepartments(workspace?.id);
  const departments = deptsData?.departments || [];
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [s, setS] = useState<any>(null);
  const [original, setOriginal] = useState<any>(null);

  useEffect(() => {
    if (data?.settings) {
      setS({ ...data.settings });
      setOriginal({ ...data.settings });
    }
  }, [data?.settings]);

  const dirty = useMemo(() => {
    if (!s || !original) return false;
    const keys: string[] = [
      'enabled', 'display_name', 'voice_enabled', 'video_enabled', 'callback_enabled',
      'pre_call_form_enabled', 'offline_behavior', 'recording_enabled',
      'recording_consent_required', 'routing_mode', 'widget_position',
      'default_department_id',
    ];
    return keys.some((k) => JSON.stringify(s[k]) !== JSON.stringify(original[k]));
  }, [s, original]);

  if (isLoading || !s) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const platform = data?.platform;
  const platformOff = !platform?.call_center_enabled;
  const platformVoice = platform?.voice_calls_enabled !== false;
  const platformVideo = platform?.video_calls_enabled !== false;
  const platformCallback = platform?.callback_requests_enabled !== false;
  const platformRecording = platform?.call_recording_enabled !== false;

  async function save() {
    if (!workspace) return;
    await update.mutateAsync({
      enabled: s.enabled, display_name: s.display_name,
      voice_enabled: s.voice_enabled, video_enabled: s.video_enabled,
      callback_enabled: s.callback_enabled, pre_call_form_enabled: s.pre_call_form_enabled,
      offline_behavior: s.offline_behavior, recording_enabled: s.recording_enabled,
      recording_consent_required: s.recording_consent_required, routing_mode: s.routing_mode,
      widget_position: s.widget_position, business_hours: s.business_hours,
      default_department_id: s.default_department_id ?? null,
    });
    setOriginal({ ...s });
    toast({ title: 'Saved' });
  }
  function reset() { setS({ ...original }); }

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !workspace) return;
    if (f.size > 2 * 1024 * 1024) { toast({ title: 'Max 2MB', variant: 'destructive' }); return; }
    try {
      const r = await callCenterApi.uploadAvatar(workspace.id, f);
      toast({ title: 'Avatar uploaded' });
      setS((p: any) => ({ ...p, avatar_url: r.avatar_url }));
      setOriginal((p: any) => ({ ...p, avatar_url: r.avatar_url }));
      qc.invalidateQueries({ queryKey: ['call-center', 'settings'] });
    } catch (err: any) {
      toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-6 max-w-3xl pb-24">
      {platformOff && (
        <Card className="p-4 border-destructive/40 bg-destructive/5 flex gap-2 items-start">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
          <div className="text-sm">Call Center is currently disabled by the platform. Workspace settings are read-only-effective until re-enabled.</div>
        </Card>
      )}

      <Section title="Status & availability" description="Toggle the entire Call Center module for your workspace.">
        <Row label="Workspace enabled" hint="Turn the standalone Call Center on/off for this workspace.">
          <Switch checked={!!s.enabled} onCheckedChange={(v) => setS({ ...s, enabled: v })} />
        </Row>
      </Section>

      <Section title="Identity & branding" description="How your call widget appears to visitors.">
        <Row label="Display name">
          <Input value={s.display_name || ''} onChange={(e) => setS({ ...s, display_name: e.target.value })} placeholder="Support" className="w-60" />
        </Row>
        <div className="flex items-center gap-3">
          {s.avatar_url
            ? <img src={s.avatar_url} alt="" className="h-12 w-12 rounded-full object-cover border" />
            : <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs">No avatar</div>}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onAvatar} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>Upload</Button>
          <span className="text-xs text-muted-foreground">PNG/JPEG/WebP, max 2MB</span>
        </div>
        <Row label="Widget position">
          <Select value={s.widget_position || 'right'} onValueChange={(v) => setS({ ...s, widget_position: v })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="right">Right</SelectItem>
              <SelectItem value="left">Left</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section title="Call modes" description="Choose which channels visitors can use.">
        <Row label="Voice calls" locked={!platformVoice ? 'Disabled by platform' : undefined}>
          <Switch checked={!!s.voice_enabled} onCheckedChange={(v) => setS({ ...s, voice_enabled: v })} disabled={!platformVoice} />
        </Row>
        <Row label="Video calls" locked={!platformVideo ? 'Disabled by platform' : undefined}>
          <Switch checked={!!s.video_enabled} onCheckedChange={(v) => setS({ ...s, video_enabled: v })} disabled={!platformVideo} />
        </Row>
        <Row label="Callback requests" locked={!platformCallback ? 'Disabled by platform' : undefined}>
          <Switch checked={!!s.callback_enabled} onCheckedChange={(v) => setS({ ...s, callback_enabled: v })} disabled={!platformCallback} />
        </Row>
        <Row label="Pre-call form" hint="Ask visitors for name/email/subject before connecting.">
          <Switch checked={!!s.pre_call_form_enabled} onCheckedChange={(v) => setS({ ...s, pre_call_form_enabled: v })} />
        </Row>
      </Section>

      <Section title="Pre-call form" description="Default fields shown before a call (name, email, phone, subject).">
        <p className="text-xs text-muted-foreground">Advanced form builder — coming later.</p>
      </Section>

      <Section title="Availability & offline" description="What happens when no agent is available.">
        <Row label="Offline behavior">
          <Select value={s.offline_behavior || 'show_callback'} onValueChange={(v) => setS({ ...s, offline_behavior: v })}>
            <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="hide">Hide widget</SelectItem>
              <SelectItem value="show_callback">Show callback request</SelectItem>
              <SelectItem value="show_message">Show offline message</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-3 w-3" /> Advanced (business hours JSON)
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="bg-muted p-2 rounded text-xs mt-2 overflow-x-auto">{JSON.stringify(s.business_hours || {}, null, 2)}</pre>
            <p className="text-xs text-muted-foreground mt-1">Editor coming soon.</p>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      <Section title="Routing" description="How incoming calls are distributed across available agents.">
        <Row label="Routing mode">
          <Select value={s.routing_mode || 'broadcast'} onValueChange={(v) => setS({ ...s, routing_mode: v })}>
            <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="broadcast">Broadcast — ring all available</SelectItem>
              <SelectItem value="round_robin">Round robin — planned</SelectItem>
              <SelectItem value="least_busy">Least busy — planned</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section title="Recording" description="Configuration only — recording provider not implemented yet.">
        <div className="flex gap-2 items-start text-xs p-3 rounded bg-amber-500/10 border border-amber-500/30">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
          <span>
            Recording depends on provider support. Do not rely on recording until provider status below is Ready.
            {(data as any)?.recording?.reason && (
              <> Provider status: <span className="font-mono">{(data as any).recording.reason}</span>.</>
            )}
          </span>
        </div>
        <Row label="Recording enabled" locked={!platformRecording ? 'Disabled by platform' : undefined}>
          <Switch checked={!!s.recording_enabled} onCheckedChange={(v) => setS({ ...s, recording_enabled: v })} disabled={!platformRecording} />
        </Row>
        <Row label="Consent required">
          <Switch checked={!!s.recording_consent_required} onCheckedChange={(v) => setS({ ...s, recording_consent_required: v })} />
        </Row>
        <div className="text-xs text-muted-foreground">
          Provider supported: {(data as any)?.recording?.provider_supported ? 'yes' : 'no'} ·
          Provider configured: {(data as any)?.recording?.provider_configured ? 'yes' : 'no'} ·
          Effective: {(data as any)?.recording?.effective_enabled ? 'enabled' : 'disabled'}
        </div>
      </Section>

      {/* Sticky save bar */}
      {dirty && (
        <div className="fixed bottom-4 inset-x-0 mx-auto max-w-3xl px-6 z-30">
          <Card className="p-3 flex items-center gap-3 shadow-lg border-primary/30 bg-card">
            <span className="text-sm flex-1">You have unsaved changes.</span>
            <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="h-3.5 w-3.5 me-1" />Reset</Button>
            <Button size="sm" onClick={save} disabled={update.isPending}><Save className="h-3.5 w-3.5 me-1" />Save changes</Button>
          </Card>
        </div>
      )}
    </div>
  );
}
