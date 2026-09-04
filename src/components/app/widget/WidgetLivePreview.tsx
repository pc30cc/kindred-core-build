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
  attachTitle: string; micTitle: string; emojiTitle: string; talkToHuman: string;
  msgSeen: string;
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
    attachTitle: 'Attach file', micTitle: 'Record voice message', emojiTitle: 'Emoji',
    talkToHuman: 'Talk to a human', msgSeen: 'Seen',
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
    attachTitle: 'پیوست فایل', micTitle: 'ضبط پیام صوتی', emojiTitle: 'شکلک',
    talkToHuman: 'صحبت با اپراتور', msgSeen: 'دیده شد',
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
    attachTitle: 'Dosya ekle', micTitle: 'Sesli mesaj kaydet', emojiTitle: 'Emoji',
    talkToHuman: 'Bir temsilciyle konuşun', msgSeen: 'Görüldü',
  },
};

/** Launcher shadow derived from the brand colour — mirrors loader.js exactly. */
export function shadowFromPrimary(hex: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 'rgba(0,0,0,.22)';
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.34)`;
}

export const FAB_ICONS: Record<string, string> = {
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
  /** Workspace identity shown in every widget header. */
  workspaceName?: string;
  /** Platform identity used only by the powered-by footer. */
  platformName?: string;
  /**
   * Platform-owned powered-by footer payload, exactly as the widget bootstrap
   * emits it. `null` => the footer must not render (platform switch off or the
   * plan hides it), matching production.
   */
  poweredBy?: { text: string; brand: string; url: string | null } | null;
  /** @deprecated Compatibility alias; prefer workspaceName. */
  brandName?: string;
  teamMembers?: { name: string; avatar?: string | null; online: boolean }[];
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
  settings, prechat, workspaceName, platformName, poweredBy, brandName, teamMembers, view, kbArticles, kbCategories, onViewChange,
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
    /* Launcher shadow is derived from the brand colour (same rule as loader.js). */
    const shadowColor: string = shadowFromPrimary(primary);
    const pos = s.position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    /* Header titles use workspace identity only — launcher_text is a launcher
       concern and is not consumed by the Web Yar presentation. */
    // An explicit empty brand_name means "cleared" — show no name at all.
    const title = (typeof s.brand_name === 'string'
      ? s.brand_name.trim()
      : (workspaceName || brandName || d.brandFallback)) as string;

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
    const rawFabImage = typeof s.fab_image_url === 'string' ? s.fab_image_url.trim() : '';
    const fabImage = /^https?:\/\//i.test(rawFabImage) ? rawFabImage : '';
    const logo = s.show_logo !== false && s.logo_url ? String(s.logo_url) : '';
    const initial = (title.trim().charAt(0) || 'S').toUpperCase();

    // Strict AND: either column being explicitly false hides the KB surface,
    // exactly like the production bootstrap (`features.knowledgeBase`).
    const kbEnabled = s.kb_enabled !== false && s.knowledge_base_enabled !== false;
    const chatEnabled = s.chat_enabled !== false && s.live_chat_enabled !== false;
    const smartDoc = previewMode === 'smart';

    /* ── Real published knowledge-base content. The preview builds only the
       KB *view-model*; every byte of KB markup comes from the active
       template renderer (kbHtml / kbArticleHtml), exactly like production. ── */
    const realArticles = (kbArticles || []).filter(a => a && a.title);
    const realCategories = (kbCategories || []).filter(c => c && c.name);

    const kbVm = {
      rtl,
      state: 'list',
      query: '',
      article: null,
      results: [],
      articles: realArticles.map((a, i) => ({
        slug: String(i), title: a.title, excerpt: a.excerpt || '',
      })),
      categories: realCategories.map(c => ({
        name: c.name, description: c.description || '', url: '',
      })),
      emptyText: d.kbEmpty,
      hideChatCta: true,
    };

    /** One article view-model per published article, opened on click. */
    const kbArticleVms = realArticles.map(a => ({
      rtl,
      state: 'article',
      hideSearch: true,
      article: {
        title: a.title,
        excerpt: a.excerpt || '',
        // Preview content is plain text — escaped here because the renderer
        // takes `contentHtml` already sanitized (Core does that in production).
        contentHtml: esc(articleText(a.content) || articleText(a.excerpt)).replace(/\n/g, '<br>'),
        publicUrl: '',
      },
      feedback: { enabled: true, rating: null },
    }));


    /* ── Smart Engagement surface (rendered by the real renderer inside the
       frame — the preview only decides placement, exactly like Core does). ── */
    const scenarioContent = smartScenario?.content;
    const smartSurface = smartScenario && scenarioContent && scenarioContent.body
      ? {
          mode: smartScenario.rule.presentation_config?.mode || 'launcher_nudge',
          title: scenarioContent.title,
          body: scenarioContent.body,
          ctaLabel: scenarioContent.ctaLabel,
          dismissible: smartScenario.rule.presentation_config?.dismissible !== false,
        }
      : null;

    /* ── View-models handed to the production renderer. Nothing below builds
       widget markup: the active template is the single source of it. ── */

    const previewConfig = {
      brandName: brandName || title,
      workspaceName: title,
      platformName: poweredBy?.brand || platformName || brandName || d.brandFallback,
      // Platform-owned footer payload — mirrors the production bootstrap so the
      // preview reflects super-admin wording/link and plan visibility exactly.
      ...(poweredBy !== undefined
        ? { poweredBy, showPoweredBy: poweredBy !== null }
        : {}),
      replyTimeText: typeof s.reply_time_text === 'string' ? s.reply_time_text.trim() : null,
      welcomeMessage: welcome,
      logoUrl: logo || null,
      showLogo: s.show_logo !== false,
      showTeamAvatars: s.show_team_avatars !== false,
      attachments: {
        enabled: s.attachments_enabled === true,
        voiceNotesEnabled: s.voice_notes_enabled === true,
        allowedMimes: [],
      },
      composer: { emojiEnabled: s.emoji_enabled !== false },
      readReceipts: { enabled: true },
    };

    const nowIso = new Date().toISOString();
    const earlierIso = new Date(Date.now() - 90 * 1000).toISOString();

    const payload = {
      locale,
      rtl,
      primary,
      view,
      /** Template id — resolved through the registry inside the frame. */
      templateId: (s.widget_template_id as string | undefined) || null,
      smart: { enabled: smartDoc, mode: smartSurface?.mode || smartScenario?.rule.presentation_config?.mode || 'launcher_nudge' },
      smartSurface,
      config: previewConfig,
      /** Dictionary keys are the renderer's i18n contract, filled from DICTS. */
      dict: {
        home: d.homeTab, chat: d.chatTab, help: d.helpTab,
        closeWidget: 'Close', openFile: 'Open', closePreview: 'Close',
        talkToHuman: d.talkToHuman, typeMsg: placeholder,
        attachFile: d.attachTitle, recordVoice: d.micTitle, emojiPicker: d.emojiTitle,
        poweredBy: d.poweredBy, operator: operatorName || title,
        intro: welcome || d.welcomeFallback,
        homeGreeting: d.homeGreeting, homeWelcome: d.homeWelcome,
        homeTeamOnline: d.homeTeamOnline, homeTeamOffline: d.homeTeamOffline,
        homeReplyFast: d.homeReplyFast, homeReplySlow: d.homeReplySlow, homeStartChat: d.homeStartChat,
        homeLeaveMessage: d.homeLeaveMessage, homeHelpTitle: d.homeHelpTitle,
        homeSeeAll: d.homeSeeAll,
        msgSeen: d.msgSeen, msgSent: d.msgSeen, msgSending: d.msgSeen, msgFailed: d.msgSeen,
        name: d.name, email: d.email, phone: d.phone,
        prechatNamePh: d.name, prechatEmailPh: d.email, prechatPhonePh: d.phone,
        required: '*', prechatTitle: d.prechatTitle, prechatSubtitle: d.prechatIntro,
        continue: d.start, prechatPrivacy: d.privacy,
        // Knowledge Base strings — the KB surfaces are part of the contract.
        searchKb: d.kbSearch, kbAllArticles: d.kbAllArticles, kbCategories: d.kbCategories,
        noArticles: d.kbEmpty, kbZeroResults: d.kbEmpty, kbBack: d.kbBack,
        kbSearching: d.kbSearch, kbSwitchToChat: d.chatTab, kbOpenInBrowser: d.homeSeeAll,
      },

      shellVm: {
        config: previewConfig,
        brandName: title,
        workspaceName: title,
        headerTitle: title,
        chatEnabled,
        kbEnabled,
        locale,
        activeTab: view === 'home' ? 'home' : view === 'kb' ? 'help' : 'chat',
        primaryColor: primary,
      },
      homeVm: {
        rtl,
        isOnline: view !== 'offline',
        chatEnabled,
        kbEnabled,
        welcomeMessage: welcome,
        primaryColor: primary,
        showTeamAvatars: s.show_team_avatars !== false,
        teamMembers: (teamMembers && teamMembers.length)
          ? teamMembers
          : [{ name: operatorName || title, avatar: operatorAvatar || '', online: true }],
        articles: realArticles.map((a, i) => ({ title: a.title, slug: String(i) })),
        categories: [],
      },
      messages: view === 'offline'
        ? [{ sender: 'operator', senderType: 'system', body: offlineMsg, time: nowIso }]
        : [
            {
              sender: 'operator', senderType: 'operator', body: d.sample, time: earlierIso,
              senderName: operatorName || title, senderAvatar: operatorAvatar || '',
            },
            { sender: 'visitor', senderType: 'visitor', body: d.visitorSample, time: nowIso, status: 'seen' },
          ],
      prechat: {
        asked: {
          name: prechat?.ask_name !== false,
          email: prechat?.ask_email !== false,
          phone: !!prechat?.ask_phone,
        },
        required: {
          name: !!prechat?.require_name,
          email: !!prechat?.require_email,
          phone: !!prechat?.require_phone,
        },
      },
      kbVm,
      kbArticleVms,

      typingLabel: `${title} ${d.typing}`,
      phase,
    };

    return `<!doctype html>
