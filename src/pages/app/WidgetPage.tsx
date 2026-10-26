import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import {
  useWidgetSettings,
  useUpdateWidgetSettings,
  useUploadWidgetFabImage,
  useRemoveWidgetFabImage,
  useWidgetAvailabilityNow,
  useWidgetWelcome,
} from '@/hooks/useWidgetSettings';
import { useWorkspaceDomains } from '@/hooks/useWorkspaceDomains';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useWidgetPlatformPublicSettings } from '@/hooks/useWidgetPlatformSettings';
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
import { Copy, Check, Code, ExternalLink, Globe, Info, Palette, Settings, Shield, Eye, MessageSquare, Link2, Clock, Sparkles, Plus, Paperclip, Mic, Smile, Lock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { AvailabilitySection } from '@/components/app/widget/AvailabilitySection';
import { ConversationAssignmentSection, InactivityCloseSetting } from '@/components/app/widget/ConversationAssignmentSection';
import { PlanReadOnlySection } from '@/components/app/widget/PlanReadOnlySection';
import { WidgetSaveStatus } from '@/components/app/widget/WidgetSaveStatus';
import { useWidgetSettingsDraft } from '@/hooks/useWidgetSettingsDraft';
import { cn } from '@/lib/utils';
import { PhoneVerificationGate } from '@/features/phone-verification/PhoneVerificationGate';
import { PrechatSection } from '@/components/app/widget/PrechatSection';
import { WidgetLivePreview, FAB_ICONS, type PreviewView } from '@/components/app/widget/WidgetLivePreview';
import { TemplateChoiceCard } from '@/components/app/widget/TemplateChoiceCard';
import { LauncherStylePicker } from '@/components/app/widget/LauncherStylePicker';
import { effectiveWorkspaceTemplate, templateCardVisible, useWorkspaceWidgetCatalog } from '@/hooks/useWidgetCatalog';
import { useKBArticles, useKBCategories } from '@/hooks/useKnowledgeBase';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { useTeamPresence } from '@/hooks/useTeamPresence';
import { useWidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useEdition } from '@/hooks/useEdition';
import { widgetTextDefault, widgetTextValue } from '../../../shared/widgetTextDefaults';
import { WIDGET_COLOR_PATTERN, widgetBrandColor, widgetOwnColor } from '../../../shared/widgetColor';
import { useLauncherKit } from '@/components/app/widget/launcherKit';
import { settingsErrorMessage } from '@/lib/settingsErrors';
import { Link } from 'react-router-dom';
import { SmartRulesTab } from '@/components/app/widget/smart/SmartRulesTab';
import { SkeletonForm, Skeleton } from '@/components/common/Skeletons';
import type { WidgetSettings } from '@/types/models';
import { chatTemplateOptionKeys } from '../../../shared/chatTemplateCatalog';
import { launcherChoiceFields, type LauncherStyleChoice } from '../../../shared/launcherStyles';
import { previewTeam } from '@/components/app/widget/previewTeam';

/** Any column the appearance form may edit through `setField`. */
type WidgetField = keyof WidgetSettings & string;

/**
 * The shape this page needs from the resolved entitlements: three keyed
 * bags whose entries carry a `value`. Deliberately narrow — the page only
 * ever asks "is this capability allowed" and "what is the domain cap".
 */
type EntitlementBag = {
  features?: Record<string, { value?: unknown } | undefined>;
  modules?: Record<string, { value?: unknown } | undefined>;
  limits?: Record<string, { value?: unknown } | undefined>;
};

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
  const { t, dir, locale } = useTranslation();
  const { isInternational, edition } = useEdition();
  const workspace = useCurrentWorkspace();
  const wsPath = useWorkspacePath();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  // The chat widget templates the Super Admin keeps enabled, and this
  // workspace's choice. A backend without the catalog answers 404: no picker.
  const { data: templateView, refetch: refetchTemplates } = useWorkspaceWidgetCatalog(workspace?.id, locale);
  // Chat bubbles in the preview show a real operator profile picture.
  const { data: workspaceMembers } = useWorkspaceMembers(workspace?.id);
  const { data: teamPresence } = useTeamPresence(workspace?.id);
  const previewOperator = (workspaceMembers || []).find((m) => m.avatar_url) || (workspaceMembers || [])[0];
  const { branding, platformName } = useBrandingContext();
  // Single source of truth — widget URLs come from platform widget settings only.
  const { data: platformWidget } = useWidgetPlatformPublicSettings();
  // Powered-by footer is platform-owned + plan-gated; the preview must show
  // exactly what production renders.
  const { data: effectiveEnts, loading: entsLoading, error: entsError } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const updateWidget = useUpdateWidgetSettings(workspace?.id);
  const uploadFab = useUploadWidgetFabImage(workspace?.id);
  const removeFab = useRemoveWidgetFabImage(workspace?.id);
  const { data: prechat } = useWidgetPrechatSettings(workspace?.id);
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  // The kit button visitors get: its size at 100% and its brand colour.
  const launcherKit = useLauncherKit();
  // Settings → Domains: the verified ones may show the widget too while the
  // list of Widget → Domains names a site (public.ts getWorkspaceOriginRules).
  const { data: workspaceDomains } = useWorkspaceDomains(workspace?.id);
  const [copiedVariant, setCopiedVariant] = useState<'window' | 'script' | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [domainError, setDomainError] = useState('');
  const [tab, setTab] = useState<string>('appearance');
  const [manualView, setManualView] = useState<PreviewView | null>(null);
  // A colour being typed that is not #RRGGBB yet: shown, never saved.
  const [colorDraft, setColorDraft] = useState<string | null>(null);

  /**
   * Local draft layer: every keystroke updates the preview instantly while the
   * actual save is debounced, so typing stays smooth and nothing is lost. A
   * refused save says why and puts the field back on the stored value;
   * leaving the page sends what is still waiting (useWidgetSettingsDraft).
   */
  const {
    live, draft, setDraft, setField: setDraftField, setFields, saveNow, cancelField, status: saveStatus, errorMessage: saveError,
  } = useWidgetSettingsDraft(workspace?.id, widget);
  const setField = (field: WidgetField, value: unknown, delay = 500) => setDraftField(field, value, delay);

  /** Launcher (FAB) image upload — goes through the workspace storage provider. */
  const fabImageInputRef = useRef<HTMLInputElement>(null);
  const [fabImageUploading, setFabImageUploading] = useState(false);
  /**
   * The launcher image goes to a DEDICATED backend endpoint, which stores it
   * in WebYar storage under a key it builds itself and records only that key.
   * The browser deliberately does not upload through the generic storage API
   * and then save the returned provider URL — that older shape persisted a
   * vendor hostname in `widget_settings`, which no longer has a writable
   * image-URL field at all.
   */
  async function uploadFabImage(file: File) {
    if (!workspace?.id) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast({ title: t('widgetPage.appearance.fabImageInvalid'), variant: 'destructive' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: t('widgetPage.appearance.fabImageTooLarge'), variant: 'destructive' });
      return;
    }
    setFabImageUploading(true);
    try {
      await uploadFab.mutateAsync(file);
      toast({ title: t('widgetPage.appearance.fabImageUploaded') });
    } catch (err) {
      toast({
        title: t('widgetPage.appearance.fabImageFailed'),
        description: settingsErrorMessage(err, t),
        variant: 'destructive',
      });
    } finally {
      setFabImageUploading(false);
    }
  }

  async function removeFabImage() {
    if (!workspace?.id) return;
    setFabImageUploading(true);
    try {
      await removeFab.mutateAsync();
    } catch (err) {
      toast({
        title: t('widgetPage.appearance.fabImageRemoveFailed'),
        description: settingsErrorMessage(err, t),
        variant: 'destructive',
      });
    } finally {
      setFabImageUploading(false);
    }
  }


  /**
   * Region lock: in a single-language platform the widget can only speak that
   * language, so the preview must render it (RTL included) even before the
   * workspace has ever picked a locale.
   */
  const regionLocales = allowedLocales.length ? allowedLocales : ['en'];
  // The language the widget speaks: one chosen (widget_language), else
  // `locale` ('auto', or no value — the column's default — follows the
  // visitor's browser among the platform's languages, then `locale`).
  const widgetLanguageAuto = !live?.widget_language || live.widget_language === 'auto';
  const chosenLanguage = !widgetLanguageAuto && regionLocales.includes(String(live?.widget_language)) ? String(live?.widget_language) : null;
  const effectiveLocale = chosenLanguage
    ?? (live?.locale && regionLocales.includes(live.locale) ? live.locale : regionLocales[0]);
  // "Automatic" is a choice only where there are languages to choose from.
  const offerAutoLanguage = canSwitchLanguage && regionLocales.length > 1;
  // What visitors read while the welcome field is empty, and whether the AI
  // agent greets instead (GET …/welcome, the rule /config uses).
  const { data: welcomeInfo } = useWidgetWelcome(workspace?.id, effectiveLocale);
  // Whether visitors find the team online now: the preview's home follows it.
  const { data: availabilityNow } = useWidgetAvailabilityNow(workspace?.id, effectiveLocale);
  /** Plan truth for widget behaviours. Unknown key => allowed (server decides). */
  const capAllowed = (key: string): boolean => {
    if (!effectiveEnts) return true;
    const bag = effectiveEnts as EntitlementBag;
    const f = bag.features?.[key] ?? bag.modules?.[key];
    return f ? f.value !== false : true;
  };
  const maxDomains = (() => {
    const l = (effectiveEnts as EntitlementBag | undefined)?.limits?.max_widget_domains?.value;
    return typeof l === 'number' ? l : -1;
  })();

  /** Appearance field → plan capability. Mirrors WIDGET_CUSTOMIZATION_CAPABILITY. */
  const APPEARANCE_CAPABILITY: Record<string, { capability: string; reset: string | number | null }> = {
    reply_time_text: { capability: 'widget_reply_time_text', reset: null },
    welcome_message: { capability: 'widget_welcome_message', reset: null },
    fab_label: { capability: 'widget_launcher_label', reset: null },
    fab_scale: { capability: 'widget_launcher_size', reset: 100 },
    fab_icon: { capability: 'widget_launcher_icon', reset: 'chat' },
    fab_shape: { capability: 'widget_launcher_icon', reset: 'circle' },
    placeholder_text: { capability: 'widget_composer_placeholder', reset: null },
    widget_template_id: { capability: 'widget_appearance', reset: null },
  };

  /**
   * The template visitors would wear with the current draft (the Super
   * Admin's catalog decides; shared/chatTemplateCatalog.ts) and its merged
   * options: what every preview on this page renders, never a stored id the
   * catalog does not offer.
   */
  const appearanceAllowed = capAllowed('widget_appearance');
  const previewTemplate = useMemo(
    () => effectiveWorkspaceTemplate(
      templateView,
      edition,
      live?.widget_template_id,
      live?.widget_template_options,
      appearanceAllowed,
    ),
    [templateView, edition, live?.widget_template_id, live?.widget_template_options, appearanceAllowed],
  );

  /**
   * A template pick: saved at once; the preview follows the draft. Through
   * mutateAsync, whose promise settles for this very call: mutate's per-call
   * callbacks fire only for the latest call, so a debounced field save
   * landing meanwhile would swallow a refusal and leave the draft on a
   * template the workspace does not wear.
   */
  const chooseTemplate = (id: string) => {
    cancelField('widget_template_id');
    setDraft((prev) => ({ ...prev, widget_template_id: id }));
    updateWidget.mutateAsync({ widget_template_id: id }).then(
      () => {
        toast({ title: t('widgetCatalog.workspace.changed') });
        void refetchTemplates();
      },
      (err: unknown) => {
        toast({
          title: err instanceof Error && err.message === 'template_not_available'
            ? t('widgetCatalog.workspace.notAvailable')
            : t('widgetCatalog.workspace.saveFailed'),
          variant: 'destructive',
        });
        setDraft((prev) => {
          const next = { ...prev };
          delete next.widget_template_id;
          return next;
        });
        void refetchTemplates();
      },
    );
  };

  const previewSettings = useMemo(
    () => {
      const base: Record<string, unknown> = {
        ...live,
        // Logo is no longer a widget-level URL field: fall back to the logo the
        // workspace owner uploaded in Settings → General.
        logo_url: live?.logo_url || branding?.logo_url || null,
        // The colour /config sends: the widget's own, else the workspace
        // branding's, else none (the brand's: shared/widgetColor.ts).
        primary_color: widgetOwnColor(live?.primary_color) ?? widgetOwnColor(branding?.primary_color),
        locale: effectiveLocale,
        widget_language: effectiveLocale,
      };
      // The preview must show exactly what the plan lets production render.
      for (const [column, def] of Object.entries(APPEARANCE_CAPABILITY)) {
        if (!capAllowed(def.capability)) base[column] = def.reset;
      }
      if (!capAllowed('widget_team_avatars')) base.show_team_avatars = false;
      // The launcher image is a launcher style (widget_launcher_icon).
      if (!capAllowed('widget_launcher_icon')) base.fab_image_url = null;
      if (!capAllowed('widget_workspace_logo')) base.show_logo = false;
      // Every preview (this page's and the smart studio's) renders the
      // template visitors would wear.
      base.widget_template_id = previewTemplate.id;
      base.widget_template_options = previewTemplate.options;
      return base;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, branding, effectiveLocale, effectiveEnts, previewTemplate],
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
    if (mayHide && live?.show_powered_by === false) return null;
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
  // The Super Admin's pre-chat policy (PrechatSection's lock badges read the
  // same): with the plan's widget_prechat_form, the preview draws the form
  // the server asks (shared/prechatPolicy.ts effectivePrechat).
  const previewPrechatPolicy = useMemo(() => ({
    name: platformWidget?.prechat_name_policy,
    email: platformWidget?.prechat_email_policy,
    phone: platformWidget?.prechat_phone_policy,
  }), [platformWidget]);
  // The team /config sends visitors: the first four members to join, under
  // the names visitors read in the widget's language, online as visitors see
  // them (previewTeam.ts). Every preview of the page draws it.
  const previewTeamMembers = useMemo(
    () => previewTeam(workspaceMembers, teamPresence?.presence, effectiveLocale),
    [workspaceMembers, teamPresence, effectiveLocale],
  );

  /**
   * A chat button style tile (LauncherStylePicker): its shape and icon, the
   * pill's text when it has none, and RESPOK's logo direction (a template
   * option, kept with the workspace's other options).
   */
  const chooseLauncher = (choice: LauncherStyleChoice) => {
    for (const [field, value] of launcherChoiceFields(choice, live?.widget_template_options)) setField(field, value, 0);
  };

  const LOCALE_LABELS: Record<string, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };

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
      .map((a) => ({ title: a.title, excerpt: a.excerpt, content: a.content })),
    [kbArticlesData, kbArticlesAny],
  );
  const previewKbCategories = useMemo(
    () => ((kbCategoriesData?.length ? kbCategoriesData : kbCategoriesAny) || [])
      .slice(0, 6)
      .map((c) => ({ name: c.name, description: c.description })),
    [kbCategoriesData, kbCategoriesAny],
  );

  // The widget's own colour, or none: "Brand colour", what visitors then see
  // (the workspace branding's colour, else the kit's; shared/widgetColor.ts).
  const ownColor = widgetOwnColor(live?.primary_color);
  const brandColor = widgetOwnColor(branding?.primary_color) ?? widgetBrandColor(launcherKit.kit);
  const shownColor = ownColor ?? brandColor;
  /** Launcher size is stored as a percentage (80–140) or a multiplier (0.8–1.4). */
  const fabScalePct = (() => {
    const raw = Number(live?.fab_scale);
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


  // Saves one switch at once (the assignment settings save through
  // ConversationAssignmentSection). A refusal is reported
  // (useWidgetSettingsDraft); the control shows the stored value.
  const handleToggle = (field: WidgetField, value: boolean) => {
    saveNow({ [field]: value } as Partial<WidgetSettings>);
  };

  const verifiedDomains = (workspaceDomains || []).filter((d) => d.verified && d.domain);

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
    saveNow({ allowed_domains: [...current, normalized] });
    setNewDomain('');
  };

  const handleRemoveDomain = (domain: string) => {
    const current = widget?.allowed_domains || [];
    saveNow({ allowed_domains: current.filter(d => d !== domain) });
  };

  /**
   * Plan-driven tabs. A tab whose plan feature is denied stays in the strip,
   * marked with a lock, and opens read-only with the upgrade notice
   * (PlanReadOnlySection): after a downgrade the owner still sees what is
   * stored instead of the tab vanishing. `install` has no capability: it is
   * the embed snippet and always available.
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
  const visibleTabs = [
    { v: 'appearance', icon: Palette },
    { v: 'behavior', icon: Settings },
    { v: 'smart', icon: Sparkles },
    { v: 'prechat', icon: MessageSquare },
    { v: 'availability', icon: Clock },
    { v: 'domains', icon: Shield },
    { v: 'install', icon: Code },
  ] as const;
  const tabAllowed = (v: string): boolean => {
    const cap = TAB_CAPABILITY[v];
    return !cap || capAllowed(cap);
  };
  /** A tab's content, read-only with the upgrade notice when the plan does not include it. */
  const planTab = (v: string, children: ReactNode) => (
    <PlanReadOnlySection featureKey={TAB_CAPABILITY[v] || v} allowed={tabAllowed(v)}>
      {children}
    </PlanReadOnlySection>
  );


  // Never render the tab strip before the plan snapshot is known — otherwise
  // plan-locked tabs appear for a moment and then vanish.
  if (isLoading || entsLoading || (!effectiveEnts && !entsError)) {
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
        <div data-page-hero="widget" className="mb-5 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm backdrop-blur">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold leading-tight sm:text-xl">{t('widgetPage.title')}</h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{t('widgetPage.subtitle')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
            <WidgetSaveStatus status={saveStatus} errorMessage={saveError} />
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
          </div>

          <TabsList className="mt-4 flex h-auto w-full flex-wrap items-center justify-start gap-1 rounded-full border border-border/70 bg-secondary/40 p-1">
            {visibleTabs.map(({ v, icon: Icon }) => (
              <TabsTrigger
                key={v}
                value={v}
                title={t(`widgetPage.tabDesc.${v}` as Parameters<typeof t>[0])}
                className={cn(
                  'flex h-9 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium',
                  'transition-all hover:bg-background/70',
                  'data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">{t(`widgetPage.tabs.${v}` as Parameters<typeof t>[0])}</span>
                {!tabAllowed(v) && (
                  <Lock className="h-3 w-3 shrink-0 opacity-70" aria-label={t('plan.locked.upgradeHint')} />
                )}
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
              {planTab('appearance',
              <div className="space-y-4">
              {/* 0 — Widget template: the picker with two or more templates
                  enabled; with one, only that template's own options */}
              {templateCardVisible(templateView, previewTemplate.id) && (
                <TemplateChoiceCard
                  view={templateView}
                  effectiveId={previewTemplate.id}
                  draftId={live?.widget_template_id}
                  draftOptions={live?.widget_template_options}
                  planAllows={appearanceAllowed}
                  onChoose={chooseTemplate}
                  onOptionsChange={(next) => setField('widget_template_options', next, 600)}
                />
              )}
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Palette className="h-4 w-4 text-primary" /> {t('widgetPage.tabs.appearance')}
                  </CardTitle>
                  <CardDescription>{t('widgetPage.tabDesc.appearance')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 p-6 pt-0">
                  {/* 1 — Display name: empty follows the workspace name; the
                      switch hides the line ('' — /config sends it as is). */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="widget-brand-name" className="text-xs font-medium">{t('widgetPage.appearance.brandName')}</Label>
                      <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {t('widgetPage.appearance.brandNameShow')}
                        <Switch
                          checked={live?.brand_name !== ''}
                          onCheckedChange={(v) => setField('brand_name', v ? null : '', 0)}
                          aria-label={t('widgetPage.appearance.brandNameShow')}
                        />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        id="widget-brand-name"
                        disabled={live?.brand_name === ''}
                        value={typeof live?.brand_name === 'string' ? live.brand_name : ''}
                        onChange={e => setField('brand_name', e.target.value === '' ? null : e.target.value)}
                        maxLength={200}
                        placeholder={workspace?.name || t('widgetPage.appearance.brandNamePlaceholder')}
                      />
                      {typeof live?.brand_name === 'string' && live.brand_name !== '' && (
                        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setField('brand_name', null, 0)}>
                          {t('widgetPage.appearance.useDefault')}
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.brandNameHint')}</p>
                  </div>

                  {/* 2 — Reply-time note: empty is the widget's own note (it
                      follows whether the team is online); the switch hides it. */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="widget-reply-time" className="text-xs font-medium">{t('widgetPage.preview.replyTimeLabel')}</Label>
                      {capAllowed('widget_reply_time_text') && (
                        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          {t('widgetPage.preview.replyTimeShow')}
                          <Switch
                            checked={live?.reply_time_text !== ''}
                            onCheckedChange={(v) => setField('reply_time_text', v ? null : '', 0)}
                            aria-label={t('widgetPage.preview.replyTimeShow')}
                          />
                        </label>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        id="widget-reply-time"
                        disabled={!capAllowed('widget_reply_time_text') || live?.reply_time_text === ''}
                        value={capAllowed('widget_reply_time_text') && typeof live?.reply_time_text === 'string' ? live.reply_time_text : ''}
                        onChange={e => setField('reply_time_text', e.target.value === '' ? null : e.target.value)}
                        maxLength={500}
                        placeholder={t('widgetPage.appearance.replyTimeDefault')}
                      />
                      {capAllowed('widget_reply_time_text') && typeof live?.reply_time_text === 'string' && live.reply_time_text !== '' && (
                        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setField('reply_time_text', null, 0)}>
                          {t('widgetPage.appearance.useDefault')}
                        </Button>
                      )}
                    </div>

                    {capAllowed('widget_reply_time_text') ? (
                      <p className="text-[11px] text-muted-foreground">{t('widgetPage.preview.replyTimeHint')}</p>
                    ) : (
                      <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                    )}
                  </div>

                  {/* 3 — Welcome message: the owner's own, else (empty) what the
                      placeholder shows, the text /config sends then. Opening the
                      page writes nothing. The seeds count as unset only in the
                      stored value: what is being typed stays as typed (an owner
                      typing "How can we help you?" keeps it), with a note that
                      visitors read the default for it. */}
                  <div className="space-y-2">
                    <Label htmlFor="widget-welcome" className="text-xs font-medium">{t('widget.welcomeMessage')}</Label>
                    <Textarea
                      id="widget-welcome"
                      disabled={!capAllowed('widget_welcome_message')}
                      value={!capAllowed('widget_welcome_message') ? ''
                        : 'welcome_message' in draft ? (draft.welcome_message ?? '')
                          : widgetTextValue(widget?.welcome_message, 'welcome')}
                      onChange={e => setField('welcome_message', e.target.value.trim() ? e.target.value : null)}
                      maxLength={2000}
                      rows={3}
                      placeholder={welcomeInfo?.default_text || widgetTextDefault('welcome', effectiveLocale)}
                    />
                    {capAllowed('widget_welcome_message') ? (
                      <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.welcomeHint')}</p>
                    ) : (
                      <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                    )}
                    {capAllowed('widget_welcome_message') && typeof draft.welcome_message === 'string'
                      && draft.welcome_message.trim() !== '' && !widgetTextValue(draft.welcome_message, 'welcome') && (
                      <p data-welcome-seed-note className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.welcomeSeedHint')}</p>
                    )}
                    {welcomeInfo?.ai_greeting && (
                      <p data-welcome-ai-note className="flex items-start gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
                        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span>{t('widgetPage.appearance.welcomeAiNote')}</span>
                      </p>
                    )}
                  </div>


                  {/* 4 — The widget's colour: "Brand colour" (none of its own,
                      NULL) or #RRGGBB (shared/widgetColor.ts). */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="widget-color" className="text-xs font-medium">{t('widget.primaryColor')}</Label>
                      <div className="flex gap-2">
                        <Input
                          type="color"
                          value={shownColor.toLowerCase()}
                          onChange={e => { setColorDraft(null); setField('primary_color', e.target.value.toUpperCase()); }}
                          aria-label={t('widget.primaryColor')}
                          className="h-10 w-12 shrink-0 cursor-pointer p-1"
                        />
                        <Input
                          id="widget-color"
                          value={colorDraft ?? ownColor ?? ''}
                          dir="ltr"
                          maxLength={7}
                          placeholder={t('widgetPage.appearance.colorBrand')}
                          aria-invalid={colorDraft !== null && !WIDGET_COLOR_PATTERN.test(colorDraft.trim())}
                          aria-describedby="widget-color-hint"
                          onChange={(e) => {
                            const typed = e.target.value;
                            const v = typed.trim();
                            if (!v) { setColorDraft(null); setField('primary_color', null); return; }
                            if (WIDGET_COLOR_PATTERN.test(v)) { setColorDraft(null); setField('primary_color', v.toUpperCase()); return; }
                            // Not a colour yet (being typed): shown, not saved.
                            setColorDraft(typed);
                          }}
                          className="text-start font-mono text-xs"
                        />
                      </div>
                      <div data-swatches className="flex flex-wrap gap-1.5 pt-1">
                        <button
                          type="button"
                          data-swatch-brand
                          aria-label={t('widgetPage.appearance.colorBrand')}
                          aria-pressed={!ownColor}
                          title={t('widgetPage.appearance.colorBrand')}
                          onClick={() => { setColorDraft(null); setField('primary_color', null, 0); }}
                          className={cn(
                            'flex h-6 items-center gap-1 rounded-full border-2 px-1.5 text-[10px] font-medium transition-transform hover:scale-105',
                            !ownColor ? 'border-foreground' : 'border-border/70',
                          )}
                        >
                          <span className="h-3.5 w-3.5 rounded-full" style={{ background: launcherKit.kit === 'iran' && brandColor === widgetBrandColor('iran') ? 'linear-gradient(140deg,#22D3B4,#0B7D6C)' : brandColor }} aria-hidden />
                          {t('widgetPage.appearance.colorBrand')}
                        </button>
                        {/* Real colours only: the seeded #3B82F6 is "Brand colour" on
                            the wire, so the blue here is its neighbour. */}
                        {['#2563EB', '#6366F1', '#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#111827'].map((c) => (
                          <button
                            key={c}
                            type="button"
                            aria-label={t('widgetPage.appearance.colorSwatch', { hex: c })}
                            aria-pressed={ownColor === c}
                            onClick={() => { setColorDraft(null); setField('primary_color', c, 0); }}
                            className={cn(
                              'h-6 w-6 rounded-full border-2 transition-transform hover:scale-110',
                              ownColor === c ? 'border-foreground' : 'border-transparent',
                            )}
                            style={{ background: c }}
                          />
                        ))}
                      </div>
                      <p id="widget-color-hint" className={cn('text-[11px]', colorDraft !== null ? 'text-destructive' : 'text-muted-foreground')} role={colorDraft !== null ? 'alert' : undefined}>
                        {colorDraft !== null ? t('widgetPage.appearance.colorInvalid') : t('widgetPage.appearance.colorBrandHint')}
                      </p>
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
                      {/* The widget's language (widget_language): automatic (the
                          visitor's browser, among the platform's languages, else
                          `locale`) or one language, which also becomes `locale`. */}
                      <Select
                        value={offerAutoLanguage && widgetLanguageAuto ? 'auto' : effectiveLocale}
                        disabled={!canSwitchLanguage}
                        onValueChange={v => (v === 'auto'
                          ? setField('widget_language', 'auto', 0)
                          : setFields({ widget_language: v, locale: v }, { delay: 0 }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {offerAutoLanguage && (
                            <SelectItem value="auto">{t('widgetPage.appearance.languageAuto')}</SelectItem>
                          )}
                          {regionLocales.map((l) => (
                            <SelectItem key={l} value={l}>{LOCALE_LABELS[l] || l}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {offerAutoLanguage && widgetLanguageAuto && (
                        <p className="text-[11px] text-muted-foreground">
                          {t('widgetPage.appearance.languageAutoHint', { language: LOCALE_LABELS[effectiveLocale] || effectiveLocale })}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 6 — Launcher bubble text (beside the floating button) */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.fabLabel')}</Label>
                    <Input
                      disabled={!capAllowed('widget_launcher_label')}
                      value={capAllowed('widget_launcher_label') ? (live?.fab_label || '') : ''}
                      onChange={e => setField('fab_label', e.target.value)}
                      maxLength={100}
                      placeholder={t(isInternational ? 'widgetPage.appearance.fabLabelPlaceholderIntl' : 'widgetPage.appearance.fabLabelPlaceholder')}
                    />
                    {capAllowed('widget_launcher_label') ? (
                      <p className="text-[11px] text-muted-foreground">
                        {t(capAllowed('widget_launcher_icon') && live?.fab_shape === 'pill' ? 'widgetPage.appearance.launcherPillHint' : 'widgetPage.appearance.fabLabelHint')}
                      </p>
                    ) : (
                      <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                    )}
                  </div>

                  {/* 7 — Launcher style, size + icon */}
                  <div className="space-y-4 rounded-lg border border-border/70 p-3">
                    <LauncherStylePicker
                      shape={capAllowed('widget_launcher_icon') ? live?.fab_shape : 'circle'}
                      icon={capAllowed('widget_launcher_icon') ? live?.fab_icon : 'chat'}
                      label={capAllowed('widget_launcher_label') ? live?.fab_label : ''}
                      primaryColor={ownColor ?? widgetOwnColor(branding?.primary_color)}
                      widgetLocale={effectiveLocale}
                      international={isInternational}
                      logoDirection={chatTemplateOptionKeys(previewTemplate.id).includes('logoDirection')
                        ? (previewTemplate.options.logoDirection === 'open' ? 'open' : 'thread')
                        : null}
                      allowed={capAllowed('widget_launcher_icon')}
                      labelAllowed={capAllowed('widget_launcher_label')}
                      logoAllowed={appearanceAllowed}
                      onChoose={chooseLauncher}
                    />
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium">{t('widgetPage.appearance.fabScale')}</Label>
                        <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                          {Math.round(launcherKit.baseSize * (capAllowed('widget_launcher_size') ? fabScalePct : 100) / 100)}px
                        </span>
                      </div>
                      <Slider
                        disabled={!capAllowed('widget_launcher_size')}
                        value={[capAllowed('widget_launcher_size') ? fabScalePct : 100]}
                        min={80}
                        max={140}
                        step={5}
                        onValueChange={v => setField('fab_scale', v[0], 300)}
                      />
                      {!capAllowed('widget_launcher_size') && (
                        <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widgetPage.appearance.launcherOtherIcons')}</Label>
                      <div data-icon-picker className={cn('flex flex-wrap gap-2', !capAllowed('widget_launcher_icon') && 'pointer-events-none opacity-50')}>
                        {/* The chat bubble and the headset are style tiles above. */}
                        {Object.keys(FAB_ICONS).filter((key) => key !== 'chat' && key !== 'headset').map((key) => (
                          <button
                            key={key}
                            type="button"
                            aria-label={t(`widgetPage.appearance.icon${key.charAt(0).toUpperCase()}${key.slice(1)}` as Parameters<typeof t>[0])}
                            aria-pressed={(capAllowed('widget_launcher_icon') ? (live?.fab_icon || 'chat') : 'chat') === key}
                            disabled={!capAllowed('widget_launcher_icon')}
                            onClick={() => setField('fab_icon', key, 0)}
                            className={cn(
                              'flex h-10 w-10 items-center justify-center rounded-xl border-2 transition-transform hover:scale-105',
                              (capAllowed('widget_launcher_icon') ? (live?.fab_icon || 'chat') : 'chat') === key
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
                    {/* Launcher image. The bytes go to a dedicated backend
                        endpoint, which stores them in WebYar storage and keeps
                        only the canonical key; `fab_image_url` here is derived
                        server-side for the current storage provider and is not
                        writable from this page. */}
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widgetPage.appearance.fabImage')}</Label>
                      <div className="flex items-center gap-3">
                        <div
                          className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/70 bg-muted"
                        >
                          {live?.fab_image_url ? (
                            <img src={live.fab_image_url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Palette className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        <input
                          ref={fabImageInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) uploadFabImage(f);
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={fabImageUploading || !capAllowed('widget_launcher_icon')}
                          onClick={() => fabImageInputRef.current?.click()}
                        >
                          {t('widgetPage.appearance.fabImageUpload')}
                        </Button>
                        {live?.fab_image_url && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={fabImageUploading}
                            onClick={() => void removeFabImage()}
                          >
                            {t('widgetPage.appearance.fabImageRemove')}
                          </Button>
                        )}
                      </div>
                      {capAllowed('widget_launcher_icon') ? (
                        <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.fabImageHint')}</p>
                      ) : (
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
                      maxLength={500}
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
                      {/* A logo link from an older version wins over the uploaded
                          logo (/config); it can only be removed. */}
                      {typeof widget?.logo_url === 'string' && widget.logo_url.trim() !== '' && (
                        <div data-logo-link className="space-y-1 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-[11px]">
                          <p>{t('widgetPage.appearance.logoLinkNotice')}</p>
                          <p dir="ltr" className="break-all font-mono text-muted-foreground">{widget.logo_url}</p>
                          <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => saveNow({ logo_url: null })}>
                            {t('widgetPage.appearance.logoLinkClear')}
                          </Button>
                        </div>
                      )}
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
                        {t(previewTemplate.id.startsWith('t1')
                          ? 'widgetPage.appearance.showTeamAvatarsHintT1'
                          : previewTemplate.id.startsWith('t2')
                            ? 'widgetPage.appearance.showTeamAvatarsHintT2'
                            : 'widgetPage.appearance.showTeamAvatarsHint')}
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
                      granting `widget_powered_by_toggle` may switch it off.
                      With the Super Admin's master switch off no widget
                      shows it (poweredBy.ts), and the card says so instead
                      of a locked "on". */}
                  {capAllowed('widget_powered_by') && (() => {
                    const platformOff = platformWidget?.powered_by_enabled === false;
                    const mayHide = capAllowed('widget_powered_by_toggle');
                    return (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3" data-powered-by-card>
                        <div className="space-y-1">
                          <Label htmlFor="widget-show-powered-by" className="text-sm">{t('widgetPage.appearance.showPoweredBy')}</Label>
                          <p className="text-[11px] text-muted-foreground">
                            {t('widgetPage.appearance.showPoweredByHint')}
                          </p>
                          {platformOff ? (
                            <p className="text-[11px] text-primary" data-powered-by-platform-off>
                              {t('widgetPage.appearance.showPoweredByPlatformOff')}
                            </p>
                          ) : !mayHide && (
                            <p className="text-[11px] text-primary">
                              {t('widgetPage.appearance.showPoweredByLocked')}
                            </p>
                          )}
                        </div>
                        <Switch
                          id="widget-show-powered-by"
                          disabled={platformOff || !mayHide}
                          checked={platformOff ? false : !mayHide ? true : (live?.show_powered_by ?? true)}
                          onCheckedChange={v => setField('show_powered_by', v, 0)}
                        />
                      </div>
                    );
                  })()}


                </CardContent>
              </Card>

              {/* Launcher visuals (shape, icon, colour, scale, label, animation) are a
                  FIXED presentation spec in the Web Yar template — 56px round button,
                  chat/X icon, white glyph on the primary colour — so they are no longer
                  workspace-configurable. */}
              </div>,
              )}
            </TabsContent>

            {/* ─── Behavior ─── */}
            <TabsContent value="behavior">
              {planTab('behavior',
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
                            ? (widget?.[feature.key] ?? feature.default)
                            : false
                        }
                        onCheckedChange={v => handleToggle(feature.key as WidgetField, v)}
                      />
                    </div>
                  ))}

                  {/* Conversation assignment: the mode, returning visitors,
                      capacity, the first-response timeout and the
                      inactivity close (every plan; below the card when
                      this tab is read-only). Saves go through the page's
                      save layer (status, refusals said). */}
                  <ConversationAssignmentSection
                    workspaceId={workspace?.id}
                    settings={live}
                    planAllowsRouting={capAllowed('widget_assignment_routing')}
                    onSave={(patch) => saveNow(patch)}
                    teamPath={wsPath('/settings/team-departments')}
                    showInactivityClose={tabAllowed('behavior')}
                  />

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
                        checked={capAllowed('widget_raw_ip_storage') && (widget?.store_raw_ip ?? false)}
                        onCheckedChange={(v) => handleToggle('store_raw_ip', v)}
                      />
                    </div>
                    {capAllowed('widget_raw_ip_storage') && widget?.store_raw_ip && (
                      <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>{t('visitors.storeRawIpWarning')}</span>
                      </div>
                    )}
                  </div>

                </CardContent>
              </Card>,
              )}
              {/* The inactivity close is never plan-gated (the server takes it
                  on every plan): on a plan without this tab it stays
                  editable here, outside the read-only copy above. */}
              {!tabAllowed('behavior') && (
                <Card className="card-elevated mt-4" data-behavior-not-plan-gated>
                  <CardContent className="p-6">
                    <InactivityCloseSetting
                      workspaceId={workspace?.id}
                      settings={live}
                      onSave={(patch) => saveNow(patch)}
                    />
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* ─── Smart actions ─── */}
            <TabsContent value="smart">
              {planTab('smart',
              <SmartRulesTab
                workspaceId={workspace?.id}
                masterEnabled={live?.smart_engagement_enabled === true}
                onToggleMaster={(v) => handleToggle('smart_engagement_enabled', v)}
                locale={effectiveLocale}
                locales={regionLocales}
                localeLabels={LOCALE_LABELS}
                kbArticles={((kbArticlesData?.length ? kbArticlesData : kbArticlesAny) || []).map((a) => ({ title: a.title, slug: a.slug }))}
                previewSettings={previewSettings}
                brandName={workspace?.name || t('widgetPage.preview.brandFallback')}
                teamMembers={previewTeamMembers}
                studioKbArticles={previewKbArticles}
                studioKbCategories={previewKbCategories}
              />,
              )}
            </TabsContent>

            {/* ─── Availability ─── */}
            <TabsContent value="availability">
              {planTab('availability',
                widget && (
                  <AvailabilitySection
                    workspaceId={workspace?.id}
                    settings={live}
                    onChange={(patch, opts) => setFields(patch, opts)}
                    saving={saveStatus === 'saving'}
                  />
                ),
              )}
            </TabsContent>

            {/* ─── Pre-chat ─── */}
            <TabsContent value="prechat">
              {planTab('prechat', <PrechatSection workspaceId={workspace?.id} />)}
            </TabsContent>

            {/* ─── Domains ─── */}
            <TabsContent value="domains">
              {planTab('domains',
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

                  {/* What really may show the widget (public.ts
                      getWorkspaceOriginRules): an empty list, any site; a list,
                      its sites and the workspace's verified domains. */}
                  {!(widget?.allowed_domains?.length) ? (
                    <p data-domains-any className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                      {t('widgetPage.domains.emptyAllowsAll')}
                    </p>
                  ) : verifiedDomains.length > 0 && (
                    <div data-domains-verified className="space-y-2 rounded-lg border border-border/70 p-3">
                      <div className="space-y-0.5">
                        <Label className="text-sm">{t('widgetPage.domains.verifiedTitle')}</Label>
                        <p className="text-xs text-muted-foreground">{t('widgetPage.domains.verifiedHint')}</p>
                      </div>
                      {verifiedDomains.map((d) => (
                        <div key={d.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2">
                          <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                          <span className="text-sm font-mono" dir="ltr">{d.domain}</span>
                        </div>
                      ))}
                      <Link to={wsPath('/settings/domains')} className="inline-block text-xs text-primary hover:underline">
                        {t('widgetPage.domains.manageDomains')}
                      </Link>
                    </div>
                  )}

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
              </Card>,
              )}
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
              {(['home', 'list', 'chat', 'prechat', 'kb', 'offline'] as PreviewView[]).map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={previewView === v ? 'default' : 'ghost'}
                  className="h-7 flex-1 px-2 text-[11px]"
                  onClick={() => setManualView(v)}
                >
                  {t(`widgetPage.preview.view.${v}` as Parameters<typeof t>[0])}
                </Button>
              ))}
            </div>

            <div style={{ height: 'max(820px, calc(100vh - 190px))', minHeight: 820 }}>
              <WidgetLivePreview
                settings={previewSettings}
                prechat={prechat}
                prechatPolicy={previewPrechatPolicy}
                prechatFormAllowed={capAllowed('widget_prechat_form')}
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
                templateId={previewTemplate.id}
                templateOptions={previewTemplate.options as Record<string, unknown>}
                availabilityState={availabilityNow?.state ?? null}
                aiGreets={welcomeInfo?.ai_greeting === true}
                defaultWelcome={welcomeInfo?.default_text ?? null}
                hiddenNote={t('widgetPage.preview.hiddenNote')}
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
