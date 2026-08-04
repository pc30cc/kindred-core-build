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
import { Badge } from '@/components/ui/badge';
import { Copy, Check, Code, ExternalLink, Globe, Info, Palette, Settings, Shield, Eye, MessageSquare, Link2, Clock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { AvailabilitySection } from '@/components/app/widget/AvailabilitySection';
import { cn } from '@/lib/utils';
import { TemplateGallery } from '@/components/app/widget/TemplateGallery';
import { PhoneVerificationGate } from '@/features/phone-verification/PhoneVerificationGate';
import { PrechatSection } from '@/components/app/widget/PrechatSection';
import { WidgetLivePreview, type PreviewView } from '@/components/app/widget/WidgetLivePreview';
import { useWidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';

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

  const urls = useMemo(
    () => resolveWidgetUrls(platformWidget, typeof window !== 'undefined' ? window.location.origin : undefined),
    [platformWidget],
  );

  const primaryColor = live?.primary_color || branding?.primary_color || '#3B82F6';
  const previewView: PreviewView =
    manualView ??
    (tab === 'prechat' ? 'prechat' : tab === 'availability' ? 'offline' : 'chat');

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-header">{t('widgetPage.title')}</h1>
          <p className="page-subtitle mt-1">{t('widgetPage.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={widget?.enabled ? 'default' : 'secondary'} className="text-xs">
            {widget?.enabled ? t('widgetPage.active') : t('widgetPage.inactive')}
          </Badge>
          <Switch
            checked={widget?.enabled ?? false}
            onCheckedChange={v => handleToggle('enabled', v)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        {/* Main config area */}
        <div className="space-y-6">
          <Tabs value={tab} onValueChange={setTab} className="space-y-5">
            <TabsList className="grid h-auto w-full grid-cols-2 gap-2 rounded-xl border border-border bg-secondary/40 p-2 sm:grid-cols-3 lg:grid-cols-6">
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
                  className={cn(
                    'flex h-auto flex-col items-center gap-1.5 rounded-lg px-2 py-3 text-center',
                    'data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-primary',
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-[13px] font-semibold leading-tight">{t(`widgetPage.tabs.${v}` as any)}</span>
                  <span className="hidden text-[11px] font-normal leading-tight text-muted-foreground sm:block">
                    {t(`widgetPage.tabDesc.${v}` as any)}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            {/* ─── Appearance ─── */}
            <TabsContent value="appearance">
              <div className="space-y-4">
              {/* Template gallery — wired to the platform-registered templates registry. */}
              <Card className="card-elevated">
                <CardContent className="p-6">
                  <TemplateGallery
                    selectedSlug={live?.template_slug || 'default'}
                    primaryColor={primaryColor}
                    brandLabel={live?.launcher_text || platformName || t('widgetPage.preview.brandFallback')}
                    saving={updateWidget.isPending}
                    onSelect={(slug) => {
                      // Reflect in the live preview immediately, then persist.
                      setDraft((prev) => ({ ...prev, template_slug: slug }));
                      updateWidget.mutate({ template_slug: slug } as any, {
                        onSuccess: () => toast({ title: t('widgetPage.template.updated'), description: t('widgetPage.template.updatedDescription', { name: slug }) }),
                        onError: (e: any) => toast({ title: t('widgetPage.template.updateFailed'), description: e.message, variant: 'destructive' }),
                      });
                    }}
                  />
                </CardContent>
              </Card>

              {/* Per-template customization — settings here apply to whichever template is active. */}
              <Card className="card-elevated">
                <CardContent className="p-6 space-y-5">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widget.primaryColor')}</Label>
                      <div className="flex gap-2">
                        <Input
                          type="color"
                          value={primaryColor}
                          onChange={e => setField('primary_color', e.target.value)}
                          className="w-12 h-10 p-1 cursor-pointer"
                        />
                        <Input
                          value={primaryColor}
                          onChange={e => setField('primary_color', e.target.value)}
                          className="font-mono text-xs"
                        />
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

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widget.launcherText')}</Label>
                    <Input
                      value={live?.launcher_text || ''}
                      onChange={e => setField('launcher_text', e.target.value)}
                      placeholder={platformName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widget.welcomeMessage')}</Label>
                    <Textarea
                      value={live?.welcome_message || ''}
                      onChange={e => setField('welcome_message', e.target.value)}
                      rows={3}
                      placeholder={t('widgetPage.appearance.welcomePlaceholder')}
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
          </Tabs>
        </div>

        {/* Live Preview — full-size, reflects every edit instantly */}
        <div className="hidden xl:block">
          <div className="sticky top-6 space-y-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> {t('widgetPage.preview.title')}
              </p>
              <Badge variant="outline" className="text-[10px] capitalize">
                {live?.template_slug || 'default'}
              </Badge>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
              {(['chat', 'prechat', 'kb', 'offline'] as PreviewView[]).map((v) => (
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
              />
            </div>
            <p className="text-[11px] text-muted-foreground">{t('widgetPage.preview.liveHint')}</p>
          </div>
        </div>
      </div>
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
