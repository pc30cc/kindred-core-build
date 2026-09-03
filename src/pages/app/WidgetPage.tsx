import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings, useUpdateWidgetSettings } from '@/hooks/useWidgetSettings';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useWidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { resolveWidgetUrls, buildWidgetEmbedSnippet } from '@/lib/widgetEmbed';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Copy, Check, Code, ExternalLink, Globe, Info, Palette, Settings, Shield, Eye, MessageSquare, Link2, Clock, Sparkles, Plus, Paperclip, Mic, Smile, Users } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { AvailabilitySection } from '@/components/app/widget/AvailabilitySection';
import { cn } from '@/lib/utils';
import { PhoneVerificationGate } from '@/features/phone-verification/PhoneVerificationGate';
import { PrechatSection } from '@/components/app/widget/PrechatSection';
import { WidgetLivePreview, FAB_ICONS, type PreviewView } from '@/components/app/widget/WidgetLivePreview';
import { useKBArticles, useKBCategories } from '@/hooks/useKnowledgeBase';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { useTeamPresence, presenceMap } from '@/hooks/useTeamPresence';
import { useWidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { widgetTextDefault, widgetTextValue } from '@/lib/widgetLocaleDefaults';
import { SmartRulesTab } from '@/components/app/widget/smart/SmartRulesTab';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { SkeletonForm, Skeleton } from '@/components/common/Skeletons';

/** Widget behaviour switch → plan capability key. Mirrors the server map in
 *  `server/services/widget/entitlements.ts` (that file is the authority). */
const BEHAVIOR_CAPABILITY: Record<string, string> = {
  chat_enabled: 'chat',
  kb_enabled: 'knowledge_base',
  visitor_tracking_enabled: 'visitor_tracking',
  attachments_enabled: 'widget_attachments',
  voice_notes_enabled: 'widget_voice_notes',
  emoji_enabled: 'widget_emoji',
  store_raw_ip: 'widget_raw_ip_storage',
  assignment_mode: 'widget_assignment_routing',
};

function normalizeDomainInput(input: string): string {
  let raw = input.trim();
  raw = raw.replace(/^https?:\/\//i, '');
  raw = raw.replace(/^www\./i, '');
  raw = raw.replace(/\/+$/, '');
  return raw.toLowerCase();
}

function isValidDomain(d: string): boolean {
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d);
}

function WidgetPageContent() {
  const { t, dir } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  // Chat bubbles in the preview show a real operator profile picture.
  const { data: workspaceMembers } = useWorkspaceMembers(workspace?.id);
  const { data: teamPresence } = useTeamPresence(workspace?.id);
  const previewOperator = (workspaceMembers || []).find((m) => m.avatar_url) || (workspaceMembers || [])[0];
  const { branding, platformName } = useBrandingContext();
  // Single source of truth — widget URLs come from platform widget settings only.
  const { data: platformWidget } = useWidgetPlatformSettings();
  // Powered-by footer is platform-owned + plan-gated; the preview must show
  // exactly what production renders.
  const { data: effectiveEnts } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const updateWidget = useUpdateWidgetSettings(workspace?.id);
  const { data: prechat } = useWidgetPrechatSettings(workspace?.id);
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const [copiedVariant, setCopiedVariant] = useState<'window' | 'script' | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [domainError, setDomainError] = useState('');
  const [tab, setTab] = useState<string>('appearance');
  const [manualView, setManualView] = useState<PreviewView | null>(null);

  /**
   * Local draft layer: every keystroke updates the preview instantly while the
   * actual save is debounced, so typing stays smooth and nothing is lost.
   */
  const [draft, setDraft] = useState<Record<string, any>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const setField = (field: string, value: any, delay = 500) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    clearTimeout(timers.current[field]);
    timers.current[field] = setTimeout(() => {
      updateWidget.mutate({ [field]: value } as any);
    }, delay);
  };

  const live = useMemo(() => ({ ...(widget as any), ...draft }), [widget, draft]);

  /**
   * Region lock: in a single-language platform the widget can only speak that
   * language, so the preview must render it (RTL included) even before the
   * workspace has ever picked a locale.
   */
  const regionLocales = allowedLocales.length ? allowedLocales : ['en'];
  const effectiveLocale =
    live?.locale && regionLocales.includes(live.locale) ? live.locale : regionLocales[0];
  /** Plan truth for widget behaviours. Unknown key => allowed (server decides). */
  const capAllowed = (key: string): boolean => {
    if (!effectiveEnts) return true;
    const f = (effectiveEnts.features as any)?.[key] ?? (effectiveEnts.modules as any)?.[key];
    return f ? f.value !== false : true;
  };
  const maxDomains = (() => {
    const l = (effectiveEnts?.limits as any)?.max_widget_domains?.value;
    return typeof l === 'number' ? l : -1;
  })();

  /** Appearance field → plan capability. Mirrors WIDGET_CUSTOMIZATION_CAPABILITY. */
  const APPEARANCE_CAPABILITY: Record<string, { capability: string; reset: any }> = {
    reply_time_text: { capability: 'widget_reply_time_text', reset: null },
    welcome_message: { capability: 'widget_welcome_message', reset: null },
    fab_label: { capability: 'widget_launcher_label', reset: null },
    fab_scale: { capability: 'widget_launcher_size', reset: 100 },
    fab_icon: { capability: 'widget_launcher_icon', reset: 'chat' },
    placeholder_text: { capability: 'widget_composer_placeholder', reset: null },
  };

  const previewSettings = useMemo(
    () => {
      const base: Record<string, any> = {
        ...live,
        // Logo is no longer a widget-level URL field: fall back to the logo the
        // workspace owner uploaded in Settings → General.
        logo_url: (live as any)?.logo_url || (branding as any)?.logo_url || null,
        locale: effectiveLocale,
        widget_language: effectiveLocale,
      };
      // The preview must show exactly what the plan lets production render.
      for (const [column, def] of Object.entries(APPEARANCE_CAPABILITY)) {
        if (!capAllowed(def.capability)) base[column] = def.reset;
      }
      if (!capAllowed('widget_team_avatars')) base.show_team_avatars = false;
      if (!capAllowed('widget_workspace_logo')) base.show_logo = false;
      return base;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, branding, effectiveLocale, effectiveEnts],
  );

  /**
   * Mirror of `server/services/widget/poweredBy.ts`: platform master switch AND
   * the `widget_powered_by` plan entitlement decide visibility; wording, brand
   * label and URL come only from platform settings. `null` => no footer.
   */
  const previewPoweredBy = useMemo(() => {
    const planAllows = effectiveEnts?.features?.widget_powered_by?.value !== false;
    if (!planAllows) return null;
    // Workspace may hide it only when its plan grants the toggle.
    const mayHide = effectiveEnts?.features?.widget_powered_by_toggle?.value === true;
    if (mayHide && (live as any)?.show_powered_by === false) return null;
    if (platformWidget && platformWidget.powered_by_enabled === false) return null;
    const brand = (platformWidget?.powered_by_brand_text || '').trim()
      || (platformName || '').trim();
    if (!brand) return null;
    const rawUrl = (platformWidget?.powered_by_url || '').trim();
    return {
      text: (platformWidget?.powered_by_text || '').trim(),
      brand,
      url: /^https?:\/\//i.test(rawUrl) ? rawUrl : null,
    };
  }, [effectiveEnts, platformWidget, platformName, live]);
  const previewTeamMembers = useMemo(() => {
    const byUser = presenceMap(teamPresence?.presence);
    return (workspaceMembers || []).map(member => ({
      name: member.full_name || member.email || '',
      avatar: member.avatar_url,
      online: byUser.get(member.user_id)?.state === 'online',
    }));
  }, [workspaceMembers, teamPresence]);

  const LOCALE_LABELS: Record<string, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };

  /**
   * Backfill localized texts: legacy workspaces store English seeds
   * ("Chat with us" / "Hello! How can we help you?"). Once the widget speaks
   * another language we write the localized default into the field itself, so
   * the operator can read and edit real text instead of a grey placeholder.
   */
  const backfilled = useRef(false);
  useEffect(() => {
    if (backfilled.current || !widget || !effectiveLocale) return;
    backfilled.current = true;
    const patch: Record<string, string> = {};
    if (!widgetTextValue((widget as any).welcome_message, 'welcome', effectiveLocale)) {
      patch.welcome_message = widgetTextDefault('welcome', effectiveLocale);
    }
    if (!Object.keys(patch).length) return;
    setDraft(prev => ({ ...patch, ...prev }));
    updateWidget.mutate(patch as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget, effectiveLocale]);

  const urls = useMemo(
    () => resolveWidgetUrls(platformWidget, typeof window !== 'undefined' ? window.location.origin : undefined),
    [platformWidget],
  );

  /**
   * Real knowledge-base content for the preview: the operator must see exactly
   * the articles/categories visitors get in the Help tab.
   */
  const { data: kbArticlesData } = useKBArticles(workspace?.id, effectiveLocale, 'published');
  const { data: kbCategoriesData } = useKBCategories(workspace?.id, effectiveLocale);
  // Fallback: workspaces that authored content in another locale still get a
  // realistic preview instead of an empty Help tab.
  const { data: kbArticlesAny } = useKBArticles(workspace?.id, undefined, 'published');
  const { data: kbCategoriesAny } = useKBCategories(workspace?.id, undefined);
  const previewKbArticles = useMemo(
    () => ((kbArticlesData?.length ? kbArticlesData : kbArticlesAny) || [])
      .slice(0, 6)
      .map((a: any) => ({ title: a.title, excerpt: a.excerpt, content: a.content })),
    [kbArticlesData, kbArticlesAny],
  );
  const previewKbCategories = useMemo(
    () => ((kbCategoriesData?.length ? kbCategoriesData : kbCategoriesAny) || [])
      .slice(0, 6)
      .map((c: any) => ({ name: c.name, description: c.description })),
    [kbCategoriesData, kbCategoriesAny],
  );

  const primaryColor = live?.primary_color || branding?.primary_color || '#3B82F6';
  /** Launcher size is stored as a percentage (80–140) or a multiplier (0.8–1.4). */
  const fabScalePct = (() => {
    const raw = Number((live as any)?.fab_scale);
    if (!isFinite(raw) || raw <= 0) return 100;
    const pct = raw <= 3 ? raw * 100 : raw;
    return Math.min(140, Math.max(80, Math.round(pct / 5) * 5));
  })();

  const previewView: PreviewView =
    manualView ??
    (tab === 'prechat' ? 'prechat'
      : tab === 'availability' ? 'offline'
      : 'home');

  const windowEmbedCode = useMemo(
    () => buildWidgetEmbedSnippet(urls, {
      variant: 'window',
      workspaceId: workspace?.id,
      headerComment: platformWidget?.embed_header_comment,
      footerComment: platformWidget?.embed_footer_comment,
    }),
    [urls, workspace?.id, platformWidget?.embed_header_comment, platformWidget?.embed_footer_comment],
  );
  const scriptTagEmbedCode = useMemo(
    () => buildWidgetEmbedSnippet(urls, {
      variant: 'script',
      workspaceId: workspace?.id,
      headerComment: platformWidget?.embed_header_comment,
      footerComment: platformWidget?.embed_footer_comment,
    }),
    [urls, workspace?.id, platformWidget?.embed_header_comment, platformWidget?.embed_footer_comment],
  );

  const handleCopy = (variant: 'window' | 'script') => {
    navigator.clipboard.writeText(variant === 'window' ? windowEmbedCode : scriptTagEmbedCode);
    setCopiedVariant(variant);
    toast({ title: t('common.copied') });
    setTimeout(() => setCopiedVariant(null), 2000);
  };


  const handleToggle = (field: string, value: boolean) => {
    updateWidget.mutate({ [field]: value } as any);
  };

  const handleAddDomain = () => {
    const normalized = normalizeDomainInput(newDomain);
    if (!normalized) return;
    if (!isValidDomain(normalized)) {
      setDomainError(t('widgetPage.domains.invalid'));
      return;
    }
    const current = widget?.allowed_domains || [];
    if (current.includes(normalized)) {
      setDomainError(t('widgetPage.domains.duplicate'));
      return;
    }
    if (maxDomains >= 0 && current.length >= maxDomains) {
      setDomainError(
        String(t('widgetPage.domains.limitReached')).replace('{max}', String(maxDomains)),
      );
      return;
    }
    setDomainError('');
    updateWidget.mutate({ allowed_domains: [...current, normalized] } as any);
    setNewDomain('');
  };

  const handleRemoveDomain = (domain: string) => {
    const current = widget?.allowed_domains || [];
    updateWidget.mutate({ allowed_domains: current.filter(d => d !== domain) } as any);
  };

  /**
   * Plan-driven tab visibility. A tab whose plan feature is denied is NOT
   * rendered at all (no locked/blurred placeholder) — the matching workspace
   * configuration is already ignored by the server runtime. `install` has no
   * capability: it is the embed snippet and always available.
   */
  const TAB_CAPABILITY: Record<string, string | null> = {
    appearance: 'widget_appearance',
    behavior: 'widget_behavior',
    smart: 'widget_smart_engagement',
    prechat: 'widget_prechat_form',
    availability: 'widget_business_hours',
    domains: 'widget_domain_allowlist',
    install: null,
  };
  const visibleTabs = ([
    { v: 'appearance', icon: Palette },
    { v: 'behavior', icon: Settings },
    { v: 'smart', icon: Sparkles },
    { v: 'prechat', icon: MessageSquare },
    { v: 'availability', icon: Clock },
    { v: 'domains', icon: Shield },
    { v: 'install', icon: Code },
  ] as const).filter(({ v }) => {
    const cap = TAB_CAPABILITY[v];
    return !cap || capAllowed(cap);
  });
  const visibleTabValues = visibleTabs.map((x) => x.v as string).join(',');

  // Never leave the page on a tab the plan just removed.
  useEffect(() => {
    const values = visibleTabValues.split(',').filter(Boolean);
    if (values.length && !values.includes(tab)) setTab(values[0]);
  }, [visibleTabValues, tab]);


  if (isLoading) {
    return (
      <div className="space-y-5 p-1" dir={dir}>
        <Skeleton className="h-24 w-full rounded-2xl" />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <SkeletonForm fields={5} />
          <Skeleton className="h-[560px] w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in" dir={dir}>
      <Tabs value={tab} onValueChange={setTab} dir={dir as 'rtl' | 'ltr'}>
        {/* Header: title, live status and the segmented section switcher */}
        <div className="mb-5 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm backdrop-blur">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold leading-tight sm:text-xl">{t('widgetPage.title')}</h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{t('widgetPage.subtitle')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-full border border-border/70 bg-secondary/50 px-3 py-1.5">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  widget?.enabled ? 'bg-success animate-pulse' : 'bg-muted-foreground/50',
                )}
              />
              <span className="text-xs font-medium">
                {widget?.enabled ? t('widgetPage.active') : t('widgetPage.inactive')}
              </span>
              <Switch
                checked={widget?.enabled ?? false}
                onCheckedChange={v => handleToggle('enabled', v)}
              />
            </div>
          </div>

          <TabsList className="mt-4 flex h-auto w-full flex-wrap items-center justify-start gap-1 rounded-full border border-border/70 bg-secondary/40 p-1">
            {visibleTabs.map(({ v, icon: Icon }) => (
              <TabsTrigger
                key={v}
                value={v}
                title={t(`widgetPage.tabDesc.${v}` as any)}
                className={cn(
                  'flex h-9 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium',
                  'transition-all hover:bg-background/70',
                  'data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">{t(`widgetPage.tabs.${v}` as any)}</span>
              </TabsTrigger>
            ))}
          </TabsList>

        </div>

        {/* The smart tab owns its own scenario studio, so the generic preview
            sidebar steps aside and the builder takes the full width. */}
        <div className={cn(
          'grid grid-cols-1 gap-6',
          tab !== 'smart' && 'xl:grid-cols-[minmax(0,1fr)_500px]',
        )}>
          {/* Main config area */}
          <div className="space-y-6">
            {/* ─── Appearance ─── */}
            <TabsContent value="appearance">
              <div className="space-y-4">
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Palette className="h-4 w-4 text-primary" /> {t('widgetPage.tabs.appearance')}
                  </CardTitle>
                  <CardDescription>{t('widgetPage.tabDesc.appearance')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 p-6 pt-0">
                  {/* 1 — Display name (defaults to the workspace name) */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.brandName')}</Label>
                    <Input
                      value={typeof (live as any)?.brand_name === 'string'
                        ? (live as any).brand_name
                        : (workspace?.name || '')}
                      onChange={e => setField('brand_name' as any, e.target.value)}
                      placeholder={workspace?.name || t('widgetPage.appearance.brandNamePlaceholder')}
                    />
                    <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.brandNameHint')}</p>
                  </div>

                  {/* 2 — Reply-time note */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.preview.replyTimeLabel')}</Label>
                    <Input
                      disabled={!capAllowed('widget_reply_time_text')}
                      value={capAllowed('widget_reply_time_text')
                        ? (typeof (live as any)?.reply_time_text === 'string'
                            ? (live as any).reply_time_text
                            : t('widgetPage.appearance.replyTimeDefault'))
                        : ''}
                      onChange={e => setField('reply_time_text' as any, e.target.value)}
                      placeholder={t('widgetPage.appearance.replyTimeDefault')}
                    />

                    {capAllowed('widget_reply_time_text') ? (
                      <p className="text-[11px] text-muted-foreground">{t('widgetPage.preview.replyTimeHint')}</p>
                    ) : (
                      <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                    )}
                  </div>

                  {/* 3 — Welcome message */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widget.welcomeMessage')}</Label>
                    <Textarea
                      disabled={!capAllowed('widget_welcome_message')}
                      value={capAllowed('widget_welcome_message')
                        ? widgetTextValue(live?.welcome_message, 'welcome', effectiveLocale)
                        : widgetTextDefault('welcome', effectiveLocale)}
                      onChange={e => setField('welcome_message', e.target.value)}
                      rows={3}
                      placeholder={widgetTextDefault('welcome', effectiveLocale)}
                    />
                    {!capAllowed('widget_welcome_message') && (
                      <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                    )}
                  </div>


                  {/* 4 — Primary + shadow colour */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widget.primaryColor')}</Label>
                      <div className="flex gap-2">
                        <Input
                          type="color"
                          value={primaryColor}
                          onChange={e => setField('primary_color', e.target.value)}
                          className="h-10 w-12 shrink-0 cursor-pointer p-1"
                        />
                        <Input
                          value={primaryColor}
                          dir="ltr"
                          onChange={e => setField('primary_color', e.target.value)}
                          className="text-start font-mono text-xs"
                        />
                      </div>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {['#3B82F6', '#6366F1', '#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#111827'].map((c) => (
                          <button
                            key={c}
                            type="button"
                            aria-label={c}
                            onClick={() => setField('primary_color', c, 0)}
                            className={cn(
                              'h-6 w-6 rounded-full border-2 transition-transform hover:scale-110',
                              primaryColor.toLowerCase() === c.toLowerCase() ? 'border-foreground' : 'border-transparent',
                            )}
                            style={{ background: c }}
                          />
                        ))}
                      </div>
                    </div>
                    {/* The launcher shadow is derived from the primary colour —
                        no separate shadow setting. */}
                  </div>

                  {/* 5 — Position + language */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widget.position')}</Label>
                      <Select
                        value={live?.position || 'bottom-right'}
                        onValueChange={v => setField('position', v, 0)}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bottom-right">{t('widgetPage.appearance.bottomRight')}</SelectItem>
                          <SelectItem value="bottom-left">{t('widgetPage.appearance.bottomLeft')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widgetPage.appearance.language')}</Label>
                      <Select
                        value={effectiveLocale}
                        disabled={!canSwitchLanguage}
                        onValueChange={v => setField('locale', v, 0)}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {regionLocales.map((l) => (
                            <SelectItem key={l} value={l}>{LOCALE_LABELS[l] || l}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* 6 — Launcher bubble text (beside the floating button) */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.fabLabel')}</Label>
                    <Input
                      disabled={!capAllowed('widget_launcher_label')}
                      value={capAllowed('widget_launcher_label') ? ((live as any)?.fab_label || '') : ''}
                      onChange={e => setField('fab_label' as any, e.target.value)}
                      placeholder={t('widgetPage.appearance.fabLabelPlaceholder')}
                    />
                    {capAllowed('widget_launcher_label') ? (
                      <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.fabLabelHint')}</p>
                    ) : (
                      <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                    )}
                  </div>

                  {/* 7 — Launcher size + icon */}
                  <div className="space-y-4 rounded-lg border border-border/70 p-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium">{t('widgetPage.appearance.fabScale')}</Label>
                        <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                          {Math.round(56 * (capAllowed('widget_launcher_size') ? fabScalePct : 100) / 100)}px
                        </span>
                      </div>
                      <Slider
                        disabled={!capAllowed('widget_launcher_size')}
                        value={[capAllowed('widget_launcher_size') ? fabScalePct : 100]}
                        min={80}
                        max={140}
                        step={5}
                        onValueChange={v => setField('fab_scale' as any, v[0], 300)}
                      />
                      {!capAllowed('widget_launcher_size') && (
                        <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widgetPage.appearance.fabIcon')}</Label>
                      <div className={cn('flex flex-wrap gap-2', !capAllowed('widget_launcher_icon') && 'pointer-events-none opacity-50')}>
                        {Object.keys(FAB_ICONS).map((key) => (
                          <button
                            key={key}
                            type="button"
                            aria-label={key}
                            disabled={!capAllowed('widget_launcher_icon')}
                            onClick={() => setField('fab_icon' as any, key, 0)}
                            className={cn(
                              'flex h-10 w-10 items-center justify-center rounded-xl border-2 transition-transform hover:scale-105',
                              (capAllowed('widget_launcher_icon') ? ((live as any)?.fab_icon || 'chat') : 'chat') === key
                                ? 'border-foreground bg-muted'
                                : 'border-border/70',
                            )}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              className="h-5 w-5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              dangerouslySetInnerHTML={{ __html: FAB_ICONS[key] }}
                            />
                          </button>
                        ))}
                      </div>
                      {!capAllowed('widget_launcher_icon') && (
                        <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                      )}
                    </div>
                  </div>


                  {/* 6 — Composer placeholder */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.preview.inputPlaceholder')}</Label>
                    <Input
                      disabled={!capAllowed('widget_composer_placeholder')}
                      value={capAllowed('widget_composer_placeholder') ? (live?.placeholder_text || '') : ''}
                      onChange={e => setField('placeholder_text', e.target.value)}
                      placeholder={t('widgetPage.preview.inputPlaceholder')}
                    />
                    {!capAllowed('widget_composer_placeholder') && (
                      <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                    )}
                  </div>

                </CardContent>

              </Card>

              {/* ── Logo & branding ── */}
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('widgetPage.appearance.logoSection')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 p-6 pt-0">
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
                    <div className="space-y-1">
                      <Label className="text-sm">{t('widgetPage.appearance.showLogo')}</Label>
                      <p className="text-[11px] text-muted-foreground">
                        {t('widgetPage.appearance.logoHint')}
                      </p>
                      {!capAllowed('widget_workspace_logo') && (
                        <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                      )}
                    </div>
                    <Switch
                      disabled={!capAllowed('widget_workspace_logo')}
                      checked={capAllowed('widget_workspace_logo') && (live?.show_logo ?? true)}
                      onCheckedChange={v => setField('show_logo', v, 0)}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
                    <div className="space-y-1">
                      <Label className="text-sm">{t('widgetPage.appearance.showTeamAvatars')}</Label>
                      <p className="text-[11px] text-muted-foreground">
                        {t('widgetPage.appearance.showTeamAvatarsHint')}
                      </p>
                      {!capAllowed('widget_team_avatars') && (
                        <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                      )}
                    </div>
                    <Switch
                      disabled={!capAllowed('widget_team_avatars')}
                      checked={capAllowed('widget_team_avatars') && (live?.show_team_avatars ?? true)}
                      onCheckedChange={v => setField('show_team_avatars', v, 0)}
                    />
                  </div>

                  {/* Platform credit footer. Always ON by default; only a plan
                      granting `widget_powered_by_toggle` may switch it off. */}
                  {capAllowed('widget_powered_by') && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
                      <div className="space-y-1">
                        <Label className="text-sm">{t('widgetPage.appearance.showPoweredBy')}</Label>
                        <p className="text-[11px] text-muted-foreground">
                          {t('widgetPage.appearance.showPoweredByHint')}
                        </p>
                        {!capAllowed('widget_powered_by_toggle') && (
                          <p className="text-[11px] text-primary">
                            {t('widgetPage.appearance.showPoweredByLocked')}
                          </p>
                        )}
                      </div>
                      <Switch
                        disabled={!capAllowed('widget_powered_by_toggle')}
                        checked={
                          !capAllowed('widget_powered_by_toggle')
                            ? true
                            : ((live as any)?.show_powered_by ?? true)
                        }
                        onCheckedChange={v => setField('show_powered_by' as any, v, 0)}
                      />
                    </div>
                  )}


                </CardContent>
              </Card>

              {/* Launcher visuals (shape, icon, colour, scale, label, animation) are a
                  FIXED presentation spec in the Web Yar template — 56px round button,
                  chat/X icon, white glyph on the primary colour — so they are no longer
                  workspace-configurable. */}
              </div>
            </TabsContent>

            {/* ─── Behavior ─── */}
            <TabsContent value="behavior">
              <Card className="card-elevated">
                <CardContent className="p-6 space-y-5">
                  {[
                    { key: 'chat_enabled', label: t('widgetPage.behavior.liveChat'), hint: undefined as string | undefined, icon: MessageSquare, default: true },
                    { key: 'kb_enabled', label: t('widgetPage.behavior.knowledgeBase'), hint: undefined as string | undefined, icon: Globe, default: true },
                    { key: 'visitor_tracking_enabled', label: t('widgetPage.behavior.visitorTracking'), hint: undefined as string | undefined, icon: Eye, default: true },
                    { key: 'attachments_enabled', label: t('widgetPage.behavior.fileSharing'), hint: t('widgetPage.behavior.fileSharingHint'), icon: Paperclip, default: false },
                    { key: 'voice_notes_enabled', label: t('widgetPage.behavior.voiceNotes'), hint: t('widgetPage.behavior.voiceNotesHint'), icon: Mic, default: false },
                    { key: 'emoji_enabled', label: t('widgetPage.behavior.emoji'), hint: t('widgetPage.behavior.emojiHint'), icon: Smile, default: true },
                  ].map(feature => (
                    <div key={feature.key} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                          <feature.icon className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <Label className="text-sm">{feature.label}</Label>
                          {feature.hint && (
                            <p className="text-xs text-muted-foreground mt-0.5">{feature.hint}</p>
                          )}
                          {!capAllowed(BEHAVIOR_CAPABILITY[feature.key] || feature.key) && (
                            <p className="text-xs text-primary mt-0.5">{t('plan.locked.upgradeHint')}</p>
                          )}
                        </div>
                      </div>
                      <Switch
                        disabled={!capAllowed(BEHAVIOR_CAPABILITY[feature.key] || feature.key)}
                        checked={
                          capAllowed(BEHAVIOR_CAPABILITY[feature.key] || feature.key)
                            ? ((widget as any)?.[feature.key] ?? feature.default)
                            : false
                        }
                        onCheckedChange={v => handleToggle(feature.key, v)}
                      />
                    </div>
                  ))}

                  {/* Chat assignment — how a conversation is handed to an
                      operator once AI hands off (or AI is off). Replaces
                      what used to be manual-only assignment with a real,
                      never-random routing algorithm. */}
                  <div className="pt-4 mt-2 border-t border-border space-y-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                        <Users className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <Label className="text-sm">{t('widgetPage.behavior.assignmentMode')}</Label>
                        <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                          {t('widgetPage.behavior.assignmentModeHint')}
                        </p>
                        {!capAllowed('widget_assignment_routing') && (
                          <p className="text-xs text-primary mt-0.5 mb-2">{t('plan.locked.upgradeHint')}</p>
                        )}
                        <Select
                          disabled={!capAllowed('widget_assignment_routing')}
                          value={
                            capAllowed('widget_assignment_routing')
                              ? ((widget as any)?.assignment_mode || 'auto')
                              : 'manual'
                          }
                          onValueChange={(v) => handleToggle('assignment_mode', v as any)}
                        >
                          <SelectTrigger className="w-full sm:w-72"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">{t('widgetPage.behavior.assignmentModeAuto')}</SelectItem>
                            <SelectItem value="round_robin">{t('widgetPage.behavior.assignmentModeRoundRobin')}</SelectItem>
                            <SelectItem value="manual">{t('widgetPage.behavior.assignmentModeManual')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  {/* Privacy: optional raw IP capture (default OFF). */}
                  <div className="pt-4 mt-2 border-t border-border space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="p-2 rounded-lg bg-warning/10 shrink-0">
                          <Shield className="h-4 w-4 text-warning" />
                        </div>
                        <div className="min-w-0">
                          <Label className="text-sm">{t('visitors.storeRawIp')}</Label>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('visitors.storeRawIpHint')}
                          </p>
                          {!capAllowed('widget_raw_ip_storage') && (
                            <p className="text-xs text-primary mt-0.5">{t('plan.locked.upgradeHint')}</p>
                          )}
                        </div>
                      </div>
                      <Switch
                        disabled={!capAllowed('widget_raw_ip_storage')}
                        checked={capAllowed('widget_raw_ip_storage') && ((widget as any)?.store_raw_ip ?? false)}
                        onCheckedChange={(v) => handleToggle('store_raw_ip', v)}
                      />
                    </div>
                    {capAllowed('widget_raw_ip_storage') && (widget as any)?.store_raw_ip && (
                      <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>{t('visitors.storeRawIpWarning')}</span>
                      </div>
                    )}
                  </div>

                </CardContent>
              </Card>
            </TabsContent>

            {/* ─── Smart actions ─── */}
            <TabsContent value="smart">
              <PlanLockedOverlay featureKey="widget_smart_engagement">
              <SmartRulesTab
                workspaceId={workspace?.id}
                masterEnabled={(live as any)?.smart_engagement_enabled === true}
                onToggleMaster={(v) => handleToggle('smart_engagement_enabled', v)}
                locale={effectiveLocale}
                locales={regionLocales}
                localeLabels={LOCALE_LABELS}
                kbArticles={((kbArticlesData?.length ? kbArticlesData : kbArticlesAny) || []).map((a: any) => ({ title: a.title, slug: a.slug }))}
                previewSettings={previewSettings}
                brandName={workspace?.name || t('widgetPage.preview.brandFallback')}
                studioKbArticles={previewKbArticles}
                studioKbCategories={previewKbCategories}
              />
              </PlanLockedOverlay>
            </TabsContent>

            {/* ─── Availability ─── */}
            <TabsContent value="availability">
              <PlanLockedOverlay featureKey="widget_business_hours">
              {widget && (
                <AvailabilitySection
                  workspaceId={workspace?.id}
                  settings={widget}
                  onSave={(patch) => updateWidget.mutate(patch as any)}
                  saving={updateWidget.isPending}
                />
              )}
              </PlanLockedOverlay>
            </TabsContent>

            {/* ─── Pre-chat ─── */}
            <TabsContent value="prechat">
              <PrechatSection workspaceId={workspace?.id} />
            </TabsContent>

            {/* ─── Domains ─── */}
            <TabsContent value="domains">
              <PlanLockedOverlay featureKey="widget_domain_allowlist">
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Globe className="h-4 w-4" /> {t('widget.allowedDomains')}
                  </CardTitle>
                  <CardDescription>
                    {t('widgetPage.domains.description')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-start gap-2 bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground">
                    <Info className="h-4 w-4 mt-0.5 shrink-0" />
                    <p>{t('widgetPage.domains.hint')}</p>
                  </div>

                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <Input
                        placeholder="example.com"
                        value={newDomain}
                        onChange={e => { setNewDomain(e.target.value); setDomainError(''); }}
                        onKeyDown={e => e.key === 'Enter' && handleAddDomain()}
                      />
                      <Button onClick={handleAddDomain} variant="outline" size="sm" className="shrink-0">{t('widgetPage.domains.add')}</Button>
                    </div>
                    {domainError && <p className="text-xs text-destructive">{domainError}</p>}
                  </div>

                  <div className="space-y-2">
                    {widget?.allowed_domains?.map(domain => (
                      <div key={domain} className="flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2.5 border border-border">
                        <div>
                          <span className="text-sm font-mono">{domain}</span>
                          <span className="text-xs text-muted-foreground ms-2">(+ www.{domain})</span>
                        </div>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => handleRemoveDomain(domain)}>{t('widgetPage.domains.remove')}</Button>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t border-border">
                    <div className="space-y-0.5">
                      <Label className="text-sm">{t('widgetPage.domains.allowSubdomains')}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t('widgetPage.domains.allowSubdomainsHint')}
                      </p>
                    </div>
                    <Switch
                      checked={widget?.allow_subdomains ?? false}
                      onCheckedChange={v => handleToggle('allow_subdomains', v)}
                    />
                  </div>
                </CardContent>
              </Card>
              </PlanLockedOverlay>
            </TabsContent>

            {/* Deployment tab moved to Super Admin → Widget Settings */}

            {/* ─── Install ─── */}
            <TabsContent value="install">
              <div className="space-y-4">
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Code className="h-4 w-4" /> {t('widget.embedCode')}
                  </CardTitle>
                  <CardDescription>
                    {t('widget.installInstructions')}
                    <span className="flex items-center gap-1 mt-1 text-xs">
                      <ExternalLink className="h-3 w-3" />
                      {t('widgetPage.install.loaderUrl')}: <span dir="ltr" className="font-mono">{urls.loaderUrl}</span>
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative">
                    <pre dir="ltr" className="bg-muted rounded-lg p-4 text-xs overflow-x-auto font-mono whitespace-pre border border-border text-start">
                      {windowEmbedCode}
                    </pre>
                    <Button size="sm" variant="outline" className="absolute top-2 end-2" onClick={() => handleCopy('window')}>
                      {copiedVariant === 'window' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      <span className="ms-1 text-xs">{copiedVariant === 'window' ? t('common.copied') : t('common.copy')}</span>
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Code className="h-4 w-4" /> {t('widgetPage.install.scriptTitle')}
                  </CardTitle>
                  <CardDescription>
                    {t('widgetPage.install.scriptDescription')}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative">
                    <pre dir="ltr" className="bg-muted rounded-lg p-4 text-xs overflow-x-auto font-mono whitespace-pre border border-border text-start">
                      {scriptTagEmbedCode}
                    </pre>
                    <Button size="sm" variant="outline" className="absolute top-2 end-2" onClick={() => handleCopy('script')}>
                      {copiedVariant === 'script' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      <span className="ms-1 text-xs">{copiedVariant === 'script' ? t('common.copied') : t('common.copy')}</span>
                    </Button>
                  </div>
                  {urls.hasMissing && (
                    <p className="text-xs text-warning mt-3 flex items-center gap-1.5">
                      <Info className="h-3.5 w-3.5" />
                      {t('widgetPage.install.missingUrls')}
                    </p>
                  )}
                </CardContent>
              </Card>
              </div>
            </TabsContent>
        </div>

        {/* Live Preview — full-size, reflects every edit instantly */}
        <div className={cn('hidden', tab !== 'smart' && 'xl:block')}>
          <div className="sticky top-6 space-y-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> {t('widgetPage.preview.title')}
              </p>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
              {(['home', 'chat', 'prechat', 'kb', 'offline'] as PreviewView[]).map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={previewView === v ? 'default' : 'ghost'}
                  className="h-7 flex-1 px-2 text-[11px]"
                  onClick={() => setManualView(v)}
                >
                  {t(`widgetPage.preview.view.${v}` as any)}
                </Button>
              ))}
            </div>

            <div style={{ height: 'max(820px, calc(100vh - 190px))', minHeight: 820 }}>
              <WidgetLivePreview
                settings={previewSettings}
                prechat={prechat}
                workspaceName={workspace?.name || t('widgetPage.preview.brandFallback')}
                platformName={platformName || t('widgetPage.preview.brandFallback')}
                poweredBy={previewPoweredBy}
                teamMembers={previewTeamMembers}
                view={previewView}
                kbArticles={previewKbArticles}
                kbCategories={previewKbCategories}
                onViewChange={setManualView}
                operatorAvatar={previewOperator?.avatar_url}
                operatorName={previewOperator?.full_name}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">{t('widgetPage.preview.liveHint')}</p>
          </div>
        </div>
        </div>
      </Tabs>
    </div>
  );
}

/**
 * The widget surface is gated behind owner phone verification.
 * UI gating only — the backend RLS policies enforce the same rule on writes.
 */
export default function WidgetPage() {
  const workspace = useCurrentWorkspace();
  return (
    <PhoneVerificationGate purpose="widget_access" workspaceId={workspace?.id} mode="full_page">
      <WidgetPageContent />
    </PhoneVerificationGate>
  );
}
