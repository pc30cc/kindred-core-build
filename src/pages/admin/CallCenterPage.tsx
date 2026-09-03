import { useState, useEffect, useMemo } from 'react';
import {
  useCallCenterAdminPlatform, useUpdateCallCenterAdminPlatform, useCallCenterAdminWorkspaces,
} from '@/hooks/useCallCenter';
import { callCenterAdminApi, callCenterDiagnosticsApi, type CallCenterPlatformSettings, type LiveKitDiagnostics } from '@/lib/call-center-api';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
  const LOCALES: Array<{ key: string; label: string; placeholder: string }> = [
    { key: 'default', label: t('callCenter.adminPage.disabledMessage.defaultLocale'), placeholder: t('callCenter.adminPage.disabledMessage.placeholder') },
    { key: 'en', label: t('callCenter.adminPage.languages.names.en'), placeholder: t('callCenter.adminPage.disabledMessage.placeholders.en') },
    { key: 'tr', label: t('callCenter.adminPage.languages.names.tr'), placeholder: t('callCenter.adminPage.disabledMessage.placeholders.tr') },
    { key: 'fa', label: t('callCenter.adminPage.languages.names.fa'), placeholder: t('callCenter.adminPage.disabledMessage.placeholders.fa') },
  ];
  const WIDGET_LOCALES: Array<{ code: 'en' | 'fa' | 'tr'; label: string; native: string }> = [
    { code: 'en', label: t('callCenter.adminPage.languages.names.en'), native: 'English' },
    { code: 'fa', label: t('callCenter.adminPage.languages.names.fa'), native: 'فارسی' },
    { code: 'tr', label: t('callCenter.adminPage.languages.names.tr'), native: 'Türkçe' },
  ];
  const DIAGNOSTIC_WARNINGS: Record<string, string> = {
    livekit_disabled: t('callCenter.adminPage.livekit.warnings.disabled'),
    livekit_api_key_missing: t('callCenter.adminPage.livekit.warnings.apiKeyMissing'),
    livekit_api_secret_missing: t('callCenter.adminPage.livekit.warnings.apiSecretMissing'),
    livekit_url_missing: t('callCenter.adminPage.livekit.warnings.urlMissing'),
    recording_storage_credentials_missing: t('callCenter.adminPage.livekit.warnings.storageCredentialsMissing'),
    livekit_v1_rtc_path_not_supported: t('callCenter.adminPage.livekit.warnings.v1PathUnsupported'),
    livekit_server_unreachable: t('callCenter.adminPage.livekit.warnings.serverUnreachable'),
  };
  const LIMITS: Array<[keyof CallCenterPlatformSettings, string]> = [
    ['max_concurrent_calls_per_workspace', t('callCenter.adminPage.limits.maxConcurrent')],
    ['max_queue_size_per_workspace', t('callCenter.adminPage.limits.maxQueue')],
    ['max_monthly_call_minutes_per_workspace', t('callCenter.adminPage.limits.maxMonthlyMinutes')],
    ['max_callback_requests_per_month', t('callCenter.adminPage.limits.maxCallbacks')],
    ['max_recording_storage_mb', t('callCenter.adminPage.limits.maxRecordingMb')],
  ];
  const CALLBACK_TOGGLES: Array<[keyof CallCenterPlatformSettings, string, string]> = [
    ['callback_show_when_online', t('callCenter.adminPage.callbacks.showWhenOnline'), t('callCenter.adminPage.callbacks.showWhenOnlineHint')],
    ['callback_require_contact', t('callCenter.adminPage.callbacks.requireContact'), t('callCenter.adminPage.callbacks.requireContactHint')],
    ['callback_honeypot_enabled', t('callCenter.adminPage.callbacks.honeypot'), t('callCenter.adminPage.callbacks.honeypotHint')],
  ];
  const CALLBACK_NUMBERS: Array<[keyof CallCenterPlatformSettings, string, string]> = [
    ['callback_min_seconds_between_requests', t('callCenter.adminPage.callbacks.cooldown'), t('callCenter.adminPage.callbacks.cooldownHint')],
    ['callback_max_per_ip_per_hour', t('callCenter.adminPage.callbacks.maxPerIp'), t('callCenter.adminPage.callbacks.maxPerIpHint')],
    ['callback_min_form_seconds', t('callCenter.adminPage.callbacks.minFormSec'), t('callCenter.adminPage.callbacks.minFormSecHint')],
    ['callback_min_message_length', t('callCenter.adminPage.callbacks.minMsgLen'), t('callCenter.adminPage.callbacks.minMsgLenHint')],
  ];
  const RINGBACK_MODES: Array<{ value: 'tone' | 'music' | 'off'; label: string; hint: string }> = [
    { value: 'tone', label: t('callCenter.adminPage.ringback.toneLabel'), hint: t('callCenter.adminPage.ringback.toneHint') },
    { value: 'music', label: t('callCenter.adminPage.ringback.musicLabel'), hint: t('callCenter.adminPage.ringback.musicHint') },
    { value: 'off', label: t('callCenter.adminPage.ringback.offLabel'), hint: t('callCenter.adminPage.ringback.offHint') },
  ];
  const QUEUE_TOGGLES: Array<[keyof CallCenterPlatformSettings, string, string]> = [
    ['queue_show_position', t('callCenter.adminPage.ringback.showPosition'), t('callCenter.adminPage.ringback.showPositionHint')],
    ['queue_show_eta', t('callCenter.adminPage.ringback.showEta'), t('callCenter.adminPage.ringback.showEtaHint')],
    ['operator_new_call_sound_enabled', t('callCenter.adminPage.ringback.soundOnNewCall'), t('callCenter.adminPage.ringback.soundOnNewCallHint')],
  ];
  const QUEUE_NUMBERS: Array<[keyof CallCenterPlatformSettings, string, string]> = [
    ['queue_eta_seconds_per_position', t('callCenter.adminPage.ringback.etaPerPos'), t('callCenter.adminPage.ringback.etaPerPosHint')],
    ['queue_offer_callback_after_seconds', t('callCenter.adminPage.ringback.offerCallback'), t('callCenter.adminPage.ringback.offerCallbackHint')],
  ];
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
      toast({ title: t('callCenter.adminPage.livekit.noWorkspace'), variant: 'destructive' });
      return;
    }
    setDiagBusy(true); setDiagErr(null);
    try {
      const d = await callCenterDiagnosticsApi.getLiveKit(firstWorkspaceId);
      setDiag(d);
    } catch (e: any) {
      setDiagErr(e?.message || t('callCenter.adminPage.livekit.diagnosticsFailed'));
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
  if (isLoading || !data) return <p className="text-sm text-muted-foreground">{t('callCenter.common.loading')}</p>;

  async function save() {
    if (jsonError) { toast({ title: t('callCenter.adminPage.toasts.invalidJson'), variant: 'destructive' }); return; }
    try {
      await update.mutateAsync(draft);
      toast({ title: t('callCenter.adminPage.toasts.saved'), description: t('callCenter.adminPage.toasts.cacheInvalidated') + '.' });
    } catch (e: any) {
      toast({ title: t('callCenter.adminPage.toasts.saveFailed'), description: e.message, variant: 'destructive' });
    }
  }
  async function invalidate() {
    await callCenterAdminApi.invalidateCache();
    toast({ title: t('callCenter.adminPage.toasts.cacheInvalidated') });
  }

  async function uploadRingbackAudio(kind: 'music' | 'announcement' | 'queue', file: File | null, queuePosition?: number) {
    if (!file) return;
    const key = kind === 'queue' ? `queue-${queuePosition}` : kind;
    setAudioBusy(key);
    try {
      const r = await callCenterAdminApi.uploadRingbackAudio({ kind, file, queue_position: queuePosition });
      setDraft({ ...r.settings });
      toast({ title: t('callCenter.adminPage.ringback.audioUploaded'), description: t('callCenter.adminPage.ringback.audioUploadedHint') });
    } catch (e: any) {
      toast({ title: t('callCenter.settingsPage.uploadFailed'), description: e.message, variant: 'destructive' });
    } finally {
      setAudioBusy(null);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <header className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-2xl font-semibold">{t('callCenter.adminPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('callCenter.adminPage.subtitle')}</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full sm:w-auto">
          <Stat label={t('callCenter.adminPage.stats.killSwitch')} value={draft.call_center_enabled ? t('callCenter.adminPage.stats.on') : t('callCenter.adminPage.stats.off')} icon={ShieldCheck} />
          <Stat label={t('callCenter.adminPage.stats.enabledWs')} value={data.stats.enabled_workspaces} icon={Building2} />
          <Stat label={t('callCenter.adminPage.stats.activeCalls')} value={data.stats.active_calls} icon={Server} />
          <Stat label={t('callCenter.adminPage.stats.waiting')} value={data.stats.waiting_calls} icon={AlertCircle} />
        </div>
      </header>

      <Tabs defaultValue="kill" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="kill">{t('callCenter.adminPage.tabs.kill')}</TabsTrigger>
          <TabsTrigger value="recording">{t('callCenter.adminPage.tabs.recording')}</TabsTrigger>
          <TabsTrigger value="features">{t('callCenter.adminPage.tabs.features')}</TabsTrigger>
          <TabsTrigger value="limits">{t('callCenter.adminPage.tabs.limits')}</TabsTrigger>
          <TabsTrigger value="callbacks">{t('callCenter.adminPage.tabs.callbacks')}</TabsTrigger>
          <TabsTrigger value="ringback">{t('callCenter.adminPage.tabs.ringback')}</TabsTrigger>
          <TabsTrigger value="languages">{t('callCenter.adminPage.tabs.languages')}</TabsTrigger>
          <TabsTrigger value="livekit">{t('callCenter.adminPage.tabs.livekit')}</TabsTrigger>
          <TabsTrigger value="workspaces">{t('callCenter.adminPage.tabs.workspaces')}</TabsTrigger>
          <TabsTrigger value="retention">{t('callCenter.adminPage.tabs.retention')}</TabsTrigger>
        </TabsList>

        <TabsContent value="kill" className="space-y-4 mt-0">
        <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">{t('callCenter.adminPage.kill.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.kill.hint')}</p>
          </div>
          <Switch checked={!!draft.call_center_enabled} onCheckedChange={(v) => setDraft({ ...draft, call_center_enabled: v })} />
        </div>
        <div>
          <Label>{t('callCenter.adminPage.disabledMessage.label')}</Label>
          <p className="text-xs text-muted-foreground mb-2">{t('callCenter.adminPage.disabledMessage.hint')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {LOCALES.map((l) => (
              <div key={l.key}>
                <Label className="text-xs">{l.label}</Label>
                <Input value={messages[l.key] || ''} onChange={(e) => updateMessage(l.key, e.target.value)} placeholder={l.placeholder} />
              </div>
            ))}
          </div>
          <Collapsible className="mt-3">
            <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground">{t('callCenter.adminPage.disabledMessage.advancedJson')}</CollapsibleTrigger>
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
              {jsonError && <p className="text-xs text-destructive mt-1">{t('callCenter.adminPage.disabledMessage.jsonError')} {jsonError}</p>}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </Card>
        </TabsContent>

      <TabsContent value="recording" className="space-y-4 mt-0">
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
      </TabsContent>

      <TabsContent value="features" className="space-y-4 mt-0">
      <Card className="p-5 space-y-5">
        <h2 className="font-semibold">{t('callCenter.adminPage.featureToggles.title')}</h2>
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('callCenter.adminPage.featureToggles.core')}</div>
          {[
            ['voice_calls_enabled', t('callCenter.adminPage.featureToggles.voiceCalls')],
            ['video_calls_enabled', t('callCenter.adminPage.featureToggles.videoCalls')],
            ['callback_requests_enabled', t('callCenter.adminPage.featureToggles.callbackRequests')],
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
            ['screen_share_enabled', t('callCenter.adminPage.featureToggles.screenShare')],
            ['call_transfer_enabled', t('callCenter.adminPage.featureToggles.callTransfer')],
            ['advanced_routing_enabled', t('callCenter.adminPage.featureToggles.advancedRouting')],
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
      </TabsContent>

      <TabsContent value="limits" className="space-y-4 mt-0">
      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">{t('callCenter.adminPage.limits.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.limits.hint')}</p>
        <div className="grid grid-cols-2 gap-3">
          {LIMITS.map(([k, label]) => (
            <div key={k as string}>
              <Label>{label}</Label>
              <Input type="number" value={String((draft as any)[k] ?? 0)} onChange={(e) => setDraft({ ...draft, [k]: parseInt(e.target.value || '0', 10) } as any)} />
            </div>
          ))}
        </div>
      </Card>
      </TabsContent>

      <TabsContent value="callbacks" className="space-y-4 mt-0">
      <Card className="p-5 space-y-5">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-5 w-5 text-amber-600 mt-0.5" />
          <div>
            <h2 className="font-semibold">{t('callCenter.adminPage.callbacks.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.callbacks.hint')}</p>
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
      </TabsContent>

      <TabsContent value="ringback" className="space-y-4 mt-0">
      <Card className="p-5 space-y-5">
        <div className="flex items-start gap-2">
          <PhoneCall className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <h2 className="font-semibold">{t('callCenter.adminPage.ringback.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.ringback.hint')}</p>
          </div>
        </div>

        <div className="flex items-start justify-between gap-3 py-1">
          <div className="min-w-0">
            <Label>{t('callCenter.adminPage.ringback.enable')}</Label>
            <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.ringback.enableHint')}</p>
          </div>
          <Switch
            checked={!!draft.ringback_enabled}
            onCheckedChange={(v) => setDraft({ ...draft, ringback_enabled: v })}
          />
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2"><Music className="h-3.5 w-3.5" /> {t('callCenter.adminPage.ringback.mode')}</Label>
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
            <Label className="flex items-center gap-2"><Upload className="h-3.5 w-3.5" /> {t('callCenter.adminPage.ringback.uploadsTitle')}</Label>
            <p className="text-[11px] text-muted-foreground mt-1">{t('callCenter.adminPage.ringback.uploadsHint')}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('callCenter.adminPage.ringback.holdMusic')}</Label>
              <Input
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac"
                disabled={audioBusy === 'music'}
                onChange={(e) => uploadRingbackAudio('music', e.target.files?.[0] || null)}
              />
              {draft.ringback_music_url && <audio className="w-full h-8" controls src={draft.ringback_music_url} />}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('callCenter.adminPage.ringback.generalAnnouncement')}</Label>
              <Input
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac"
                disabled={audioBusy === 'announcement'}
                onChange={(e) => uploadRingbackAudio('announcement', e.target.files?.[0] || null)}
              />
            </div>
          </div>
          <div className="space-y-2 pt-2 border-t">
            <Label className="text-xs">{t('callCenter.adminPage.ringback.queueAudioTitle')}</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[1, 2, 3, 4, 5, 6].map((pos) => (
                <div key={pos} className="space-y-1 rounded-md border border-input p-2">
                  <Label className="text-[11px]">{t('callCenter.adminPage.ringback.queueLabel', { pos: String(pos) })}</Label>
                  <Input
                    type="file"
                    accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac"
                    disabled={audioBusy === `queue-${pos}`}
                    onChange={(e) => uploadRingbackAudio('queue', e.target.files?.[0] || null, pos)}
                  />
                  {(draft.ringback_queue_audio_paths || {})[String(pos)] && (
                    <p className="text-[10px] text-muted-foreground">{t('callCenter.adminPage.ringback.uploaded')}</p>
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
          <Button onClick={save} disabled={update.isPending}>{t('callCenter.adminPage.ringback.saveBtn')}</Button>
        </div>
      </Card>
      </TabsContent>

      <TabsContent value="languages" className="space-y-4 mt-0">
      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-2">
          <Languages className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <h2 className="font-semibold">{t('callCenter.adminPage.languages.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.languages.hint')}</p>
          </div>
        </div>

        <div>
          <Label>{t('callCenter.adminPage.languages.defaultLabel')}</Label>
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
          <p className="text-[11px] text-muted-foreground mt-1">{t('callCenter.adminPage.languages.defaultHint')}</p>
        </div>

        <div className="pt-2 border-t">
          <Label>{t('callCenter.adminPage.languages.availableLabel')}</Label>
          <p className="text-xs text-muted-foreground mb-2">{t('callCenter.adminPage.languages.availableHint')}</p>
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
                        {t('callCenter.adminPage.languages.default')}
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
          <Button onClick={save} disabled={update.isPending}>{t('callCenter.adminPage.languages.saveBtn')}</Button>
        </div>
      </Card>
      </TabsContent>

      <TabsContent value="livekit" className="space-y-4 mt-0">
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-semibold flex items-center gap-2"><Activity className="h-4 w-4" /> {t('callCenter.adminPage.livekit.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.livekit.hint')}</p>
          </div>
          <Button size="sm" variant="outline" onClick={runDiagnostics} disabled={diagBusy || !firstWorkspaceId}>
            {diagBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
            <span className="ms-1.5">{t('callCenter.adminPage.livekit.runDiagnostics')}</span>
          </Button>
        </div>
        {diagErr && <p className="text-xs text-destructive">{diagErr}</p>}
        {diag && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <DiagRow label={t('callCenter.adminPage.livekit.serverUrl')} value={diag.server_url_public || '—'} mono />
              <DiagRow label={t('callCenter.adminPage.livekit.normalized')} value={diag.server_url_public_normalized || '—'} mono />
              <DiagRow label={t('callCenter.adminPage.livekit.apiKey')} value={diag.api_key_present ? t('callCenter.adminPage.livekit.present') : t('callCenter.adminPage.livekit.missing')} ok={diag.api_key_present} />
              <DiagRow label={t('callCenter.adminPage.livekit.apiSecret')} value={diag.api_secret_present ? t('callCenter.adminPage.livekit.present') : t('callCenter.adminPage.livekit.missing')} ok={diag.api_secret_present} />
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
                    <span>{DIAGNOSTIC_WARNINGS[w] || w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
      </TabsContent>

      <TabsContent value="workspaces" className="space-y-4 mt-0">
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="font-semibold">{t('callCenter.adminPage.workspacesPanel.title')}</h2>
          <div className="relative w-64 max-w-full">
            <Search className="h-3.5 w-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8 h-8 text-sm" placeholder={t('callCenter.adminPage.workspacesPanel.search')} value={wsSearch} onChange={(e) => setWsSearch(e.target.value)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b">
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.workspace')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.slug')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.enabled')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.voice')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.video')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.callback')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.admin.workspaces.recording')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.publicKey')}</th>
                <th className="text-start py-2 px-2">{t('callCenter.adminPage.workspacesPanel.headers.updated')}</th>
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
                <tr><td colSpan={9} className="py-4 text-center text-muted-foreground">{t('callCenter.adminPage.workspacesPanel.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      </TabsContent>

      <TabsContent value="retention" className="space-y-4 mt-0">
      <Card className="p-5 space-y-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-5 w-5 text-primary mt-0.5" />
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold">{t('callCenter.adminPage.retentionCard.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('callCenter.adminPage.retentionCard.hint')}</p>
          </div>
        </div>
        <RecordingRetentionPanel />
      </Card>
      </TabsContent>
      </Tabs>

      <div className="flex gap-2 sticky bottom-4 z-10 bg-background/95 backdrop-blur p-2 rounded-md border shadow-sm">
        <Button onClick={save} disabled={update.isPending}>{t('callCenter.adminPage.buttons.savePlatform')}</Button>
        <Button variant="outline" onClick={invalidate}>{t('callCenter.adminPage.buttons.invalidateCache')}</Button>
      </div>
    </div>
  );
}
