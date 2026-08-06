/**
 * WidgetLivePreview — pixel-faithful preview of the real chat widget.
 *
 * Instead of re-implementing the widget in React (which drifted from the real
 * thing), we render the *actual* widget markup inside an isolated iframe that
 * loads the production stylesheet at `/widget/runtime.css`. Every class name
 * below mirrors what `public/widget/runtime.js` emits at runtime, so what the
 * operator sees here is what the visitor gets on their site.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import type { SmartEvalResult } from '@/lib/widget/smartEngine';
import type { SmartRuleDraft } from '@/lib/widget/smartRules';

export type PreviewView = 'home' | 'chat' | 'prechat' | 'offline' | 'kb';

/** Lifecycle a smart action walks through inside the scenario studio. */
export type SmartPreviewPhase =
  | 'idle' | 'waiting' | 'matched' | 'surface_shown'
  | 'widget_opened' | 'cta_clicked' | 'dismissed' | 'suppressed';

/** Resolved, already-sanitized copy for the surface being simulated. */
export interface SmartPreviewContent {
  title?: string;
  body: string;
  ctaLabel?: string;
}

/**
 * Everything the smart iframe needs. The preview receives the *whole rule*
 * plus the scenario state — never a flattened surface — because the panel's
 * open/closed state, the active view and the surface placement are all
 * derived from the rule's presentation mode and the current phase.
 */
export interface SmartPreviewScenario {
  rule: SmartRuleDraft;
  content: SmartPreviewContent | null;
  verdict: SmartEvalResult;
  phase: SmartPreviewPhase;
  device: 'desktop' | 'mobile';
  locale: string;
  rtl: boolean;
  /** Localized "Automated message" label shown on chat-mode surfaces. */
  automationLabel: string;
}

/** Messages the studio pushes into, or receives from, the smart iframe. */
export type SmartPreviewMessage =
  | { source: 'gs-smart-preview'; type: 'smart-preview:set-phase'; phase: SmartPreviewPhase }
  | { source: 'gs-smart-preview'; type: 'smart-preview:trigger' }
  | { source: 'gs-smart-preview'; type: 'smart-preview:reset' }
  | { source: 'gs-smart-preview'; type: 'smart-preview:dismiss' }
  | { source: 'gs-smart-preview'; type: 'smart-preview:cta' }
  | { source: 'gs-smart-preview'; type: 'smart-preview:widget-opened' }
  | { source: 'gs-smart-preview'; type: 'smart-preview:widget-closed' };

