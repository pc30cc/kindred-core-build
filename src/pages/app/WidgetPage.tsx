import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';

export default function WidgetPage() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const embedCode = `<script type="text/javascript">
  window.__gs = [];
  window.__gs_id = "YOUR_WORKSPACE_ID";
  (function(){
    var d = document;
    var s = d.createElement("script");
    s.src = "YOUR_WIDGET_BASE_URL/loader.js";
    s.async = 1;
    d.getElementsByTagName("head")[0].appendChild(s);
  })();
</script>`;

  const handleCopy = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('widget.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('widget.embedCode')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('widget.installInstructions')}</p>
          <div className="relative">
            <pre className="bg-muted rounded-md p-4 text-sm overflow-x-auto font-mono">
              {embedCode}
            </pre>
            <Button
              size="sm"
              variant="outline"
              className="absolute top-2 end-2"
              onClick={handleCopy}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ms-1">{copied ? t('common.copied') : t('common.copy')}</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
