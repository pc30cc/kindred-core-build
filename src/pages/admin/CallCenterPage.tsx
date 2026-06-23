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
import { AlertCircle, ShieldCheck, Server, Building2, Search, Activity, Loader2, CheckCircle2, XCircle, AlertTriangle, ShieldAlert, PhoneCall, Music, Languages, Upload, Disc3 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RecordingRetentionPanel } from '@/components/admin/calls/RecordingRetentionPanel';
import { useTranslation } from '@/i18n';
import { Link } from 'react-router-dom';

const WIDGET_LOCALES: Array<{ code: 'en' | 'fa' | 'tr'; label: string; native: string }> = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'fa', label: 'Persian', native: 'فارسی' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe' },
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

const CALLBACK_TOGGLES: Array<[keyof CallCenterPlatformSettings, string, string]> = [
  ['callback_show_when_online', 'Show callback button when operators are online', 'If off, the "Request a callback" button only appears when no operator is online.'],
  ['callback_require_contact', 'Require email or phone', 'Reject submissions that have neither an email nor a phone number.'],
  ['callback_honeypot_enabled', 'Honeypot field (anti-bot)', 'Adds an invisible bait field. Any submission that fills it is silently rejected.'],
];

const CALLBACK_NUMBERS: Array<[keyof CallCenterPlatformSettings, string, string]> = [
  ['callback_min_seconds_between_requests', 'Cooldown per visitor (seconds)', 'Minimum seconds the same visitor must wait between callback submissions.'],
  ['callback_max_per_ip_per_hour', 'Max requests per IP / hour', 'Hard ceiling per IP address within the last hour.'],
  ['callback_min_form_seconds', 'Minimum form-fill time (seconds)', 'Rejects submissions sent faster than a human could plausibly fill the form.'],
  ['callback_min_message_length', 'Minimum message length (chars)', '0 = no requirement.'],
];

const RINGBACK_MODES: Array<{ value: 'tone' | 'music' | 'off'; label: string; hint: string }> = [
  { value: 'tone', label: 'Generated soft hold music', hint: 'In-browser fallback music. Persian TTS is not used.' },
  { value: 'music', label: 'Uploaded hold music', hint: 'Loops the uploaded provider-backed audio file.' },
  { value: 'off', label: 'Silent', hint: 'No audio is played while the visitor is waiting.' },
];

const QUEUE_TOGGLES: Array<[keyof CallCenterPlatformSettings, string, string]> = [
  ['queue_show_position', 'Show queue position to visitor', 'Displays "You are #2 in the queue" while the visitor waits.'],
  ['queue_show_eta', 'Show estimated wait time', 'Displays an estimate based on the per-position seconds below.'],
  ['operator_new_call_sound_enabled', 'Operator notification sound on new call', 'Plays a short tone in the operator console when a call enters the queue.'],
];

