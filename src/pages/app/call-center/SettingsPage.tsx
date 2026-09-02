import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterSettings, useUpdateCallCenterSettings } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useEffect, useMemo, useState, useRef } from 'react';
import { toast } from '@/hooks/use-toast';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, RotateCcw, Save, Languages, Plus, Trash2 } from 'lucide-react';
import { CheckCircle2, XCircle, ShieldCheck, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link, useParams } from 'react-router-dom';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
// CC-2G-UI-Architecture-Fix — read canonical departments from
// Team & Departments instead of the deprecated Call Center departments
// hook. Only departments with a Call Center channel enabled are
// surfaced as options here.
import { useQuery } from '@tanstack/react-query';
import { listDepartments } from '@/lib/workspace-departments-api';
import { useTranslation } from '@/i18n';

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
  const { t, dir } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { allowedLocales: regionLocales, canSwitchLanguage: regionMultilingual } = usePlatformRegion();
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
  const [previewOnline, setPreviewOnline] = useState(true);
  const [tab, setTab] = useState('general');

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
      'widget_template_id', 'widget_theme', 'pre_call_form_schema',
    ];
    return keys.some((k) => JSON.stringify(s[k]) !== JSON.stringify(original[k]));
  }, [s, original]);

  if (isLoading || !s) return <p className="text-sm text-muted-foreground">{t('callCenter.common.loading')}</p>;

  const platform = data?.platform;
  const platformOff = !platform?.call_center_enabled;
  const platformVoice = platform?.voice_calls_enabled !== false;
  const platformVideo = platform?.video_calls_enabled !== false;
  const platformCallback = platform?.callback_requests_enabled !== false;
  // Use strict boolean coercion to match the backend's !!platform.call_recording_enabled.
  // A null/undefined platform flag means recording is disabled, not enabled.
  const platformRecording = !!platform?.call_recording_enabled;
  const planRecording = !!data?.recording?.enabled_by_plan;
  const showRecordingTab = platformRecording && planRecording;

  async function save() {
    if (!workspace) return;
    await update.mutateAsync({
      enabled: s.enabled, display_name: s.display_name,
      voice_enabled: s.voice_enabled, video_enabled: s.video_enabled,
      callback_enabled: s.callback_enabled, pre_call_form_enabled: s.pre_call_form_enabled,
      offline_behavior: s.offline_behavior, recording_enabled: s.recording_enabled,
      recording_consent_required: s.recording_consent_required, routing_mode: s.routing_mode,
      widget_position: s.widget_position, business_hours: s.business_hours,
      widget_template_id: s.widget_template_id || 'default',
      widget_theme: s.widget_theme || {},
      pre_call_form_schema: s.pre_call_form_schema || [],
      default_department_id: s.default_department_id ?? null,
      widget_default_locale: s.widget_default_locale ?? null,
      widget_enabled_locales: s.widget_enabled_locales ?? null,
      widget_custom_texts: s.widget_custom_texts ?? {},
      operator_video_visible_to_visitor: s.operator_video_visible_to_visitor !== false,
    });
    setOriginal({ ...s });
    toast({ title: t('callCenter.settingsPage.saved') });
  }
  function reset() { setS({ ...original }); }

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !workspace) return;
    if (f.size > 2 * 1024 * 1024) { toast({ title: t('callCenter.settingsPage.max2mb'), variant: 'destructive' }); return; }
    try {
      const r = await callCenterApi.uploadAvatar(workspace.id, f);
      toast({ title: t('callCenter.settingsPage.avatarUploaded') });
      setS((p: any) => ({ ...p, avatar_url: r.avatar_url }));
      setOriginal((p: any) => ({ ...p, avatar_url: r.avatar_url }));
      qc.invalidateQueries({ queryKey: ['call-center', 'settings'] });
    } catch (err: any) {
      toast({ title: t('callCenter.settingsPage.uploadFailed'), description: err.message, variant: 'destructive' });
    }
  }

  return (
    <div className={cn('space-y-6 pb-24', tab === 'presentation' ? 'max-w-6xl' : 'max-w-3xl')} dir={dir}>
      {platformOff && (
        <Card className="p-4 border-destructive/40 bg-destructive/5 flex gap-2 items-start">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
          <div className="text-sm">{t('callCenter.settingsPage.platformDisabledBanner')}</div>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab} className="space-y-4" dir={dir}>
      <TabsList className="flex flex-wrap h-auto gap-1 w-full justify-start">
        <TabsTrigger value="general">{t('callCenter.settingsPage.tabs.general')}</TabsTrigger>
        <TabsTrigger value="presentation">{t('callCenter.settingsPage.tabs.presentation')}</TabsTrigger>
        <TabsTrigger value="languages">{t('callCenter.settingsPage.tabs.languages')}</TabsTrigger>
        <TabsTrigger value="channels">{t('callCenter.settingsPage.tabs.channels')}</TabsTrigger>
        <TabsTrigger value="availability">{t('callCenter.settingsPage.tabs.availability')}</TabsTrigger>
        <TabsTrigger value="routing">{t('callCenter.settingsPage.tabs.routing')}</TabsTrigger>
        {showRecordingTab && (
          <TabsTrigger value="recording">{t('callCenter.settingsPage.tabs.recording')}</TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="general" className="space-y-6 mt-0">
      <Section title={t('callCenter.settingsPage.identityBranding')} description={t('callCenter.settingsPage.identityBrandingHint')}>
        <Row label={t('callCenter.settingsPage.displayName')}>
          <Input value={s.display_name || ''} onChange={(e) => setS({ ...s, display_name: e.target.value })} placeholder="Support" className="w-60" />
        </Row>
        <div className="flex items-center gap-3">
          {s.avatar_url
            ? <img src={s.avatar_url} alt="" className="h-12 w-12 rounded-full object-cover border" />
            : <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs">{t('callCenter.settingsPage.noAvatar')}</div>}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onAvatar} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>{t('callCenter.settingsPage.upload')}</Button>
          <span className="text-xs text-muted-foreground">{t('callCenter.settingsPage.avatarHint')}</span>
        </div>
        <Row label={t('callCenter.settingsPage.widgetPosition')}>
          <Select value={s.widget_position || 'right'} onValueChange={(v) => setS({ ...s, widget_position: v })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="right">{t('callCenter.settingsPage.right')}</SelectItem>
              <SelectItem value="left">{t('callCenter.settingsPage.left')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <WidgetTextsEditor
          settings={s}
          platform={platform}
          onChange={(next) => setS({ ...s, widget_custom_texts: next })}
        />
      </Section>
      </TabsContent>

      <TabsContent value="presentation" className="space-y-6 mt-0">
        <Section
          title={t('callCenter.settingsPage.presentationTitle')}
          description={t('callCenter.settingsPage.presentationHint')}
        >
          <Row label={t('callCenter.settingsPage.template')}>
            <Select
              value={s.widget_template_id || 'default'}
              onValueChange={(v) => setS({ ...s, widget_template_id: v })}
            >
              <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t('callCenter.settingsPage.defaultTemplate')}</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              ['primary', t('callCenter.settingsPage.primaryColor'), '#3b82f6'],
              ['accent', t('callCenter.settingsPage.accentColor'), '#10b981'],
              ['surface', t('callCenter.settingsPage.surfaceColor'), '#ffffff'],
              ['text', t('callCenter.settingsPage.textColor'), '#111827'],
              ['muted', t('callCenter.settingsPage.mutedColor'), '#64748b'],
              ['danger', t('callCenter.settingsPage.dangerColor'), '#dc2626'],
            ].map(([key, label, fallback]) => (
              <div key={key} className="space-y-1.5">
                <Label>{label}</Label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    className="w-12 px-1"
                    value={s.widget_theme?.[key] || fallback}
                    onChange={(e) => setS({
                      ...s,
                      widget_theme: { ...(s.widget_theme || {}), [key]: e.target.value },
                    })}
                  />
                  <Input
                    value={s.widget_theme?.[key] || ''}
                    placeholder={fallback}
                    onChange={(e) => setS({
                      ...s,
                      widget_theme: { ...(s.widget_theme || {}), [key]: e.target.value },
                    })}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Row label={t('callCenter.settingsPage.radius')}>
              <Select
                value={s.widget_theme?.radius || 'md'}
                onValueChange={(v) => setS({ ...s, widget_theme: { ...(s.widget_theme || {}), radius: v } })}
              >
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sm">{t('callCenter.settingsPage.small')}</SelectItem>
                  <SelectItem value="md">{t('callCenter.settingsPage.medium')}</SelectItem>
                  <SelectItem value="lg">{t('callCenter.settingsPage.large')}</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label={t('callCenter.settingsPage.density')}>
              <Select
                value={s.widget_theme?.density || 'comfortable'}
                onValueChange={(v) => setS({ ...s, widget_theme: { ...(s.widget_theme || {}), density: v } })}
              >
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">{t('callCenter.settingsPage.compact')}</SelectItem>
                  <SelectItem value="comfortable">{t('callCenter.settingsPage.comfortable')}</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </div>
        </Section>
        <Section
          title={t('callCenter.settingsPage.livePreview')}
          description={t('callCenter.settingsPage.livePreviewHint')}
        >
          <Select value={previewOnline ? 'online' : 'offline'} onValueChange={(v) => setPreviewOnline(v === 'online')}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="online">{t('callCenter.settingsPage.previewOnline')}</SelectItem>
              <SelectItem value="offline">{t('callCenter.settingsPage.previewOffline')}</SelectItem>
            </SelectContent>
          </Select>
          <CallWidgetPreview settings={s} online={previewOnline} />
        </Section>
      </TabsContent>

      <TabsContent value="languages" className="space-y-6 mt-0">
      {(() => {
        const LOC_LABELS: Record<string, { label: string; native: string }> = {
          en: { label: 'English', native: 'English' },
          fa: { label: 'Persian', native: 'فارسی' },
          tr: { label: 'Turkish', native: 'Türkçe' },
        };
        // Intersect the call-center-specific "available locales" (set by a
        // super admin for this feature) with the platform's active
        // region/language mode — the call center can never offer a language
        // the rest of the product doesn't speak on this deployment.
        const rawPlatformAvail: string[] = (platform as any)?.widget_available_locales || ['en'];
        const regionScoped = rawPlatformAvail.filter((c) => (regionLocales as string[]).includes(c));
        const platformAvail: string[] = regionScoped.length ? regionScoped : (regionLocales.length ? regionLocales : rawPlatformAvail);
        const platformDefault: string = (platform as any)?.widget_default_locale || 'en';
        const wsEnabled: string[] = (s.widget_enabled_locales && s.widget_enabled_locales.length > 0)
          ? s.widget_enabled_locales
          : platformAvail;
        const wsDefault: string = (s.widget_default_locale && platformAvail.includes(s.widget_default_locale))
          ? s.widget_default_locale
          : (platformAvail.includes(platformDefault) ? platformDefault : platformAvail[0]);
        const effective = wsEnabled.filter((c) => platformAvail.includes(c));
        const singleLanguage = !regionMultilingual || platformAvail.length <= 1;
        return (
          <Section
            title={t('callCenter.settingsPage.widgetLanguages')}
            description={t('callCenter.settingsPage.widgetLanguagesHint')}
          >
            {singleLanguage ? (
              <p className="text-sm text-muted-foreground">
                {(LOC_LABELS[platformAvail[0]]?.label) || platformAvail[0]}
                <span className="ms-1">({LOC_LABELS[platformAvail[0]]?.native || platformAvail[0]})</span>
              </p>
            ) : (
            <>
            <Row label={t('callCenter.settingsPage.defaultLanguage')} hint={t('callCenter.settingsPage.defaultLanguageHint')}>
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
              <Label className="flex items-center gap-2"><Languages className="h-3.5 w-3.5" /> {t('callCenter.settingsPage.enabledLanguages')}</Label>
              <p className="text-xs text-muted-foreground">{t('callCenter.settingsPage.enabledLanguagesHint')}</p>
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
                            {t('callCenter.settingsPage.default')}
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
            </div>
            </>
            )}
          </Section>
        );
      })()}
      </TabsContent>

      <TabsContent value="channels" className="space-y-6 mt-0">
      <Section title={t('callCenter.settingsPage.callModes')} description={t('callCenter.settingsPage.callModesHint')}>
        <Row label={t('callCenter.settingsPage.voiceCalls')} locked={!platformVoice ? t('callCenter.settingsPage.disabledByPlatform') : undefined}>
          <Switch checked={!!s.voice_enabled} onCheckedChange={(v) => setS({ ...s, voice_enabled: v })} disabled={!platformVoice} />
        </Row>
        <Row label={t('callCenter.settingsPage.videoCalls')} locked={!platformVideo ? t('callCenter.settingsPage.disabledByPlatform') : undefined}>
          <Switch checked={!!s.video_enabled} onCheckedChange={(v) => setS({ ...s, video_enabled: v })} disabled={!platformVideo} />
        </Row>
        {platformCallback && (
          <Row label={t('callCenter.settingsPage.callbackRequests')}>
            <Switch checked={!!s.callback_enabled} onCheckedChange={(v) => setS({ ...s, callback_enabled: v })} />
          </Row>
        )}
        <Row label={t('callCenter.settingsPage.preCallFormShort')} hint={t('callCenter.settingsPage.preCallFormHint')}>
          <Switch checked={!!s.pre_call_form_enabled} onCheckedChange={(v) => setS({ ...s, pre_call_form_enabled: v })} />
        </Row>
        <Row
          label={t('callCenter.settingsPage.visitorSeesOperatorVideo')}
          hint={t('callCenter.settingsPage.visitorSeesOperatorVideoHint')}
          locked={!platformVideo ? t('callCenter.settingsPage.videoDisabledByPlatform') : undefined}
        >
          <Switch
            checked={s.operator_video_visible_to_visitor !== false}
            disabled={!platformVideo}
            onCheckedChange={(v) => setS({ ...s, operator_video_visible_to_visitor: v })}
          />
        </Row>
      </Section>

      <Section title={t('callCenter.settingsPage.preCallFormSection')} description={t('callCenter.settingsPage.preCallFormSectionHint')}>
        <PreCallFormBuilder
          value={Array.isArray(s.pre_call_form_schema) ? s.pre_call_form_schema : []}
          onChange={(value) => setS({ ...s, pre_call_form_schema: value })}
          t={t}
        />
      </Section>
      </TabsContent>

      <TabsContent value="availability" className="space-y-6 mt-0">
      <Section title={t('callCenter.settingsPage.availabilityOffline')} description={t('callCenter.settingsPage.availabilityOfflineHint')}>
        <Row label={t('callCenter.settingsPage.offlineBehavior')}>
          <Select value={s.offline_behavior || 'show_callback'} onValueChange={(v) => setS({ ...s, offline_behavior: v })}>
            <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="hide">{t('callCenter.settingsPage.hideWidget')}</SelectItem>
              {platformCallback && <SelectItem value="show_callback">{t('callCenter.settingsPage.showCallbackRequest')}</SelectItem>}
              <SelectItem value="show_message">{t('callCenter.settingsPage.showOfflineMessage')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-3 w-3" /> {t('callCenter.settingsPage.advancedBusinessHours')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="bg-muted p-2 rounded text-xs mt-2 overflow-x-auto">{JSON.stringify(s.business_hours || {}, null, 2)}</pre>
            <p className="text-xs text-muted-foreground mt-1">{t('callCenter.settings.businessHoursPlaceholder')}</p>
          </CollapsibleContent>
        </Collapsible>
      </Section>
      </TabsContent>

      <TabsContent value="routing" className="space-y-6 mt-0">
      <Section title={t('callCenter.settingsPage.routing')} description={t('callCenter.settingsPage.routingHint')}>
        <Row label={t('callCenter.settingsPage.routingMode')}>
          <Select value={s.routing_mode || 'broadcast'} onValueChange={(v) => setS({ ...s, routing_mode: v })}>
            <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="broadcast">{t('callCenter.settingsPage.broadcastOption')}</SelectItem>
              <SelectItem value="round_robin">{t('callCenter.settingsPage.roundRobinOption')}</SelectItem>
              <SelectItem value="least_busy">{t('callCenter.settingsPage.leastBusyOption')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section
        title={t('callCenter.settingsPage.departmentsRouting')}
        description={t('callCenter.settingsPage.departmentsRoutingHint')}>
        {ccDepartments.length === 0 && (
          <div className="flex gap-2 items-start text-xs p-3 rounded bg-amber-500/10 border border-amber-500/30">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
            <span>
              {t('callCenter.settingsPage.noDeptEnabled')}{' '}
              <Link to={`/app/w/${slug}/settings/team-departments`} className="text-primary underline">
                {t('callCenter.settingsPage.teamDepartmentsLink')}
              </Link>
            </span>
          </div>
        )}
        <Row label={t('callCenter.settingsPage.defaultDepartment')} hint={t('callCenter.settingsPage.defaultDepartmentHint')}>
          <Select
            value={s.default_department_id || '__none__'}
            onValueChange={(v) => setS({ ...s, default_department_id: v === '__none__' ? null : v })}
          >
            <SelectTrigger className="w-60"><SelectValue placeholder={t('callCenter.common.none')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('callCenter.common.none')}</SelectItem>
              {ccDepartments.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <div className="text-xs text-muted-foreground space-y-1">
          <div><b>{t('callCenter.settingsPage.broadcastOption').split('—')[0].trim()}</b> — {t('callCenter.settingsPage.broadcastDesc')}</div>
          <div><b>{t('callCenter.settingsPage.roundRobinOption').split('—')[0].trim()}</b> — {t('callCenter.settingsPage.roundRobinDesc')}</div>
          <div><b>{t('callCenter.settingsPage.leastBusyOption').split('—')[0].trim()}</b> — {t('callCenter.settingsPage.leastBusyDesc')}</div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/app/w/${slug}/settings/team-departments`}>{t('callCenter.settingsPage.manageDepartments')}</Link>
        </Button>
      </Section>
      </TabsContent>

      {showRecordingTab && (
        <TabsContent value="recording" className="space-y-6 mt-0">
          <RecordingSection
            s={s}
            setS={setS}
            platformRecording={platformRecording}
            recording={(data as any)?.recording || null}
          />
        </TabsContent>
      )}
      </Tabs>

      {/* Sticky save bar */}
      {dirty && (
        <div className="fixed bottom-4 inset-x-0 mx-auto max-w-3xl px-6 z-30">
          <Card className="p-3 flex items-center gap-3 shadow-lg border-primary/30 bg-card">
            <span className="text-sm flex-1">{t('callCenter.common.unsavedChanges')}</span>
            <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="h-3.5 w-3.5 me-1" />{t('callCenter.common.reset')}</Button>
            <Button size="sm" onClick={save} disabled={update.isPending}><Save className="h-3.5 w-3.5 me-1" />{t('callCenter.common.saveChanges')}</Button>
          </Card>
        </div>
      )}
    </div>
  );
}

type PreCallField = {
  id: string;
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox';
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
};

function PreCallFormBuilder({
  value,
  onChange,
  t,
}: {
  value: PreCallField[];
  onChange: (value: PreCallField[]) => void;
  t: (key: string) => string;
}) {
  const updateField = (index: number, patch: Partial<PreCallField>) => {
    onChange(value.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  };
  const addField = () => {
    if (value.length >= 12) return;
    let suffix = value.length + 1;
    while (value.some((field) => field.id === `field_${suffix}`)) suffix += 1;
    onChange([...value, { id: `field_${suffix}`, type: 'text', label: t('callCenter.settingsPage.newField'), required: false }]);
  };

  return (
    <div className="space-y-3">
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('callCenter.settingsPage.defaultFormHint')}</p>
      )}
      {value.map((field, index) => (
        <Card key={`${field.id}-${index}`} className="p-3 space-y-3 bg-muted/20">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>{t('callCenter.settingsPage.fieldLabel')}</Label>
              <Input value={field.label} maxLength={120} onChange={(e) => updateField(index, { label: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>{t('callCenter.settingsPage.fieldId')}</Label>
              <Input
                value={field.id}
                maxLength={40}
                onChange={(e) => updateField(index, {
                  id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, ''),
                })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('callCenter.settingsPage.fieldType')}</Label>
              <Select
                value={field.type}
                onValueChange={(type: PreCallField['type']) => updateField(index, {
                  type,
                  options: type === 'select' ? (field.options?.length ? field.options : [{ value: 'option_1', label: 'Option 1' }]) : undefined,
                })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['text', 'email', 'tel', 'textarea', 'select', 'checkbox'] as const).map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('callCenter.settingsPage.placeholder')}</Label>
              <Input
                value={field.placeholder || ''}
                maxLength={160}
                disabled={field.type === 'checkbox'}
                onChange={(e) => updateField(index, { placeholder: e.target.value || undefined })}
              />
            </div>
          </div>
          {field.type === 'select' && (
            <div className="space-y-2">
              <Label>{t('callCenter.settingsPage.options')}</Label>
              {(field.options || []).map((option, optionIndex) => (
                <div key={optionIndex} className="flex gap-2">
                  <Input
                    value={option.label}
                    maxLength={120}
                    onChange={(e) => {
                      const options = [...(field.options || [])];
                      options[optionIndex] = { ...option, label: e.target.value };
                      updateField(index, { options });
                    }}
                  />
                  <Input
                    value={option.value}
                    maxLength={80}
                    onChange={(e) => {
                      const options = [...(field.options || [])];
                      options[optionIndex] = { ...option, value: e.target.value };
                      updateField(index, { options });
                    }}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={(field.options || []).length <= 1}
                    onClick={() => updateField(index, { options: field.options?.filter((_, i) => i !== optionIndex) })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={(field.options || []).length >= 30}
                onClick={() => updateField(index, {
                  options: [...(field.options || []), { value: `option_${(field.options?.length || 0) + 1}`, label: `Option ${(field.options?.length || 0) + 1}` }],
                })}
              >
                <Plus className="h-3.5 w-3.5 me-1" />{t('callCenter.settingsPage.addOption')}
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={!!field.required} onCheckedChange={(required) => updateField(index, { required })} />
              {t('callCenter.settingsPage.requiredField')}
            </label>
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter((_, i) => i !== index))}>
              <Trash2 className="h-3.5 w-3.5 me-1" />{t('callCenter.settingsPage.removeField')}
            </Button>
          </div>
        </Card>
      ))}
      <Button type="button" variant="outline" size="sm" disabled={value.length >= 12} onClick={addField}>
        <Plus className="h-3.5 w-3.5 me-1" />{t('callCenter.settingsPage.addField')}
      </Button>
    </div>
  );
}

function CallWidgetPreview({ settings, online }: { settings: any; online: boolean }) {
  const bootstrap = {
    status: 'ok',
    provider_ready: true,
    assets_version: 'preview',
    session: 'preview',
    config: {
      display_name: settings.display_name,
      avatar_url: settings.avatar_url,
      widget_position: settings.widget_position,
      widget_template_id: settings.widget_template_id || 'default',
      widget_theme: settings.widget_theme || {},
      pre_call_form_enabled: settings.pre_call_form_enabled,
      pre_call_form_schema: settings.pre_call_form_schema || [],
      offline_behavior: settings.offline_behavior || 'show_callback',
      custom_texts: settings.widget_custom_texts || {},
    },
    capabilities: {
      voice: online && settings.voice_enabled !== false,
      video: online && settings.video_enabled !== false,
      callback: settings.callback_enabled !== false,
      recording: false,
      operator_video_visible: true,
    },
    callback_policy: { enabled: true, show_when_online: true },
    departments: { voice: [], video: [], callback: [] },
    recording: { effective_enabled: false },
    i18n: {
      default_locale: settings.widget_default_locale || 'en',
      available_locales: settings.widget_enabled_locales?.length ? settings.widget_enabled_locales : ['en'],
    },
  };
  const data = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script src="/call-widget/presentation-registry.js"></script>
    <script src="/call-widget/presentation-default.js"></script>
    <script src="/call-widget/runtime.js"></script>
    <script>window.CallCenterWidget.mount({apiBase:'',origin:parent.location.origin,preview:true,bootstrap:${data}});</script>
  </body></html>`;
  return (
    <iframe
      key={data}
      title="Call Widget live preview"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={srcDoc}
      className="w-full h-[700px] rounded-lg border bg-muted/20"
    />
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
// Derives the effective state and the first failing gate directly from the
// capability flags so the UI can never show a reason that contradicts the
// checklist. Falls back gracefully when the backend capability is missing.
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
    enabled_by_plan: boolean;
    enabled_by_workspace: boolean;
    consent_required: boolean;
    provider_supported: boolean;
    provider_configured: boolean;
    effective_enabled: boolean;
    reason?: string;
  } | null;
}) {
  const { t } = useTranslation();

  const enabledByPlatform = recording?.enabled_by_platform ?? platformRecording;
  const enabledByPlan = recording?.enabled_by_plan ?? false;
  const enabledByWorkspace = recording?.enabled_by_workspace ?? !!s.recording_enabled;
  const providerSupported = recording?.provider_supported ?? false;
  const providerConfigured = recording?.provider_configured ?? false;

  const eff = enabledByPlatform && enabledByPlan && enabledByWorkspace && providerSupported && providerConfigured;

  let reason: 'platform_disabled' | 'plan_forbidden' | 'workspace_disabled' | 'provider_not_supported' | 'provider_not_configured' | 'unknown';
  if (!enabledByPlatform) reason = 'platform_disabled';
  else if (!enabledByPlan) reason = 'plan_forbidden';
  else if (!enabledByWorkspace) reason = 'workspace_disabled';
  else if (!providerSupported) reason = 'provider_not_supported';
  else if (!providerConfigured) reason = 'provider_not_configured';
  else reason = 'unknown';

  const gates = [
    { ok: enabledByPlatform, label: t('callCenter.recording.gate.platform') },
    { ok: enabledByPlan, label: t('callCenter.recording.gate.plan') },
    { ok: enabledByWorkspace, label: t('callCenter.recording.gate.workspace') },
    { ok: providerSupported, label: t('callCenter.recording.gate.provider_support') },
    { ok: providerConfigured, label: t('callCenter.recording.gate.provider_config') },
  ];

  return (
    <Section
      title={t('callCenter.recording.title')}
      description={t('callCenter.recording.description')}
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
          <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />
        ) : (
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
        )}
        <div className="text-xs space-y-1">
          <div className="font-semibold">
            {eff ? t('callCenter.recording.effectiveOn') : t('callCenter.recording.effectiveOff')}
          </div>
          {!eff && (
            <div className="text-muted-foreground">
              {t(`callCenter.recording.reason.${reason}` as const)}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('callCenter.recording.readiness')}
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {gates.map((g) => (
            <CheckRow key={g.label} ok={g.ok} label={g.label} />
          ))}
        </div>
      </div>

      <Row
        label={t('callCenter.recording.switch.label')}
        hint={t('callCenter.recording.switch.hint')}
        locked={!enabledByPlatform ? t('callCenter.recording.switch.locked') : undefined}
      >
        <Switch
          checked={!!s.recording_enabled}
          onCheckedChange={(v) => setS({ ...s, recording_enabled: v })}
          disabled={!enabledByPlatform}
        />
      </Row>
      <Row
        label={t('callCenter.recording.consent.label')}
        hint={t('callCenter.recording.consent.hint')}
      >
        <Switch
          checked={!!s.recording_consent_required}
          onCheckedChange={(v) => setS({ ...s, recording_consent_required: v })}
        />
      </Row>

      <div className="text-[11px] text-muted-foreground flex items-start gap-1.5 pt-1 border-t">
        <Info className="h-3 w-3 mt-0.5" />
        <span>{t('callCenter.recording.footer')}</span>
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
  const { t } = useTranslation();
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
          <Label>{t('callCenter.settingsPage.widgetLabelOverrides')}</Label>
          <p className="text-xs text-muted-foreground">{t('callCenter.settingsPage.widgetLabelOverridesHint')}</p>
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
