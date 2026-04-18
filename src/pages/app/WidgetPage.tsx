import { useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings, useUpdateWidgetSettings } from '@/hooks/useWidgetSettings';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { usePlatformDomains } from '@/hooks/usePlatformBranding';
import { useUpdateBranding } from '@/hooks/useBranding';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Copy, Check, Code, ExternalLink, Globe, Info, Palette, Settings, Shield, Eye, MessageSquare, Bug, Link2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

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

function nz(v: string | null | undefined): string {
  return (v || '').trim();
}

export default function WidgetPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  const { branding, platformName } = useBrandingContext();
  const { data: platformDomains } = usePlatformDomains();
  const updateWidget = useUpdateWidgetSettings(workspace?.id);
  const updateBranding = useUpdateBranding(workspace?.id);
  const [copiedVariant, setCopiedVariant] = useState<'window' | 'script' | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [domainError, setDomainError] = useState('');

  // Resolution: workspace override (if non-empty) → platform default → window.location.origin
  const wsWidgetPublic = nz((branding as any)?.widget_public_base_url);
  const wsWidgetLoader = nz((branding as any)?.widget_loader_base_url);
  const wsWidgetAsset = nz((branding as any)?.widget_base_url);
  const wsWidgetApi = nz((branding as any)?.widget_api_base_url);

  const pdWidget = nz(platformDomains?.widget_base_url);
  const pdPublic = nz(platformDomains?.public_base_url);
  const pdAsset = nz(platformDomains?.asset_base_url);
  const pdApi = nz(platformDomains?.api_base_url);

  const widgetPublicBaseUrl = wsWidgetPublic || pdWidget || pdPublic || window.location.origin;
  const widgetLoaderBaseUrl = wsWidgetLoader || pdWidget || widgetPublicBaseUrl;
  const widgetAssetBaseUrl = wsWidgetAsset || pdAsset || pdWidget || widgetLoaderBaseUrl;
  const widgetApiBaseUrl = wsWidgetApi || pdApi || '';

  const primaryColor = widget?.primary_color || branding?.primary_color || '#3B82F6';
  const loaderVersion = '2026-04-15-build-3';
  const loaderScriptUrl = `${widgetLoaderBaseUrl || 'https://widget.example.com'}/widget/loader.js?v=${encodeURIComponent(loaderVersion)}`;

  const windowEmbedCode = `<script type="text/javascript">
  window.__gs = [];
  window.__gs_id = "${workspace?.id || 'YOUR_WORKSPACE_ID'}";
  window.__gs_api_base = "${widgetApiBaseUrl || 'https://api.example.com'}";
  (function(){
    var d = document;
    var s = d.createElement("script");
    s.src = "${loaderScriptUrl}";
    s.setAttribute("data-asset-base", "${widgetAssetBaseUrl || 'https://widget.example.com'}");
    s.async = 1;
    d.getElementsByTagName("head")[0].appendChild(s);
  })();
</script>`;

  const scriptTagEmbedCode = `<script
  src="${loaderScriptUrl}"
  data-workspace-id="${workspace?.id || 'YOUR_WORKSPACE_ID'}"
  data-api-base="${widgetApiBaseUrl || 'https://api.example.com'}"
  data-asset-base="${widgetAssetBaseUrl || 'https://widget.example.com'}"
  async
></script>`;

  const embedPreview = useMemo(() => ({
    loader: loaderScriptUrl,
    api: widgetApiBaseUrl || '—',
    asset: widgetAssetBaseUrl || '—',
  }), [loaderScriptUrl, widgetApiBaseUrl, widgetAssetBaseUrl]);

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
      setDomainError('Please enter a valid domain (e.g. example.com)');
      return;
    }
    const current = widget?.allowed_domains || [];
    if (current.includes(normalized)) {
      setDomainError('This domain is already added');
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
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-header">{t('widget.title')}</h1>
          <p className="page-subtitle mt-1">Configure and customize the chat widget for your website</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={widget?.enabled ? 'default' : 'secondary'} className="text-xs">
            {widget?.enabled ? 'Active' : 'Inactive'}
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
              <TabsTrigger value="appearance" className="gap-1.5 text-xs"><Palette className="h-3.5 w-3.5" />Appearance</TabsTrigger>
              <TabsTrigger value="behavior" className="gap-1.5 text-xs"><Settings className="h-3.5 w-3.5" />Behavior</TabsTrigger>
              <TabsTrigger value="domains" className="gap-1.5 text-xs"><Shield className="h-3.5 w-3.5" />Domains</TabsTrigger>
              <TabsTrigger value="deployment" className="gap-1.5 text-xs"><Link2 className="h-3.5 w-3.5" />Deployment</TabsTrigger>
              <TabsTrigger value="install" className="gap-1.5 text-xs"><Code className="h-3.5 w-3.5" />Install</TabsTrigger>
            </TabsList>

            {/* ─── Appearance ─── */}
            <TabsContent value="appearance">
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
                          <SelectItem value="bottom-right">↘ Bottom Right</SelectItem>
                          <SelectItem value="bottom-left">↙ Bottom Left</SelectItem>
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
                      placeholder="Hi there 👋 How can we help?"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Widget Language</Label>
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
            </TabsContent>

            {/* ─── Behavior ─── */}
            <TabsContent value="behavior">
              <Card className="card-elevated">
                <CardContent className="p-6 space-y-5">
                  {[
                    { key: 'chat_enabled', label: 'Live Chat', icon: MessageSquare, default: true },
                    { key: 'kb_enabled', label: 'Knowledge Base', icon: Globe, default: true },
                    { key: 'visitor_tracking_enabled', label: 'Visitor Tracking', icon: Eye, default: true },
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
                </CardContent>
              </Card>
            </TabsContent>

            {/* ─── Domains ─── */}
            <TabsContent value="domains">
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Globe className="h-4 w-4" /> {t('widget.allowedDomains')}
                  </CardTitle>
                  <CardDescription>
                    Restrict widget loading to specific domains. Leave empty to allow all.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-start gap-2 bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground">
                    <Info className="h-4 w-4 mt-0.5 shrink-0" />
                    <p>Enter a domain like <strong>example.com</strong>. Protocols and <strong>www</strong> variants are automatically supported.</p>
                  </div>

                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <Input
                        placeholder="example.com"
                        value={newDomain}
                        onChange={e => { setNewDomain(e.target.value); setDomainError(''); }}
                        onKeyDown={e => e.key === 'Enter' && handleAddDomain()}
                      />
                      <Button onClick={handleAddDomain} variant="outline" size="sm" className="shrink-0">Add</Button>
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
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => handleRemoveDomain(domain)}>Remove</Button>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t border-border">
                    <div className="space-y-0.5">
                      <Label className="text-sm">Allow subdomains</Label>
                      <p className="text-xs text-muted-foreground">
                        e.g. app.example.com, shop.example.com
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

            <TabsContent value="deployment">
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Link2 className="h-4 w-4" /> Widget deployment settings
                  </CardTitle>
                  <CardDescription>
                    Each URL prefers the workspace override (if set) and falls back to the platform default. If your widget code shows the wrong domain, clear the workspace override here.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { key: 'widget_public_base_url', label: 'Widget Public Base URL', override: wsWidgetPublic, fallback: pdWidget || pdPublic, resolved: widgetPublicBaseUrl },
                    { key: 'widget_loader_base_url', label: 'Widget Loader Base URL', override: wsWidgetLoader, fallback: pdWidget, resolved: widgetLoaderBaseUrl },
                    { key: 'widget_base_url', label: 'Widget Asset Base URL', override: wsWidgetAsset, fallback: pdAsset || pdWidget, resolved: widgetAssetBaseUrl },
                    { key: 'widget_api_base_url', label: 'Widget API Base URL', override: wsWidgetApi, fallback: pdApi, resolved: widgetApiBaseUrl },
                  ].map(row => (
                    <div key={row.key} className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-xs font-medium">{row.label}</Label>
                        <Badge variant={row.override ? 'default' : 'secondary'} className="text-[10px]">
                          {row.override ? 'Workspace override' : 'Platform default'}
                        </Badge>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          key={`${row.key}-${row.override}`}
                          defaultValue={row.override}
                          placeholder={row.fallback || 'Inherits from platform default'}
                          onBlur={e => {
                            const v = e.target.value.trim();
                            if (v !== row.override) {
                              updateBranding.mutate({ [row.key]: v || null } as any, {
                                onSuccess: () => toast({ title: 'Updated' }),
                              });
                            }
                          }}
                          className="font-mono text-xs"
                        />
                        {row.override && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              updateBranding.mutate({ [row.key]: null } as any, {
                                onSuccess: () => toast({ title: 'Reset to platform default' }),
                              });
                            }}
                          >
                            Reset
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Resolved: <span className="font-mono text-foreground">{row.resolved || '—'}</span>
                      </p>
                    </div>
                  ))}

                  <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
                    <div className="space-y-0.5">
                      <Label className="text-sm flex items-center gap-2"><Bug className="h-3.5 w-3.5" /> Debug mode</Label>
                      <p className="text-xs text-muted-foreground">Temporary loader/runtime console logs for bootstrap and asset issues.</p>
                    </div>
                    <Switch checked={widget?.debug_mode ?? false} onCheckedChange={v => handleToggle('debug_mode', v)} />
                  </div>

                  <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2 text-sm">
                    <p className="font-medium text-foreground">Embed code preview</p>
                    <p className="text-muted-foreground">Loader URL: <span className="font-mono text-foreground">{embedPreview.loader}</span></p>
                    <p className="text-muted-foreground">API base: <span className="font-mono text-foreground">{embedPreview.api}</span></p>
                    <p className="text-muted-foreground">Asset base: <span className="font-mono text-foreground">{embedPreview.asset}</span></p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

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
                    {widgetLoaderBaseUrl && (
                      <span className="flex items-center gap-1 mt-1 text-xs">
                        <ExternalLink className="h-3 w-3" />
                        Loader URL: {widgetLoaderBaseUrl}
                      </span>
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative">
                    <pre className="bg-muted rounded-lg p-4 text-xs overflow-x-auto font-mono whitespace-pre border border-border">
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
                    <Code className="h-4 w-4" /> Script tag version
                  </CardTitle>
                  <CardDescription>
                    Use this version if you prefer a single script tag with explicit API and asset bases.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative">
                    <pre className="bg-muted rounded-lg p-4 text-xs overflow-x-auto font-mono whitespace-pre border border-border">
                      {scriptTagEmbedCode}
                    </pre>
                    <Button size="sm" variant="outline" className="absolute top-2 end-2" onClick={() => handleCopy('script')}>
                      {copiedVariant === 'script' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      <span className="ms-1 text-xs">{copiedVariant === 'script' ? t('common.copied') : t('common.copy')}</span>
                    </Button>
                  </div>
                  {!widgetLoaderBaseUrl && (
                    <p className="text-xs text-warning mt-3 flex items-center gap-1.5">
                      <Info className="h-3.5 w-3.5" />
                      Widget deployment URLs are not configured yet. Set them in Branding and platform domain settings before going live.
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
            <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5" /> Live Preview
            </p>
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
                  {widget?.launcher_text || platformName || 'Support'}
                  <p className="text-[10px] font-normal opacity-80 mt-0.5">
                    {(widget?.welcome_message || 'How can we help?').slice(0, 50)}
                  </p>
                </div>
                <div className="p-3 space-y-2 flex-1">
                  <div className="bg-muted rounded-lg p-2 text-[10px] text-muted-foreground max-w-[85%]">Hi! How can we help?</div>
                </div>
                <div className="border-t border-border p-2">
                  <div className="bg-muted rounded-full h-6 px-3 flex items-center">
                    <span className="text-[9px] text-muted-foreground">Type a message...</span>
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
