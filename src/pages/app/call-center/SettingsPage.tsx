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
import { AlertCircle, ChevronDown, RotateCcw, Save, Languages } from 'lucide-react';
import { CheckCircle2, XCircle, ShieldCheck, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link, useParams } from 'react-router-dom';
// CC-2G-UI-Architecture-Fix — read canonical departments from
// Team & Departments instead of the deprecated Call Center departments
// hook. Only departments with a Call Center channel enabled are
// surfaced as options here.
import { useQuery } from '@tanstack/react-query';
import { listDepartments } from '@/lib/workspace-departments-api';

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
  const { data: allDepartments = [] } = useQuery({
    queryKey: ['workspace-departments', workspace?.id],
    queryFn: () => listDepartments(workspace!.id),
    enabled: !!workspace?.id,
  });
  // Only departments that have at least one Call Center channel enabled
  // can route Call Center traffic. Disabled departments are excluded
  // entirely from the default-department picker.
  const ccDepartments = allDepartments.filter(
    (d) => d.enabled && (d.cc_voice_enabled || d.cc_video_enabled || d.cc_callback_enabled),
  );
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
      'default_department_id', 'widget_default_locale', 'widget_enabled_locales',
      'widget_custom_texts', 'operator_video_visible_to_visitor',
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
      widget_default_locale: s.widget_default_locale ?? null,
      widget_enabled_locales: s.widget_enabled_locales ?? null,
      widget_custom_texts: s.widget_custom_texts ?? {},
      operator_video_visible_to_visitor: s.operator_video_visible_to_visitor !== false,
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
        <WidgetTextsEditor
          settings={s}
          platform={platform}
          onChange={(next) => setS({ ...s, widget_custom_texts: next })}
        />
      </Section>

      {(() => {
        const LOC_LABELS: Record<string, { label: string; native: string }> = {
          en: { label: 'English', native: 'English' },
          fa: { label: 'Persian', native: 'فارسی' },
          tr: { label: 'Turkish', native: 'Türkçe' },
        };
        const platformAvail: string[] = (platform as any)?.widget_available_locales || ['en'];
        const platformDefault: string = (platform as any)?.widget_default_locale || 'en';
        const wsEnabled: string[] = (s.widget_enabled_locales && s.widget_enabled_locales.length > 0)
          ? s.widget_enabled_locales
          : platformAvail;
        const wsDefault: string = s.widget_default_locale
          || (platformAvail.includes(platformDefault) ? platformDefault : platformAvail[0]);
        const effective = wsEnabled.filter((c) => platformAvail.includes(c));
        return (
          <Section
            title="Widget languages"
            description="Choose which languages your widget exposes to visitors and which one is the default. Only languages allowed by the platform are shown."
          >
            <Row label="Default widget language" hint="Visitors who don't pick a language see the widget in this language.">
              <Select
                value={wsDefault}
                onValueChange={(v) => {
                  // Auto-include the chosen default in enabled list
                  const nextEnabled = effective.includes(v) ? effective : [...effective, v];
                  setS({ ...s, widget_default_locale: v, widget_enabled_locales: nextEnabled });
                }}
              >
                <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {platformAvail.map((c) => (
                    <SelectItem key={c} value={c}>
                      {(LOC_LABELS[c]?.label) || c} <span className="text-muted-foreground ms-1">({LOC_LABELS[c]?.native || c})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>

            <div className="space-y-2">
              <Label className="flex items-center gap-2"><Languages className="h-3.5 w-3.5" /> Enabled languages</Label>
              <p className="text-xs text-muted-foreground">
                Toggle which languages are offered in the widget's language switcher. The default
                language is always enabled.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {platformAvail.map((c) => {
                  const isOn = effective.includes(c);
                  const isDefault = wsDefault === c;
                  return (
                    <label
                      key={c}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 cursor-pointer transition',
                        isOn ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/40',
                        isDefault && 'ring-1 ring-primary',
                      )}
                    >
                      <span className="text-sm">
                        {(LOC_LABELS[c]?.label) || c}
                        <span className="text-muted-foreground ms-1">{LOC_LABELS[c]?.native || c}</span>
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
                          let next = effective.slice();
                          if (v) {
                            if (!next.includes(c)) next.push(c);
                          } else {
                            next = next.filter((x) => x !== c);
                          }
                          if (!next.includes(wsDefault)) next.push(wsDefault);
                          setS({ ...s, widget_enabled_locales: next });
                        }}
                      />
                    </label>
                  );
                })}
              </div>
              {platformAvail.length <= 1 && (
                <p className="text-xs text-amber-600">
                  The platform currently allows only one language. Ask the platform admin to enable
                  more languages in the super-admin Call Center settings.
                </p>
              )}
            </div>
          </Section>
        );
      })()}

      <Section title="Call modes" description="Choose which channels visitors can use.">
        <Row label="Voice calls" locked={!platformVoice ? 'Disabled by platform' : undefined}>
          <Switch checked={!!s.voice_enabled} onCheckedChange={(v) => setS({ ...s, voice_enabled: v })} disabled={!platformVoice} />
        </Row>
        <Row label="Video calls" locked={!platformVideo ? 'Disabled by platform' : undefined}>
          <Switch checked={!!s.video_enabled} onCheckedChange={(v) => setS({ ...s, video_enabled: v })} disabled={!platformVideo} />
        </Row>
        {platformCallback && (
          <Row label="Callback requests">
            <Switch checked={!!s.callback_enabled} onCheckedChange={(v) => setS({ ...s, callback_enabled: v })} />
          </Row>
        )}
        <Row label="Pre-call form" hint="Ask visitors for name/email/subject before connecting.">
          <Switch checked={!!s.pre_call_form_enabled} onCheckedChange={(v) => setS({ ...s, pre_call_form_enabled: v })} />
        </Row>
        <Row
          label="Visitor sees operator video"
          hint="When off, the operator's camera is hidden from the visitor during video calls (audio still works). On by default."
          locked={!platformVideo ? 'Video disabled by platform' : undefined}
        >
          <Switch
            checked={s.operator_video_visible_to_visitor !== false}
            disabled={!platformVideo}
            onCheckedChange={(v) => setS({ ...s, operator_video_visible_to_visitor: v })}
          />
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
              {platformCallback && <SelectItem value="show_callback">Show callback request</SelectItem>}
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
              <SelectItem value="round_robin">Round robin — next available agent</SelectItem>
              <SelectItem value="least_busy">Least busy — fewest active calls</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section
        title="Departments & Routing"
        description="Departments and agents are managed in Team & Departments. Only departments with a Call Center channel enabled can receive Call Center calls.">
        {ccDepartments.length === 0 && (
          <div className="flex gap-2 items-start text-xs p-3 rounded bg-amber-500/10 border border-amber-500/30">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
            <span>
              No departments are enabled for Call Center. Open{' '}
              <Link to={`/app/w/${slug}/settings/team-departments`} className="text-primary underline">
                Team &amp; Departments
              </Link>{' '}
              and turn on Call Center Voice, Video, or Callback on at least one department.
            </span>
          </div>
        )}
        <Row label="Default department" hint="New Call Center calls without a department choice are routed here.">
          <Select
            value={s.default_department_id || '__none__'}
            onValueChange={(v) => setS({ ...s, default_department_id: v === '__none__' ? null : v })}
          >
            <SelectTrigger className="w-60"><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {ccDepartments.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <div className="text-xs text-muted-foreground space-y-1">
          <div><b>Broadcast</b> — every eligible agent in the department sees the call.</div>
          <div><b>Round robin</b> — the next available agent is picked.</div>
          <div><b>Least busy</b> — agent with the lowest active call count is picked.</div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/app/w/${slug}/settings/team-departments`}>Manage Departments in Team & Departments →</Link>
        </Button>
      </Section>

      <RecordingSection
        s={s}
        setS={setS}
        platformRecording={platformRecording}
        recording={(data as any)?.recording || null}
      />

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

// ── Widget text overrides editor ──────────────────────────────
const CALLBACK_TEXT_KEYS = new Set([
  'callback', 'leave_details', 'callback_desk',
  'leave_callback_request', 'offline_copy',
  'request_callback', 'request_callback_instead',
]);

const WIDGET_TEXT_KEYS: { key: string; label: string; placeholder: Record<string, string> }[] = [
  { key: 'talk_now',            label: 'Launcher text (online)',     placeholder: { en: 'Talk now',            fa: 'همین حالا تماس بگیرید', tr: 'Şimdi konuş' } },
  { key: 'live_support',        label: 'Launcher subtitle (online)', placeholder: { en: 'Live support',        fa: 'پشتیبانی آنلاین',     tr: 'Canlı destek' } },
  { key: 'callback',            label: 'Launcher text (offline)',    placeholder: { en: 'Callback',            fa: 'درخواست تماس',        tr: 'Geri arama' } },
  { key: 'leave_details',       label: 'Launcher subtitle (offline)',placeholder: { en: 'Leave details',       fa: 'ثبت اطلاعات',         tr: 'Bilgilerini bırak' } },
  { key: 'operators_available', label: 'Header subtitle (online)',   placeholder: { en: 'Operators available', fa: 'اپراتورها آماده‌اند', tr: 'Operatörler müsait' } },
  { key: 'callback_desk',       label: 'Header subtitle (offline)',  placeholder: { en: 'Callback desk',       fa: 'میز درخواست تماس',    tr: 'Geri arama masası' } },
  { key: 'talk_to_team',        label: 'Hero title (online)',        placeholder: { en: 'Talk to our team',    fa: 'با تیم ما صحبت کنید', tr: 'Ekibimizle konuşun' } },
  { key: 'online_copy',         label: 'Hero subtitle (online)',     placeholder: { en: 'Start a secure voice or video call with the next available operator.', fa: 'یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید.', tr: 'İlk uygun operatörle güvenli sesli veya görüntülü arama başlatın.' } },
  { key: 'leave_callback_request', label: 'Hero title (offline)',    placeholder: { en: 'Leave a callback request', fa: 'درخواست تماس ثبت کنید', tr: 'Geri arama isteği bırakın' } },
  { key: 'offline_copy',        label: 'Hero subtitle (offline)',    placeholder: { en: 'Our team is offline right now, but we can call you back.', fa: 'تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم.', tr: 'Ekibimiz şu anda çevrimdışı, ancak sizi geri arayabiliriz.' } },
  { key: 'voice_call',          label: 'Voice call button',          placeholder: { en: 'Voice call',          fa: 'تماس صوتی',           tr: 'Sesli arama' } },
  { key: 'video_call',          label: 'Video call button',          placeholder: { en: 'Video call',          fa: 'تماس تصویری',         tr: 'Görüntülü arama' } },
  { key: 'request_callback',    label: 'Callback button',            placeholder: { en: 'Request callback',    fa: 'درخواست تماس',        tr: 'Geri arama iste' } },
  { key: 'request_callback_instead', label: 'Callback alternative (during call)', placeholder: { en: 'Request a callback instead', fa: 'درخواست تماس', tr: 'Bunun yerine geri arama iste' } },
];

const LOC_LABELS_FULL: Record<string, string> = {
  en: 'English', fa: 'فارسی', tr: 'Türkçe',
};

// ── Recording section ─────────────────────────────────────────
// Replaces the old single-line "Effective: enabled/disabled" with a
// transparent breakdown of platform/workspace/provider/configuration so the
// operator can immediately see WHY recording is or isn't effective.
function RecordingSection({
  s,
  setS,
  platformRecording,
  recording,
}: {
  s: any;
  setS: (next: any) => void;
  platformRecording: boolean;
  recording: {
    enabled_by_platform: boolean;
    enabled_by_workspace: boolean;
    consent_required: boolean;
    provider_supported: boolean;
    provider_configured: boolean;
    effective_enabled: boolean;
    reason?: string;
  } | null;
}) {
  const eff = recording?.effective_enabled === true;
  const reasonLabel: Record<string, string> = {
    platform_disabled: 'Recording is turned off at the platform level. Ask the platform admin to enable Call recording in super-admin → Call Center.',
    workspace_disabled: 'Recording is off for this workspace. Toggle "Recording enabled" below to start capturing future calls.',
    provider_not_supported: 'The active call provider for this workspace does not support recording. Switch provider in super-admin → Voice & Video.',
    provider_not_configured: 'Recording provider is missing required configuration (e.g. LiveKit egress storage credentials). Configure it in super-admin → Voice & Video.',
  };
  const reason = recording?.reason;
  return (
    <Section
      title="Recording"
      description="Configure call recording for this workspace. The effective status reflects platform, workspace, and provider checks combined."
    >
      <div
        className={cn(
          'rounded-md border p-3 flex items-start gap-2',
          eff
            ? 'border-emerald-500/30 bg-emerald-500/5'
            : 'border-amber-500/30 bg-amber-500/5',
        )}
      >
        {eff ? (
          <ShieldCheck className="h-4 w-4 text-emerald-600 mt-0.5" />
        ) : (
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
        )}
        <div className="text-xs space-y-1">
          <div className="font-semibold">
            {eff
              ? 'Recording is effectively ENABLED for new calls.'
              : 'Recording is currently NOT effective — new calls will not be recorded.'}
          </div>
          {!eff && reason && reasonLabel[reason] && (
            <div className="text-muted-foreground">{reasonLabel[reason]}</div>
          )}
        </div>
      </div>

      {recording && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <CheckRow ok={recording.enabled_by_platform} label="Platform allows recording" />
          <CheckRow ok={recording.enabled_by_workspace} label="Workspace enabled" />
          <CheckRow ok={recording.provider_supported} label="Provider supports recording" />
          <CheckRow ok={recording.provider_configured} label="Provider configured (storage / egress)" />
        </div>
      )}

      <Row
        label="Recording enabled"
        hint="When on, eligible calls are recorded once consent has been satisfied."
        locked={!platformRecording ? 'Disabled by platform' : undefined}
      >
        <Switch
          checked={!!s.recording_enabled}
          onCheckedChange={(v) => setS({ ...s, recording_enabled: v })}
          disabled={!platformRecording}
        />
      </Row>
      <Row
        label="Consent required"
        hint="Recording will not start until the visitor accepts the consent prompt in the widget."
      >
        <Switch
          checked={!!s.recording_consent_required}
          onCheckedChange={(v) => setS({ ...s, recording_consent_required: v })}
        />
      </Row>

      <div className="text-[11px] text-muted-foreground flex items-start gap-1.5 pt-1 border-t">
        <Info className="h-3 w-3 mt-0.5" />
        <span>
          Retention, legal hold, deletion and bulk export of recorded files are
          managed by the platform administrator in super-admin → Voice &amp; Video
          → Recordings. Operators can play back and download recordings from the
          Calls page.
        </span>
      </div>
    </Section>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      <span className={ok ? '' : 'text-muted-foreground'}>{label}</span>
    </div>
  );
}

function WidgetTextsEditor({
  settings,
  platform,
  onChange,
}: {
  settings: any;
  platform: any;
  onChange: (next: Record<string, Record<string, string>>) => void;
}) {
  const platformAvail: string[] = platform?.widget_available_locales || ['en'];
  const enabled: string[] = (settings.widget_enabled_locales && settings.widget_enabled_locales.length > 0)
    ? settings.widget_enabled_locales.filter((l: string) => platformAvail.includes(l))
    : platformAvail;
  const [locale, setLocale] = useState<string>(enabled[0] || 'en');
  useEffect(() => { if (!enabled.includes(locale)) setLocale(enabled[0] || 'en'); }, [enabled.join(','), locale]);

  const all: Record<string, Record<string, string>> = settings.widget_custom_texts || {};
  const current = all[locale] || {};
  const callbackOn = platform?.callback_requests_enabled !== false;
  const visibleKeys = WIDGET_TEXT_KEYS.filter((k) => callbackOn || !CALLBACK_TEXT_KEYS.has(k.key));

  function setField(key: string, val: string) {
    const nextLocale = { ...current };
    if (val.trim()) nextLocale[key] = val;
    else delete nextLocale[key];
    const next = { ...all };
    if (Object.keys(nextLocale).length > 0) next[locale] = nextLocale;
    else delete next[locale];
    onChange(next);
  }

  const isRtl = locale === 'fa';

  return (
    <div className="pt-3 border-t space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>Widget label overrides</Label>
          <p className="text-xs text-muted-foreground">
            Customize the launcher, header and button labels visitors see. Leave a field empty to use the default.
          </p>
        </div>
        <Select value={locale} onValueChange={setLocale}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {enabled.map((c) => (
              <SelectItem key={c} value={c}>{LOC_LABELS_FULL[c] || c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {visibleKeys.map(({ key, label, placeholder }) => (
          <div key={key} className="space-y-1">
            <Label className="text-xs">{label}</Label>
            <Input
              value={current[key] || ''}
              onChange={(e) => setField(key, e.target.value)}
              placeholder={placeholder[locale] || placeholder.en}
              dir={isRtl ? 'rtl' : 'ltr'}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
