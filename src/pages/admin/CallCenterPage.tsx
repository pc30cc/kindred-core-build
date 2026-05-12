import { useState, useEffect, useMemo } from 'react';
import {
  useCallCenterAdminPlatform, useUpdateCallCenterAdminPlatform, useCallCenterAdminWorkspaces,
} from '@/hooks/useCallCenter';
import { callCenterAdminApi, callCenterDiagnosticsApi, type CallCenterPlatformSettings, type LiveKitDiagnostics } from '@/lib/call-center-api';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { AlertCircle, ShieldCheck, Server, Building2, Search, Activity, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

const TOGGLE_GROUPS: Array<{ title: string; items: Array<[keyof CallCenterPlatformSettings, string, boolean?]> }> = [
  { title: 'Core', items: [
    ['voice_calls_enabled', 'Voice calls'],
    ['video_calls_enabled', 'Video calls'],
    ['callback_requests_enabled', 'Callback requests'],
  ] },
  { title: 'Recording', items: [
    ['call_recording_enabled', 'Call recording'],
  ] },
  { title: 'Future', items: [
    ['screen_share_enabled', 'Screen share', true],
    ['call_transfer_enabled', 'Call transfer', true],
    ['departments_enabled', 'Departments', true],
    ['advanced_routing_enabled', 'Advanced routing', true],
  ] },
];

const LOCALES: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'default', label: 'Default', placeholder: 'Call center is currently unavailable.' },
  { key: 'en', label: 'English', placeholder: 'Call center is currently unavailable.' },
  { key: 'tr', label: 'Türkçe', placeholder: 'Çağrı merkezi şu anda kullanılamıyor.' },
  { key: 'fa', label: 'فارسی', placeholder: 'مرکز تماس در حال حاضر در دسترس نیست.' },
];

const LIMITS: Array<[keyof CallCenterPlatformSettings, string]> = [
  ['max_concurrent_calls_per_workspace', 'Max concurrent calls / workspace'],
  ['max_queue_size_per_workspace', 'Max queue size / workspace'],
  ['max_monthly_call_minutes_per_workspace', 'Max monthly call minutes / workspace'],
  ['max_callback_requests_per_month', 'Max callbacks / month'],
  ['max_recording_storage_mb', 'Max recording storage (MB)'],
];

function Stat({ label, value, icon: Icon }: { label: string; value: number | string; icon?: any }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3 flex items-center gap-3">
      {Icon && <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center"><Icon className="h-4 w-4" /></div>}
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
      </div>
    </div>
  );
}