<html dir="${dir}" lang="${esc(locale)}">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="/widget/runtime.css" />
<!-- The active template's stylesheet is injected at runtime from the
     registry descriptor — the preview never names a template asset. -->

<style>
  html,body{margin:0;height:100%;}
  body{background:#F1F5F9;overflow:hidden;font-family:'IRANSans','InterWY',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .site{padding:22px;}
  .site .bar{height:12px;border-radius:6px;background:#E2E8F0;margin-bottom:10px;}
  .site .bar.w2{width:62%}.site .bar.w3{width:78%}.site .bar.w4{width:45%}
  .site .block{height:120px;border-radius:14px;background:#E2E8F0;margin:16px 0;}
  .site .cards{display:flex;gap:12px}.site .cards div{flex:1;height:64px;border-radius:12px;background:#E2E8F0}
  .shell{--gs-primary:${esc(primary)};--gs-secondary:${esc(secondary)};--gs-fab-size:${fabSize}px;${shadowColor ? `--gs-shadow:${esc(shadowColor)};` : ''}color:#1F2937;}
  /* PARITY RULE: the preview provides ONLY the fake page + viewport. It must
     NOT redefine panel geometry or lifecycle — the panel is positioned and
     toggled by the production presentation stylesheet, exactly like a real
     visitor's browser, so layout regressions surface here too. */
  .header-op-avatar.has-img img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;}
  /* Launcher styles copied 1:1 from loader.js SHELL_CSS. */
  .shell .launcher{position:fixed;display:flex;align-items:center;justify-content:center;
    width:var(--gs-fab-size,56px);height:var(--gs-fab-size,56px);border-radius:${fabRadius};border:none;cursor:pointer;
    box-shadow:0 3px 12px -4px var(--gs-shadow,rgba(0,0,0,.16)),0 0 0 1px rgba(0,0,0,.03);
    transition:transform .34s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,opacity .24s ease;
     background:${esc(primary)};color:${esc(fabIconColor)};z-index:2147483646;}
  .launcher.bottom-right{bottom:24px;right:24px;}
  .launcher.bottom-left{bottom:24px;left:24px;}
  .shell .launcher svg{width:calc(var(--gs-fab-size,56px) * .46);height:calc(var(--gs-fab-size,56px) * .46);fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
  .launcher.open svg.chat-icon{display:none;}
  .launcher:not(.open) svg.close-icon{display:none;}
  .launcher .fab-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;
    pointer-events:none;clip-path:circle(75% at 50% 50%);transition:clip-path .42s cubic-bezier(.22,1,.36,1);}
  .launcher.has-image:hover .fab-img{clip-path:circle(0% at 50% 50%);}
  .launcher.open,.launcher.open:hover{transform:translateY(calc(100% + 24px)) scale(.5);opacity:0;pointer-events:none;animation:none;}
  ${s.fab_animation === true ? '.launcher{animation:gsp 2s ease-in-out infinite}@keyframes gsp{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}' : ''}
  .fab-label{position:fixed;bottom:${Math.round(24 + fabSize / 2 - 15)}px;${pos === 'bottom-left' ? `left:${fabSize + 36}px` : `right:${fabSize + 36}px`};
    background:${esc(primary)};color:${esc(s.fab_text_color || '#fff')};padding:7px 12px;border-radius:999px;font-size:12px;font-weight:600;
     box-shadow:0 4px 14px -4px rgba(0,0,0,.25);z-index:2147483646;}

  /* Smart simulation: surfaces fade in/out with the real transition timing. */
  [data-smart-surface]{transition:opacity .22s ease, transform .22s ease;}
  [data-smart-surface][hidden]{display:none!important;}
  [data-smart-surface].smart-enter{opacity:0;transform:translateY(6px);}
</style>
</head>
<body>
  <div class="site" aria-hidden="true">
    <div class="bar w3"></div><div class="bar w2"></div><div class="bar w4"></div>
    <div class="block"></div>
    <div class="cards"><div></div><div></div><div></div></div>
  </div>
  <div class="shell${s.fab_animation === true ? ' anim-on' : ''}">
    <div class="panel ${pos} visible${rtl ? ' panel-rtl' : ''}${s.fab_animation === true ? ' anim-on' : ''}" dir="${dir}"></div>
    <button type="button" class="launcher ${pos}${fabImage ? ' has-image' : ''}" id="gs-launcher" aria-label="chat">
      <svg class="chat-icon" viewBox="0 0 24 24">${fabIcon}</svg>
      <svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"></path></svg>
      ${fabImage ? `<img class="fab-img" alt="" src="${esc(fabImage)}">` : ''}
    </button>
    ${s.fab_label ? `<div class="fab-label">${esc(s.fab_label)}</div>` : ''}
  </div>
<!-- The preview loads the SAME presentation assets the visitor widget loads,
     resolved through the registry (no template name is hard-coded here). -->
<script src="/widget/presentation-registry.js"></script>
<script>
  var GS_PREVIEW = ${JSON.stringify(payload)};
  var GS_SMART = GS_PREVIEW.smart;

  (function () {
    var reg = window.__gs_presentation_registry;
    if (!reg || typeof reg.resolve !== 'function') return;
    var desc = reg.resolve(GS_PREVIEW.templateId);
    if (!desc) return;

    // ASSET PARITY: visitors get manifest-hashed files. Resolve through the
    // SAME manifest here so a stale/mismatched build cannot hide behind the
    // unhashed dev sources. Falls back to the plain names in dev, where
    // dist/widget/widget-manifest.json does not exist yet.
    function boot(manifest) {
      var styleFile = (manifest && manifest[desc.style]) || desc.style;
      var scriptFile = (manifest && manifest[desc.script]) || desc.script;
      // Optional template-owned font asset — the SAME hashed stylesheet the
      // visitor loader injects, so preview and live share one cache entry.
      if (desc.fonts && !document.getElementById('gs-presentation-fonts')) {
        var fontsFile = (manifest && manifest[desc.fonts]) || desc.fonts;
        var fl = document.createElement('link');
        fl.id = 'gs-presentation-fonts';
        fl.rel = 'stylesheet';
        fl.href = '/widget/' + fontsFile;
        document.head.appendChild(fl);
      }
      var styleReady = false;
      var scriptReady = false;
      var mod = null;
      function prepareAndRender() {
        if (!styleReady || !scriptReady || !mod || !mod.create) return;
        var preparation = typeof mod.prepare === 'function' ? mod.prepare() : null;
        Promise.resolve(preparation).catch(function () {}).then(function () { gsRenderPreview(mod); });
      }
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/widget/' + styleFile;
      link.onload = function () { styleReady = true; prepareAndRender(); };
      link.onerror = function () { styleReady = true; prepareAndRender(); };
      document.head.appendChild(link);

      var scr = document.createElement('script');
      scr.src = '/widget/' + scriptFile;
      scr.onload = function () {
        mod = window[desc.globalKey];
        scriptReady = true;
        prepareAndRender();
      };
      document.body.appendChild(scr);
    }

    fetch('/widget/widget-manifest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(boot);
  })();


  /* Render the panel with the production renderer — the preview never builds
     widget markup itself. */
  function gsRenderPreview(mod) {


    function escapeHtml(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function t(key) {
      var v = GS_PREVIEW.dict[key];
      return v == null ? key : v;
    }

    var R = mod.create({
      t: t,
      escapeHtml: escapeHtml,
      config: GS_PREVIEW.config,
      locale: GS_PREVIEW.locale,
      primaryColor: GS_PREVIEW.primary,
    });

    var panel = document.querySelector('.panel');
    panel.innerHTML = R.shellHtml(GS_PREVIEW.shellVm);

    var body = panel.querySelector('[data-body]');
    var view = GS_PREVIEW.view;
    if (view === 'home') {
      body.innerHTML = R.homeHtml(GS_PREVIEW.homeVm);
    } else if (view === 'prechat') {
      var pc = GS_PREVIEW.prechat;
      var identity = {
        isAsked: function (k) { return !!pc.asked[k]; },
        isRequired: function (k) { return !!pc.required[k]; },
      };
      body.innerHTML = R.prechatFormHtml(identity, {}, GS_PREVIEW.locale);
    } else if (view === 'kb') {
      body.innerHTML = R.kbHtml(GS_PREVIEW.kbVm);
    } else {
      /* Single-view architecture: chat is a full view (header + messages +
         composer + footer) exactly like production mounts it. */
      body.innerHTML = R.chatFrameHtml(GS_PREVIEW.shellVm);
      var msgHost = body.querySelector('[data-chat-messages]');
      if (msgHost) msgHost.innerHTML = R.messagesHtml({ messages: GS_PREVIEW.messages }, '', {});
      /* Typing state is sr-only in the design — no visible typing row. */
    }


    /* The scenario studio simulates one moment — browsing away from it via
       the tabs would leave the scenario. */
    if (GS_SMART.enabled) {
      var tabsEl = panel.querySelector('.tabs');
      if (tabsEl) tabsEl.remove();
    }

    /* Smart surfaces: inner markup from the renderer, placement from Core. */
    var surface = GS_PREVIEW.smartSurface;
    if (surface) {
      var inner = R.smartSurfaceHtml(surface);
      var shell = document.querySelector('.shell');
      if (surface.mode === 'launcher_nudge') {
        var nudge = document.createElement('div');
        nudge.className = 'smart-nudge ' + ${JSON.stringify(pos)};
        nudge.setAttribute('data-smart-surface', '');
        nudge.style.bottom = ${JSON.stringify(String(fabSize + 40) + 'px')};
        nudge.innerHTML = inner;
        shell.appendChild(nudge);
      } else if (surface.mode === 'announcement') {
        var ann = document.createElement('div');
        ann.className = 'smart-announce';
        ann.setAttribute('data-smart-surface', '');
        ann.innerHTML = inner;
        panel.insertBefore(ann, body);
      } else if (surface.mode === 'home_card' && view === 'home') {
        var card = document.createElement('div');
        card.className = 'smart-home-card';
        card.setAttribute('data-smart-surface', '');
        card.innerHTML = inner;
        body.insertBefore(card, body.firstChild);
      } else if (surface.mode === 'chat_message') {
        var dock = document.createElement('div');
        dock.className = 'smart-chat-dock';
        dock.setAttribute('data-smart-surface', '');
        dock.innerHTML = inner;
        var bar = panel.querySelector('[data-input-bar]');
        panel.insertBefore(dock, bar || null);
      }
    }

    gsBindLauncher();
    gsBindSmart();
    gsBindTabs();
    gsBindArticles(R);
  }

  // Preview-only: let the operator open/close the widget exactly like a visitor.
  function gsBindLauncher() {

    var panel = document.querySelector('.panel');
    var launcher = document.getElementById('gs-launcher');
    if (!panel || !launcher) return;
    var label = document.querySelector('.fab-label');
    // LIFECYCLE PARITY: the preview uses the PRODUCTION contract —
    // panel.visible + launcher.open — never a preview-only
    // hidden attribute. Anything else masks real regressions.
    function isOpen() { return panel.classList.contains('visible'); }
    function setOpen(open) {
      panel.classList.toggle('visible', !!open);
      launcher.classList.toggle('open', !!open);
    }
    window.__gsSetOpen = setOpen;
    // In the scenario studio the panel state belongs to the simulation, so it
    // starts closed and only opens when the rule says a visitor would see it.
    setOpen(!GS_SMART.enabled);
    launcher.addEventListener('click', function () {
      var willOpen = !isOpen();
      setOpen(willOpen);

      if (GS_SMART.enabled) {
        parent.postMessage({
          source: 'gs-smart-preview',
          type: willOpen ? 'smart-preview:widget-opened' : 'smart-preview:widget-closed',
        }, '*');
      }
    });
    document.addEventListener('click', function (e) {
      var closeEl = e.target && e.target.closest ? e.target.closest('[data-panel-close]') : null;
      if (!closeEl) return;
      setOpen(false);
      if (GS_SMART.enabled) parent.postMessage({ source: 'gs-smart-preview', type: 'smart-preview:widget-closed' }, '*');
    });
  }

  // Preview-only: drive the smart surface lifecycle from the parent studio.
  function gsBindSmart() {

    if (!GS_SMART.enabled) return;
    var surfaces = [].slice.call(document.querySelectorAll('[data-smart-surface]'));
    surfaces.forEach(function (el) { el.setAttribute('hidden', ''); el.classList.add('smart-enter'); });

    function showSurface(show) {
      surfaces.forEach(function (el) {
        if (show) {
          el.removeAttribute('hidden');
          requestAnimationFrame(function () { el.classList.remove('smart-enter'); });
        } else {
          el.classList.add('smart-enter');
          el.setAttribute('hidden', '');
        }
      });
    }

    function applyPhase(phase) {
      var visible = phase === 'surface_shown' || phase === 'cta_clicked'
        || (phase === 'widget_opened' && GS_SMART.mode !== 'open_widget');
      var open = GS_SMART.mode === 'launcher_nudge'
        ? false
        : GS_SMART.mode === 'open_widget'
          ? phase === 'widget_opened' || phase === 'cta_clicked'
          : visible;
      if (window.__gsSetOpen) window.__gsSetOpen(open);
      showSurface(visible);
    }

    window.addEventListener('message', function (e) {
      var data = e.data;
      if (!data || data.source !== 'gs-smart-preview') return;
      if (data.type === 'smart-preview:set-phase') applyPhase(data.phase);
    });

    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      if (t.closest('[data-smart-dismiss]')) {
        e.preventDefault();
        parent.postMessage({ source: 'gs-smart-preview', type: 'smart-preview:dismiss' }, '*');
        return;
      }
      if (t.closest('[data-smart-cta]')) {
        e.preventDefault();
        parent.postMessage({ source: 'gs-smart-preview', type: 'smart-preview:cta' }, '*');
      }
    });

    applyPhase(GS_PREVIEW.phase);
  }

  // Preview-only: the renderer's real tab hooks drive the parent's view state.
  function gsBindTabs() {
    if (GS_SMART.enabled) return;
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
      if (!el) return;
      e.preventDefault();
      parent.postMessage({ source: 'gs-widget-preview', nav: el.getAttribute('data-tab') }, '*');
    });
  }

  // Preview-only: open a real article and support returning to the list.
  // The markup always comes from the renderer's KB surfaces.
  function gsBindArticles(R) {
    var body = document.querySelector('.panel [data-body]');
    if (!body) return;
    var initialMarkup = body.innerHTML;
    function openArticle(index) {
      var vm = (GS_PREVIEW.kbArticleVms || [])[Number(index)];
      if (!vm) return;
      body.innerHTML = R.kbHtml(vm);
      body.scrollTop = 0;
    }
    document.addEventListener('click', function (e) {
      var target = e.target && e.target.closest ? e.target : null;
      if (!target) return;
      var article = target.closest('[data-kb-action="open"]');
      if (article) {
        e.preventDefault();
        openArticle(article.getAttribute('data-kb-slug'));
        return;
      }
      var homeArticle = target.closest('[data-home-article]');
      if (homeArticle) {
        e.preventDefault();
        openArticle(homeArticle.getAttribute('data-home-article'));
        return;
      }
      if (target.closest('[data-kb-action="back"]')) {
        e.preventDefault();
        body.innerHTML = initialMarkup;
        body.scrollTop = 0;
        return;
      }

      var homeAction = target.closest('[data-home-action]');
      if (homeAction) {
        e.preventDefault();
        var act = homeAction.getAttribute('data-home-action');
        parent.postMessage({ source: 'gs-widget-preview', nav: act === 'help' ? 'help' : 'chat' }, '*');
      }
    });
  }

</script>
</body>
</html>`;
    // `phase` intentionally stays out of the dependency list: it is pushed in
    // via postMessage so the frame animates instead of being re-created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings, prechat, workspaceName, platformName, poweredBy, brandName, teamMembers, view, kbArticles, kbCategories, operatorAvatar, operatorName,
    previewMode, smartScenario?.rule, smartScenario?.content, smartScenario?.locale,
    smartScenario?.rtl,
  ]);

  return (
    <div className="h-full w-full overflow-hidden rounded-xl border border-border bg-muted/20">
      <iframe
        ref={frameRef}
        title="widget-preview"
        srcDoc={srcDoc}
        className="h-full w-full border-0"
        // Preview-only: the frame stays sandboxed (no same-origin), but the
        // platform-owned "Powered by" anchor must be able to open a real new
        // tab whose destination is NOT itself sandboxed. The live customer
        // widget never depends on this — it uses a plain native anchor.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"

        onLoad={() => {
          if (!isSmart) return;
          frameRef.current?.contentWindow?.postMessage(
            { source: 'gs-smart-preview', type: 'smart-preview:set-phase', phase },
            '*',
          );
        }}
      />
    </div>
  );
}
