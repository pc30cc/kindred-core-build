import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterSettings, useUpdateCallCenterSettings } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Panel, SectionHeading } from '@/features/calls/callCenterUi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import { toast } from '@/hooks/use-toast';
import {
  CALLBACK_HOURS_LIMITS,
  callCenterApi,
  callWidgetDesignPatch,
  cleanCallWidgetTheme,
  defaultCallbackHours,
  effectiveCallWidgetLocales,
  isCallbackHoursStrict,
  isMigrationPendingError,
  type CallCenterPlatformSettings,
  type CallCenterWorkspaceSettings,
  type CallWidgetDesignKey,
} from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { useWidgetSettings } from '@/hooks/useWidgetSettings';
import { useWorkspaceMembers, type WorkspaceMember } from '@/hooks/useWorkspaceMembers';
import { CallLauncherStylePicker } from '@/components/app/call-center/CallLauncherStylePicker';
import { WeeklyHoursEditor } from '@/components/app/widget/WeeklyHoursEditor';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { BusinessHoursConfig, WidgetSettings } from '@/types/models';
import {
  AlertCircle, RotateCcw, Save, Languages, Plus, Trash2,
  Palette, Phone, ClipboardList, CalendarClock, Route, Mic, Monitor, Smartphone,
} from 'lucide-react';
import { CheckCircle2, XCircle, ShieldCheck, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link, useParams } from 'react-router-dom';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { intlLocaleFor } from '@/lib/region';
import { useEdition } from '@/hooks/useEdition';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { brandName as platformBrandName, useBrandVersion } from '@/lib/brand';
import {
  CALL_WIDGET_TEMPLATES,
  EDITION_CALL_WIDGET_TEMPLATES,
  resolveCallWidgetTemplateForEdition,
  widgetDateHints,
} from '../../../../shared/widgetTemplates';
import {
  CALL_WIDGET_POSITIONS,
  callLauncherNeedsPresence,
  normalizeCallLauncherStyle,
  normalizeCallWidgetPosition,
} from '../../../../shared/callLauncherStyles';
import {
  CALLBACK_DAYS_AHEAD,
  CALLBACK_SLOT_CAPACITY,
  CALLBACK_SLOT_MINUTES,
  DAY_KEYS,
  callbackHoursHaveInterval,
  computeCallbackSlots,
  type BusinessHours,
} from '../../../../shared/callbackSlots';
import { chatTemplateOptionKeys } from '../../../../shared/chatTemplateCatalog';
import { widgetTeamMembers } from '../../../../shared/widgetTeam';
import { launcherInitial } from '../../../../shared/launcherStyles';
import type { Edition } from '../../../../shared/edition';
import { INTL_BRAND } from '../../../../shared/internationalMode';
import { WEBYAR_BRAND, useWebyarKit } from '@/lib/webyarBrand';
// CC-2G-UI-Architecture-Fix — read canonical departments from
// Team & Departments instead of the deprecated Call Center departments
// hook. Only departments with a Call Center channel enabled are
// surfaced as options here.
import { useQuery } from '@tanstack/react-query';
import { listDepartments } from '@/lib/workspace-departments-api';
import { useTranslation } from '@/i18n';
import { SkeletonForm, SkeletonCard, Skeleton } from '@/components/common/Skeletons';

/**
 * One settings group.
 *
 * `icon` is optional so existing call sites keep working; where it is given,
 * the tinted square matches every other section heading in the module.
 */
/** The settings row as this page edits it (its theme as strings, its form as fields). */
type SettingsDraft = Omit<CallCenterWorkspaceSettings, 'widget_theme' | 'widget_default_locale' | 'pre_call_form_schema'> & {
  widget_theme: Record<string, string | undefined>;
  widget_default_locale?: string | null;
  pre_call_form_schema: PreCallField[];
};

function Section({
  title, description, icon, children,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Panel className="space-y-4">
      <SectionHeading icon={icon} title={title} hint={description} />
      <div className="space-y-1">{children}</div>
    </Panel>
  );
}

/**
 * One setting.
 *
 * Rows are separated by a hairline rather than by whitespace alone: a long
 * settings page scans much faster when each control is visibly its own line.
 */
