import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWidgetSettings, useUpdateWidgetSettings } from '@/hooks/useWidgetSettings';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Globe, Info, Save, Loader2 } from 'lucide-react';
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

export default function WidgetGeneralTab() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: widget, isLoading } = useWidgetSettings(workspace?.id);
  const { platformName } = useBrandingContext();
  const updateWidget = useUpdateWidgetSettings(workspace?.id);

  const [localSettings, setLocalSettings] = useState({
    enabled: false,
    position: 'bottom-right',
    launcher_text: '',
    welcome_message: '',
    greeting_message: '',
    placeholder_text: '',
    offline_message: '',
    auto_open_delay: 0,
    chat_enabled: true,
    kb_enabled: true,
    visitor_tracking_enabled: true,
    default_mode: 'chat',
    support_mode: 'human_first',
    mobile_behavior: 'bottom_sheet',
  });
  const [dirty, setDirty] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [domainError, setDomainError] = useState('');

  useEffect(() => {
    if (widget) {
      setLocalSettings({
        enabled: widget.enabled ?? false,
        position: widget.position || 'bottom-right',
        launcher_text: widget.launcher_text || '',
        welcome_message: widget.welcome_message || '',
        greeting_message: (widget as any).greeting_message || '',
        placeholder_text: (widget as any).placeholder_text || '',
        offline_message: (widget as any).offline_message || '',
        auto_open_delay: (widget as any).auto_open_delay ?? 0,
        chat_enabled: widget.chat_enabled ?? true,
        kb_enabled: widget.kb_enabled ?? true,
        visitor_tracking_enabled: widget.visitor_tracking_enabled ?? true,
        default_mode: (widget as any).default_mode || 'chat',
        support_mode: (widget as any).support_mode || 'human_first',
        mobile_behavior: (widget as any).mobile_behavior || 'bottom_sheet',
      });
      setDirty(false);
    }
  }, [widget]);

  const update = (partial: Partial<typeof localSettings>) => {
    setLocalSettings(s => ({ ...s, ...partial }));
    setDirty(true);
  };

  const handleSave = () => {
    updateWidget.mutate(localSettings as any, {
      onSuccess: () => { toast({ title: 'ذخیره شد' }); setDirty(false); },
    });
  };

  const handleAddDomain = () => {
    const normalized = normalizeDomainInput(newDomain);
    if (!normalized) return;
    if (!isValidDomain(normalized)) { setDomainError('لطفاً دامنه معتبر وارد کنید'); return; }
    const current = widget?.allowed_domains || [];
    if (current.includes(normalized)) { setDomainError('این دامنه قبلاً اضافه شده'); return; }
    setDomainError('');
    updateWidget.mutate({ allowed_domains: [...current, normalized] } as any);
    setNewDomain('');
  };

  const handleRemoveDomain = (domain: string) => {
    const current = widget?.allowed_domains || [];
    updateWidget.mutate({ allowed_domains: current.filter(d => d !== domain) } as any);
  };

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;

  return (
    <div className="space-y-6">
      {/* Enable/Disable */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">وضعیت ویجت</CardTitle>
              <CardDescription>فعال یا غیرفعال کردن ویجت روی سایت</CardDescription>
            </div>
            <Switch checked={localSettings.enabled} onCheckedChange={v => update({ enabled: v })} />
          </div>
        </CardHeader>
      </Card>

      {/* Position & Auto-open */}
      <Card>
        <CardHeader><CardTitle className="text-base">نمایش</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('widget.position')}</Label>
              <Select value={localSettings.position} onValueChange={v => update({ position: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bottom-right">Bottom Right</SelectItem>
                  <SelectItem value="bottom-left">Bottom Left</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>تاخیر باز شدن خودکار (ثانیه)</Label>
              <Input type="number" min={0} value={localSettings.auto_open_delay} onChange={e => update({ auto_open_delay: parseInt(e.target.value) || 0 })} dir="ltr" />
              <p className="text-[10px] text-muted-foreground">0 = غیرفعال</p>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('widget.launcherText')}</Label>
            <Input value={localSettings.launcher_text} onChange={e => update({ launcher_text: e.target.value })} placeholder={platformName} />
          </div>
        </CardContent>
      </Card>

      {/* Messages */}
      <Card>
        <CardHeader><CardTitle className="text-base">پیام‌ها</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>پیام خوش‌آمدگویی</Label>
            <Textarea value={localSettings.welcome_message} onChange={e => update({ welcome_message: e.target.value })} rows={2} />
          </div>
          <div className="space-y-2">
            <Label>پیام تبریک</Label>
            <Textarea value={localSettings.greeting_message} onChange={e => update({ greeting_message: e.target.value })} rows={2} />
          </div>
          <div className="space-y-2">
            <Label>متن placeholder</Label>
            <Input value={localSettings.placeholder_text} onChange={e => update({ placeholder_text: e.target.value })} placeholder="پیام خود را بنویسید..." />
          </div>
          <div className="space-y-2">
            <Label>پیام آفلاین</Label>
            <Textarea value={localSettings.offline_message} onChange={e => update({ offline_message: e.target.value })} rows={2} placeholder="در حال حاضر آفلاین هستیم..." />
          </div>
        </CardContent>
      </Card>

      {/* Behavior */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('widget.behavior')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>چت زنده</Label>
            <Switch checked={localSettings.chat_enabled} onCheckedChange={v => update({ chat_enabled: v })} />
          </div>
          <div className="flex items-center justify-between">
            <Label>پایگاه دانش</Label>
            <Switch checked={localSettings.kb_enabled} onCheckedChange={v => update({ kb_enabled: v })} />
          </div>
          <div className="flex items-center justify-between">
            <Label>ردیابی بازدیدکنندگان</Label>
            <Switch checked={localSettings.visitor_tracking_enabled} onCheckedChange={v => update({ visitor_tracking_enabled: v })} />
          </div>
          <div className="space-y-2">
            <Label>تب پیش‌فرض</Label>
            <div className="flex gap-2">
              {[{ value: 'chat', label: 'چت' }, { value: 'help', label: 'راهنما' }, { value: 'ai', label: 'AI' }].map(m => (
                <button key={m.value} onClick={() => update({ default_mode: m.value })}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs transition-colors ${
                    localSettings.default_mode === m.value ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:border-foreground/30'
                  }`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>حالت پشتیبانی</Label>
            <div className="flex gap-2">
              {[{ value: 'human_first', label: 'انسان اول' }, { value: 'helpdesk_first', label: 'راهنمای اول' }, { value: 'ai_first', label: 'AI اول' }].map(m => (
                <button key={m.value} onClick={() => update({ support_mode: m.value })}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs transition-colors ${
                    localSettings.support_mode === m.value ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:border-foreground/30'
                  }`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>رفتار موبایل</Label>
            <div className="flex gap-2">
              {[{ value: 'bottom_sheet', label: 'Bottom Sheet' }, { value: 'fullscreen', label: 'Fullscreen' }].map(b => (
                <button key={b.value} onClick={() => update({ mobile_behavior: b.value })}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs transition-colors ${
                    localSettings.mobile_behavior === b.value ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:border-foreground/30'
                  }`}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Allowed Domains */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" /> {t('widget.allowedDomains')}
          </CardTitle>
          <CardDescription>محدود کردن بارگذاری ویجت به دامنه‌های خاص. خالی بگذارید تا همه مجاز باشند.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 bg-muted/50 rounded-md p-3 text-xs text-muted-foreground">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <p>دامنه را مانند <strong>example.com</strong> وارد کنید. پروتکل و www خودکار پشتیبانی می‌شود.</p>
          </div>
          <div className="space-y-1">
            <div className="flex gap-2">
              <Input placeholder="example.com" value={newDomain} onChange={e => { setNewDomain(e.target.value); setDomainError(''); }} onKeyDown={e => e.key === 'Enter' && handleAddDomain()} />
              <Button onClick={handleAddDomain} variant="outline">افزودن</Button>
            </div>
            {domainError && <p className="text-xs text-destructive">{domainError}</p>}
          </div>
          {widget?.allowed_domains?.map(domain => (
            <div key={domain} className="flex items-center justify-between bg-muted rounded px-3 py-2">
              <div>
                <span className="text-sm font-mono">{domain}</span>
                <span className="text-xs text-muted-foreground ms-2">(+ www.{domain})</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleRemoveDomain(domain)}>حذف</Button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="space-y-0.5">
              <Label className="text-sm">اجازه زیردامنه‌ها</Label>
              <p className="text-xs text-muted-foreground">وقتی فعال باشد، زیردامنه‌هایی مثل app.example.com هم مجاز هستند.</p>
            </div>
            <Switch
              checked={widget?.allow_subdomains ?? false}
              onCheckedChange={v => updateWidget.mutate({ allow_subdomains: v } as any)}
            />
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
