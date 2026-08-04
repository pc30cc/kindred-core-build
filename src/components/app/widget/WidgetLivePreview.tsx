/**
 * WidgetLivePreview — full-size, live preview of the chat widget.
 *
 * Renders a realistic mock website with the widget panel opened, driven by the
 * *draft* widget settings so every textual/visual edit is reflected instantly
 * (before the debounced save reaches the server).
 *
 * The preview text uses the WIDGET locale (not the panel locale), because that
 * is what visitors will actually see.
 */
import { useMemo } from 'react';
import { MessageSquare, HelpCircle, Send, Paperclip, X, ChevronDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';

export type PreviewView = 'chat' | 'prechat' | 'offline' | 'kb';

type Dict = {
  online: string; offline: string; typing: string; input: string;
  send: string; name: string; email: string; phone: string;
  required: string; start: string; prechatIntro: string;
  sample: string; visitorSample: string; kbTitle: string; kbSearch: string;
  kbArticles: string[]; poweredBy: string; welcomeFallback: string; brandFallback: string;
};

const DICTS: Record<string, Dict> = {
  en: {
    online: 'We are online', offline: 'We are offline', typing: 'is typing…',
    input: 'Write a message…', send: 'Send', name: 'Your name', email: 'Email', phone: 'Phone',
    required: 'required', start: 'Start chat', prechatIntro: 'Tell us how to reach you',
    sample: 'Hi! How can we help you today?', visitorSample: 'Hi, I have a question about pricing.',
    kbTitle: 'Help center', kbSearch: 'Search articles…',
    kbArticles: ['Getting started', 'Billing & plans', 'Troubleshooting'],
    poweredBy: 'Powered by', welcomeFallback: 'How can we help?', brandFallback: 'Support',
  },
  fa: {
    online: 'ما آنلاین هستیم', offline: 'در حال حاضر آفلاین هستیم', typing: 'در حال نوشتن…',
    input: 'پیام خود را بنویسید…', send: 'ارسال', name: 'نام شما', email: 'ایمیل', phone: 'شماره تماس',
    required: 'الزامی', start: 'شروع گفتگو', prechatIntro: 'راه ارتباطی خود را وارد کنید',
    sample: 'سلام! چطور می‌توانیم کمکتان کنیم؟', visitorSample: 'سلام، دربارهٔ تعرفه‌ها سؤال داشتم.',
    kbTitle: 'مرکز راهنما', kbSearch: 'جستجوی مقاله‌ها…',
    kbArticles: ['شروع به کار', 'صورتحساب و پلن‌ها', 'رفع اشکال'],
    poweredBy: 'قدرت‌گرفته از', welcomeFallback: 'چطور می‌توانیم کمک کنیم؟', brandFallback: 'پشتیبانی',
  },
  tr: {
    online: 'Çevrimiçiyiz', offline: 'Şu anda çevrimdışıyız', typing: 'yazıyor…',
    input: 'Bir mesaj yazın…', send: 'Gönder', name: 'Adınız', email: 'E-posta', phone: 'Telefon',
    required: 'zorunlu', start: 'Sohbeti başlat', prechatIntro: 'Size nasıl ulaşalım?',
    sample: 'Merhaba! Size nasıl yardımcı olabiliriz?', visitorSample: 'Merhaba, fiyatlandırma hakkında bir sorum var.',
    kbTitle: 'Yardım merkezi', kbSearch: 'Makalelerde ara…',
    kbArticles: ['Başlarken', 'Faturalama ve planlar', 'Sorun giderme'],
    poweredBy: 'Destekleyen', welcomeFallback: 'Nasıl yardımcı olabiliriz?', brandFallback: 'Destek',
  },
};

function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#111827' : '#ffffff';
}

export interface WidgetLivePreviewProps {
  settings: Record<string, any> | null | undefined;
  prechat?: WidgetPrechatSettings | null;
  brandName: string;
  view: PreviewView;
}