function Row({ label, hint, locked, children }: { label: string; hint?: string; locked?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 py-2.5 last:border-0">
      <div className="min-w-0">
        <Label>{label}</Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        {locked && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-warning">
            <AlertCircle className="h-3 w-3" />{locked}
          </p>
        )}
      </div>
      <div className={cn('shrink-0', locked && 'pointer-events-none opacity-50')}>{children}</div>
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
  // The preview's departments per channel, in the bootstrap's shape and order.
  const previewDepartments = useMemo<PreviewDepartments>(() => {
    const sorted = [...ccDepartments].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const pick = (on: (d: (typeof sorted)[number]) => boolean | undefined) =>
      sorted.filter((d) => on(d)).map((d) => ({ id: d.id, name: d.name, sort_order: d.sort_order ?? 0 }));
    return { voice: pick((d) => d.cc_voice_enabled), video: pick((d) => d.cc_video_enabled), callback: pick((d) => d.cc_callback_enabled) };
  }, [ccDepartments]);
  const qc = useQueryClient();
  const { edition, isInternational } = useEdition();
  // The chat widget's side (the stacking hint) and logo direction (the
  // preview); the team's first members (the preview's sample operators).
  const { data: chatSettings } = useWidgetSettings(workspace?.id);
  const { data: members } = useWorkspaceMembers(workspace?.id);
  const { data: entitlements, loading: entitlementsLoading } = useWorkspaceEffectiveEntitlements(workspace?.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [s, setS] = useState<SettingsDraft | null>(null);
  const [original, setOriginal] = useState<SettingsDraft | null>(null);
  const [previewOnline, setPreviewOnline] = useState(true);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const [tab, setTab] = useState('general');

  useEffect(() => {
    if (data?.settings) {
      setS({ ...data.settings } as SettingsDraft);
      setOriginal({ ...data.settings } as SettingsDraft);
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
      'business_hours', 'launcher_style', 'callback_slots_enabled',
      'callback_slot_minutes', 'callback_days_ahead', 'callback_slot_capacity',
      'allow_visitor_department_choice',
    ];
    return keys.some((k) => JSON.stringify(s[k]) !== JSON.stringify(original[k]));
  }, [s, original]);

  if (isLoading || !s) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-10 w-72 rounded-lg" />
        <SkeletonForm fields={5} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

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

  /** The loaded settings have this migration-277 key (the backend and its database have 277). */
  const designLoaded = (key: CallWidgetDesignKey) =>
    !!data?.settings && Object.prototype.hasOwnProperty.call(data.settings, key);
  const themeDefaults = CALL_THEME_DEFAULTS[isInternational ? 'international' : 'iran'];

  // The workspace's own switch: on only while the plan has the call center.
  // It saves at once (like Team & Departments' switch), apart from the form.
  const planCallCenter = !!entitlements?.modules?.call_center?.value;
  async function setWorkspaceEnabled(next: boolean) {
    if (!workspace) return;
    try {
      await update.mutateAsync({ enabled: next });
      setS((p) => (p ? { ...p, enabled: next } : p));
      setOriginal((p) => (p ? { ...p, enabled: next } : p));
      qc.invalidateQueries({ queryKey: ['call-center'] });
      toast({ title: t(next ? 'teamDept.ccMasterOn' : 'teamDept.ccMasterOff') });
    } catch (err: unknown) {
      const planDenied = (err as { code?: unknown }).code === 'plan_forbidden';
      toast({
        title: planDenied ? t('callCenter.settingsPage.masterPlanLocked') : t('callCenter.settingsPage.saveFailed'),
        description: planDenied ? undefined : (err as Error).message,
        variant: 'destructive',
      });
    }
  }

  async function save() {
    if (!workspace || !s || !original) return;
    // The callback hours are sent only when edited (an untouched legacy value
    // is never rewritten), and only in the shape the server stores.
    const hoursChanged = JSON.stringify(s.business_hours) !== JSON.stringify(original.business_hours);
    if (hoursChanged && !isCallbackHoursStrict(s.business_hours)) {
      toast({ title: t('callCenter.settingsPage.callbackHoursInvalid'), variant: 'destructive' });
      return;
    }
    const theme = cleanCallWidgetTheme(s.widget_theme);
    if (theme.invalid) {
      toast({ title: t('callCenter.settingsPage.colorInvalid'), description: t(`callCenter.settingsPage.${theme.invalid}Color` as 'callCenter.settingsPage.primaryColor'), variant: 'destructive' });
      return;
    }
    const patch: Partial<CallCenterWorkspaceSettings> = {
      enabled: s.enabled, display_name: s.display_name,
      voice_enabled: s.voice_enabled, video_enabled: s.video_enabled,
      callback_enabled: s.callback_enabled, pre_call_form_enabled: s.pre_call_form_enabled,
      offline_behavior: s.offline_behavior, recording_enabled: s.recording_enabled,
      recording_consent_required: s.recording_consent_required, routing_mode: s.routing_mode,
      // As loaded unless the admin chose another (an older spelling stays
      // what an old backend's widget reads until then).
      widget_position: s.widget_position,
      widget_template_id: s.widget_template_id || 'default',
      widget_theme: theme.theme,
      pre_call_form_schema: s.pre_call_form_schema || [],
      default_department_id: s.default_department_id ?? null,
      widget_default_locale: (s.widget_default_locale ?? null) as CallCenterWorkspaceSettings['widget_default_locale'],
      widget_enabled_locales: s.widget_enabled_locales ?? null,
      widget_custom_texts: s.widget_custom_texts ?? {},
      operator_video_visible_to_visitor: s.operator_video_visible_to_visitor !== false,
      ...(hoursChanged ? { business_hours: s.business_hours } : {}),
      // Sent only when changed (a backend from before it refuses the keys).
      // On turns both flags on (the bootstrap needs both); off, the choice only.
      ...(!!s.allow_visitor_department_choice !== !!original.allow_visitor_department_choice
        ? (s.allow_visitor_department_choice
          ? { departments_enabled: true, allow_visitor_department_choice: true }
          : { allow_visitor_department_choice: false })
        : {}),
      // Migration 277: only what the loaded settings have and the admin changed.
      ...callWidgetDesignPatch(original, s),
    };
    try {
      await update.mutateAsync(patch);
    } catch (err: unknown) {
      toast(isMigrationPendingError(err)
        ? { title: t('callCenter.settingsPage.migrationPending'), variant: 'destructive' }
        : { title: t('callCenter.settingsPage.saveFailed'), description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
      return;
    }
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
      setS((p) => (p ? { ...p, avatar_url: r.avatar_url } : p));
      setOriginal((p) => (p ? { ...p, avatar_url: r.avatar_url } : p));
      qc.invalidateQueries({ queryKey: ['call-center', 'settings'] });
    } catch (err: unknown) {
      toast({ title: t('callCenter.settingsPage.uploadFailed'), description: (err as Error).message, variant: 'destructive' });
    }
  }

  async function onRemoveAvatar() {
    if (!workspace) return;
    try {
      await callCenterApi.removeAvatar(workspace.id);
      setS((p) => (p ? { ...p, avatar_url: null } : p));
      setOriginal((p) => (p ? { ...p, avatar_url: null } : p));
      if (fileRef.current) fileRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['call-center', 'settings'] });
      toast({ title: t('callCenter.settingsPage.avatarRemoved') });
    } catch (err: unknown) {
      toast({ title: t('callCenter.settingsPage.uploadFailed'), description: (err as Error).message, variant: 'destructive' });
    }
  }


  return (
    <div className={cn('space-y-6 pb-24', (tab === 'presentation' || tab === 'general') ? 'max-w-6xl' : 'max-w-3xl')} dir={dir}>
      {platformOff && (
        <Card className="flex items-start gap-2 rounded-xl border-destructive/40 bg-destructive/5 p-4">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
          <div className="text-sm">{t('callCenter.settingsPage.platformDisabledBanner')}</div>
        </Card>
      )}

      <Card className="flex items-center justify-between gap-4 rounded-xl p-4" data-cc-master>
        <div className="min-w-0">
          <Label className="text-sm font-semibold">{t('teamDept.ccMasterTitle')}</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {s.enabled ? t('callCenter.settingsPage.masterOnHint') : t('callCenter.settingsPage.masterOffHint')}
          </p>
          {!entitlementsLoading && !planCallCenter && (
            <p className="mt-1 flex items-center gap-1 text-xs text-warning">
              <AlertCircle className="h-3 w-3" />{t('callCenter.settingsPage.masterPlanLocked')}
            </p>
          )}
        </div>
        <Switch
          checked={!!s.enabled}
          onCheckedChange={(v) => void setWorkspaceEnabled(v)}
          // Off is always allowed; on needs the plan and the platform.
          disabled={update.isPending || (!s.enabled && (platformOff || entitlementsLoading || !planCallCenter))}
          aria-label={t('teamDept.ccMasterTitle')}
        />
      </Card>

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

      <TabsContent value="general" className="mt-0">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px] xl:grid-cols-[minmax(0,1fr)_520px] items-start">
        <Section icon={Palette} title={t('callCenter.settingsPage.identityBranding')} description={t('callCenter.settingsPage.identityBrandingHint')}>
        <Row label={t('callCenter.settingsPage.displayName')}>
          <Input value={s.display_name || ''} onChange={(e) => setS({ ...s, display_name: e.target.value })} placeholder="Support" className="w-60" />
        </Row>
        <div className="flex items-center gap-3">
          {s.avatar_url
            ? <img src={s.avatar_url} alt="" className="h-12 w-12 rounded-full object-cover border" />
            : <div className="h-12 w-12 shrink-0 rounded-full border bg-muted flex items-center justify-center text-center px-1 text-muted-foreground text-[9px] leading-tight break-words">{t('callCenter.settingsPage.noAvatar')}</div>}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onAvatar} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>{t('callCenter.settingsPage.upload')}</Button>
          {s.avatar_url && (
            <Button variant="ghost" className="text-destructive" onClick={onRemoveAvatar}>
              {t('callCenter.settingsPage.removeAvatar')}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">{t('callCenter.settingsPage.avatarHint')}</span>

        </div>
        <Row label={t('callCenter.settingsPage.widgetPosition')}>
          <Select value={normalizeCallWidgetPosition(s.widget_position)} onValueChange={(v) => setS({ ...s, widget_position: v })}>
            <SelectTrigger className="w-44" data-call-position aria-label={t('callCenter.settingsPage.widgetPosition')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {CALL_WIDGET_POSITIONS.map((position) => (
                <SelectItem key={position} value={position}>{t(`callCenter.settingsPage.positionOptions.${position}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <PlacementNotes settings={s} chat={chatSettings} />
        <WidgetTextsEditor
          settings={s}
          platform={platform}
          onChange={(next) => setS({ ...s, widget_custom_texts: next })}
        />
        </Section>
        <div className="lg:sticky lg:top-4">
          <LivePreviewSection
            t={t} settings={s} platform={platform} chat={chatSettings} members={members}
            departments={previewDepartments} recordingAvailable={platformRecording && planRecording}
            previewOnline={previewOnline} setPreviewOnline={setPreviewOnline}
            device={previewDevice} setDevice={setPreviewDevice}
          />
        </div>
        </div>
      </TabsContent>

      <TabsContent value="presentation" className="mt-0">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px] xl:grid-cols-[minmax(0,1fr)_520px] items-start">
        <Section
          icon={Palette}
          title={t('callCenter.settingsPage.presentationTitle')}
          description={t('callCenter.settingsPage.presentationHint')}
        >
          <Row label={t('callCenter.settingsPage.template')}>
            <CallWidgetTemplateSelect
              value={s.widget_template_id}
              onChange={(v) => setS({ ...s, widget_template_id: v })}
              t={t}
            />
          </Row>
          <div className="border-b border-border/50 py-2.5">
            <CallLauncherStylePicker
              value={s.launcher_style}
              onChange={(v) => setS({ ...s, launcher_style: v })}
              accent={s.widget_theme?.primary}
              international={isInternational}
              disabled={!designLoaded('launcher_style')}
            />
          </div>
          {isInternational && (
            <p className="flex items-start gap-1.5 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('callCenter.settingsPage.logoDirectionNote')}
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Unset colours wear the design's defaults of this edition (stored ones win). */}
            {([
              ['primary', t('callCenter.settingsPage.primaryColor'), themeDefaults.primary],
              ['accent', t('callCenter.settingsPage.accentColor'), themeDefaults.accent],
              ['surface', t('callCenter.settingsPage.surfaceColor'), themeDefaults.surface],
              ['text', t('callCenter.settingsPage.textColor'), themeDefaults.text],
              ['muted', t('callCenter.settingsPage.mutedColor'), themeDefaults.muted],
              ['danger', t('callCenter.settingsPage.dangerColor'), themeDefaults.danger],
            ] as const).map(([key, label, fallback]) => (
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
        <div className="lg:sticky lg:top-4">
          <LivePreviewSection
            t={t} settings={s} platform={platform} chat={chatSettings} members={members}
            departments={previewDepartments} recordingAvailable={platformRecording && planRecording}
            previewOnline={previewOnline} setPreviewOnline={setPreviewOnline}
            device={previewDevice} setDevice={setPreviewDevice}
          />
        </div>
        </div>
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
        const rawPlatformAvail: string[] = (platform as Partial<CallCenterPlatformSettings> | undefined)?.widget_available_locales || ['en'];
        const regionScoped = rawPlatformAvail.filter((c) => (regionLocales as string[]).includes(c));
        const platformAvail: string[] = regionScoped.length ? regionScoped : (regionLocales.length ? regionLocales : rawPlatformAvail);
        const platformDefault: string = (platform as Partial<CallCenterPlatformSettings> | undefined)?.widget_default_locale || 'en';
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
            icon={Languages}
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
      <Section icon={Phone} title={t('callCenter.settingsPage.callModes')} description={t('callCenter.settingsPage.callModesHint')}>
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

      <Section icon={ClipboardList} title={t('callCenter.settingsPage.preCallFormSection')} description={t('callCenter.settingsPage.preCallFormSectionHint')}>
        <PreCallFormBuilder
          value={Array.isArray(s.pre_call_form_schema) ? s.pre_call_form_schema : []}
          onChange={(value) => setS({ ...s, pre_call_form_schema: value })}
          t={t}
        />
      </Section>
      </TabsContent>

      <TabsContent value="availability" className="space-y-6 mt-0">
      <Section icon={CalendarClock} title={t('callCenter.settingsPage.availabilityOffline')} description={t('callCenter.settingsPage.availabilityOfflineHint')}>
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
      </Section>
      {platformCallback && s.callback_enabled && (
        <CallbackHoursSection s={s} setS={setS} loaded={designLoaded('callback_slots_enabled')} edition={edition} />
      )}
      </TabsContent>

      <TabsContent value="routing" className="space-y-6 mt-0">
      <Section icon={Route} title={t('callCenter.settingsPage.routing')} description={t('callCenter.settingsPage.routingHint')}>
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
          <div className="flex gap-2 items-start text-xs p-3 rounded bg-warning/10 border border-warning/30">
            <AlertCircle className="h-4 w-4 text-warning mt-0.5" />
            <span>
              {t('callCenter.settingsPage.noDeptEnabled')}{' '}
              <Link to={`/${slug}/settings/team-departments`} className="text-primary underline">
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
        {/* The widget's department picker: the bootstrap sends the departments
            only while the platform allows departments and this is on. */}
        <Row
          label={t('callCenter.settingsPage.visitorDepartmentChoice')}
          hint={platform?.departments_enabled
            ? t('callCenter.settingsPage.visitorDepartmentChoiceHint')
            : t('callCenter.settingsPage.visitorDepartmentChoiceOff')}
        >
          <Switch
            data-cc-dept-choice
            checked={!!s.allow_visitor_department_choice && !!platform?.departments_enabled}
            disabled={!platform?.departments_enabled || ccDepartments.length === 0}
            onCheckedChange={(v) => setS({ ...s, allow_visitor_department_choice: v })}
          />
        </Row>
        <div className="text-xs text-muted-foreground space-y-1">
          <div><b>{t('callCenter.settingsPage.broadcastOption').split('—')[0].trim()}</b> — {t('callCenter.settingsPage.broadcastDesc')}</div>
          <div><b>{t('callCenter.settingsPage.roundRobinOption').split('—')[0].trim()}</b> — {t('callCenter.settingsPage.roundRobinDesc')}</div>
          <div><b>{t('callCenter.settingsPage.leastBusyOption').split('—')[0].trim()}</b> — {t('callCenter.settingsPage.leastBusyDesc')}</div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/${slug}/settings/team-departments`}>{t('callCenter.settingsPage.manageDepartments')}</Link>
        </Button>
      </Section>
      </TabsContent>

      {showRecordingTab && (
        <TabsContent value="recording" className="space-y-6 mt-0">
          <RecordingSection
            s={s}
            setS={setS}
            platformRecording={platformRecording}
            recording={data?.recording || null}
          />
        </TabsContent>
      )}
      </Tabs>

      {/* Sticky save bar */}
      {dirty && (
        <div className="fixed bottom-4 inset-x-0 mx-auto max-w-3xl px-6 z-30">
          <Card className="flex items-center gap-3 rounded-xl border-primary/30 bg-card p-3 shadow-[var(--shadow-elevated)]">
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
        <Card key={`${field.id}-${index}`} className="space-y-3 rounded-xl border-border/70 bg-muted/20 p-3">
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

/**
 * The call widget templates this edition offers (shared/widgetTemplates.ts):
 * `default` in the Iranian edition, exactly as before; `intl` in the
 * International one.
 */
function CallWidgetTemplateSelect({ value, onChange, t }: {
  value: string | undefined;
  onChange: (value: string) => void;
  t: (key: string) => string;
}) {
  const { edition, isInternational } = useEdition();
  const offered = EDITION_CALL_WIDGET_TEMPLATES[edition].offered;
  const label = (id: string) =>
    id === 'intl' ? t('callCenter.settingsPage.intlTemplate') : t('callCenter.settingsPage.defaultTemplate');
  return (
    <Select
      value={isInternational ? resolveCallWidgetTemplateForEdition(edition, value) : value || 'default'}
      onValueChange={onChange}
    >
      <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
      <SelectContent>
        {offered.map((id) => (
          <SelectItem key={id} value={id}>{label(id)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The design's colour defaults of each edition (tokens.json of both decks): what an unset colour wears. */
const CALL_THEME_DEFAULTS = {
  iran: { primary: '#0B7D6C', accent: '#12A150', surface: '#FFFFFF', text: '#0F1217', muted: '#626A77', danger: '#E5484D' },
  international: { primary: '#16142B', accent: '#FF5A3C', surface: '#FFFFFF', text: '#16142B', muted: '#5E5C75', danger: '#E5432A' },
} as const;

/**
 * The preview's page sizes. Desktop is wider than the widget's phone
 * breakpoint (640px, the chat widget's) and tall enough for the whole
 * 400×660 panel under its `100dvh - 130px` cap; both are scaled down to
 * the column they sit in.
 */
const PREVIEW_DEVICES = {
  desktop: { width: 660, height: 800 },
  phone: { width: 390, height: 760 },
} as const;
type PreviewDevice = keyof typeof PREVIEW_DEVICES;

/** Roles that answer calls (server/services/callCenter/publicPresence.ts). */
const OPERATOR_ROLES = new Set(['owner', 'admin', 'team_lead', 'agent', 'support_agent']);

/**
 * The preview's sample operators for `card` and `operator_face`: the team's
 * first three operators to join, by the rule the bootstrap's
 * `presence.operators` follows (their own name or null, never an e-mail),
 * without photos.
 */
function previewOperators(members: readonly WorkspaceMember[] | undefined) {
  return widgetTeamMembers((members || []).filter((m) => OPERATOR_ROLES.has(m.role)))
    .slice(0, 3)
    .map((m) => {
      const own = (m.full_name || '').trim();
      const name = own && launcherInitial([own]) ? own : null;
      return { name, initial: launcherInitial([name]), avatar_url: null };
    });
}

/** The browser's own time zone (an International schedule starts in it). */
function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Callback hours of the strict shape that name a schedule (a `weekly`), else null. */
function scheduleOf(value: unknown): BusinessHours | null {
  return isCallbackHoursStrict(value) && !!value && typeof value === 'object' && 'weekly' in value
    ? value as BusinessHours
    : null;
}

/** Hours as the settings row stores them. */
function storedHours(hours: BusinessHoursConfig): Record<string, unknown> {
  return { ...hours };
}

/** A stored schedule as the editor shows it: every day present; the zone the server would use when it names none. */
function editorHours(schedule: BusinessHours, edition: Edition): BusinessHoursConfig {
  const stored = schedule as Partial<BusinessHoursConfig>;
  const weekly: BusinessHoursConfig['weekly'] = {};
  for (const day of DAY_KEYS) weekly[day] = stored.weekly?.[day] ?? [];
  return {
    enabled: stored.enabled ?? true,
    timezone: stored.timezone || (edition === 'international' ? 'UTC' : 'Asia/Tehran'),
    weekly,
    overrides: stored.overrides ?? [],
  };
}

/** Where the launcher sits: the edge tab's side, and the chat button on the same side. */
function PlacementNotes({ settings, chat }: { settings: SettingsDraft; chat: WidgetSettings | null | undefined }) {
  const { t } = useTranslation();
  const style = normalizeCallLauncherStyle(settings.launcher_style);
  const position = normalizeCallWidgetPosition(settings.widget_position);
  const chatSide = chat?.enabled ? (chat.position === 'bottom-left' ? 'left' : chat.position === 'bottom-right' ? 'right' : null) : null;
  const stacks = style !== 'edge_tab' && chatSide !== null && chatSide === position;
  if (style !== 'edge_tab' && !stacks) return null;
  return (
    <div className="space-y-1 pb-2">
      {style === 'edge_tab' && <p className="text-xs text-muted-foreground">{t('callCenter.settingsPage.positionEdgeNote')}</p>}
      {stacks && <p className="text-xs text-muted-foreground">{t('callCenter.settingsPage.positionStacksAboveChat')}</p>}
    </div>
  );
}

/**
 * Availability → Callback hours (migration 277): slots on/off, the weekly
 * schedule, slot length, days offered and callbacks per slot. A stored value
 * of another shape (written before 277, by API) is shown read-only until the
 * admin replaces it; it is never rewritten silently.
 */
function CallbackHoursSection({ s, setS, loaded, edition }: {
  s: SettingsDraft;
  setS: (next: SettingsDraft) => void;
  loaded: boolean;
  edition: Edition;
}) {
  const { t, locale } = useTranslation();
  // Numbers in the page's digits (Persian digits in Persian, as its one-day option).
  const num = (n: number) => n.toLocaleString(intlLocaleFor(locale));
  const stored = s.business_hours;
  const legacy = !isCallbackHoursStrict(stored);
  const schedule = scheduleOf(stored);
  const fresh = () => defaultCallbackHours(edition, browserTimeZone());
  const hours = schedule ? editorHours(schedule, edition) : fresh();
  const slotsOn = s.callback_slots_enabled === true;
  const minutes = s.callback_slot_minutes ?? CALLBACK_SLOT_MINUTES.default;
  const days = s.callback_days_ahead ?? CALLBACK_DAYS_AHEAD.default;
  const minuteOptions = [10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
  if (!minuteOptions.includes(minutes)) minuteOptions.push(minutes);
  minuteOptions.sort((a, b) => a - b);

  return (
    <div data-callback-hours>
      <Section icon={CalendarClock} title={t('callCenter.settingsPage.callbackHours')} description={t('callCenter.settingsPage.callbackHoursHint')}>
        {!loaded ? (
          <p className="text-xs text-warning">{t('callCenter.settingsPage.designSettingsPending')}</p>
        ) : (
          <div className="space-y-4">
            <Row
              label={t('callCenter.settingsPage.callbackHoursSlots')}
              hint={t('callCenter.settingsPage.callbackHoursSlotsHint')}
              locked={legacy ? t('callCenter.settingsPage.callbackHoursNeedsReplace') : undefined}
            >
              <Switch
                data-callback-slots
                aria-label={t('callCenter.settingsPage.callbackHoursSlots')}
                checked={slotsOn}
                disabled={legacy}
                onCheckedChange={(on) => setS({
                  ...s,
                  callback_slots_enabled: on,
                  // Turning slots on with no schedule yet starts the edition's default week.
                  ...(on && !schedule ? { business_hours: storedHours(fresh()) } : {}),
                })}
              />
            </Row>
            {legacy ? (
              <div className="space-y-2" data-callback-hours-legacy>
                <p className="text-xs text-muted-foreground">{t('callCenter.settingsPage.callbackHoursLegacy')}</p>
                <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs" dir="ltr">{JSON.stringify(stored ?? {}, null, 2)}</pre>
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={() => setS({ ...s, business_hours: storedHours(fresh()) })}
                >
                  {t('callCenter.settingsPage.callbackHoursReplace')}
                </Button>
              </div>
            ) : (
              <WeeklyHoursEditor
                hours={hours}
                onChange={(next) => setS({ ...s, business_hours: storedHours(next) })}
                disabled={!slotsOn}
                firstDay={edition === 'international' ? 'mon' : 'sat'}
                limits={CALLBACK_HOURS_LIMITS}
              />
            )}
            {slotsOn && schedule && !callbackHoursHaveInterval(hours) && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p>{t('callCenter.settingsPage.callbackHoursNoInterval')}</p>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>{t('callCenter.settingsPage.callbackHoursSlotMinutes')}</Label>
                <Select
                  value={String(minutes)}
                  disabled={!slotsOn}
                  onValueChange={(v) => setS({ ...s, callback_slot_minutes: Number(v) })}
                >
                  <SelectTrigger data-callback-slot-minutes aria-label={t('callCenter.settingsPage.callbackHoursSlotMinutes')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {minuteOptions.map((n) => (
                      <SelectItem key={n} value={String(n)}>{t('callCenter.settingsPage.callbackHoursMinutes', { n: num(n) })}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('callCenter.settingsPage.callbackHoursDaysAhead')}</Label>
                <Select
                  value={String(days)}
                  disabled={!slotsOn}
                  onValueChange={(v) => setS({ ...s, callback_days_ahead: Number(v) })}
                >
                  <SelectTrigger data-callback-days-ahead aria-label={t('callCenter.settingsPage.callbackHoursDaysAhead')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: CALLBACK_DAYS_AHEAD.max }, (_, i) => i + 1).map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n === 1 ? t('callCenter.settingsPage.callbackHoursDayOne') : t('callCenter.settingsPage.callbackHoursDays', { n: num(n) })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="callback-slot-capacity">{t('callCenter.settingsPage.callbackHoursCapacity')}</Label>
                <Input
                  id="callback-slot-capacity"
                  data-callback-capacity
                  type="number"
                  inputMode="numeric"
                  min={CALLBACK_SLOT_CAPACITY.min}
                  max={CALLBACK_SLOT_CAPACITY.max}
                  disabled={!slotsOn}
                  value={s.callback_slot_capacity ?? ''}
                  placeholder={t('callCenter.settingsPage.callbackHoursCapacityHint')}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setS({
                      ...s,
                      callback_slot_capacity: Number.isFinite(n)
                        ? Math.min(CALLBACK_SLOT_CAPACITY.max, Math.max(CALLBACK_SLOT_CAPACITY.min, n))
                        : null,
                    });
                  }}
                />
                <p className="text-[11px] text-muted-foreground">{t('callCenter.settingsPage.callbackHoursCapacityHint')}</p>
              </div>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

/**
 * The live preview: the real widget files (registry, core renderer, panel
 * module, engine; no loader, so the panel module is on the page) in a frame,
 * fed the bootstrap the server would send for the draft (edition, dates,
 * assets with the shared fonts stylesheet, launcher style, placement, the
 * International logo direction, sample operators, slots from the draft
 * hours). Calls are off (`preview: true`).
 */
/** The bootstrap's `departments` (server/routes/callWidget.ts). */
type PreviewDepartments = Record<'voice' | 'video' | 'callback', { id: string; name: string; sort_order: number }[]>;

function CallWidgetPreview({ settings, platform, chat, members, departments, recordingAvailable, online, device }: {
  settings: SettingsDraft;
  platform: Partial<CallCenterPlatformSettings> | null | undefined;
  chat: WidgetSettings | null | undefined;
  members: readonly WorkspaceMember[] | undefined;
  departments: PreviewDepartments;
  recordingAvailable: boolean;
  online: boolean;
  device: PreviewDevice;
}) {
  const { edition, isInternational } = useEdition();
  const webyarKit = useWebyarKit() && !isInternational;
  const { locale } = useTranslation();
  useBrandVersion();
  // One instant for the frame's lifetime: slots before it are past.
  const [now] = useState(() => Date.now());
  const templateId = isInternational
    ? resolveCallWidgetTemplateForEdition(edition, settings.widget_template_id)
    : settings.widget_template_id || 'default';
  const template = CALL_WIDGET_TEMPLATES[templateId as keyof typeof CALL_WIDGET_TEMPLATES] ?? CALL_WIDGET_TEMPLATES.default;
  const style = normalizeCallLauncherStyle(settings.launcher_style);
  const dates = widgetDateHints(edition);
  const logoDirection: 'open' | 'thread' = chat && chatTemplateOptionKeys(String(chat.widget_template_id || '')).includes('logoDirection')
    && chat.widget_template_options?.logoDirection === 'open' ? 'open' : 'thread';
  // The channels the platform and the workspace both allow (the bootstrap's
  // capabilities; the master switches aside, so a switched-off widget still
  // previews).
  const callbackOn = platform?.callback_requests_enabled !== false && settings.callback_enabled !== false;
  const voiceOn = platform?.voice_calls_enabled !== false && settings.voice_enabled !== false;
  const videoOn = platform?.video_calls_enabled !== false && settings.video_enabled !== false;
  const locales = effectiveCallWidgetLocales(platform, settings);
  const recordingOn = recordingAvailable && !!settings.recording_enabled;
  const schedule = settings.callback_slots_enabled === true && callbackOn ? scheduleOf(settings.business_hours) : null;
  const slots = schedule && callbackHoursHaveInterval(schedule)
    ? computeCallbackSlots({
      hours: schedule,
      slotMinutes: settings.callback_slot_minutes ?? CALLBACK_SLOT_MINUTES.default,
      daysAhead: settings.callback_days_ahead ?? CALLBACK_DAYS_AHEAD.default,
      capacity: settings.callback_slot_capacity ?? null,
      now,
      defaultTimeZone: edition === 'international' ? 'UTC' : 'Asia/Tehran',
    })
    : null;
  const bootstrap = {
    status: 'ok',
    provider_ready: true,
    assets_version: 'preview',
    session: 'preview',
    edition,
    calendar: dates.calendar,
    time_zone: dates.timeZone,
    assets: {
      // Faces register at document level (the chat widget's stylesheet).
      font_style_url: '/widget/presentation-default-fonts.css',
      presentation_style_url: `/call-widget/${template.style}`,
      presentation_panel_script_url: `/call-widget/${template.panel.script}`,
      presentation_panel_style_url: `/call-widget/${template.panel.style}`,
    },
    // The International edition previews its own credit, in the logo
    // direction the bootstrap follows (the chat widget's).
    ...(isInternational
      ? {
          powered_by: {
            brand: platformBrandName(locale),
            brands: { en: platformBrandName('en'), fa: platformBrandName('fa'), tr: platformBrandName('tr') },
            url: null,
            logo: logoDirection === 'open' ? INTL_BRAND.horizontalOpen.light : INTL_BRAND.horizontal.light,
          },
        }
      : {}),
    // The Iranian edition (known, never assumed) previews WebYar's logotype
    // in its credit, as the bootstrap sends it (server/routes/callWidget.ts).
    ...(webyarKit ? { powered_by_logo: WEBYAR_BRAND.logo.light } : {}),
    config: {
      display_name: settings.display_name,
      avatar_url: settings.avatar_url,
      widget_position: normalizeCallWidgetPosition(settings.widget_position),
      widget_template_id: templateId,
      launcher_style: style,
      ...(isInternational ? { logoDirection } : {}),
      widget_theme: settings.widget_theme || {},
      pre_call_form_enabled: settings.pre_call_form_enabled,
      pre_call_form_schema: settings.pre_call_form_schema || [],
      offline_behavior: settings.offline_behavior || 'show_callback',
      recording_consent_required: !!settings.recording_consent_required,
      custom_texts: settings.widget_custom_texts || {},
    },
    capabilities: {
      voice: online && voiceOn,
      video: online && videoOn,
      callback: callbackOn,
      recording: recordingOn,
      operator_video_visible: settings.operator_video_visible_to_visitor !== false,
    },
    // Staffed while previewed online; names only for the styles that show them.
    presence: online
      ? { any_available: true, ...(callLauncherNeedsPresence(style) ? { operators: previewOperators(members) } : {}) }
      : { any_available: false },
    callback_policy: {
      enabled: callbackOn,
      show_when_online: platform?.callback_show_when_online !== false,
      require_contact: !!platform?.callback_require_contact,
      min_message_length: platform?.callback_min_message_length ?? 0,
      ...(slots ? { slots } : {}),
    },
    // As the bootstrap gates them (server/routes/callWidget.ts): the
    // departments only while visitors may choose, recording as configured.
    departments: settings.allow_visitor_department_choice && platform?.departments_enabled
      ? departments
      : { voice: [], video: [], callback: [] },
    recording: { effective_enabled: recordingOn, consent_required: recordingOn && !!settings.recording_consent_required },
    // The languages the bootstrap would give (the platform's while the workspace chose none).
    i18n: { default_locale: locales.default_locale, available_locales: locales.available },
  };
  // Inert JSON in its own script element: "<" is escaped, so no value can end it.
  const data = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script type="application/json" id="ccw-preview-bootstrap">${data}</script>
    <script src="/call-widget/presentation-registry.js"></script>
    <script src="/call-widget/presentation-default.js"></script>
    <script src="/call-widget/presentation-default-panel.js"></script>
    <script src="/call-widget/runtime.js"></script>
    <script>window.CallCenterWidget.mount({apiBase:'',origin:parent.location.origin,preview:true,bootstrap:JSON.parse(document.getElementById('ccw-preview-bootstrap').textContent)});</script>
  </body></html>`;
  return <ScaledPreviewFrame device={device} srcDoc={srcDoc} frameKey={`${device}:${data}`} />;
}

/**
 * The frame at the device's own size (the widget lays itself out with
 * `position: fixed` and its phone media query against it), scaled down to
 * the column's width and centred.
 */
function ScaledPreviewFrame({ device, srcDoc, frameKey }: { device: PreviewDevice; srcDoc: string; frameKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { width, height } = PREVIEW_DEVICES[device];
  const scale = available > 0 ? Math.min(1, available / width) : 1;
  return (
    <div
      ref={box}
      data-preview-frame
      data-device={device}
      data-scale={scale.toFixed(3)}
      className="relative w-full overflow-hidden rounded-lg border bg-muted/20"
      style={{ height: Math.round(height * scale) }}
    >
      <iframe
        key={frameKey}
        title="Call Widget live preview"
        sandbox="allow-scripts allow-same-origin"
        srcDoc={srcDoc}
        className="absolute top-0 border-0"
        style={{
          width,
          height,
          left: Math.max(0, (available - width * scale) / 2),
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: 'top left',
        }}
      />
    </div>
  );
}

function LivePreviewSection({
  t, settings, platform, chat, members, departments, recordingAvailable, previewOnline, setPreviewOnline, device, setDevice,
}: {
  t: ReturnType<typeof useTranslation>['t'];
  settings: SettingsDraft;
  platform: Partial<CallCenterPlatformSettings> | null | undefined;
  chat: WidgetSettings | null | undefined;
  members: readonly WorkspaceMember[] | undefined;
  departments: PreviewDepartments;
  recordingAvailable: boolean;
  previewOnline: boolean;
  setPreviewOnline: (v: boolean) => void;
  device: PreviewDevice;
  setDevice: (v: PreviewDevice) => void;
}) {
  return (
    <Section
      icon={Palette}
      title={t('callCenter.settingsPage.livePreview')}
      description={t('callCenter.settingsPage.livePreviewHint')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <Select value={previewOnline ? 'online' : 'offline'} onValueChange={(v) => setPreviewOnline(v === 'online')}>
          <SelectTrigger className="w-44" data-preview-state><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="online">{t('callCenter.settingsPage.previewOnline')}</SelectItem>
            <SelectItem value="offline">{t('callCenter.settingsPage.previewOffline')}</SelectItem>
          </SelectContent>
        </Select>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={device}
          onValueChange={(v) => { if (v === 'desktop' || v === 'phone') setDevice(v); }}
          aria-label={t('callCenter.settingsPage.previewDevice')}
        >
          <ToggleGroupItem value="desktop" aria-label={t('callCenter.settingsPage.previewDesktop')}>
            <Monitor className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="phone" aria-label={t('callCenter.settingsPage.previewPhone')}>
            <Smartphone className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <CallWidgetPreview
        settings={settings} platform={platform} chat={chat} members={members}
        departments={departments} recordingAvailable={recordingAvailable}
        online={previewOnline} device={device}
      />
    </Section>
  );
}

// ── Widget text overrides editor ──────────────────────────────
const CALLBACK_TEXT_KEYS = new Set([
  'callback', 'leave_details', 'callback_desk',
  'leave_callback_request', 'offline_copy',
  'request_callback', 'request_callback_instead', 'callback_intro',
]);

/**
 * The widget texts an owner may override, with the widget's own copy as the
 * placeholder (public/call-widget/runtime.js I18N, the 2026-10 design).
 */
/** The server's cap on one widget text (server/routes/callCenter.ts); a longer one fails the whole save. */
const WIDGET_TEXT_MAX = 200;

const WIDGET_TEXT_KEYS: { key: string; label: string; placeholder: Record<string, string> }[] = [
  { key: 'talk_now',            label: 'Launcher text (online)',     placeholder: { en: 'Talk now',            fa: 'همین حالا تماس بگیرید', tr: 'Şimdi konuş' } },
  { key: 'live_support',        label: 'Launcher subtitle (online)', placeholder: { en: 'Live support',        fa: 'پشتیبانی آنلاین',     tr: 'Canlı destek' } },
  { key: 'callback',            label: 'Launcher text (offline)',    placeholder: { en: 'Callback',            fa: 'درخواست تماس',        tr: 'Geri arama' } },
  { key: 'leave_details',       label: 'Launcher subtitle (offline)',placeholder: { en: 'Leave details',       fa: 'ثبت اطلاعات',         tr: 'Bilgilerini bırak' } },
  { key: 'launcher_pill',       label: 'Pill launcher text',         placeholder: { en: 'Call support',        fa: 'تماس با پشتیبانی',    tr: 'Desteği ara' } },
  { key: 'launcher_tab',        label: 'Edge tab text',              placeholder: { en: 'Call us',             fa: 'تماس با ما',          tr: 'Bizi arayın' } },
  { key: 'operators_available', label: 'Header subtitle (online)',   placeholder: { en: 'Operators available', fa: 'اپراتورها آماده‌اند', tr: 'Operatörler müsait' } },
  { key: 'callback_desk',       label: 'Header subtitle (offline)',  placeholder: { en: 'Callback desk',       fa: 'میز درخواست تماس',    tr: 'Geri arama masası' } },
  { key: 'talk_to_team',        label: 'Hero title (online)',        placeholder: { en: 'Talk to our team',    fa: 'با تیم ما صحبت کنید', tr: 'Ekibimizle konuşun' } },
  { key: 'online_copy',         label: 'Hero subtitle (online)',     placeholder: { en: 'Start a secure voice or video call with the next available operator.', fa: 'یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید.', tr: 'İlk uygun operatörle güvenli sesli veya görüntülü arama başlatın.' } },
  { key: 'leave_callback_request', label: 'Hero title (offline)',    placeholder: { en: 'Leave a callback request', fa: 'درخواست تماس ثبت کنید', tr: 'Geri arama isteği bırakın' } },
  { key: 'offline_copy',        label: 'Hero subtitle (offline)',    placeholder: { en: 'Our team is offline right now, but we can call you back.', fa: 'تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم.', tr: 'Ekibimiz şu anda çevrimdışı, ancak sizi geri arayabiliriz.' } },
  { key: 'offline_title',       label: 'Offline message title',      placeholder: { en: 'We are offline',      fa: 'در حال حاضر آفلاین هستیم', tr: 'Şu anda çevrimdışıyız' } },
  { key: 'offline_message',     label: 'Offline message text',       placeholder: { en: 'Our team is offline right now. Please try again later.', fa: 'تیم ما الان آفلاین است. لطفاً بعداً دوباره تلاش کنید.', tr: 'Ekibimiz şu anda çevrimdışı. Lütfen daha sonra tekrar deneyin.' } },
  { key: 'voice_call',          label: 'Voice call button',          placeholder: { en: 'Voice call',          fa: 'تماس صوتی',           tr: 'Sesli arama' } },
  { key: 'video_call',          label: 'Video call button',          placeholder: { en: 'Video call',          fa: 'تماس تصویری',         tr: 'Görüntülü arama' } },
  { key: 'request_callback',    label: 'Callback button',            placeholder: { en: 'Request callback',    fa: 'درخواست تماس',        tr: 'Geri arama iste' } },
  { key: 'request_callback_instead', label: 'Home callback row title', placeholder: { en: 'Request a callback', fa: 'درخواست تماس', tr: 'Geri arama iste' } },
  { key: 'callback_intro',      label: 'Home callback row subtitle', placeholder: { en: 'Tell us how to reach you and our team calls back fast.', fa: 'راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.', tr: 'Size nasıl ulaşacağımızı yazın; ekibimiz hızlıca geri arar.' } },
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
  s: SettingsDraft;
  setS: (next: SettingsDraft) => void;
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
      icon={Mic}
      title={t('callCenter.recording.title')}
      description={t('callCenter.recording.description')}
    >
      <div
        className={cn(
          'rounded-md border p-3 flex items-start gap-2',
          eff
            ? 'border-success/30 bg-success/[0.06]'
            : 'border-warning/30 bg-warning/[0.06]',
        )}
      >
        {eff ? (
          <CheckCircle2 className="h-4 w-4 text-success mt-0.5" />
        ) : (
          <AlertCircle className="h-4 w-4 text-warning mt-0.5" />
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
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
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
  settings: SettingsDraft;
  platform: Partial<CallCenterPlatformSettings> | null | undefined;
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
        {visibleKeys.map(({ key, label, placeholder }) => {
          // Translated field name when the locale bundle has one; the English
          // constant stays as the fallback so a missing key never shows a path.
          const tk = `callCenter.settingsPage.widgetTextKeys.${key}`;
          const translated = (t as unknown as (k: string) => string)(tk);
          const fieldLabel = translated === tk ? label : translated;
          return (
          <div key={key} className="space-y-1">
            <Label className="text-xs">{fieldLabel}</Label>

            <Input
              value={current[key] || ''}
              onChange={(e) => setField(key, e.target.value)}
              placeholder={placeholder[locale] || placeholder.en}
              maxLength={WIDGET_TEXT_MAX}
              dir={isRtl ? 'rtl' : 'ltr'}
            />
          </div>
          );
        })}

      </div>
    </div>
  );
}
