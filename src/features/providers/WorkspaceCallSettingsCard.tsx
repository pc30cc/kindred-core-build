/**
 * Phase 8C — Workspace call channel settings.
 *
 * Each toggle is bounded by the corresponding global gate. If the global
 * gate is off, the workspace toggle is disabled and shows a hint.
 * Effective state (global AND workspace) is summarised at the bottom so
 * admins can verify what visitors actually see.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Phone, Video } from 'lucide-react';
import {
  fetchWorkspaceCallSettings,
  updateWorkspaceCallSettings,
  type WorkspaceCallSettingsResponse,
  type WorkspaceCallOverrides,
} from '@/lib/workspace-calls-api';
import { useToast } from '@/hooks/use-toast';
import { WorkspaceRolePermissionsCard } from './WorkspaceRolePermissionsCard';

interface CallToggleRow {
  key: keyof WorkspaceCallOverrides;
  globalKey: keyof WorkspaceCallSettingsResponse['global_gates'];
  label: string;
  hint: string;
}

const ROWS: CallToggleRow[] = [
  { key: 'voice_calls_enabled', globalKey: 'voice_calls_enabled_global', label: 'Voice calls', hint: 'Allow audio calls in this workspace.' },
  { key: 'video_calls_enabled', globalKey: 'video_calls_enabled_global', label: 'Video calls', hint: 'Allow video calls in this workspace.' },
  { key: 'call_queue_enabled', globalKey: 'call_queue_enabled_global', label: 'Call queue', hint: 'Park visitors when no operator is available.' },
  { key: 'call_recording_enabled', globalKey: 'call_recording_enabled_global', label: 'Recording', hint: 'Allow operators to record calls.' },
  { key: 'visitor_initiated_audio_enabled', globalKey: 'visitor_initiated_audio_enabled_global', label: 'Visitor → audio', hint: 'Visitors may start audio calls from the widget.' },
  { key: 'visitor_initiated_video_enabled', globalKey: 'visitor_initiated_video_enabled_global', label: 'Visitor → video', hint: 'Visitors may start video calls from the widget.' },
];

export function WorkspaceCallSettingsCard({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const [data, setData] = useState<WorkspaceCallSettingsResponse | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setData(await fetchWorkspaceCallSettings(workspaceId));
    } catch (e: any) {
      toast({ title: 'Failed to load call settings', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId]);

  async function toggle(row: CallToggleRow, value: boolean) {
    if (!data) return;
    setSaving(row.key);
    const prev = data.overrides[row.key];
    setData({ ...data, overrides: { ...data.overrides, [row.key]: value } });
    try {
      const r = await updateWorkspaceCallSettings(workspaceId, { [row.key]: value } as Partial<WorkspaceCallOverrides>);
      setData(prev2 => prev2 ? { ...prev2, overrides: r.overrides, effective: r.effective } : prev2);
    } catch (e: any) {
      setData(d => d && ({ ...d, overrides: { ...d.overrides, [row.key]: prev } }));
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  }

  if (loading || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const masterDisabled = !data.global_gates.enabled;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" /> Voice & Video
          </CardTitle>
          <CardDescription>
            Workspace-level call channel toggles. Each is bounded by the platform global gate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {masterDisabled && (
            <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-warning mb-3">
              The platform call layer is disabled. All channels are off until a super admin enables it.
            </div>
          )}
          {ROWS.map((row) => {
            const globalOn = !!data.global_gates[row.globalKey];
            const wsValue = !!data.overrides[row.key];
            const disabled = !globalOn || saving === row.key;
            return (
              <div key={row.key} className="flex items-start justify-between gap-3 py-2">
                <div className="flex-1 min-w-0">
                  <Label className="text-sm flex items-center gap-2">
                    {row.label}
                    {!globalOn && <Badge variant="outline" className="text-[9px]">platform off</Badge>}
                  </Label>
                  <p className="text-xs text-muted-foreground">{row.hint}</p>
                </div>
                <Switch checked={wsValue && globalOn} disabled={disabled} onCheckedChange={(v) => void toggle(row, v)} />
              </div>
            );
          })}

          <Separator className="my-3" />

          <div className="flex items-center justify-between gap-3 py-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm">Default video quality</Label>
              <p className="text-xs text-muted-foreground">
                Operators start every video call at this quality. They can change it during the call.
              </p>
            </div>
            <Select
              value={data.overrides.default_video_quality || 'auto'}
              onValueChange={(v) => {
                setSaving('default_video_quality');
                const prev = data.overrides.default_video_quality;
                setData({ ...data, overrides: { ...data.overrides, default_video_quality: v as any } });
                updateWorkspaceCallSettings(workspaceId, { default_video_quality: v as any })
                  .then((r) => setData(p => p ? { ...p, overrides: r.overrides, effective: r.effective } : p))
                  .catch((e) => {
                    setData(d => d && ({ ...d, overrides: { ...d.overrides, default_video_quality: prev } }));
                    toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
                  })
                  .finally(() => setSaving(null));
              }}
            >
              <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="low">Low (360p)</SelectItem>
                <SelectItem value="medium">Medium (540p)</SelectItem>
                <SelectItem value="high">High (720p)</SelectItem>
                <SelectItem value="hd">HD (1080p)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator className="my-3" />

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
            <EffBadge label="Voice" on={data.effective.voice_enabled} />
            <EffBadge label="Video" on={data.effective.video_enabled} icon={Video} />
            <EffBadge label="Queue" on={data.effective.queue_enabled} />
            <EffBadge label="Recording" on={data.effective.recording_enabled} />
            <EffBadge label="Visitor audio" on={data.effective.visitor_initiated_audio} />
            <EffBadge label="Visitor video" on={data.effective.visitor_initiated_video} />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Effective state = platform global ∧ workspace setting.
          </p>
        </CardContent>
      </Card>

      <WorkspaceRolePermissionsCard workspaceId={workspaceId} />
    </div>
  );
}

function EffBadge({ label, on, icon: Icon }: { label: string; on: boolean; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className={
      'rounded-md px-2 py-1.5 border flex items-center gap-1.5 ' +
      (on
        ? 'bg-success/10 border-success/30 text-success'
        : 'bg-muted/40 border-border text-muted-foreground')
    }>
      {Icon && <Icon className="h-3 w-3" />}
      <span className="font-medium">{label}</span>
      <span className="ms-auto text-[10px] uppercase tracking-wide">{on ? 'on' : 'off'}</span>
    </div>
  );
}