type Dict = {
  online: string; offline: string; typing: string; input: string;
  name: string; email: string; phone: string; start: string;
  prechatTitle: string; prechatIntro: string; privacy: string;
  sample: string; visitorSample: string; chatTab: string; helpTab: string;
  kbSearch: string; kbArticles: string[]; poweredBy: string;
  welcomeFallback: string; brandFallback: string;
  homeTab: string; homeGreeting: string; homeWelcome: string;
  homeTeamOnline: string; homeTeamOffline: string;
  homeStartChat: string; homeLeaveMessage: string;
  homeReplyFast: string; homeReplySlow: string;
  homeHelpTitle: string; homeSeeAll: string;
  kbAllArticles: string; kbCategories: string; kbEmpty: string; kbBack: string;
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
    homeTab: 'Home', homeGreeting: 'Hello 👋', homeWelcome: 'Welcome! How can we help you today?',
    homeTeamOnline: 'Our team is online right now', homeTeamOffline: "We're offline at the moment",
    homeStartChat: 'Start a conversation', homeLeaveMessage: 'Leave a message',
    homeReplyFast: 'Typically replies in a few minutes',
    homeReplySlow: "We'll reply by email as soon as we're back",
    homeHelpTitle: 'Find an answer', homeSeeAll: 'See all',
    kbAllArticles: 'Popular articles', kbCategories: 'Browse by category',
    kbEmpty: 'No articles published yet — add some in the Knowledge Base.',
    kbBack: 'Back to articles',
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
    homeTab: 'خانه', homeGreeting: 'سلام 👋', homeWelcome: 'خوش آمدید! چطور می‌توانیم کمکتان کنیم؟',
    homeTeamOnline: 'تیم ما هم‌اکنون آنلاین است', homeTeamOffline: 'در حال حاضر آفلاین هستیم',
    homeStartChat: 'شروع گفتگو', homeLeaveMessage: 'پیغام بگذارید',
    homeReplyFast: 'معمولاً در چند دقیقه پاسخ می‌دهیم',
    homeReplySlow: 'به‌محض بازگشت، از طریق ایمیل پاسخ می‌دهیم',
    homeHelpTitle: 'پاسخ خود را پیدا کنید', homeSeeAll: 'مشاهده همه',
    kbAllArticles: 'مقالات پرکاربرد', kbCategories: 'دسته‌بندی‌ها',
    kbEmpty: 'هنوز مقاله‌ای منتشر نشده است — از بخش پایگاه دانش اضافه کنید.',
    kbBack: 'بازگشت به مقاله‌ها',
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
    homeTab: 'Ana sayfa', homeGreeting: 'Merhaba 👋', homeWelcome: 'Hoş geldiniz! Size nasıl yardımcı olabiliriz?',
    homeTeamOnline: 'Ekibimiz şu anda çevrimiçi', homeTeamOffline: 'Şu anda çevrimdışıyız',
    homeStartChat: 'Sohbeti başlat', homeLeaveMessage: 'Mesaj bırakın',
    homeReplyFast: 'Genellikle birkaç dakika içinde yanıtlıyoruz',
    homeReplySlow: 'Döner dönmez e-posta ile yanıtlayacağız',
    homeHelpTitle: 'Yanıtınızı bulun', homeSeeAll: 'Tümünü gör',
    kbAllArticles: 'Popüler makaleler', kbCategories: 'Kategoriye göre göz at',
    kbEmpty: 'Henüz yayınlanmış makale yok — Bilgi Bankası’ndan ekleyin.',
    kbBack: 'Makalelere dön',
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

function articleText(value: unknown): string {
  return String(value ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Mirrors server/routes/widget.ts: English seed values are treated as unset
// for non-English widgets so the localized default is shown instead.
const SEED_TEXTS: Record<'launcher' | 'welcome', string[]> = {
  launcher: ['chat with us', 'support', 'hello!'],
  welcome: ['hello! how can we help you?', 'how can we help you?'],
};

function localizedValue(
  value: unknown,
  kind: 'launcher' | 'welcome',
  locale: string,
): string {
  const lang = (locale || 'en').toLowerCase().split('-')[0];
  const raw = typeof value === 'string' ? value.trim() : '';
  if (lang === 'en') return raw;
  if (!raw || SEED_TEXTS[kind].includes(raw.toLowerCase())) return '';
  return raw;
}

export interface WidgetLivePreviewProps {
  settings: Record<string, any> | null | undefined;
  prechat?: WidgetPrechatSettings | null;
  brandName: string;
  view: PreviewView;
  /** Real published knowledge-base data so the preview matches the live widget. */
  kbArticles?: { title: string; excerpt?: string | null; content?: string | null }[];
  kbCategories?: { name: string; description?: string | null }[];
  /** Fired when the operator clicks a nav tab inside the preview. */
  onViewChange?: (view: PreviewView) => void;
  /** Operator profile picture shown next to chat bubbles (not the workspace logo). */
  operatorAvatar?: string | null;
  /** Operator display name — used for the initial fallback avatar. */
  operatorName?: string | null;
  /**
   * `generic` is the ordinary settings preview. `smart` turns the frame into a
   * scenario simulator: the panel's open state, the active view and the surface
   * placement are all derived from the rule + phase instead of the tab.
   */
  previewMode?: 'generic' | 'smart';
  /** Scenario driving the smart simulation (required when previewMode==='smart'). */
  smartScenario?: SmartPreviewScenario | null;
  /** Interaction feedback coming back out of the simulated widget. */
  onSmartEvent?: (type: 'dismiss' | 'cta' | 'widget-opened' | 'widget-closed') => void;
}

export function WidgetLivePreview({
  settings, prechat, brandName, view, kbArticles, kbCategories, onViewChange,
  operatorAvatar, operatorName, previewMode = 'generic', smartScenario, onSmartEvent,
}: WidgetLivePreviewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const isSmart = previewMode === 'smart' && !!smartScenario;
  const smartMode = smartScenario?.rule.presentation_config?.mode || 'launcher_nudge';
  const phase = smartScenario?.phase || 'idle';

  useEffect(() => {
    if (!onViewChange) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { source?: string; nav?: string } | null;
      if (!data || data.source !== 'gs-widget-preview' || !data.nav) return;
      onViewChange(data.nav === 'home' ? 'home' : data.nav === 'help' ? 'kb' : 'chat');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onViewChange]);

  // Smart interactions travel back from the sandboxed frame.
  useEffect(() => {
    if (!onSmartEvent) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { source?: string; type?: string } | null;
      if (!data || data.source !== 'gs-smart-preview' || !data.type) return;
      const kind = data.type.replace('smart-preview:', '');
      if (kind === 'dismiss' || kind === 'cta' || kind === 'widget-opened' || kind === 'widget-closed') {
        onSmartEvent(kind);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSmartEvent]);

  // Phase changes are pushed into the frame so the panel animates instead of
  // the whole document being re-created on every scenario tick.
  useEffect(() => {
    if (!isSmart) return;
    frameRef.current?.contentWindow?.postMessage(
      { source: 'gs-smart-preview', type: 'smart-preview:set-phase', phase },
      '*',
    );
  }, [isSmart, phase, smartMode]);

  const srcDoc = useMemo(() => {
    const s = settings || {};
    const locale: string = smartScenario?.locale || s.widget_language || s.locale || 'en';
    const d = DICTS[locale] || DICTS.en;
    const rtl = smartScenario ? smartScenario.rtl : locale === 'fa';
    const dir = rtl ? 'rtl' : 'ltr';

    const primary: string = s.primary_color || '#3B82F6';
    const secondary: string = s.secondary_color || s.primary_color || '#6366F1';
    const pos = s.position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    const title = (localizedValue(s.launcher_text, 'launcher', locale) || s.fab_label || brandName || d.brandFallback) as string;
    const welcome = (localizedValue(s.welcome_message, 'welcome', locale)
      || localizedValue(s.greeting_message, 'welcome', locale)
      || d.welcomeFallback) as string;
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
    const NAV_ICONS: Record<string, string> = {
      home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.8"/>',
      chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><line x1="12" y1="17.5" x2="12.01" y2="17.5"/>',
    };
    const smartDoc = previewMode === 'smart';
    const navDefs: { key: string; label: string }[] = [{ key: 'home', label: d.homeTab }, { key: 'chat', label: d.chatTab }];
    if (kbEnabled) navDefs.push({ key: 'help', label: d.helpTab });
    const activeNav = view === 'home' ? 'home' : view === 'kb' ? 'help' : 'chat';
    // The scenario studio is a simulation of one moment, not a browsable
    // widget — generic navigation would let the operator leave the scenario.
    const tabs = smartDoc ? '' : `<div class="tabs tabs-bottom">${navDefs
      .map(
        (n) => `<button type="button" data-preview-nav="${n.key}" class="tab${n.key === activeNav ? ' active' : ''}">
           <svg class="tab-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[n.key]}</svg>
           <span class="tab-label">${esc(n.label)}</span>
         </button>`,
      )
      .join('')}</div>`;

    // Header shows the uploaded workspace logo; falls back to nothing.
    const avatar = logo
      ? `<span class="header-op-avatar has-img"><img src="${esc(logo)}" alt="${esc(title)}" /></span>`
      : '';

    const header = `
      <div class="header${rtl ? ' header-rtl' : ''}" dir="${dir}">
        <button type="button" class="header-close" id="gs-close" aria-label="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="header-brand">
          ${avatar ? `<div class="header-op-stack">${avatar}</div>` : ''}
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
        <!--SMART_CHAT_SLOT-->
        <div class="msg-row operator">
          ${operatorAvatar
            ? `<span class="msg-avatar has-img"><img src="${esc(String(operatorAvatar))}" alt="${esc(operatorName || '')}" /></span>`
            : `<span class="msg-avatar">${esc(((operatorName || '').trim().charAt(0) || initial).toUpperCase())}</span>`}
          <div class="msg operator welcome-bubble">${esc(d.sample)}</div>
        </div>
        <div class="msg-row visitor">
          <div class="msg visitor" style="background:${esc(primary)}">${esc(d.visitorSample)}</div>
        </div>
      </div>`;

    // Real published knowledge-base content (falls back to sample titles only
    // when the workspace has nothing published yet).
    const realArticles = (kbArticles || []).filter(a => a && a.title);
    const realCategories = (kbCategories || []).filter(c => c && c.name);
    const hasRealKb = realArticles.length > 0 || realCategories.length > 0;
    const homeKbItems: { title: string; articleIndex?: number }[] = hasRealKb
      ? (realArticles.length
          ? realArticles.slice(0, 4).map((a, index) => ({ title: a.title, articleIndex: index }))
          : realCategories.slice(0, 4).map(c => ({ title: c.name })))
      : [];

    const articleTemplates = realArticles.map((a, index) => {
      const bodyText = articleText(a.content) || articleText(a.excerpt);
      return `<template id="preview-article-${index}">
        <div class="kb-root kb-article-view" dir="${dir}">
          <button type="button" class="kb-back" data-preview-kb-back>
            <span aria-hidden="true">${rtl ? '→' : '←'}</span>
            <span>${esc(d.kbBack)}</span>
          </button>
          <article>
            <h2 class="kb-article-h">${esc(a.title)}</h2>
            ${a.excerpt ? `<p class="kb-article-excerpt-full">${esc(a.excerpt)}</p>` : ''}
            <div class="kb-article-body">${esc(bodyText).replace(/\n/g, '<br>')}</div>
          </article>
        </div>
      </template>`;
    }).join('');

    const kbEmptyBlock = `
      <div class="kb-empty kb-empty-centered">
        <div class="kb-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </div>
        <p class="kb-empty-text">${esc(d.kbEmpty)}</p>
      </div>`;

    const kbBody = `
      <div class="kb-root" dir="${dir}">
        <div class="kb-search-wrap">
          <input class="kb-search" type="search" placeholder="${esc(d.kbSearch)}" />
        </div>
        ${!hasRealKb ? kbEmptyBlock : `
          ${realArticles.length ? `
            <div class="kb-section-h">${esc(d.kbAllArticles)}</div>
            <div class="kb-list">
              ${realArticles.map(a => `
                <button type="button" class="kb-article" data-preview-article="${realArticles.indexOf(a)}">
                  <div class="kb-article-title">${esc(a.title)}</div>
                  ${a.excerpt ? `<div class="kb-article-excerpt">${esc(a.excerpt)}</div>` : ''}
                </button>`).join('')}
            </div>` : ''}
          ${realCategories.length ? `
            <div class="kb-section-h">${esc(d.kbCategories)}</div>
            <div class="kb-list">
              ${realCategories.map(c => `
                <a class="kb-category">
                  <div class="kb-article-title">${esc(c.name)}</div>
                  ${c.description ? `<div class="kb-article-excerpt">${esc(c.description)}</div>` : ''}
                </a>`).join('')}
            </div>` : ''}
        `}
      </div>`;

    const offlineBody = `
      <div class="messages">
        <div class="msg-row system"><div class="msg-system-pill">${esc(offlineMsg)}</div></div>
      </div>` + prechatBody;

    // Operator avatars only — the workspace logo is not shown here.
    const homeAvatar = operatorAvatar
      ? `<span class="home-avatar has-img is-online"><img src="${esc(String(operatorAvatar))}" alt="${esc(operatorName || '')}" /></span>`
      : `<span class="home-avatar is-online"><span aria-hidden="true">${esc(operatorName ? operatorName.trim().charAt(0).toUpperCase() : initial)}</span></span>`;

    const homeBody = `
      <div class="home-root" dir="${dir}">
        <section class="home-hero">
          <div class="home-greeting">${esc(d.homeGreeting)}</div>
          <p class="home-welcome">${esc(welcome || d.homeWelcome)}</p>
        </section>
        <section class="home-card">
          <div class="home-card-top">
            <div class="home-avatars">${homeAvatar}</div>
            <div class="home-status is-online">
              <span class="home-status-dot"></span>
              <span>${esc(d.homeTeamOnline)}</span>
            </div>
          </div>
          <button type="button" class="home-cta" style="background:${esc(primary)}">
            <span class="home-cta-label">${esc(d.homeStartChat)}</span>
            <span class="home-cta-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          </button>
        </section>
        ${kbEnabled ? `<section class="home-section">
          <div class="home-section-head">
            <h4 class="home-section-title">${esc(d.homeHelpTitle)}</h4>
            <button type="button" class="home-section-link">${esc(d.homeSeeAll)}</button>
          </div>
          <div class="home-kb-list">
            ${(homeKbItems.length ? homeKbItems : []).map(a => `<button type="button" class="home-kb-item"${a.articleIndex !== undefined ? ` data-preview-article="${a.articleIndex}"` : ' data-preview-open-help'}>
              <span class="home-kb-title">${esc(a.title)}</span>
              <span class="home-kb-chevron" aria-hidden="true">${rtl ? '‹' : '›'}</span>
            </button>`).join('') || `<div class="kb-empty"><p class="kb-empty-text">${esc(d.kbEmpty)}</p></div>`}
          </div>
        </section>` : ''}
      </div>`;

    const body =
      view === 'home' ? homeBody :
      view === 'prechat' ? prechatBody :
      view === 'kb' ? kbBody :
      view === 'offline' ? offlineBody : chatBody;

    /* ── Smart Engagement surfaces (same markup as the runtime emits) ── */
    const scenarioContent = smartScenario?.content;
    const sp = smartScenario && scenarioContent && scenarioContent.body
      ? {
          mode: smartScenario.rule.presentation_config?.mode || 'launcher_nudge',
          title: scenarioContent.title,
          body: scenarioContent.body,
          ctaLabel: scenarioContent.ctaLabel,
          dismissible: smartScenario.rule.presentation_config?.dismissible !== false,
        }
      : null;
    const spTitle = sp?.title ? `<div class="smart-title">${esc(sp.title)}</div>` : '';
    const spCta = sp?.ctaLabel ? `<button type="button" class="smart-cta">${esc(sp.ctaLabel)}</button>` : '';
    const spDismiss = sp && sp.dismissible !== false
      ? '<button type="button" class="smart-dismiss" aria-label="dismiss">×</button>' : '';

    const smartNudge = sp && sp.mode === 'launcher_nudge'
      ? `<div class="smart-nudge ${pos}" style="bottom:${fabSize + 40}px">
           ${spDismiss}${spTitle}
           <div class="smart-body">${esc(sp.body)}</div>
           ${spCta}
         </div>`
      : '';

    const smartAnnounce = sp && sp.mode === 'announcement'
      ? `<div class="smart-announce">
           <span class="smart-body">${esc(sp.body)}</span>${spCta}${spDismiss}
         </div>`
      : '';

    const smartHomeCard = sp && sp.mode === 'home_card'
      ? `<div class="smart-home-card">
           ${spDismiss}${spTitle}
           <div class="smart-body">${esc(sp.body)}</div>
           ${spCta}
         </div>`
      : '';

    /* A smart chat message is automation, not a human operator: it never
       borrows an operator avatar or name — it is labelled as automated. */
    const smartChatMessage = sp && sp.mode === 'chat_message'
      ? `<div class="msg-row automation">
           <div class="msg automation">
             <span class="smart-automation-label">${esc(smartScenario?.automationLabel || '')}</span>
             ${esc(sp.body)}${sp.ctaLabel ? `<div class="smart-cta-wrap">${spCta}</div>` : ''}
           </div>
         </div>`
      : '';

    // Home card renders inside the home view; the chat message goes into the
    // message list via a dedicated slot. Everything else floats over the shell.
    const bodyWithSmart = (smartHomeCard && view === 'home'
      ? `${smartHomeCard}${body}`
      : body
    ).replace('<!--SMART_CHAT_SLOT-->', view === 'chat' ? smartChatMessage : '');

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
  body{background:#F1F5F9;overflow:hidden;font-family:'Vazirmatn',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .site{padding:22px;}
  .site .bar{height:12px;border-radius:6px;background:#E2E8F0;margin-bottom:10px;}
  .site .bar.w2{width:62%}.site .bar.w3{width:78%}.site .bar.w4{width:45%}
  .site .block{height:120px;border-radius:14px;background:#E2E8F0;margin:16px 0;}
  .site .cards{display:flex;gap:12px}.site .cards div{flex:1;height:64px;border-radius:12px;background:#E2E8F0}
  .shell{--gs-primary:${esc(primary)};--gs-secondary:${esc(secondary)};color:#1F2937;}
  /* Panel keeps production geometry (380px wide, anchored 92px above the
     launcher) — only the height clamp differs because the preview frame is
     smaller than a real browser viewport. */
  /* Override the runtime's <=480px full-screen rule: inside this small preview
     frame the panel must stay a floating card, otherwise it covers the FAB. */
   .panel{position:fixed!important;top:auto!important;width:min(380px, calc(100% - 28px))!important;
    max-width:calc(100% - 28px)!important;border-radius:20px!important;
     height:calc(100% - ${fabSize + 60}px)!important;}
  .panel[hidden]{display:none!important;}
  .launcher.is-hidden{opacity:0!important;visibility:hidden!important;pointer-events:none!important;}
  .fab-label.is-hidden{opacity:0!important;visibility:hidden!important;}
  .header-op-avatar.has-img img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;}
   .panel.bottom-right{bottom:${fabSize + 44}px!important;right:20px!important;left:auto!important;}
   .panel.bottom-left{bottom:${fabSize + 44}px!important;left:20px!important;right:auto!important;}
  /* Launcher styles copied 1:1 from loader.js SHELL_CSS. */
  .launcher{position:fixed;display:flex;align-items:center;justify-content:center;
    width:${fabSize}px;height:${fabSize}px;border-radius:${fabRadius};border:none;cursor:pointer;
    box-shadow:0 4px 20px -4px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.05);
    transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease,opacity .2s ease;
     background:${esc(primary)};color:${esc(fabIconColor)};z-index:5;}
  .launcher.bottom-right{bottom:24px;right:24px;}
  .launcher.bottom-left{bottom:24px;left:24px;}
  .launcher svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
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
  <div class="shell${s.fab_animation === true ? ' anim-on' : ''}">
    <div class="panel ${pos} visible${rtl ? ' panel-rtl' : ''}${s.fab_animation === true ? ' anim-on' : ''}" dir="${dir}">
      ${header}
      ${smartAnnounce}
      <div class="body">${bodyWithSmart}</div>
      ${composer}
      ${tabs}
      ${powered}
    </div>
    <button type="button" class="launcher ${pos}" id="gs-launcher" aria-label="chat">
      <svg class="chat-icon" viewBox="0 0 24 24">${fabIcon}</svg>
    </button>
    ${s.fab_label ? `<div class="fab-label">${esc(s.fab_label)}</div>` : ''}
    ${smartNudge}
    ${articleTemplates}
  </div>
<script>
  // Preview-only: let the operator open/close the widget exactly like a visitor.
  (function () {
    var panel = document.querySelector('.panel');
    var launcher = document.getElementById('gs-launcher');
    if (!panel || !launcher) return;
    var label = document.querySelector('.fab-label');
    function setOpen(open) {
      if (open) { panel.removeAttribute('hidden'); } else { panel.setAttribute('hidden', ''); }
      // Preview keeps the launcher visible even while the panel is open.
      launcher.classList.remove('is-hidden');
      if (label) label.classList.remove('is-hidden');
    }
    setOpen(true);
    launcher.addEventListener('click', function () { setOpen(panel.hasAttribute('hidden')); });
    var closeBtn = document.getElementById('gs-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
  })();

  // Preview-only: clicking a bottom nav tab tells the parent to switch views.
  (function () {
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-preview-nav]') : null;
      if (!el) return;
      e.preventDefault();
      parent.postMessage({ source: 'gs-widget-preview', nav: el.getAttribute('data-preview-nav') }, '*');
    });
  })();

  // Preview-only: open a real article and support returning to the list.
  (function () {
    var body = document.querySelector('.panel > .body');
    if (!body) return;
    var initialMarkup = body.innerHTML;
    document.addEventListener('click', function (e) {
      var target = e.target && e.target.closest ? e.target : null;
      if (!target) return;
      var article = target.closest('[data-preview-article]');
      if (article) {
        e.preventDefault();
        var template = document.getElementById('preview-article-' + article.getAttribute('data-preview-article'));
        if (template) {
          body.innerHTML = template.innerHTML;
          body.scrollTop = 0;
        }
        return;
      }
      if (target.closest('[data-preview-kb-back]')) {
        e.preventDefault();
        body.innerHTML = initialMarkup;
        body.scrollTop = 0;
        return;
      }
      if (target.closest('[data-preview-open-help]')) {
        e.preventDefault();
        parent.postMessage({ source: 'gs-widget-preview', nav: 'help' }, '*');
      }
    });
  })();
</script>
</body>
</html>`;
  }, [settings, prechat, brandName, view, kbArticles, kbCategories, operatorAvatar, operatorName, smartPreview]);

  return (
    <div className="h-full w-full overflow-hidden rounded-xl border border-border bg-muted/20">
      <iframe
        title="widget-preview"
        srcDoc={srcDoc}
        className="h-full w-full border-0"
        sandbox="allow-scripts"
      />
    </div>
  );
}