const QUEUE_NUMBERS: Array<[keyof CallCenterPlatformSettings, string, string]> = [
  ['queue_eta_seconds_per_position', 'ETA seconds per queue position', 'Used to compute the estimated wait time shown to the visitor.'],
  ['queue_offer_callback_after_seconds', 'Offer callback after (seconds)', '0 = never. After this many seconds in queue, the visitor sees a "Request a callback" prompt.'],
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

function DiagRow({ label, value, mono, ok }: { label: string; value: string; mono?: boolean; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs ${mono ? 'font-mono' : ''} ${ok === false ? 'text-destructive' : ok === true ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
        {ok === true && <CheckCircle2 className="inline h-3 w-3 me-1" />}
        {ok === false && <XCircle className="inline h-3 w-3 me-1" />}
        {value}
      </span>
    </div>
  );
}

export default function AdminCallCenterPage() {
  const { t } = useTranslation();
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
  const [audioBusy, setAudioBusy] = useState<string | null>(null);
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

  async function uploadRingbackAudio(kind: 'music' | 'announcement' | 'queue', file: File | null, queuePosition?: number) {
    if (!file) return;
    const key = kind === 'queue' ? `queue-${queuePosition}` : kind;
    setAudioBusy(key);
    try {
      const r = await callCenterAdminApi.uploadRingbackAudio({ kind, file, queue_position: queuePosition });
      setDraft({ ...r.settings });
      toast({ title: 'Audio uploaded', description: 'Stored through the active storage provider.' });
    } catch (e: any) {
      toast({ title: 'Upload failed', description: e.message, variant: 'destructive' });
    } finally {
      setAudioBusy(null);
    }
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

      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-2">
          <Disc3 className="h-5 w-5 text-primary mt-0.5" />
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold">{t('callCenter.admin.recording.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('callCenter.admin.recording.description')}</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <Label>{t('callCenter.admin.recording.toggleLabel')}</Label>
            <p className="text-xs text-muted-foreground">{t('callCenter.admin.recording.toggleHint')}</p>
          </div>
          <Switch
            checked={!!draft.call_recording_enabled}
            onCheckedChange={(v) => setDraft({ ...draft, call_recording_enabled: v })}
          />
        </div>
        <div className="rounded-md border border-input p-3 bg-muted/20 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('callCenter.admin.recording.providerStatus')}</div>
          <p className="text-xs text-muted-foreground">{t('callCenter.admin.recording.providerUnknown')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/voice-video?tab=recordings">{t('callCenter.admin.recording.retentionLink')}</Link>
          </Button>
        </div>
      </Card>

      <Card className="p-5 space-y-5">
        <h2 className="font-semibold">Feature toggles</h2>
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Core</div>
          {[
            ['voice_calls_enabled', 'Voice calls'],
            ['video_calls_enabled', 'Video calls'],
            ['callback_requests_enabled', 'Callback requests'],
          ].map(([k, label]) => (
            <div key={k as string} className="flex items-center justify-between py-1">
              <Label>{label}</Label>
              <Switch checked={!!(draft as any)[k]} onCheckedChange={(v) => setDraft({ ...draft, [k]: v } as any)} />
            </div>
          ))}
        </div>
        <div className="space-y-2 pt-3 border-t">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('callCenter.admin.comingSoon')}</div>
          {[
            ['screen_share_enabled', 'Screen share'],
            ['call_transfer_enabled', 'Call transfer'],
            ['advanced_routing_enabled', 'Advanced routing'],
          ].map(([k, label]) => (
            <div key={k as string} className="flex items-center justify-between py-1 opacity-60">
              <div className="flex items-center gap-2">
                <Label>{label}</Label>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border">{t('callCenter.admin.comingSoon')}</span>
              </div>
              <Switch checked={!!(draft as any)[k]} disabled onCheckedChange={() => {}} />
            </div>
          ))}
        </div>
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

      <Card className="p-5 space-y-5">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-5 w-5 text-amber-600 mt-0.5" />
          <div>
            <h2 className="font-semibold">Callback requests & anti-spam</h2>
            <p className="text-xs text-muted-foreground">
              Controls the "Request a callback" experience inside the call widget for every workspace.
              The master switch is the <strong>Callback requests</strong> toggle above.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {CALLBACK_TOGGLES.map(([k, label, hint]) => (
            <div key={k as string} className="flex items-start justify-between gap-3 py-1">
              <div className="min-w-0">
                <Label>{label}</Label>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <Switch
                checked={!!(draft as any)[k]}
                onCheckedChange={(v) => setDraft({ ...draft, [k]: v } as any)}
              />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CALLBACK_NUMBERS.map(([k, label, hint]) => (
            <div key={k as string}>
              <Label>{label}</Label>
              <Input
                type="number"
                min={0}
                value={String((draft as any)[k] ?? 0)}
                onChange={(e) => setDraft({ ...draft, [k]: Math.max(0, parseInt(e.target.value || '0', 10)) } as any)}
              />
              <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex gap-2">
        <Button onClick={save} disabled={update.isPending}>Save platform settings</Button>
        <Button variant="outline" onClick={invalidate}>Invalidate cache</Button>
      </div>

      <Card className="p-5 space-y-5">
        <div className="flex items-start gap-2">
          <PhoneCall className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <h2 className="font-semibold">Ringback & Queue experience</h2>
            <p className="text-xs text-muted-foreground">
              Audio played to the visitor while they wait for an operator, plus the on-screen queue UX.
            </p>
          </div>
        </div>

        <div className="flex items-start justify-between gap-3 py-1">
          <div className="min-w-0">
            <Label>Enable ringback / hold audio</Label>
            <p className="text-xs text-muted-foreground">Master switch for the visitor-side on-hold audio.</p>
          </div>
          <Switch
            checked={!!draft.ringback_enabled}
            onCheckedChange={(v) => setDraft({ ...draft, ringback_enabled: v })}
          />
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2"><Music className="h-3.5 w-3.5" /> Ringback mode</Label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {RINGBACK_MODES.map((m) => {
              const active = (draft.ringback_mode || 'tone') === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setDraft({ ...draft, ringback_mode: m.value })}
                  className={`text-start rounded-lg border p-3 transition ${active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-input hover:bg-muted/40'}`}
                >
                  <div className="text-sm font-semibold">{m.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{m.hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-input p-3">
          <div>
            <Label className="flex items-center gap-2"><Upload className="h-3.5 w-3.5" /> Provider-backed audio uploads</Label>
            <p className="text-[11px] text-muted-foreground mt-1">
              Files are stored through the active global storage provider. The widget resolves the current provider URL on bootstrap.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Hold music loop</Label>
              <Input
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac"
                disabled={audioBusy === 'music'}
                onChange={(e) => uploadRingbackAudio('music', e.target.files?.[0] || null)}
              />
              {draft.ringback_music_url && <audio className="w-full h-8" controls src={draft.ringback_music_url} />}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">General waiting announcement</Label>
              <Input
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac"
                disabled={audioBusy === 'announcement'}
                onChange={(e) => uploadRingbackAudio('announcement', e.target.files?.[0] || null)}
              />
              <p className="text-[11px] text-muted-foreground">Use this for “لطفا جهت ارتباط با کارشناسان ما منتظر بمانید”.</p>
            </div>
          </div>
          <div className="space-y-2 pt-2 border-t">
            <Label className="text-xs">Queue-position waiting audio 1–6</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[1, 2, 3, 4, 5, 6].map((pos) => (
                <div key={pos} className="space-y-1 rounded-md border border-input p-2">
                  <Label className="text-[11px]">Queue {pos}</Label>
                  <Input
                    type="file"
                    accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac"
                    disabled={audioBusy === `queue-${pos}`}
                    onChange={(e) => uploadRingbackAudio('queue', e.target.files?.[0] || null, pos)}
                  />
                  {(draft.ringback_queue_audio_paths || {})[String(pos)] && (
                    <p className="text-[10px] text-muted-foreground">Uploaded</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t">
          {QUEUE_TOGGLES.map(([k, label, hint]) => (
            <div key={k as string} className="flex items-start justify-between gap-3 py-1">
              <div className="min-w-0">
                <Label>{label}</Label>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <Switch
                checked={!!(draft as any)[k]}
                onCheckedChange={(v) => setDraft({ ...draft, [k]: v } as any)}
              />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {QUEUE_NUMBERS.map(([k, label, hint]) => (
            <div key={k as string}>
              <Label>{label}</Label>
              <Input
                type="number"
                min={0}
                value={String((draft as any)[k] ?? 0)}
                onChange={(e) => setDraft({ ...draft, [k]: Math.max(0, parseInt(e.target.value || '0', 10)) } as any)}
              />
              <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <Button onClick={save} disabled={update.isPending}>Save ringback & queue settings</Button>
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-2">
          <Languages className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <h2 className="font-semibold">Widget languages</h2>
            <p className="text-xs text-muted-foreground">
              Pick the default widget language and which languages every workspace operator can
              enable from their own Call Center settings.
            </p>
          </div>
        </div>

        <div>
          <Label>Default widget language</Label>
          <Select
            value={(draft.widget_default_locale as string) || 'en'}
            onValueChange={(v) => {
              const next = { ...draft, widget_default_locale: v as any };
              // Auto-include the default in the available set.
              const avail = (draft.widget_available_locales || []).slice();
              if (!avail.includes(v)) avail.push(v);
              next.widget_available_locales = avail as any;
              setDraft(next);
            }}
          >
            <SelectTrigger className="w-60 mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {WIDGET_LOCALES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.label} <span className="text-muted-foreground ms-1">({l.native})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground mt-1">
            Used by every workspace whose operator hasn't picked their own default.
          </p>
        </div>

        <div className="pt-2 border-t">
          <Label>Languages available to operators</Label>
          <p className="text-xs text-muted-foreground mb-2">
            Only checked languages can be turned on per workspace. The default language is always
            available regardless of these toggles.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {WIDGET_LOCALES.map((l) => {
              const list = (draft.widget_available_locales || []) as string[];
              const isOn = list.includes(l.code);
              const isDefault = (draft.widget_default_locale || 'en') === l.code;
              return (
                <label
                  key={l.code}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 transition cursor-pointer ${
                    isOn ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/40'
                  } ${isDefault ? 'ring-1 ring-primary' : ''}`}
                >
                  <span className="text-sm">
                    {l.label} <span className="text-muted-foreground ms-1">{l.native}</span>
                    {isDefault && (
                      <span className="ms-2 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30">
                        Default
                      </span>
                    )}
                  </span>
                  <Switch
                    checked={isOn}
                    disabled={isDefault}
                    onCheckedChange={(v) => {
                      let next = list.slice();
                      if (v) {
                        if (!next.includes(l.code)) next.push(l.code);
                      } else {
                        next = next.filter((c) => c !== l.code);
                      }
                      if (next.length === 0) next = [draft.widget_default_locale || 'en'];
                      setDraft({ ...draft, widget_available_locales: next as any });
                    }}
                  />
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button onClick={save} disabled={update.isPending}>Save language settings</Button>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-semibold flex items-center gap-2"><Activity className="h-4 w-4" /> LiveKit connectivity</h2>
            <p className="text-xs text-muted-foreground">
              Probes the configured LiveKit URL for the standalone Call Center widget.
              Probes <code>/rtc/validate</code> and <code>/rtc/v1/validate</code>.
              Never returns secrets or tokens.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={runDiagnostics} disabled={diagBusy || !firstWorkspaceId}>
            {diagBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
            <span className="ms-1.5">Run diagnostics</span>
          </Button>
        </div>
        {diagErr && <p className="text-xs text-destructive">{diagErr}</p>}
        {diag && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <DiagRow label="Server URL" value={diag.server_url_public || '—'} mono />
              <DiagRow label="Normalized" value={diag.server_url_public_normalized || '—'} mono />
              <DiagRow label="API key" value={diag.api_key_present ? 'Present' : 'Missing'} ok={diag.api_key_present} />
              <DiagRow label="API secret" value={diag.api_secret_present ? 'Present' : 'Missing'} ok={diag.api_secret_present} />
              <DiagRow
                label="/rtc/validate"
                value={diag.health.rtc_validate_status == null ? '—' : String(diag.health.rtc_validate_status)}
                ok={diag.health.rtc_validate_status != null && diag.health.rtc_validate_status !== 404}
              />
              <DiagRow
                label="/rtc/v1/validate"
                value={diag.health.rtc_v1_validate_status == null ? '—' : String(diag.health.rtc_v1_validate_status)}
                ok={diag.health.rtc_v1_validate_status != null && diag.health.rtc_v1_validate_status !== 404}
              />
            </div>
            {diag.warnings.length > 0 && (
              <div className="space-y-1">
                {diag.warnings.map((w) => (
                  <div key={w} className="flex items-center gap-2 text-xs rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

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
                <th className="text-start py-2 px-2">{t('callCenter.admin.workspaces.recording')}</th>
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
                  <td className="py-2 px-2">{w.recording_enabled ? '✓' : '—'}</td>
                  <td className="py-2 px-2 text-xs font-mono truncate max-w-[180px]">{w.public_key || '—'}</td>
                  <td className="py-2 px-2 text-muted-foreground">{w.updated_at ? new Date(w.updated_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
              {(!ws || ws.workspaces.length === 0) && (
                <tr><td colSpan={9} className="py-4 text-center text-muted-foreground">No workspaces.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-5 w-5 text-primary mt-0.5" />
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold">Recording retention & legal hold</h2>
            <p className="text-xs text-muted-foreground">
              Cross-workspace operability over every retained recording. Read,
              play, download, toggle legal hold, override retention, restore,
              and adopt legacy rows. The janitor remains the sole deletion path.
            </p>
          </div>
        </div>
        <RecordingRetentionPanel />
      </Card>
    </div>
  );
}
