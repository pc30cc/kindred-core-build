import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings, useUpdateWidgetSettings } from '@/hooks/useWidgetSettings';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Save, Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

export default function WidgetLanguageTab() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  const updateWidget = useUpdateWidgetSettings(workspace?.id);

  const [widgetLanguage, setWidgetLanguage] = useState('auto');
  const [locale, setLocale] = useState('en');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (widget) {
      setWidgetLanguage((widget as any).widget_language || 'auto');
      setLocale(widget.locale || 'en');
      setDirty(false);
    }
  }, [widget]);

  const handleSave = () => {
    updateWidget.mutate({ widget_language: widgetLanguage, locale } as any, {
      onSuccess: () => { toast({ title: 'ذخیره شد' }); setDirty(false); },
    });
  };

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;

  const languages = [
    { value: 'auto', label: 'خودکار (Auto)', desc: 'زبان بر اساس مرورگر بازدیدکننده تشخیص داده می‌شود' },
    { value: 'fa', label: 'فارسی', desc: 'ویجت همیشه به فارسی نمایش داده می‌شود' },
    { value: 'en', label: 'English', desc: 'Widget always displayed in English' },
    { value: 'tr', label: 'Türkçe', desc: 'Widget her zaman Türkçe gösterilir' },
  ];

  return (
    <div className="space-y-6">
      {/* Widget Language */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">زبان ویجت</CardTitle>
          <CardDescription>زبانی که ویجت چت به بازدیدکنندگان نمایش داده می‌شود را انتخاب کنید.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {languages.map(lang => (
              <button
                key={lang.value}
                onClick={() => { setWidgetLanguage(lang.value); setDirty(true); }}
                className={`w-full text-start p-4 rounded-xl border-2 transition-all ${
                  widgetLanguage === lang.value
                    ? 'border-primary ring-2 ring-primary/20 bg-primary/5'
                    : 'border-border hover:border-foreground/30'
                }`}
              >
                <div className="font-medium text-sm text-foreground">{lang.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{lang.desc}</div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Default Locale */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">زبان پیش‌فرض محتوا</CardTitle>
          <CardDescription>زبان پیش‌فرض برای مقالات پایگاه دانش و محتوای ویجت.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            {[
              { value: 'en', label: 'English' },
              { value: 'fa', label: 'فارسی' },
              { value: 'tr', label: 'Türkçe' },
            ].map(l => (
              <button
                key={l.value}
                onClick={() => { setLocale(l.value); setDirty(true); }}
                className={`flex-1 min-w-[80px] px-4 py-3 rounded-lg border text-sm transition-colors ${
                  locale === l.value ? 'bg-primary/10 border-primary text-primary font-medium' : 'border-border text-muted-foreground hover:border-foreground/30'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      {dirty && (
        <Button onClick={handleSave} disabled={updateWidget.isPending} className="w-full">
          {updateWidget.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span className="ms-2">ذخیره تغییرات</span>
        </Button>
      )}
    </div>
  );
}
