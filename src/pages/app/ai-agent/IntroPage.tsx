import { useEffect, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Loader2, MessageCircle, Languages, Tags, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';

const FALLBACK_INTRO_TEMPLATES: Record<string, (name: string) => string> = {
  en: (name) =>
    `Hi! I'm ${name}, an AI assistant. I can answer questions from our help center. If I'm not sure about something, I'll connect you with a human agent.`,
  fa: (name) =>
    `سلام! من ${name} هستم، یک دستیار هوشمند. می‌توانم به سوالات شما با کمک پایگاه دانش پاسخ بدهم. اگر مطمئن نباشم، شما را به یک کارشناس انسانی وصل می‌کنم.`,
  tr: (name) =>
    `Merhaba! Ben ${name}, bir yapay zeka asistanıyım. Yardım merkezimizden sorularınızı yanıtlayabilirim. Emin olmadığım konularda sizi bir temsilciye bağlarım.`,
};

const LOCALE_LABELS: Record<string, string> = { fa: 'فارسی', en: 'English', tr: 'Türkçe' };
const LOCALE_DIR: Record<string, 'rtl' | 'ltr'> = { fa: 'rtl', en: 'ltr', tr: 'ltr' };

export default function IntroPage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useAiAgentSettings(workspace?.id);
  const update = useUpdateAiAgentSettings(workspace?.id);
  const { dir } = useTranslation();
  const settings = data?.settings;
  // The platform's active region/language mode decides which languages show
  // here — a single-language platform (e.g. Persian-only) must not show a
  // language picker or fields for languages it never speaks.
  const { allowedLocales } = usePlatformRegion();
  const activeLocales: string[] = allowedLocales.length ? allowedLocales : ['fa', 'en', 'tr'];
  const isMultilingual = activeLocales.length > 1;

  const [drafts, setDrafts] = useState<Record<string, string>>({ fa: '', en: '', tr: '' });
  const [newKeyword, setNewKeyword] = useState('');
  const [keywordError, setKeywordError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    const localized = (settings.intro_message_localized || {}) as Record<string, string>;
    setDrafts({ fa: localized.fa || '', en: localized.en || '', tr: localized.tr || '' });
  }, [settings?.intro_message_localized]);

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center py-20" dir={dir}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const agentName = settings.agent_name || 'AI Assistant';

  const saveLocalizedMessage = async (code: string, value: string) => {
    const current = (settings.intro_message_localized || {}) as Record<string, string>;
    if ((current[code] || '') === value) return;
    try {
      await update.mutateAsync({
        intro_message_localized: { ...current, [code]: value },
      });
      toast.success('پیام معرفی ذخیره شد');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const toggleIntro = async (v: boolean) => {
    try {
      await update.mutateAsync({ ai_intro_enabled: v });
      toast.success(v ? 'ارسال پیام معرفی فعال شد' : 'ارسال پیام معرفی غیرفعال شد');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const keywords = settings.handoff_keywords || [];

  const handleAddKeyword = async () => {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    if (keywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      setKeywordError('این کلمه قبلاً اضافه شده است.');
      return;
    }
    setKeywordError(null);
    try {
      await update.mutateAsync({ handoff_keywords: [...keywords, trimmed] });
      setNewKeyword('');
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  const handleRemoveKeyword = async (word: string) => {
    try {
      await update.mutateAsync({ handoff_keywords: keywords.filter((k) => k !== word) });
    } catch (e: any) {
      toast.error(e?.message || 'ذخیره‌سازی ناموفق بود');
    }
  };

  return (
    <div className="space-y-8" dir={dir}>
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
            <MessageCircle className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">معرفی و ارجاع به اپراتور</h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">
              پیام خوش‌آمدگویی هوش مصنوعی و کلمات کلیدی که ویزیتور را به یک کارشناس انسانی وصل می‌کنند را کنترل کنید.
            </p>
          </div>
        </div>
      </div>

      <Card className="border-border/60">
        <CardContent className="p-6 flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium">ارسال پیام معرفی بعد از پیش‌گفتگو</Label>
            <p className="text-xs text-muted-foreground mt-1">
              وقتی ویزیتور پیش‌گفتگو را کامل کرد، هوش مصنوعی یک پیام خوش‌آمدگویی می‌فرستد. فقط در حالت‌های پاسخ خودکار فعال است.
            </p>
          </div>
          <Switch checked={settings.ai_intro_enabled !== false} onCheckedChange={toggleIntro} disabled={update.isPending} />
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-sky-500/10 text-sky-600 ring-sky-500/20">
              <Languages className="h-4 w-4" />
            </span>
            {isMultilingual ? 'متن پیام معرفی به تفکیک زبان' : 'متن پیام معرفی'}
          </CardTitle>
          <CardDescription className="mt-1">
            {isMultilingual
              ? 'برای هر زبان می‌توانید متن دلخواه بنویسید. اگر خالی بگذارید، متن پیش‌فرض همان زبان به‌طور خودکار استفاده می‌شود.'
              : 'اگر خالی بگذارید، متن پیش‌فرض به‌طور خودکار استفاده می‌شود.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {activeLocales.map((code) => (
            <div key={code}>
              {isMultilingual && <Label htmlFor={`intro-${code}`}>{LOCALE_LABELS[code] || code}</Label>}
              <Textarea
                id={`intro-${code}`}
                className={isMultilingual ? 'mt-1.5' : ''}
                rows={3}
                dir={LOCALE_DIR[code] || 'ltr'}
                placeholder={(FALLBACK_INTRO_TEMPLATES[code] || FALLBACK_INTRO_TEMPLATES.en)(agentName)}
                value={drafts[code] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [code]: e.target.value }))}
                onBlur={(e) => saveLocalizedMessage(code, e.target.value)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-lg flex items-center justify-center ring-1 bg-amber-500/10 text-amber-600 ring-amber-500/20">
              <Tags className="h-4 w-4" />
            </span>
            کلمات کلیدی ارجاع به انسان
          </CardTitle>
          <CardDescription className="mt-1">
            وقتی ویزیتور یکی از این کلمات را در پیام خود بنویسد (مثلاً «اپراتور» یا «انسان»)، گفتگو به یک کارشناس واقعی ارجاع داده می‌شود.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="مثلاً: پشتیبان"
              value={newKeyword}
              onChange={(e) => { setNewKeyword(e.target.value); setKeywordError(null); }}
              onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword()}
            />
            <Button onClick={handleAddKeyword} variant="outline" size="sm" className="shrink-0" disabled={update.isPending}>
              افزودن
            </Button>
          </div>
          {keywordError && <p className="text-xs text-destructive">{keywordError}</p>}
          <div className="flex flex-wrap gap-2">
            {keywords.map((word) => (
              <div key={word} className="flex items-center gap-1.5 bg-muted/50 rounded-full ps-3 pe-1.5 py-1 border border-border text-sm">
                <span>{word}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveKeyword(word)}
                  className="h-5 w-5 rounded-full flex items-center justify-center hover:bg-destructive/15 hover:text-destructive transition-colors"
                  aria-label="حذف"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {keywords.length === 0 && (
              <p className="text-xs text-muted-foreground">هنوز کلمه‌ای اضافه نشده است.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
