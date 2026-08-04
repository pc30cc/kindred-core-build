import { useMemo, useState } from 'react';
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
import { TemplateGallery } from '@/components/app/widget/TemplateGallery';
import { PhoneVerificationGate } from '@/features/phone-verification/PhoneVerificationGate';
import { PrechatSection } from '@/components/app/widget/PrechatSection';

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
  const [copiedVariant, setCopiedVariant] = useState<'window' | 'script' | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [domainError, setDomainError] = useState('');

  const urls = useMemo(
    () => resolveWidgetUrls(platformWidget, typeof window !== 'undefined' ? window.location.origin : undefined),
    [platformWidget],
  );

  const primaryColor = widget?.primary_color || branding?.primary_color || '#3B82F6';

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

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Main config area */}
        <div className="space-y-6">
          <Tabs defaultValue="appearance" className="space-y-4">
            <TabsList className="bg-secondary/50 border border-border">
              <TabsTrigger value="appearance" className="gap-1.5 text-xs"><Palette className="h-3.5 w-3.5" />{t('widgetPage.tabs.appearance')}</TabsTrigger>
              <TabsTrigger value="behavior" className="gap-1.5 text-xs"><Settings className="h-3.5 w-3.5" />{t('widgetPage.tabs.behavior')}</TabsTrigger>
              <TabsTrigger value="prechat" className="gap-1.5 text-xs"><MessageSquare className="h-3.5 w-3.5" />{t('widgetPage.tabs.prechat')}</TabsTrigger>
              <TabsTrigger value="availability" className="gap-1.5 text-xs"><Clock className="h-3.5 w-3.5" />{t('widgetPage.tabs.availability')}</TabsTrigger>
              <TabsTrigger value="domains" className="gap-1.5 text-xs"><Shield className="h-3.5 w-3.5" />{t('widgetPage.tabs.domains')}</TabsTrigger>
              <TabsTrigger value="install" className="gap-1.5 text-xs"><Code className="h-3.5 w-3.5" />{t('widgetPage.tabs.install')}</TabsTrigger>
            </TabsList>

            {/* ─── Appearance ─── */}
            <TabsContent value="appearance">
              <div className="space-y-4">
              {/* Template gallery — wired to the platform-registered templates registry. */}
              <Card className="card-elevated">
                <CardContent className="p-6">
                  <TemplateGallery
                    selectedSlug={(widget as any)?.template_slug || 'default'}
                    primaryColor={primaryColor}
                    brandLabel={widget?.launcher_text || platformName || t('widgetPage.preview.brandFallback')}
                    saving={updateWidget.isPending}
                    onSelect={(slug) => {
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
                          onChange={e => updateWidget.mutate({ primary_color: e.target.value } as any)}
                          className="w-12 h-10 p-1 cursor-pointer"
                        />
                        <Input
                          value={primaryColor}
                          onChange={e => updateWidget.mutate({ primary_color: e.target.value } as any)}
                          className="font-mono text-xs"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t('widget.position')}</Label>
                      <Select
                        value={widget?.position || 'bottom-right'}
                        onValueChange={v => updateWidget.mutate({ position: v } as any)}
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
                      value={widget?.launcher_text || ''}
                      onChange={e => updateWidget.mutate({ launcher_text: e.target.value } as any)}
                      placeholder={platformName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widget.welcomeMessage')}</Label>
                    <Textarea
                      value={widget?.welcome_message || ''}
                      onChange={e => updateWidget.mutate({ welcome_message: e.target.value } as any)}
                      rows={3}
                      placeholder={t('widgetPage.appearance.welcomePlaceholder')}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('widgetPage.appearance.language')}</Label>
                    <Select
                      value={widget?.locale || 'en'}
                      onValueChange={v => updateWidget.mutate({ locale: v } as any)}
                    >
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="fa">فارسی</SelectItem>
                        <SelectItem value="tr">Türkçe</SelectItem>
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

        {/* Live Preview */}
        <div className="hidden lg:block">
          <div className="sticky top-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" /> {t('widgetPage.preview.title')}
              </p>
              <Badge variant="outline" className="text-[10px] capitalize">
                {(widget as any)?.template_slug || 'default'}
              </Badge>
            </div>
            <div className="relative bg-muted/30 border border-border rounded-xl overflow-hidden" style={{ height: 520 }}>
              {/* Mini website preview */}
              <div className="p-4 space-y-3">
                <div className="h-4 w-3/4 bg-muted rounded" />
                <div className="h-3 w-full bg-muted/60 rounded" />
                <div className="h-3 w-5/6 bg-muted/60 rounded" />
                <div className="h-24 w-full bg-muted/40 rounded-lg mt-4" />
                <div className="h-3 w-2/3 bg-muted/60 rounded" />
                <div className="h-3 w-full bg-muted/60 rounded" />
              </div>

              {/* Widget launcher preview */}
              <div
                className="absolute flex items-center justify-center rounded-full shadow-lg cursor-default"
                style={{
                  width: 48,
                  height: 48,
                  background: primaryColor,
                  color: '#fff',
                  bottom: 16,
                  ...(widget?.position === 'bottom-left' ? { left: 16 } : { right: 16 }),
                }}
              >
                <MessageSquare className="h-5 w-5" />
              </div>

              {/* Mini chat panel preview */}
              <div
                className="absolute bg-card border border-border rounded-xl shadow-xl overflow-hidden"
                style={{
                  width: 240,
                  height: 300,
                  bottom: 72,
                  ...(widget?.position === 'bottom-left' ? { left: 16 } : { right: 16 }),
                }}
              >
                <div className="p-3 text-white text-xs font-semibold" style={{ background: primaryColor }}>
                  {widget?.launcher_text || platformName || t('widgetPage.preview.brandFallback')}
                  <p className="text-[10px] font-normal opacity-80 mt-0.5">
                    {(widget?.welcome_message || t('widgetPage.preview.welcomeFallback')).slice(0, 50)}
                  </p>
                </div>
                <div className="p-3 space-y-2 flex-1">
                  <div className="bg-muted rounded-lg p-2 text-[10px] text-muted-foreground max-w-[85%]">{t('widgetPage.preview.sampleMessage')}</div>
                </div>
                <div className="border-t border-border p-2">
                  <div className="bg-muted rounded-full h-6 px-3 flex items-center">
                    <span className="text-[9px] text-muted-foreground">{t('widgetPage.preview.inputPlaceholder')}</span>
                  </div>
                </div>
              </div>
            </div>
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
