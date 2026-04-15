import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings, useUpdateWidgetSettings } from '@/hooks/useWidgetSettings';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Copy, Check, Code, ExternalLink, Globe, Info } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

/** Strip protocol, www, trailing slash to get bare domain */
function normalizeDomainInput(input: string): string {
  let raw = input.trim();
  raw = raw.replace(/^https?:\/\//i, '');
  raw = raw.replace(/^www\./i, '');
  raw = raw.replace(/\/+$/, '');
  raw = raw.toLowerCase();
  return raw;
}

function isValidDomain(d: string): boolean {
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d);
}

export default function WidgetPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  const { branding, platformName } = useBrandingContext();
  const updateWidget = useUpdateWidgetSettings(workspace?.id);
  const [copied, setCopied] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [domainError, setDomainError] = useState('');

  const widgetBaseUrl = branding?.widget_base_url || window.location.origin;

  const embedCode = `<script type="text/javascript">
  window.__gs = [];
  window.__gs_id = "${workspace?.id || 'YOUR_WORKSPACE_ID'}";
  (function(){
    var d = document;
    var s = d.createElement("script");
    s.src = "${widgetBaseUrl}/widget/loader.js";
    s.async = 1;
    d.getElementsByTagName("head")[0].appendChild(s);
  })();
</script>`;

  const handleCopy = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    toast({ title: t('common.copied') });
    setTimeout(() => setCopied(false), 2000);
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
    <div className="space-y-6 animate-fade-in max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground">{t('widget.title')}</h1>

      {/* Enable/Disable */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t('widget.title')}</CardTitle>
              <CardDescription>Enable or disable the widget on your website</CardDescription>
            </div>
            <Switch
              checked={widget?.enabled ?? false}
              onCheckedChange={v => handleToggle('enabled', v)}
            />
          </div>
        </CardHeader>
      </Card>

      {/* Embed Code */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Code className="h-4 w-4" /> {t('widget.embedCode')}
          </CardTitle>
          <CardDescription>
            {t('widget.installInstructions')}
            {branding?.widget_base_url && (
              <span className="flex items-center gap-1 mt-1 text-xs">
                <ExternalLink className="h-3 w-3" />
                Widget URL: {branding.widget_base_url}
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto font-mono whitespace-pre">
              {embedCode}
            </pre>
            <Button size="sm" variant="outline" className="absolute top-2 end-2" onClick={handleCopy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ms-1">{copied ? t('common.copied') : t('common.copy')}</span>
            </Button>
          </div>
          {!branding?.widget_base_url && (
            <p className="text-xs text-warning mt-2">
              ⚠ Widget Base URL not configured. Go to Settings → Branding to set it for production.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('widget.appearance')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('widget.primaryColor')}</Label>
              <div className="flex gap-2">
                <Input
                  type="color"
                  value={widget?.primary_color || branding?.primary_color || '#3B82F6'}
                  onChange={e => updateWidget.mutate({ primary_color: e.target.value } as any)}
                  className="w-12 h-10 p-1"
                />
                <Input
                  value={widget?.primary_color || branding?.primary_color || '#3B82F6'}
                  onChange={e => updateWidget.mutate({ primary_color: e.target.value } as any)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('widget.position')}</Label>
              <Select
                value={widget?.position || 'bottom-right'}
                onValueChange={v => updateWidget.mutate({ position: v } as any)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bottom-right">Bottom Right</SelectItem>
                  <SelectItem value="bottom-left">Bottom Left</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('widget.launcherText')}</Label>
            <Input
              value={widget?.launcher_text || ''}
              onChange={e => updateWidget.mutate({ launcher_text: e.target.value } as any)}
              placeholder={platformName}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('widget.welcomeMessage')}</Label>
            <Textarea
              value={widget?.welcome_message || ''}
              onChange={e => updateWidget.mutate({ welcome_message: e.target.value } as any)}
            />
          </div>
          <div className="space-y-2">
            <Label>Locale</Label>
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

      {/* Features */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('widget.behavior')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Live Chat</Label>
            <Switch checked={widget?.chat_enabled ?? true} onCheckedChange={v => handleToggle('chat_enabled', v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label>Knowledge Base</Label>
            <Switch checked={widget?.kb_enabled ?? true} onCheckedChange={v => handleToggle('kb_enabled', v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label>Visitor Tracking</Label>
            <Switch checked={widget?.visitor_tracking_enabled ?? true} onCheckedChange={v => handleToggle('visitor_tracking_enabled', v)} />
          </div>
        </CardContent>
      </Card>

      {/* Allowed Domains */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" /> {t('widget.allowedDomains')}
          </CardTitle>
          <CardDescription>
            Restrict widget loading to specific domains. Leave empty to allow all.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Helper info */}
          <div className="flex items-start gap-2 bg-muted/50 rounded-md p-3 text-xs text-muted-foreground">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p>Enter a domain like <strong>example.com</strong>. Protocols (http/https) and <strong>www</strong> variants are automatically supported — no need to add them separately.</p>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex gap-2">
              <Input
                placeholder="example.com"
                value={newDomain}
                onChange={e => { setNewDomain(e.target.value); setDomainError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleAddDomain()}
              />
              <Button onClick={handleAddDomain} variant="outline">Add</Button>
            </div>
            {domainError && <p className="text-xs text-destructive">{domainError}</p>}
          </div>

          {widget?.allowed_domains?.map(domain => (
            <div key={domain} className="flex items-center justify-between bg-muted rounded px-3 py-2">
              <div>
                <span className="text-sm font-mono">{domain}</span>
                <span className="text-xs text-muted-foreground ms-2">
                  (+ www.{domain})
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleRemoveDomain(domain)}>Remove</Button>
            </div>
          ))}

          {/* Subdomain toggle */}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="space-y-0.5">
              <Label className="text-sm">Allow subdomains</Label>
              <p className="text-xs text-muted-foreground">
                When enabled, subdomains like app.example.com or shop.example.com are also allowed.
              </p>
            </div>
            <Switch
              checked={widget?.allow_subdomains ?? false}
              onCheckedChange={v => handleToggle('allow_subdomains', v)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
