import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings } from '@/hooks/useWidgetSettings';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Copy, Check, Code, ExternalLink, Palette, Settings2, Languages } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import WidgetThemesTab from '@/components/widget/WidgetThemesTab';
import WidgetGeneralTab from '@/components/widget/WidgetGeneralTab';
import WidgetLanguageTab from '@/components/widget/WidgetLanguageTab';

export default function WidgetPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  const { branding } = useBrandingContext();
  const [copied, setCopied] = useState(false);

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

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground">{t('widget.title')}</h1>

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

      {/* Tabs */}
      <Tabs defaultValue="themes" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="themes" className="flex items-center gap-1.5">
            <Palette className="h-4 w-4" />
            <span>قالب‌ها</span>
          </TabsTrigger>
          <TabsTrigger value="general" className="flex items-center gap-1.5">
            <Settings2 className="h-4 w-4" />
            <span>تنظیمات عمومی</span>
          </TabsTrigger>
          <TabsTrigger value="language" className="flex items-center gap-1.5">
            <Languages className="h-4 w-4" />
            <span>تنظیمات زبان</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="themes">
          <WidgetThemesTab />
        </TabsContent>
        <TabsContent value="general">
          <WidgetGeneralTab />
        </TabsContent>
        <TabsContent value="language">
          <WidgetLanguageTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
