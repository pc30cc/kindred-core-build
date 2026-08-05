import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings, useUpdateWidgetSettings } from '@/hooks/useWidgetSettings';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useWidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { resolveWidgetUrls, buildWidgetEmbedSnippet } from '@/lib/widgetEmbed';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Copy, Check, Code, ExternalLink, Globe, Info, Palette, Settings, Shield, Eye, MessageSquare, Link2, Clock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { AvailabilitySection } from '@/components/app/widget/AvailabilitySection';
import { cn } from '@/lib/utils';
import { PhoneVerificationGate } from '@/features/phone-verification/PhoneVerificationGate';
import { PrechatSection } from '@/components/app/widget/PrechatSection';
import { WidgetLivePreview, type PreviewView } from '@/components/app/widget/WidgetLivePreview';
import { useKBArticles, useKBCategories } from '@/hooks/useKnowledgeBase';
import { useWidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { widgetTextDefault, widgetTextValue } from '@/lib/widgetLocaleDefaults';

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
  const { branding, platformName } = useBrandingContext();
  // Single source of truth — widget URLs come from platform widget settings only.
  const { data: platformWidget } = useWidgetPlatformSettings();
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
  const previewSettings = useMemo(
    () => ({ ...live, locale: effectiveLocale, widget_language: effectiveLocale }),
    [live, effectiveLocale],
  );

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
    if (!widgetTextValue((widget as any).launcher_text, 'launcher', effectiveLocale)) {
      patch.launcher_text = widgetTextDefault('launcher', effectiveLocale);
    }
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
  const previewKbArticles = useMemo(
    () => (kbArticlesData || []).slice(0, 6).map((a: any) => ({ title: a.title, excerpt: a.excerpt })),
    [kbArticlesData],
  );
  const previewKbCategories = useMemo(
    () => (kbCategoriesData || []).slice(0, 6).map((c: any) => ({ name: c.name, description: c.description })),
    [kbCategoriesData],
  );

  const primaryColor = live?.primary_color || branding?.primary_color || '#3B82F6';
  const previewView: PreviewView =
    manualView ??
    (tab === 'prechat' ? 'prechat' : tab === 'availability' ? 'offline' : 'home');

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
    setDomainError('');
    updateWidget.mutate({ allowed_domains: [...current, normalized] } as any);
    setNewDomain('');
  };

  const handleRemoveDomain = (domain: string) => {
    const current = widget?.allowed_domains || [];
    updateWidget.mutate({ allowed_domains: current.filter(d => d !== domain) } as any);
  };

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;
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
            {([
              { v: 'appearance', icon: Palette },
              { v: 'behavior', icon: Settings },
              { v: 'prechat', icon: MessageSquare },
              { v: 'availability', icon: Clock },
              { v: 'domains', icon: Shield },
              { v: 'install', icon: Code },
            ] as const).map(({ v, icon: Icon }) => (
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

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          {/* Main config area */}
          <div className="space-y-6">
            {/* ─── Appearance ─── */}
            <TabsContent value="appearance">
              <div className="space-y-4">
              {/* Single unified template: the widget always uses the built-in template,
                  fully customizable through the controls below. */}
              {/* Per-template customization — settings here apply to whichever template is active. */}
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Palette className="h-4 w-4 text-primary" /> {t('widgetPage.tabs.appearance')}
                  </CardTitle>
                  <CardDescription>{t('widgetPage.tabDesc.appearance')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 p-6 pt-0">
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
                  </div>

                  {/* Secondary color — drives the header gradient */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.secondaryColor')}</Label>
                    <div className="flex gap-2">
                      <Input
                        type="color"
                        value={live?.secondary_color || primaryColor}
                        onChange={e => setField('secondary_color', e.target.value)}
                        className="h-10 w-12 shrink-0 cursor-pointer p-1"
                      />
                      <Input
                        value={live?.secondary_color || ''}
                        dir="ltr"
                        placeholder={primaryColor}
                        onChange={e => setField('secondary_color', e.target.value)}
                        className="text-start font-mono text-xs"
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.gradientHint')}</p>
                  </div>

                  {/* Header/panel gradient — presets write both stops at once */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.gradientTheme')}</Label>
                    <div
                      className="h-12 w-full rounded-xl border border-border/60 shadow-inner"
                      style={{ background: `linear-gradient(165deg, ${primaryColor} 0%, ${live?.secondary_color || primaryColor} 100%)` }}
                    />
                    <div className="flex flex-wrap gap-2 pt-1">
                      {([
                        ['#3B82F6', '#6366F1'],
                        ['#0EA5E9', '#22D3EE'],
                        ['#8B5CF6', '#EC4899'],
                        ['#10B981', '#0D9488'],
                        ['#F59E0B', '#EF4444'],
                        ['#111827', '#374151'],
                      ] as const).map(([from, to]) => (
                        <button
                          key={from + to}
                          type="button"
                          aria-label={`${from} → ${to}`}
                          onClick={() => {
                            setField('primary_color', from, 0);
                            setField('secondary_color', to, 0);
                          }}
                          className={cn(
                            'h-8 w-12 rounded-lg border-2 transition-transform hover:scale-105',
                            primaryColor.toLowerCase() === from.toLowerCase() &&
                              (live?.secondary_color || '').toLowerCase() === to.toLowerCase()
                              ? 'border-foreground'
                              : 'border-transparent',
                          )}
                          style={{ background: `linear-gradient(165deg, ${from} 0%, ${to} 100%)` }}
                        />
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.gradientThemeHint')}</p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widget.launcherText')}</Label>
                    <Input
                      value={widgetTextValue(live?.launcher_text, 'launcher', effectiveLocale)}
                      onChange={e => setField('launcher_text', e.target.value)}
                      placeholder={widgetTextDefault('launcher', effectiveLocale) || platformName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widget.welcomeMessage')}</Label>
                    <Textarea
                      value={widgetTextValue(live?.welcome_message, 'welcome', effectiveLocale)}
                      onChange={e => setField('welcome_message', e.target.value)}
                      rows={3}
                      placeholder={widgetTextDefault('welcome', effectiveLocale)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.preview.inputPlaceholder')}</Label>
                    <Input
                      value={live?.placeholder_text || ''}
                      onChange={e => setField('placeholder_text', e.target.value)}
                      placeholder={t('widgetPage.preview.inputPlaceholder')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.language')}</Label>
                    <Select
                      value={effectiveLocale}
                      disabled={!canSwitchLanguage}
                      onValueChange={v => setField('locale', v, 0)}
                    >
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {regionLocales.map((l) => (
                          <SelectItem key={l} value={l}>{LOCALE_LABELS[l] || l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                    <Label className="text-sm">{t('widgetPage.appearance.showLogo')}</Label>
                    <Switch
                      checked={live?.show_logo ?? true}
                      onCheckedChange={v => setField('show_logo', v, 0)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.logoUrl')}</Label>
                    <div className="flex items-center gap-3">
                      {live?.logo_url ? (
                        <img
                          src={live.logo_url}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-lg border border-border object-cover"
                        />
                      ) : null}
                      <Input
                        value={live?.logo_url || ''}
                        dir="ltr"
                        placeholder="https://…/logo.png"
                        onChange={e => setField('logo_url', e.target.value)}
                        className="text-start"
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.logoHint')}</p>
                  </div>
                </CardContent>
              </Card>

              {/* ── Launcher button ── */}
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('widgetPage.appearance.launcherSection')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5 p-6 pt-0">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widgetPage.appearance.fabShape')}</Label>
                      <Select
                        value={live?.fab_shape || 'round'}
                        onValueChange={v => setField('fab_shape', v, 0)}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="round">{t('widgetPage.appearance.shapeRound')}</SelectItem>
                          <SelectItem value="square">{t('widgetPage.appearance.shapeSquare')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widgetPage.appearance.fabIconColor')}</Label>
                      <div className="flex gap-2">
                        <Input
                          type="color"
                          value={live?.fab_icon_color || '#FFFFFF'}
                          onChange={e => setField('fab_icon_color', e.target.value)}
                          className="h-10 w-12 shrink-0 cursor-pointer p-1"
                        />
                        <Input
                          value={live?.fab_icon_color || ''}
                          dir="ltr"
                          placeholder="#FFFFFF"
                          onChange={e => setField('fab_icon_color', e.target.value)}
                          className="text-start font-mono text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.fabIcon')}</Label>
                    <Select
                      value={live?.fab_icon || 'chat'}
                      onValueChange={v => setField('fab_icon', v, 0)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="chat">{t('widgetPage.appearance.iconChat')}</SelectItem>
                        <SelectItem value="message">{t('widgetPage.appearance.iconMessage')}</SelectItem>
                        <SelectItem value="help">{t('widgetPage.appearance.iconHelp')}</SelectItem>
                        <SelectItem value="headset">{t('widgetPage.appearance.iconHeadset')}</SelectItem>
                        <SelectItem value="phone">{t('widgetPage.appearance.iconPhone')}</SelectItem>
                        <SelectItem value="sparkles">{t('widgetPage.appearance.iconSparkles')}</SelectItem>
                        <SelectItem value="smile">{t('widgetPage.appearance.iconSmile')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">
                      {t('widgetPage.appearance.fabScale')} —{' '}
                      {(() => {
                        const raw = Number(live?.fab_scale);
                        if (!isFinite(raw) || raw <= 0) return 100;
                        return Math.round(raw > 3 ? raw : raw * 100);
                      })()}%
                    </Label>
                    <input
                      type="range"
                      min={80}
                      max={140}
                      step={5}
                      value={(() => {
                        const raw = Number(live?.fab_scale);
                        if (!isFinite(raw) || raw <= 0) return 100;
                        return Math.round(raw > 3 ? raw : raw * 100);
                      })()}
                      onChange={e => setField('fab_scale', Number(e.target.value), 400)}
                      className="w-full accent-primary"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.fabLabel')}</Label>
                    <Input
                      value={live?.fab_label || ''}
                      onChange={e => setField('fab_label', e.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.fabLabelHint')}</p>
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
                    <Label className="text-sm">{t('widgetPage.appearance.fabAnimation')}</Label>
                    <Switch
                      checked={live?.fab_animation ?? false}
                      onCheckedChange={v => setField('fab_animation', v, 0)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.autoOpenDelay')}</Label>
                    <Input
                      type="number"
                      min={0}
                      dir="ltr"
                      value={live?.auto_open_delay ?? 0}
                      onChange={e => setField('auto_open_delay', Number(e.target.value) || 0)}
                      className="w-32 text-start"
                    />
                    <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.autoOpenHint')}</p>
                  </div>
                </CardContent>
              </Card>
              </div>
            </TabsContent>

            {/* ─── Behavior ─── */}
            <TabsContent value="behavior">
              <Card className="card-elevated">
                <CardContent className="p-6 space-y-5">
                  {[
                    { key: 'chat_enabled', label: t('widgetPage.behavior.liveChat'), icon: MessageSquare, default: true },
                    { key: 'kb_enabled', label: t('widgetPage.behavior.knowledgeBase'), icon: Globe, default: true },
                    { key: 'visitor_tracking_enabled', label: t('widgetPage.behavior.visitorTracking'), icon: Eye, default: true },
                  ].map(feature => (
                    <div key={feature.key} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                          <feature.icon className="h-4 w-4 text-primary" />
                        </div>
                        <Label className="text-sm">{feature.label}</Label>
                      </div>
                      <Switch
                        checked={(widget as any)?.[feature.key] ?? feature.default}
                        onCheckedChange={v => handleToggle(feature.key, v)}
                      />
                    </div>
                  ))}

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
                        </div>
                      </div>
                      <Switch
                        checked={(widget as any)?.store_raw_ip ?? false}
                        onCheckedChange={(v) => handleToggle('store_raw_ip', v)}
                      />
                    </div>
                    {(widget as any)?.store_raw_ip && (
                      <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>{t('visitors.storeRawIpWarning')}</span>
                      </div>
                    )}
                  </div>

                </CardContent>
              </Card>
            </TabsContent>

            {/* ─── Availability ─── */}
            <TabsContent value="availability">
              {widget && (
                <AvailabilitySection
                  workspaceId={workspace?.id}
                  settings={widget}
                  onSave={(patch) => updateWidget.mutate(patch as any)}
                  saving={updateWidget.isPending}
                />
              )}
            </TabsContent>

            {/* ─── Pre-chat ─── */}
            <TabsContent value="prechat">
              <PrechatSection workspaceId={workspace?.id} />
            </TabsContent>

            {/* ─── Domains ─── */}
            <TabsContent value="domains">
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
        <div className="hidden xl:block">
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

            <div style={{ height: 'calc(100vh - 190px)', minHeight: 560 }}>
              <WidgetLivePreview
                settings={previewSettings}
                prechat={prechat}
                brandName={platformName || t('widgetPage.preview.brandFallback')}
                view={previewView}
                kbArticles={previewKbArticles}
                kbCategories={previewKbCategories}
                onViewChange={setManualView}
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