export default function AdminCallCenterPage() {
  const { data, isLoading } = useCallCenterAdminPlatform();
  const update = useUpdateCallCenterAdminPlatform();
  const { data: ws } = useCallCenterAdminWorkspaces();
  const [draft, setDraft] = useState<Partial<CallCenterPlatformSettings>>({});
  const [jsonText, setJsonText] = useState('{}');
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [wsSearch, setWsSearch] = useState('');
  const [diag, setDiag] = useState<LiveKitDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const firstWorkspaceId = ws?.workspaces?.[0]?.workspace_id || null;

  async function runDiagnostics() {
    if (!firstWorkspaceId) {
      toast({ title: 'No workspace available to probe', variant: 'destructive' });
      return;
    }
    setDiagBusy(true); setDiagErr(null);
    try {
      const d = await callCenterDiagnosticsApi.getLiveKit(firstWorkspaceId);
      setDiag(d);
    } catch (e: any) {
      setDiagErr(e?.message || 'Diagnostics failed');
    } finally {
      setDiagBusy(false);
    }
  }

  useEffect(() => {
    if (data?.settings) {
      setDraft({ ...data.settings });
      const dm = (data.settings.disabled_message || {}) as Record<string, string>;
      setJsonText(JSON.stringify(dm, null, 2));
      setMessages({
        default: dm.default || '',
        en: dm.en || '',
        tr: dm.tr || '',
        fa: dm.fa || '',
      });
    }
  }, [data?.settings]);

  function updateMessage(key: string, value: string) {
    const next = { ...messages, [key]: value };
    setMessages(next);
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, v]) => v.trim()));
    setDraft((d) => ({ ...d, disabled_message: cleaned }));
    setJsonText(JSON.stringify(cleaned, null, 2));
    setJsonError(null);
  }
  if (isLoading || !data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  async function save() {
    if (jsonError) { toast({ title: 'Disabled message JSON is invalid', variant: 'destructive' }); return; }
    try {
      await update.mutateAsync(draft);
      toast({ title: 'Saved', description: 'Cache invalidated.' });
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
      <header className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-2xl font-semibold">Call Center</h1>
          <p className="text-sm text-muted-foreground">Platform-wide controls for the standalone Call Center module.</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full sm:w-auto">
          <Stat label="Kill switch" value={draft.call_center_enabled ? 'On' : 'Off'} icon={ShieldCheck} />
          <Stat label="Enabled WS" value={data.stats.enabled_workspaces} icon={Building2} />
          <Stat label="Active calls" value={data.stats.active_calls} icon={Server} />
          <Stat label="Waiting" value={data.stats.waiting_calls} icon={AlertCircle} />
        </div>
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
          <Label>Disabled message</Label>
          <p className="text-xs text-muted-foreground mb-2">Shown in the widget when the Call Center is disabled. Provide per-locale text.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {LOCALES.map((l) => (
              <div key={l.key}>
                <Label className="text-xs">{l.label}</Label>
                <Input value={messages[l.key] || ''} onChange={(e) => updateMessage(l.key, e.target.value)} placeholder={l.placeholder} />
              </div>
            ))}
          </div>
          <Collapsible className="mt-3">
            <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground">Advanced JSON editor</CollapsibleTrigger>
            <CollapsibleContent>
              <textarea
                className={`w-full min-h-[100px] rounded border bg-background p-2 text-xs font-mono mt-2 ${jsonError ? 'border-destructive' : 'border-input'}`}
                value={jsonText}
                onChange={(e) => {
                  const v = e.target.value;
                  setJsonText(v);
                  try { const parsed = JSON.parse(v); setDraft((d) => ({ ...d, disabled_message: parsed })); setJsonError(null); }
                  catch (err: any) { setJsonError(err.message); }
                }}
              />
              {jsonError && <p className="text-xs text-destructive mt-1">JSON error: {jsonError}</p>}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </Card>

      <Card className="p-5 space-y-5">
        <h2 className="font-semibold">Feature toggles</h2>
        {TOGGLE_GROUPS.map((group) => (
          <div key={group.title} className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</div>
            {group.items.map(([k, label, isPlaceholder]) => (
              <div key={k as string} className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <Label>{label}</Label>
                  {isPlaceholder && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/30">Placeholder</span>}
                </div>
                <Switch checked={!!(draft as any)[k]} disabled={!!isPlaceholder} onCheckedChange={(v) => setDraft({ ...draft, [k]: v } as any)} />
              </div>
            ))}
          </div>
        ))}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Platform limits</h2>
        <p className="text-xs text-muted-foreground">Effective limit = min(platform cap, plan limit, workspace override).</p>
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
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="font-semibold">Workspaces</h2>
          <div className="relative w-64 max-w-full">
            <Search className="h-3.5 w-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8 h-8 text-sm" placeholder="Search…" value={wsSearch} onChange={(e) => setWsSearch(e.target.value)} />
          </div>
        </div>
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
              {(ws?.workspaces || []).filter((w: any) => {
                if (!wsSearch) return true;
                const s = wsSearch.toLowerCase();
                return (w.workspaces?.name || '').toLowerCase().includes(s) || (w.workspaces?.slug || '').toLowerCase().includes(s);
              }).map((w: any) => (
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
