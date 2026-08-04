/**
 * WidgetLivePreview — pixel-faithful preview of the real chat widget.
 *
 * Instead of re-implementing the widget in React (which drifted from the real
 * thing), we render the *actual* widget markup inside an isolated iframe that
 * loads the production stylesheet at `/widget/runtime.css`. Every class name
 * below mirrors what `public/widget/runtime.js` emits at runtime, so what the
 * operator sees here is what the visitor gets on their site.
 */
import { useMemo } from 'react';
import type { WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';

export type PreviewView = 'chat' | 'prechat' | 'offline' | 'kb';

type Dict = {
  online: string; offline: string; typing: string; input: string;
  name: string; email: string; phone: string; start: string;
  prechatTitle: string; prechatIntro: string; privacy: string;
  sample: string; visitorSample: string; chatTab: string; helpTab: string;
  kbSearch: string; kbArticles: string[]; poweredBy: string;
  welcomeFallback: string; brandFallback: string;
};

const DICTS: Record<string, Dict> = {
  en: {
    online: 'We are online', offline: 'We are offline', typing: 'is typing…',
    input: 'Write a message…', name: 'Your name', email: 'Email', phone: 'Phone',
    start: 'Continue', prechatTitle: 'Before we start', prechatIntro: 'Tell us how to reach you',
    privacy: 'Your details stay private and are only used to reply to you.',
    sample: 'Hi! How can we help you today?', visitorSample: 'Hi, I have a question about pricing.',
    chatTab: 'Chat', helpTab: 'Help', kbSearch: 'Search articles…',
    kbArticles: ['Getting started', 'Billing & plans', 'Troubleshooting'],
    poweredBy: 'Powered by', welcomeFallback: 'How can we help?', brandFallback: 'Support',
  },
  fa: {
    online: 'ما آنلاین هستیم', offline: 'در حال حاضر آفلاین هستیم', typing: 'در حال نوشتن…',
    input: 'پیام خود را بنویسید…', name: 'نام شما', email: 'ایمیل', phone: 'شماره تماس',
    start: 'ادامه', prechatTitle: 'پیش از شروع', prechatIntro: 'راه ارتباطی خود را وارد کنید',
    privacy: 'اطلاعات شما محرمانه است و فقط برای پاسخ‌گویی استفاده می‌شود.',
    sample: 'سلام! چطور می‌توانیم کمکتان کنیم؟', visitorSample: 'سلام، دربارهٔ تعرفه‌ها سؤال داشتم.',
    chatTab: 'گفتگو', helpTab: 'راهنما', kbSearch: 'جستجوی مقاله‌ها…',
    kbArticles: ['شروع به کار', 'صورتحساب و پلن‌ها', 'رفع اشکال'],
    poweredBy: 'قدرت‌گرفته از', welcomeFallback: 'چطور می‌توانیم کمک کنیم؟', brandFallback: 'پشتیبانی',
  },
  tr: {
    online: 'Çevrimiçiyiz', offline: 'Şu anda çevrimdışıyız', typing: 'yazıyor…',
    input: 'Bir mesaj yazın…', name: 'Adınız', email: 'E-posta', phone: 'Telefon',
    start: 'Devam', prechatTitle: 'Başlamadan önce', prechatIntro: 'Size nasıl ulaşalım?',
    privacy: 'Bilgileriniz gizli kalır ve yalnızca yanıt vermek için kullanılır.',
    sample: 'Merhaba! Size nasıl yardımcı olabiliriz?', visitorSample: 'Merhaba, fiyatlandırma hakkında bir sorum var.',
    chatTab: 'Sohbet', helpTab: 'Yardım', kbSearch: 'Makalelerde ara…',
    kbArticles: ['Başlarken', 'Faturalama ve planlar', 'Sorun giderme'],
    poweredBy: 'Destekleyen', welcomeFallback: 'Nasıl yardımcı olabiliriz?', brandFallback: 'Destek',
  },
};

const FAB_ICONS: Record<string, string> = {
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
};

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export interface WidgetLivePreviewProps {
  settings: Record<string, any> | null | undefined;
  prechat?: WidgetPrechatSettings | null;
  brandName: string;
  view: PreviewView;
}

export function WidgetLivePreview({ settings, prechat, brandName, view }: WidgetLivePreviewProps) {
  const srcDoc = useMemo(() => {
    const s = settings || {};
    const locale: string = s.widget_language || s.locale || 'en';
    const d = DICTS[locale] || DICTS.en;
    const rtl = locale === 'fa';
    const dir = rtl ? 'rtl' : 'ltr';

    const primary: string = s.primary_color || '#3B82F6';
    const pos = s.position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    const title = (s.launcher_text || s.fab_label || brandName || d.brandFallback) as string;
    const welcome = (s.welcome_message || s.greeting_message || d.welcomeFallback) as string;
    const placeholder = (s.placeholder_text || d.input) as string;
    const offlineMsg =
      (s.offline_message_localized && s.offline_message_localized[locale]) || s.offline_message || d.offline;

    // Scale is stored as percent (80–140) or multiplier (0.8–1.4) — normalize
    // exactly like public/widget/loader.js does.
    const rawScale = Number(s.fab_scale);
    const fabScale = Math.min(
      1.4,
      Math.max(0.8, !isFinite(rawScale) || rawScale <= 0 ? 1 : rawScale > 3 ? rawScale / 100 : rawScale),
    );
    const fabSize = Math.round(56 * fabScale);
    const fabRadius = s.fab_shape === 'square' ? '16px' : '50%';
    const fabIconColor = s.fab_icon_color || '#fff';
    const fabIcon = FAB_ICONS[(s.fab_icon as string) || 'chat'] || FAB_ICONS.chat;
    const logo = s.show_logo !== false && s.logo_url ? String(s.logo_url) : '';
    const initial = (title.trim().charAt(0) || 'S').toUpperCase();

    const kbEnabled = s.kb_enabled !== false || s.knowledge_base_enabled !== false;
    const tabs = kbEnabled
      ? `<div class="tabs">
           <button type="button" class="tab${view === 'kb' ? '' : ' active'}">${esc(d.chatTab)}</button>
           <button type="button" class="tab${view === 'kb' ? ' active' : ''}">${esc(d.helpTab)}</button>
         </div>`
      : '';

    // Production renders the operator team stack here (runtime.js) — never the
    // workspace logo. Mirror that: a single online operator avatar.
    const avatar = `<span class="header-op-avatar is-online"><span aria-hidden="true">${esc(initial)}</span><span class="header-op-dot"></span></span>`;

    const header = `
      <div class="header${rtl ? ' header-rtl' : ''}" dir="${dir}">
        <div class="header-brand">
          <div class="header-op-stack">${avatar}</div>
          <div class="header-brand-text">
            <div class="header-title">${esc(title)}</div>
            <div class="header-subtitle">${esc(view === 'offline' ? offlineMsg : welcome)}</div>
          </div>
        </div>
      </div>`;

    const fields = [
      prechat?.ask_name !== false && { key: 'name', label: d.name, req: prechat?.require_name },
      prechat?.ask_email !== false && { key: 'email', label: d.email, req: prechat?.require_email },
      prechat?.ask_phone && { key: 'phone', label: d.phone, req: prechat?.require_phone },
    ].filter(Boolean) as { key: string; label: string; req?: boolean }[];

    const prechatBody = `
      <div class="prechat prechat-pro" dir="${dir}">
        <div class="prechat-hero">
          <h3 class="prechat-title">${esc(d.prechatTitle)}</h3>
          <p class="prechat-subtitle">${esc(d.prechatIntro)}</p>
        </div>
        <div class="prechat-fields">
          ${fields.map(f => `
            <div class="prechat-field">
              <div class="prechat-row">
                <label class="prechat-label">${esc(f.label)}${f.req ? '<span class="prechat-req-mark">*</span>' : ''}</label>
              </div>
              <div class="prechat-control">
                <input class="prechat-input" placeholder="${esc(f.label)}" />
              </div>
            </div>`).join('')}
        </div>
        <button type="button" class="prechat-submit" style="background:${esc(primary)}">
          <span class="prechat-submit-label">${esc(d.start)}</span>
        </button>
        <p class="prechat-privacy">${esc(d.privacy)}</p>
      </div>`;

    const chatBody = `
      <div class="messages">
        <div class="msg-row operator">
          ${logo ? `<span class="msg-avatar has-img"><img src="${esc(logo)}" alt="" /></span>`
                 : `<span class="msg-avatar">${esc(initial)}</span>`}
          <div class="msg operator welcome-bubble">${esc(d.sample)}</div>
        </div>
        <div class="msg-row visitor">
          <div class="msg visitor" style="background:${esc(primary)}">${esc(d.visitorSample)}</div>
        </div>
      </div>`;

    const kbBody = `
      <div class="kb-root" dir="${dir}">
        <div class="kb-search-wrap">
          <input class="kb-search" type="search" placeholder="${esc(d.kbSearch)}" />
        </div>
        <div class="kb-list">
          ${d.kbArticles.map(a => `
            <button type="button" class="kb-article">
              <div class="kb-article-title">${esc(a)}</div>
            </button>`).join('')}
        </div>
      </div>`;

    const offlineBody = `
      <div class="messages">
        <div class="msg-row system"><div class="msg-system-pill">${esc(offlineMsg)}</div></div>
      </div>` + prechatBody;

    const body =
      view === 'prechat' ? prechatBody :
      view === 'kb' ? kbBody :
      view === 'offline' ? offlineBody : chatBody;

    const composer = view === 'chat' ? `
      <div class="typing-row" aria-live="polite">
        <span class="typing-dots"><span></span><span></span><span></span></span>
        <span class="typing-label">${esc(title)} ${esc(d.typing)}</span>
      </div>
      <div class="input-bar">
        <button type="button" class="send-btn" style="background:${esc(primary)}">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
        ${s.attachments_enabled !== false ? `<button type="button" class="attach-btn">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>` : ''}
        <input class="input" placeholder="${esc(placeholder)}" />
      </div>` : '';

    const powered = `<div class="powered">${esc(d.poweredBy)} <a href="#">${esc(brandName || title)}</a></div>`;

    return `<!doctype html>
<html dir="${dir}" lang="${esc(locale)}">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="/widget/runtime.css" />
<style>
  html,body{margin:0;height:100%;}
  body{background:#F1F5F9;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .site{padding:22px;}
  .site .bar{height:12px;border-radius:6px;background:#E2E8F0;margin-bottom:10px;}
  .site .bar.w2{width:62%}.site .bar.w3{width:78%}.site .bar.w4{width:45%}
  .site .block{height:120px;border-radius:14px;background:#E2E8F0;margin:16px 0;}
  .site .cards{display:flex;gap:12px}.site .cards div{flex:1;height:64px;border-radius:12px;background:#E2E8F0}
  .shell{--gs-primary:${esc(primary)};color:#1F2937;}
  .panel{width:min(380px, calc(100% - 32px));height:calc(100% - 116px);}
  .launcher{position:fixed;display:flex;align-items:center;justify-content:center;
    width:${fabSize}px;height:${fabSize}px;border-radius:${fabRadius};border:none;
    box-shadow:0 4px 20px -4px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.05);
    background:${esc(primary)};color:${esc(fabIconColor)};z-index:5;}
  .launcher.bottom-right{bottom:24px;right:24px;}
  .launcher.bottom-left{bottom:24px;left:24px;}
  .launcher svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
  .launcher img{width:60%;height:60%;border-radius:50%;object-fit:cover;}
  ${s.fab_animation === true ? '.launcher{animation:gsp 2s ease-in-out infinite}@keyframes gsp{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}' : ''}
  .fab-label{position:fixed;bottom:${Math.round(24 + fabSize / 2 - 15)}px;${pos === 'bottom-left' ? `left:${fabSize + 36}px` : `right:${fabSize + 36}px`};
    background:${esc(primary)};color:${esc(s.fab_text_color || '#fff')};padding:7px 12px;border-radius:999px;font-size:12px;font-weight:600;
    box-shadow:0 4px 14px -4px rgba(0,0,0,.25);z-index:5;}
</style>
</head>
<body>
  <div class="site" aria-hidden="true">
    <div class="bar w3"></div><div class="bar w2"></div><div class="bar w4"></div>
    <div class="block"></div>
    <div class="cards"><div></div><div></div><div></div></div>
  </div>
  <div class="shell" data-template="default">
    <div class="panel ${pos} visible" dir="${dir}">
      ${header}
      ${tabs}
      <div class="body">${body}</div>
      ${composer}
      ${powered}
    </div>
    <button type="button" class="launcher ${pos}" aria-label="chat">
      ${logo ? `<img src="${esc(logo)}" alt="" />` : `<svg viewBox="0 0 24 24">${fabIcon}</svg>`}
    </button>
    ${s.fab_label ? `<div class="fab-label">${esc(s.fab_label)}</div>` : ''}
  </div>
</body>
</html>`;
  }, [settings, prechat, brandName, view]);

  return (
    <div className="h-full w-full overflow-hidden rounded-xl border border-border bg-muted/20">
      <iframe
        title="widget-preview"
        srcDoc={srcDoc}
        className="h-full w-full border-0"
        sandbox="allow-same-origin"
      />
    </div>
  );
}
