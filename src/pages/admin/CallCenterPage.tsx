import { useState, useEffect } from 'react';
import {
  useCallCenterAdminPlatform, useUpdateCallCenterAdminPlatform, useCallCenterAdminWorkspaces,
} from '@/hooks/useCallCenter';
import { callCenterAdminApi, type CallCenterPlatformSettings } from '@/lib/call-center-api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { AlertCircle } from 'lucide-react';

const TOGGLES: Array<[keyof CallCenterPlatformSettings, string, boolean?]> = [
  ['voice_calls_enabled', 'Voice calls'],
  ['video_calls_enabled', 'Video calls'],
  ['callback_requests_enabled', 'Callback requests'],
  ['call_recording_enabled', 'Call recording'],
  ['screen_share_enabled', 'Screen share', true],
  ['call_transfer_enabled', 'Call transfer', true],
  ['departments_enabled', 'Departments', true],
  ['advanced_routing_enabled', 'Advanced routing', true],
];

const LIMITS: Array<[keyof CallCenterPlatformSettings, string]> = [
  ['max_concurrent_calls_per_workspace', 'Max concurrent calls / workspace'],
  ['max_queue_size_per_workspace', 'Max queue size / workspace'],
  ['max_monthly_call_minutes_per_workspace', 'Max monthly call minutes / workspace'],
  ['max_callback_requests_per_month', 'Max callbacks / month'],
  ['max_recording_storage_mb', 'Max recording storage (MB)'],
];

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

export default function AdminCallCenterPage() {
  const { data, isLoading } = useCallCenterAdminPlatform();
  const update = useUpdateCallCenterAdminPlatform();
  const { data: ws } = useCallCenterAdminWorkspaces();
  const [draft, setDraft] = useState<Partial<CallCenterPlatformSettings>>({});

  useEffect(() => { if (data?.settings) setDraft({ ...data.settings }); }, [data?.settings]);
  if (isLoading || !data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  async function save() {
    try {
      await update.mutateAsync(draft);
      toast({ title: 'Saved' });
    } catch (e: any) {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    }
  }
  async function invalidate() {
    await callCenterAdminApi.invalidateCache();
    toast({ title: 'Cache invalidated' });
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold">Call Center</h1>
        <p className="text-sm text-muted-foreground">Platform-wide controls for the standalone Call Center module.</p>
      </header>

      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Global kill-switch</h2>
            <p className="text-xs text-muted-foreground">When off, no workspace can see or use the Call Center.</p>
          </div>
          <Switch checked={!!draft.call_center_enabled} onCheckedChange={(v) => setDraft({ ...draft, call_center_enabled: v })} />
        </div>
        <div>
          <Label>Disabled message (JSON)</Label>
          <textarea
            className="w-full min-h-[80px] rounded border border-input bg-background p-2 text-xs font-mono"
            value={JSON.stringify(draft.disabled_message || {}, null, 2)}
            onChange={(e) => { try { setDraft({ ...draft, disabled_message: JSON.parse(e.target.value) }); } catch {} }}
          />
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="Enabled workspaces" value={data.stats.enabled_workspaces} />
          <Stat label="Active calls" value={data.stats.active_calls} />
          <Stat label="Waiting calls" value={data.stats.waiting_calls} />
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Feature toggles</h2>
        {TOGGLES.map(([k, label, isPlaceholder]) => (
          <div key={k as string} className="flex items-center justify-between">
            <div>
              <Label>{label}</Label>
              {isPlaceholder && <p className="text-[11px] text-muted-foreground flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Placeholder — not implemented yet</p>}
            </div>
            <Switch checked={!!(draft as any)[k]} disabled={!!isPlaceholder} onCheckedChange={(v) => setDraft({ ...draft, [k]: v } as any)} />
          </div>
        ))}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Platform limits</h2>
        <div className="grid grid-cols-2 gap-3">
          {LIMITS.map(([k, label]) => (
            <div key={k as string}>
              <Label>{label}</Label>
              <Input type="number" value={String((draft as any)[k] ?? 0)} onChange={(e) => setDraft({ ...draft, [k]: parseInt(e.target.value || '0', 10) } as any)} />
            </div>
          ))}
        </div>
      </Card>

      <div className="flex gap-2">
        <Button onClick={save} disabled={update.isPending}>Save platform settings</Button>
        <Button variant="outline" onClick={invalidate}>Invalidate cache</Button>
      </div>

      <Card className="p-5">
        <h2 className="font-semibold mb-3">Workspaces</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b">
                <th className="text-start py-2 px-2">Workspace</th>
                <th className="text-start py-2 px-2">Slug</th>
                <th className="text-start py-2 px-2">Enabled</th>
                <th className="text-start py-2 px-2">Voice</th>
                <th className="text-start py-2 px-2">Video</th>
                <th className="text-start py-2 px-2">Callback</th>
                <th className="text-start py-2 px-2">Public key</th>
                <th className="text-start py-2 px-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {(ws?.workspaces || []).map((w: any) => (
                <tr key={w.workspace_id} className="border-b">
                  <td className="py-2 px-2">{w.workspaces?.name || w.workspace_id}</td>
                  <td className="py-2 px-2 text-muted-foreground">{w.workspaces?.slug || '—'}</td>
                  <td className="py-2 px-2">{w.enabled ? '✓' : '—'}</td>
                  <td className="py-2 px-2">{w.voice_enabled ? '✓' : '—'}</td>
                  <td className="py-2 px-2">{w.video_enabled ? '✓' : '—'}</td>
                  <td className="py-2 px-2">{w.callback_enabled ? '✓' : '—'}</td>
                  <td className="py-2 px-2 text-xs font-mono truncate max-w-[180px]">{w.public_key || '—'}</td>
                  <td className="py-2 px-2 text-muted-foreground">{w.updated_at ? new Date(w.updated_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
              {(!ws || ws.workspaces.length === 0) && (
                <tr><td colSpan={8} className="py-4 text-center text-muted-foreground">No workspaces.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