export function WidgetLivePreview({ settings, prechat, brandName, view }: WidgetLivePreviewProps) {
  const s = settings || {};
  const locale: string = s.widget_language || s.locale || 'en';
  const d = DICTS[locale] || DICTS.en;
  const rtl = locale === 'fa';

  const primary: string = s.primary_color || '#3B82F6';
  const secondary: string = s.secondary_color || primary;
  const onPrimary = readableOn(primary);
  const left = s.position === 'bottom-left';

  const title = (s.launcher_text || s.fab_label || brandName || d.brandFallback) as string;
  const welcome = (s.welcome_message || s.greeting_message || d.welcomeFallback) as string;
  const placeholder = (s.placeholder_text || d.input) as string;
  const offlineMsg =
    (s.offline_message_localized && s.offline_message_localized[locale]) || s.offline_message || d.offline;

  const fields = useMemo(
    () =>
      [
        prechat?.ask_name && { label: d.name, req: prechat?.require_name },
        prechat?.ask_email && { label: d.email, req: prechat?.require_email },
        prechat?.ask_phone && { label: d.phone, req: prechat?.require_phone },
      ].filter(Boolean) as { label: string; req?: boolean }[],
    [prechat, d],
  );

  const radius = s.fab_shape === 'square' ? 14 : 9999;

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-border bg-gradient-to-b from-muted/40 to-muted/10">
      {/* Mock browser chrome */}
      <div className="flex items-center gap-2 border-b border-border/70 bg-background/80 px-3 py-2 backdrop-blur">
        <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
        <div className="mx-auto h-5 w-1/2 rounded-full bg-muted" />
      </div>

      {/* Mock page content */}
      <div className="space-y-3 p-5" aria-hidden>
        <div className="h-5 w-2/3 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted/60" />
        <div className="h-3 w-5/6 rounded bg-muted/60" />
        <div className="mt-4 h-32 w-full rounded-lg bg-muted/40" />
        <div className="grid grid-cols-3 gap-3">
          <div className="h-16 rounded-lg bg-muted/40" />
          <div className="h-16 rounded-lg bg-muted/40" />
          <div className="h-16 rounded-lg bg-muted/40" />
        </div>
        <div className="h-3 w-3/4 rounded bg-muted/60" />
        <div className="h-3 w-2/3 rounded bg-muted/60" />
      </div>

      {/* Launcher */}
      <div
        className={cn('absolute bottom-5 flex items-center gap-2', left ? 'start-5 flex-row' : 'end-5 flex-row-reverse')}
        style={{ [left ? 'left' : 'right']: 20 } as any}
      >
        <div
          className="flex items-center justify-center shadow-lg"
          style={{
            width: 56, height: 56, borderRadius: radius, background: primary, color: onPrimary,
          }}
        >
          {view === 'kb' ? <HelpCircle className="h-6 w-6" /> : <MessageSquare className="h-6 w-6" />}
        </div>
        {s.fab_label && (
          <span
            className="rounded-full px-3 py-1.5 text-xs font-medium shadow"
            style={{ background: primary, color: onPrimary }}
          >
            {s.fab_label}
          </span>
        )}
      </div>

      {/* Widget panel */}
      <div
        dir={rtl ? 'rtl' : 'ltr'}
        className="absolute flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        style={{
          width: 340,
          bottom: 92,
          top: 64,
          [left ? 'left' : 'right']: 20,
        } as any}
      >
        {/* Header */}
        <div className="px-4 py-3.5" style={{ background: `linear-gradient(135deg, ${primary}, ${secondary})`, color: onPrimary }}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {s.show_logo !== false && s.logo_url ? (
                  <img src={s.logo_url} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : null}
                <p className="truncate text-sm font-semibold">{title}</p>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] opacity-90">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: view === 'offline' ? '#9ca3af' : '#22c55e' }}
                />
                {view === 'offline' ? d.offline : d.online}
              </p>
            </div>
            <div className="flex items-center gap-1 opacity-80">
              <Minus className="h-3.5 w-3.5" />
              <X className="h-3.5 w-3.5" />
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed opacity-90">{welcome}</p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden bg-background/60 p-3">
          {view === 'prechat' && (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">{d.prechatIntro}</p>
              {(fields.length ? fields : [{ label: d.name }, { label: d.email }]).map((f) => (
                <div key={f.label} className="space-y-1">
                  <p className="text-[11px] font-medium text-foreground">
                    {f.label}
                    {f.req ? <span className="ms-1 text-destructive">*</span> : null}
                  </p>
                  <div className="h-8 rounded-lg border border-border bg-card" />
                </div>
              ))}
              <div
                className="mt-2 flex h-9 items-center justify-center rounded-lg text-xs font-semibold"
                style={{ background: primary, color: onPrimary }}
              >
                {d.start}
              </div>
            </div>
          )}

          {view === 'kb' && (
            <div className="space-y-2">
              <div className="flex h-8 items-center rounded-lg border border-border bg-card px-3 text-[11px] text-muted-foreground">
                {d.kbSearch}
              </div>
              <p className="pt-1 text-[11px] font-semibold text-foreground">{d.kbTitle}</p>
              {d.kbArticles.map((a) => (
                <div key={a} className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-[11px]">
                  <span className="text-foreground">{a}</span>
                  <ChevronDown className="h-3 w-3 -rotate-90 text-muted-foreground rtl:rotate-90" />
                </div>
              ))}
            </div>
          )}

          {view === 'offline' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                {offlineMsg}
              </div>
              {[d.name, d.email].map((f) => (
                <div key={f} className="space-y-1">
                  <p className="text-[11px] font-medium text-foreground">{f}</p>
                  <div className="h-8 rounded-lg border border-border bg-card" />
                </div>
              ))}
            </div>
          )}

          {view === 'chat' && (
            <div className="space-y-2.5">
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl rounded-es-md bg-muted px-3 py-2 text-[11px] text-foreground">
                  {d.sample}
                </div>
              </div>
              <div className="flex justify-end">
                <div
                  className="max-w-[80%] rounded-2xl rounded-ee-md px-3 py-2 text-[11px]"
                  style={{ background: primary, color: onPrimary }}
                >
                  {d.visitorSample}
                </div>
              </div>
              <div className="flex justify-start">
                <div className="rounded-2xl bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                  {title} {d.typing}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5">
            {s.attachments_enabled !== false && <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="flex-1 truncate text-[11px] text-muted-foreground">{placeholder}</span>
            <Send className="h-3.5 w-3.5 rtl:-scale-x-100" style={{ color: primary }} />
          </div>
          <p className="mt-1.5 text-center text-[9px] text-muted-foreground">
            {d.poweredBy} {brandName}
          </p>
        </div>
      </div>
    </div>
  );
}
