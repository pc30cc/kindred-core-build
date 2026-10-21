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
import { useArtPreviewStage } from './useArtPreviewStage';
import { useEdition } from '@/hooks/useEdition';
import { resolveChatWidgetTemplate, widgetDateHints } from '../../../../shared/widgetTemplates';
import { INTL_BRAND } from '../../../../shared/internationalMode';
import { WEBYAR_BRAND, isUncustomisedColor, useWebyarKit } from '@/lib/webyarBrand';
import {
  LOCAL_KIT_LAUNCHER_BASE_SIZE,
  LOCAL_KIT_LAUNCHER_CHAT_GLYPH,
  LOCAL_KIT_LAUNCHER_CLOSE_GLYPH,
  LOCAL_KIT_LAUNCHER_CSS,
} from '../../../../shared/localKitLauncher';
import { SHIPS_INTL_KIT, SHIPS_IRAN_KIT } from '../../../../shared/buildBrand';
import { resolveLauncherStyle } from '../../../../shared/launcherStyles';
import { agentFaceInitial, onlineFirst, widgetTeamName } from '../../../../shared/widgetTeam';
import {
  RESPOK_LAUNCHER_BASE_SIZE,
  RESPOK_LAUNCHER_CHAT_GLYPH,
  RESPOK_LAUNCHER_CLOSE_GLYPH,
  RESPOK_LAUNCHER_CSS,
  RESPOK_LAUNCHER_OPEN_GLYPH,
} from '../../../../shared/respokLauncher';

/** `list` is the conversation list (a bottom menu's Messages). */
export type PreviewView = 'home' | 'list' | 'chat' | 'prechat' | 'offline' | 'kb';

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
  messagesTab: string; conversations: string; noConversations: string; newConversation: string;
  statusOpen: string; statusResolved: string; unread: string; back: string;
  listTimeRecent: string; listTimeEarlier: string;
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
    homeReplySlow: "We'll reply here as soon as we're back",
    homeHelpTitle: 'Find an answer', homeSeeAll: 'See all',
    kbAllArticles: 'Popular articles', kbCategories: 'Browse by category',
    kbEmpty: 'No articles published yet — add some in the Knowledge Base.',
    kbBack: 'Back to articles',
    attachTitle: 'Attach file', micTitle: 'Record voice message', emojiTitle: 'Emoji',
    talkToHuman: 'Talk to a human', msgSeen: 'Seen',
    messagesTab: 'Messages', conversations: 'Conversations', noConversations: 'No conversations yet',
    newConversation: 'New conversation', statusOpen: 'Open', statusResolved: 'Resolved', unread: 'Unread messages',
    back: 'Back', listTimeRecent: '2 min', listTimeEarlier: 'Yesterday',
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
    homeReplySlow: 'به‌محض بازگشت، همین‌جا در گفتگو پاسخ می‌دهیم',
    homeHelpTitle: 'پاسخ خود را پیدا کنید', homeSeeAll: 'مشاهده همه',
    kbAllArticles: 'مقالات پرکاربرد', kbCategories: 'دسته‌بندی‌ها',
    kbEmpty: 'هنوز مقاله‌ای منتشر نشده است — از بخش پایگاه دانش اضافه کنید.',
    kbBack: 'بازگشت به مقاله‌ها',
    attachTitle: 'پیوست فایل', micTitle: 'ضبط پیام صوتی', emojiTitle: 'شکلک',
    talkToHuman: 'صحبت با اپراتور', msgSeen: 'دیده شد',
    messagesTab: 'پیام‌ها', conversations: 'گفتگوها', noConversations: 'هنوز گفتگویی ندارید',
    newConversation: 'گفتگوی جدید', statusOpen: 'باز', statusResolved: 'حل شده', unread: 'پیام‌های خوانده‌نشده',
    back: 'بازگشت', listTimeRecent: '۲ دقیقه', listTimeEarlier: 'دیروز',
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
    homeReplySlow: 'Döner dönmez burada yanıtlayacağız',
    homeHelpTitle: 'Yanıtınızı bulun', homeSeeAll: 'Tümünü gör',
    kbAllArticles: 'Popüler makaleler', kbCategories: 'Kategoriye göre göz at',
    kbEmpty: 'Henüz yayınlanmış makale yok — Bilgi Bankası’ndan ekleyin.',
    kbBack: 'Makalelere dön',
    attachTitle: 'Dosya ekle', micTitle: 'Sesli mesaj kaydet', emojiTitle: 'Emoji',
    talkToHuman: 'Bir temsilciyle konuşun', msgSeen: 'Görüldü',
    messagesTab: 'Mesajlar', conversations: 'Sohbetler', noConversations: 'Henüz sohbet yok',
    newConversation: 'Yeni sohbet', statusOpen: 'Açık', statusResolved: 'Çözüldü', unread: 'Okunmamış mesajlar',
    back: 'Geri', listTimeRecent: '2 dk', listTimeEarlier: 'Dün',
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

/**
 * True when a #rgb / #rrggbb colour is dark enough to read on white (WCAG
 * contrast >= 3). Same rule as the widget loader's readsOnWhite: the label
 * card is white, so a light text colour would leave an empty white box.
 */
function readsOnWhite(hex: unknown): boolean {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return false;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (l + 0.05) >= 3;
}

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
  // Widget settings are a loose server record read field by field below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  /**
   * The team /config would send (previewTeam.ts). With `fullName`, their own
   * name (null without one), the frame names them in its own language (the
   * smart studio previews any of the workspace's); without the key, `name`.
   */
  teamMembers?: { name: string; fullName?: string | null; avatar?: string | null; online: boolean }[];
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
   * The template to render: the one the workspace's visitors wear (resolved
   * with the Super Admin's catalog, shared/chatTemplateCatalog.ts), or the
   * one a Super Admin previews. Without it the frame renders
   * `settings.widget_template_id`, which the caller must then have resolved
   * (WidgetPage's previewSettings carries the effective id) — the frame
   * renders any registered id, enabled or not.
   */
  templateId?: string | null;
  /** That template's merged options (`config.templateOptions` in production). */
  templateOptions?: Record<string, unknown> | null;
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
  operatorAvatar, operatorName, previewMode = 'generic', smartScenario, onSmartEvent, templateId, templateOptions,
}: WidgetLivePreviewProps) {
  // The mock page around the widget: the panel theme's own colours under
  // Art (useArtPreviewStage), the cool slate otherwise.
  const stage = useArtPreviewStage();
  // The International edition previews its own template and dates
  // (shared/widgetTemplates.ts); the Iranian edition exactly as before.
  const { isInternational } = useEdition();
  // The Iranian edition (known, never assumed) previews its local kit's
  // floating button and logo credit, as loader.js / the bootstrap draw them.
  // SHIPS_IRAN_KIT is a build-time literal: the RESPOK build drops every
  // branch below that reads it, and the kit's strings and logo with them.
  const iranKitEdition = useWebyarKit();
  const localKit = SHIPS_IRAN_KIT && iranKitEdition && !isInternational;
  // The International edition previews RESPOK's floating button (the kit's
  // Thread or Open chat button), as loader.js draws it, when this build
  // ships it: the Iran build's loader leaves RESPOK's kit out (`@intl-kit`),
  // so an Iran-brand deployment switched to the International edition shows
  // the plain launcher on its sites, and here.
  const respokKit = SHIPS_INTL_KIT && isInternational;
  const stageBackground = stage?.background ?? '#F1F5F9';
  const stageBar = stage?.bar ?? '#E2E8F0';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const isSmart = previewMode === 'smart' && !!smartScenario;
  const smartMode = smartScenario?.rule.presentation_config?.mode || 'launcher_nudge';
  const phase = smartScenario?.phase || 'idle';

  useEffect(() => {
    if (!onViewChange) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { source?: string; nav?: string } | null;
      if (!data || data.source !== 'gs-widget-preview' || !data.nav) return;
      onViewChange(data.nav === 'home' ? 'home' : data.nav === 'help' ? 'kb' : data.nav === 'list' ? 'list' : 'chat');
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
       concern and is not consumed by the presentation layer. */
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
    const fabSize = Math.round((SHIPS_IRAN_KIT && localKit ? LOCAL_KIT_LAUNCHER_BASE_SIZE : respokKit ? RESPOK_LAUNCHER_BASE_SIZE : 56) * fabScale);
    // The launcher as /config sends it (shared/launcherStyles.ts: an unknown
    // icon is `chat`, a pill needs its text; `s` has the plan applied).
    const launcher = resolveLauncherStyle({ shape: s.fab_shape, icon: s.fab_icon, label: s.fab_label });
    // An icon of today's set other than `chat`, by its own keys only (as the
    // loader: "constructor" is no icon).
    const customIcon = typeof s.fab_icon === 'string' && s.fab_icon !== 'chat' && Object.prototype.hasOwnProperty.call(FAB_ICONS, s.fab_icon);
    // The local kit's button (shared/localKitLauncher.ts): its gradient unless
    // the workspace chose its own colour; its bubble unless it chose an icon.
    const kitBrand = SHIPS_IRAN_KIT && localKit && isUncustomisedColor(s.primary_color);
    const kitBubble = SHIPS_IRAN_KIT && localKit && !customIcon;
    // RESPOK's button (shared/respokLauncher.ts): Ink + Signal unless the
    // workspace chose its own colour; the kit's pills unless it chose an icon.
    const rpkBrand = respokKit && isUncustomisedColor(s.primary_color);
    const rpkPills = respokKit && !customIcon;
    // The kit's square has the brand's 18px corners (LOCAL_KIT_LAUNCHER_CSS), every other 16px.
    const fabRadius = launcher.shape === 'square' ? (SHIPS_IRAN_KIT && localKit ? '18px' : '16px') : '50%';
    const fabIconColor = s.fab_icon_color || '#fff';
    const fabIcon = customIcon ? FAB_ICONS[s.fab_icon as string] : FAB_ICONS.chat;
    // A launcher style (the pill, the bubble, two bubbles, the agent's face):
    // the loader's classes and texts on the same markup, its look from
    // runtime-fab.css (asked for in the frame, through the manifest). The
    // team named as /config names it, in the frame's language, and the
    // agent's letter as /config picks it (shared/widgetTeam.ts): the team,
    // online first, by those names, then the workspace's name.
    const team = (teamMembers || []).map(({ name, fullName, avatar, online }) => ({
      name: fullName !== undefined ? widgetTeamName(fullName, locale) : name,
      avatar,
      online,
    }));
    const fabStyled = launcher.styled;
    const fabInitial = launcher.icon === 'avatar'
      ? agentFaceInitial(team, typeof s.brand_name === 'string' ? s.brand_name : workspaceName || brandName)
      : '';
    const fabStyleAttrs = fabStyled
      ? ` data-fx="${esc(s.fab_label || '')}" data-fi="${esc(fabInitial)}" dir="${/^fa/.test(locale) ? 'rtl' : 'ltr'}" style="visibility:hidden"`
      : '';
    const fabStyleClass = fabStyled ? ` fx fx-${launcher.icon} fx-${launcher.shape}${view === 'offline' ? ' fx-off' : ''}` : '';
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

    /* The template: the caller's (effective or previewed) id, else the
       settings' one, resolved per edition as the bootstrap does. */
    const previewTemplateId: string | null = templateId !== undefined
      ? templateId || null
      : isInternational
        ? resolveChatWidgetTemplate('international', s.widget_template_id)
        : (s.widget_template_id as string | undefined) || null;
    const previewTemplateOptions = (templateOptions !== undefined ? templateOptions : s.widget_template_options) || {};
    // RESPOK's logo direction (a template option of t1-intl / t2-intl): the
    // server credits with that direction's lockup in the International
    // edition; the loader (the build that ships RESPOK's kit) puts one class
    // on the shell for the panel's art and draws that direction's glyph.
    const logoOpen = isInternational && (previewTemplateOptions as { logoDirection?: unknown }).logoDirection === 'open';
    const lgOpen = respokKit && logoOpen;

    const previewConfig = {
      brandName: brandName || title,
      workspaceName: title,
      platformName: poweredBy?.brand || platformName || brandName || d.brandFallback,
      // Platform-owned footer payload — mirrors the production bootstrap so the
      // preview reflects super-admin wording/link and plan visibility exactly.
      ...(poweredBy !== undefined
        ? {
            // The International template credits the platform with its logo,
            // as the widget bootstrap does (server/routes/widget.ts).
            // The Iranian edition (known, never assumed) credits its platform
            // with the local kit's Persian logotype the same way.
            poweredBy: isInternational && poweredBy
              ? { ...poweredBy, logo: `${window.location.origin}${(logoOpen ? INTL_BRAND.horizontalOpen : INTL_BRAND.horizontal).light}` }
              : SHIPS_IRAN_KIT && localKit && poweredBy
                ? { ...poweredBy, logo: `${window.location.origin}${WEBYAR_BRAND.logo.light}` }
                : poweredBy,
            showPoweredBy: poweredBy !== null,
          }
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
      // Persian dates: Gregorian in the visitor's zone, as the International
      // bootstrap says; the Iranian preview sends no hint (Jalali, Tehran).
      ...(isInternational ? widgetDateHints('international') : {}),
      // As the bootstrap: the template and its options (never its name).
      templateId: previewTemplateId,
      templateOptions: previewTemplateOptions,
    };

    // The panel's view key, as Core names it (panel[data-view], the tabs).
    const previewTab = view === 'home' ? 'home' : view === 'kb' ? 'help' : view === 'list' ? 'list' : 'chat';
    const nowIso = new Date().toISOString();
    const earlierIso = new Date(Date.now() - 90 * 1000).toISOString();

    const payload = {
      locale,
      rtl,
      primary,
      view,
      /** Template id — resolved through the registry inside the frame. */
      templateId: previewTemplateId,
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
        // The conversation list (a bottom menu's Messages view).
        messages: d.messagesTab, back: d.back,
        wyConversations: d.conversations, wyNoConversations: d.noConversations,
        wyNewConversation: d.newConversation, wyStatusOpen: d.statusOpen,
        wyStatusResolved: d.statusResolved, wyUnread: d.unread,
      },

      shellVm: {
        config: previewConfig,
        brandName: title,
        workspaceName: title,
        headerTitle: title,
        chatEnabled,
        kbEnabled,
        locale,
        activeTab: previewTab,
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
        // As /config sends them: online first, name, avatar and dot only.
        teamMembers: team.length
          ? onlineFirst(team)
          : [{ name: operatorName || title, avatar: operatorAvatar || '', online: true }],
        articles: realArticles.map((a, i) => ({ title: a.title, slug: String(i) })),
        categories: [],
      },
      /* The conversation list: two sample threads, one waiting for the
         visitor (unread) and one closed. */
      listVm: {
        rtl,
        loading: false,
        error: false,
        chatEnabled,
        conversations: [
          {
            id: 'preview-1', status: 'open', preview: d.sample, unreadCount: 1, timeLabel: d.listTimeRecent,
            lastFromVisitor: false, operatorName: operatorName || title, operatorAvatar: operatorAvatar || '', operatorOnline: true,
          },
          {
            id: 'preview-2', status: 'resolved', preview: d.visitorSample, unreadCount: 0, timeLabel: d.listTimeEarlier,
            lastFromVisitor: true, operatorName: operatorName || title, operatorAvatar: operatorAvatar || '', operatorOnline: false,
          },
        ],
      },
      // The capabilities Core passes to a renderer (production: runtime.js).
      capabilities: { kbNeutral: true, csat: true, reactions: true, orderCard: true, prechatSteps: true, instantAnswers: true, chatMenu: true, awayThread: true, queuePosition: true, emojiSearch: true, dlProgress: true, kbAuthor: true },
      // Who answers the sample conversation (the chat bar Core paints for it).
      chatOperator: { name: operatorName || title, avatar: operatorAvatar || '', online: true },
      // The pre-chat one question at a time (a renderer declaring prechatSteps,
      // template option prechatMode 'steps'): its sample answers and the
      // edition's phone prefix, as runtime-late.js uses it.
      steps: {
        name: rtl ? 'علی رضایی' : 'Alex Morgan',
        phonePrefix: isInternational ? '' : '+98',
      },
      // The message left while the team is away (a renderer declaring
      // awayThread), when the workspace's offline mode takes one.
      awaySample: (s.offline_mode || 'capture_message') === 'capture_message'
        ? { sender: 'visitor', senderType: 'visitor', body: d.visitorSample, time: nowIso, status: 'sent' } : null,
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
      /** The launcher wears a style: the frame asks for runtime-fab.css. */
      fabStyled,
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
  body{background:${stageBackground};overflow:hidden;font-family:'IRANSans','InterWY',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .site{padding:22px;}
  .site .bar{height:12px;border-radius:6px;background:${stageBar};margin-bottom:10px;}
  .site .bar.w2{width:62%}.site .bar.w3{width:78%}.site .bar.w4{width:45%}
  .site .block{height:120px;border-radius:14px;background:${stageBar};margin:16px 0;}
  .site .cards{display:flex;gap:12px}.site .cards div{flex:1;height:64px;border-radius:12px;background:${stageBar}}
  .shell{--gs-primary:${esc(primary)};--gs-secondary:${esc(secondary)};--gs-fab-size:${fabSize}px;${shadowColor ? `--gs-shadow:${esc(shadowColor)};` : ''}color:#1F2937;}
  /* PARITY RULE: the preview provides ONLY the fake page + viewport. It must
     NOT redefine panel geometry or lifecycle — the panel is positioned and
     toggled by the production presentation stylesheet, exactly like a real
     visitor's browser, so layout regressions surface here too. */
  .header-op-avatar.has-img img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;}
  /* Launcher styles copied 1:1 from loader.js SHELL_CSS. */
  .shell{position:fixed;width:0;height:0;z-index:2147483646;}
  .shell.pos-bottom-right{bottom:24px;right:24px;left:auto;top:auto;}
  .shell.pos-bottom-left{bottom:24px;left:24px;right:auto;top:auto;}
  .shell .launcher{position:absolute;bottom:0;z-index:2;display:flex;align-items:center;justify-content:center;
    --gs-fab-exit:calc(var(--gs-fab-size,56px) + 56px);
    width:var(--gs-fab-size,56px);height:var(--gs-fab-size,56px);border-radius:${fabRadius};border:none;cursor:pointer;font-family:inherit;
    box-shadow:0 3px 12px -4px var(--gs-shadow,rgba(0,0,0,.16)),0 0 0 1px rgba(0,0,0,.03);
    transition:transform .62s cubic-bezier(.33,1,.68,1),box-shadow .2s ease;
     background:${esc(primary)};color:${esc(fabIconColor)};}
  .launcher.bottom-right{right:0;left:auto;}
  .launcher.bottom-left{left:0;right:auto;}
  .shell .launcher svg{width:calc(var(--gs-fab-size,56px) * .46);height:calc(var(--gs-fab-size,56px) * .46);fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
  .launcher.open svg.chat-icon{display:none;}
  .launcher:not(.open) svg.close-icon{display:none;}
  .launcher .fab-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;
    pointer-events:none;clip-path:circle(75% at 50% 50%);transition:clip-path .55s cubic-bezier(.22,1,.36,1);}
  .launcher.has-image:hover .fab-img{clip-path:circle(0% at 50% 50%);}
  .shell .launcher:hover{transform:translateY(-2px) scale(1.06);transition:transform .3s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease;}
  .shell .launcher:active{transform:scale(.96);}

  .launcher.enter,.launcher.enter:hover{transform:translateY(var(--gs-fab-exit,112px));animation:none!important;}
  .launcher.open,.launcher.open:hover{transform:translateY(var(--gs-fab-exit,112px));pointer-events:none;animation:none;}
  ${s.fab_animation === true ? '.launcher{animation:gsp 2s ease-in-out infinite}@keyframes gsp{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}' : ''}
  .fab-label{position:absolute;bottom:0;z-index:2;display:flex;flex-direction:column;justify-content:center;
    --gs-fab-exit:calc(var(--gs-fab-size,56px) + 56px);
    height:calc(var(--gs-fab-size,56px) - 4px);padding:0 16px;border-radius:.9rem;background:#fff;white-space:nowrap;
    box-shadow:0 8px 20px rgba(0,0,0,.12);pointer-events:none;
    ${pos === 'bottom-left' ? `left:${fabSize + 10}px` : `right:${fabSize + 10}px`};
    transition:transform .62s cubic-bezier(.33,1,.68,1);transform:translateY(0);}
  .fab-label .label-title{font-size:13px;font-weight:600;line-height:1.3;color:${esc(s.fab_text_color && readsOnWhite(s.fab_text_color) ? s.fab_text_color : '#1c2024')};}
  .fab-label .label-sub{font-size:11px;line-height:1.3;color:#60646c;}
  .fab-label.enter{transform:translateY(var(--gs-fab-exit,112px));}
  .fab-label.open{transform:translateY(var(--gs-fab-exit,112px));pointer-events:none;}

  /* Smart simulation: surfaces fade in/out with the real transition timing. */
  [data-smart-surface]{transition:opacity .22s ease, transform .22s ease;}
  [data-smart-surface][hidden]{display:none!important;}
  [data-smart-surface].smart-enter{opacity:0;transform:translateY(6px);}
  ${SHIPS_IRAN_KIT && localKit ? LOCAL_KIT_LAUNCHER_CSS : ''}
  ${respokKit ? RESPOK_LAUNCHER_CSS : ''}
</style>
</head>
<body>
  <div class="site" aria-hidden="true">
    <div class="bar w3"></div><div class="bar w2"></div><div class="bar w4"></div>
    <div class="block"></div>
    <div class="cards"><div></div><div></div><div></div></div>
  </div>
  <div class="shell pos-${pos}${respokKit ? (lgOpen ? ' lg-open' : ' lg-thread') : ''}${s.fab_animation === true ? ' anim-on' : ''}">
    <div class="panel ${pos} visible${rtl ? ' panel-rtl' : ''}${s.fab_animation === true ? ' anim-on' : ''}" dir="${dir}"></div>
    <button type="button" class="launcher ${pos}${fabImage ? ' has-image' : ''}${SHIPS_IRAN_KIT && localKit ? ` lk-kit${kitBrand ? ' lk-kit-brand' : ''}` : ''}${respokKit ? ` rpk-kit${rpkBrand ? ' rpk-kit-brand' : ''}` : ''}${fabStyleClass}" id="gs-launcher" aria-label="chat"${fabStyleAttrs}>
      ${SHIPS_IRAN_KIT && kitBubble ? LOCAL_KIT_LAUNCHER_CHAT_GLYPH : rpkPills ? (lgOpen ? RESPOK_LAUNCHER_OPEN_GLYPH : RESPOK_LAUNCHER_CHAT_GLYPH) : `<svg class="chat-icon" viewBox="0 0 24 24">${fabIcon}</svg>`}
      ${SHIPS_IRAN_KIT && localKit ? LOCAL_KIT_LAUNCHER_CLOSE_GLYPH : respokKit ? RESPOK_LAUNCHER_CLOSE_GLYPH : '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"></path></svg>'}
      ${fabImage ? `<img class="fab-img" alt="" src="${esc(fabImage)}">` : ''}
    </button>
    ${s.fab_label && launcher.shape !== 'pill' ? `<div class="fab-label"${fabStyled ? ' style="visibility:hidden"' : ''}><span class="label-title">${esc(s.fab_label)}</span></div>` : ''}
  </div>
<!-- The preview loads the SAME presentation assets the visitor widget loads,
     resolved through the registry (no template name is hard-coded here). -->
<script src="/widget/presentation-registry.js"></script>
<script>
  // A platform logo that cannot load becomes its name (as Core does).
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || !img.hasAttribute || !img.hasAttribute('data-wy-brand-logo')) return;
    if (img.parentNode) img.parentNode.replaceChild(document.createTextNode(' ' + (img.getAttribute('alt') || '')), img);
  }, true);
  var GS_PREVIEW = ${JSON.stringify(payload).replace(/</g, '\\u003c')};
  var GS_SMART = GS_PREVIEW.smart;

  // A launcher style's stylesheet (runtime-fab.css), as the loader asks for
  // it: the manifest's file, the launcher and its card unseen until it is in
  // (3 s at most); without it the launcher is today's.
  function gsFabShow() {
    var els = document.querySelectorAll('#gs-launcher, .fab-label');
    for (var i = 0; i < els.length; i++) els[i].style.visibility = '';
  }
  if (GS_PREVIEW.fabStyled) setTimeout(gsFabShow, 3000);
  function gsFabStyle(manifest) {
    if (!GS_PREVIEW.fabStyled || document.querySelector('link[data-gs-fab]')) return;
    var fx = document.createElement('link');
    fx.rel = 'stylesheet';
    fx.href = '/widget/' + ((manifest && manifest['runtime-fab.css']) || 'runtime-fab.css');
    fx.setAttribute('data-gs-fab', '');
    fx.onload = fx.onerror = gsFabShow;
    document.head.appendChild(fx);
  }

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
      var skinReady = !desc.skin;
      var scriptReady = false;
      // The renderer's extras (its markup no first paint needs): the live
      // widget gets them after its first paint, the preview before it paints.
      var extrasReady = !desc.extras;
      var mod = null;
      function prepareAndRender() {
        if (!styleReady || !skinReady || !scriptReady || !extrasReady || !mod || !mod.create) return;
        var preparation = typeof mod.prepare === 'function'
          ? mod.prepare({ locale: GS_PREVIEW.locale, templateId: GS_PREVIEW.templateId })
          : null;
        Promise.resolve(preparation).catch(function () {}).then(function () { gsRenderPreview(mod); });
      }
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/widget/' + styleFile;
      link.onload = function () { styleReady = true; prepareAndRender(); };
      link.onerror = function () { styleReady = true; prepareAndRender(); };
      document.head.appendChild(link);
      // A skin template's own stylesheet, after the base one (as the loader).
      if (desc.skin) {
        var skin = document.createElement('link');
        skin.rel = 'stylesheet';
        skin.href = '/widget/' + ((manifest && manifest[desc.skin]) || desc.skin);
        skin.onload = function () { skinReady = true; prepareAndRender(); };
        skin.onerror = function () { skinReady = true; prepareAndRender(); };
        document.head.appendChild(skin);
      }

      var scr = document.createElement('script');
      scr.src = '/widget/' + scriptFile;
      scr.onload = function () {
        mod = window[desc.globalKey];
        scriptReady = true;
        prepareAndRender();
      };
      document.body.appendChild(scr);
      if (desc.extras) {
        var xs = document.createElement('script');
        xs.src = '/widget/' + ((manifest && manifest[desc.extras]) || desc.extras);
        xs.onload = xs.onerror = function () { extrasReady = true; prepareAndRender(); };
        document.body.appendChild(xs);
      }
    }

    fetch('/widget/widget-manifest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (manifest) { gsFabStyle(manifest); boot(manifest); });
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
      capabilities: GS_PREVIEW.capabilities,
    });
    // Its extras before anything is painted (the renderer refuses a file
    // that is not its own); without them it draws what it draws without.
    if (typeof R.extend === 'function' && window.__gs_mod_extras) R.extend(window.__gs_mod_extras);

    // The renderer's declared features, read as Core reads them (feat() in
    // runtime-ext.js), and the view-model fields Core adds for them: the unread total
    // of a bottom menu (tabs), the search field (kbSearch) and the visitor's
    // first name (visitorName; the preview has no contact, so empty, as Core
    // without one). The default template declares none, so it gets the same
    // view-models and the same pixels as before. What changed for every
    // template, 'default' included, is the navigation: the Messages view
    // (list) and the frame following the renderer's own [data-view],
    // [data-view-back] and [data-conversation-open] hooks (gsBindTabs), as
    // the live widget does.
    function feat(name) { return !!(R.features && R.features[name]); }
    var unreadTotal = 0;
    (GS_PREVIEW.listVm.conversations || []).forEach(function (c) { unreadTotal += Number(c.unreadCount) || 0; });
    var kbVms = [GS_PREVIEW.kbVm].concat(GS_PREVIEW.kbArticleVms || []);
    if (feat('tabs')) {
      GS_PREVIEW.homeVm.unreadTotal = unreadTotal;
      GS_PREVIEW.listVm.unreadTotal = unreadTotal;
      kbVms.forEach(function (vm) { if (vm) vm.unreadTotal = unreadTotal; });
    }
    if (feat('kbSearch')) {
      GS_PREVIEW.homeVm.hasSearch = true;
      kbVms.forEach(function (vm) { if (vm) vm.hasSearch = true; });
    }
    if (feat('visitorName')) GS_PREVIEW.homeVm.visitorName = '';

    var panel = document.querySelector('.panel');
    panel.innerHTML = R.shellHtml(GS_PREVIEW.shellVm);
    // The view the panel shows, as Core marks it (a template may style by it).
    panel.setAttribute('data-view', GS_PREVIEW.shellVm.activeTab);

    var body = panel.querySelector('[data-body]');
    var view = GS_PREVIEW.view;
    if (view === 'home') {
      body.innerHTML = R.homeHtml(GS_PREVIEW.homeVm);
    } else if (view === 'list') {
      body.innerHTML = R.conversationListHtml ? R.conversationListHtml(GS_PREVIEW.listVm) : '';
    } else if (view === 'prechat') {
      var pc = GS_PREVIEW.prechat;
      var identity = {
        isAsked: function (k) { return !!pc.asked[k]; },
        isRequired: function (k) { return !!pc.required[k]; },
      };
      /* The pre-chat one question at a time (feature prechatSteps, option
         prechatMode 'steps'): the chat view with the questions answered so
         far, an e-mail refused then taken, and the last step in the
         composer's place, as runtime-late.js paints it. */
      var keys = ['name', 'email', 'phone'].filter(function (k) { return pc.asked[k]; });
      var steps = feat('prechatSteps') && (GS_PREVIEW.config.templateOptions || {}).prechatMode === 'steps' &&
        typeof R.prechatStepBoxHtml === 'function' && keys.length;
      if (!steps) {
        body.innerHTML = R.prechatFormHtml(identity, {}, GS_PREVIEW.locale);
      } else {
        var open = keys[keys.length - 1];
        var log = [];
        keys.slice(0, -1).forEach(function (k) {
          if (k === 'email') log.push({ key: k, value: 'ali@example', ok: false, why: 'invalid' });
          log.push({ key: k, value: k === 'name' ? GS_PREVIEW.steps.name : k === 'email' ? 'ali@example.com' : '0912 345 6789', ok: true });
        });
        body.innerHTML = R.chatFrameHtml(GS_PREVIEW.shellVm);
        var stepsHost = body.querySelector('[data-chat-messages]');
        if (stepsHost) {
          stepsHost.innerHTML = R.messagesHtml({ messages: [] },
            R.prechatStepsHtml({ key: open, log: log, firstName: pc.asked.name ? GS_PREVIEW.steps.name.split(' ')[0] : '' }), {});
        }
        var stepsHead = body.querySelector('[data-chat-header]');
        if (stepsHead && feat('chatHeader')) stepsHead.innerHTML = R.chatHeaderHtml({ online: true, typing: false, isNew: false, operator: null });
        var stepsBar = body.querySelector('[data-input-bar]');
        if (stepsBar) {
          stepsBar.style.display = 'none';
          stepsBar.insertAdjacentHTML('beforebegin', R.prechatStepBoxHtml({
            key: open, n: keys.length, total: keys.length, optional: !pc.required[open], value: '',
            prefix: open === 'phone' ? GS_PREVIEW.steps.phonePrefix : '', busy: false, error: false,
          }));
        }
      }
    } else if (view === 'kb') {
      body.innerHTML = R.kbHtml(GS_PREVIEW.kbVm);
    } else {
      /* Single-view architecture: chat is a full view (header + messages +
         composer + footer) exactly like production mounts it. */
      body.innerHTML = R.chatFrameHtml(GS_PREVIEW.shellVm);
      var msgHost = body.querySelector('[data-chat-messages]');
      /* Away, a renderer with the in-thread message (feature awayThread)
         shows the visitor's message and the automated reply asking for an
         e-mail, as runtime-late.js does; any other its offline line. */
      var away = view === 'offline' && feat('awayThread') && GS_PREVIEW.awaySample;
      if (msgHost) {
        msgHost.innerHTML = away
          ? R.messagesHtml({ messages: [GS_PREVIEW.awaySample] }, '', { awayReply: { at: 0, status: 'ask', value: '', error: '', skip: true } })
          : R.messagesHtml({ messages: GS_PREVIEW.messages }, '', {});
      }
      /* The chat bar as Core paints it for an existing conversation (feature
         chatHeader: who answers), with its closed menu button (feature
         chatMenu: the notification sounds item, drawn by the extras). */
      var chatHead = body.querySelector('[data-chat-header]');
      if (chatHead && feat('chatHeader') && typeof R.chatHeaderHtml === 'function') {
        chatHead.innerHTML = R.chatHeaderHtml({
          online: view !== 'offline', typing: false, isNew: false,
          operator: view === 'offline' ? null : GS_PREVIEW.chatOperator,
          menu: feat('chatMenu') ? { open: false, items: [{ action: 'sound', on: true }] } : null,
        });
      }
      /* Typing state is sr-only in the design — no visible typing row. */
    }

    // A bottom menu's current tab and its unread badges, as Core marks them
    // after every paint (runtime-ext.js markActiveTab, paintTabBadges).
    if (feat('tabs')) {
      Array.prototype.forEach.call(panel.querySelectorAll('[data-view][aria-current]'), function (el) {
        el.setAttribute('aria-current', el.getAttribute('data-view') === GS_PREVIEW.shellVm.activeTab ? 'page' : 'false');
      });
      var badge = R.format && R.format.badge;
      Array.prototype.forEach.call(panel.querySelectorAll('[data-tab-badge]'), function (el) {
        el.textContent = unreadTotal ? (typeof badge === 'function' ? badge(unreadTotal) : String(unreadTotal)) : '';
        el.hidden = unreadTotal === 0;
      });
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
        nudge.className = 'smart-nudge entering ' + ${JSON.stringify(pos)};
        setTimeout(function () { nudge.classList.remove('entering'); }, 480);
        nudge.setAttribute('data-smart-surface', '');
        /* Geometry + direction come from the production stylesheet contract:
           the bubble hangs above the launcher and follows the widget locale. */
        nudge.setAttribute('dir', ${JSON.stringify(dir)});
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
    function playFabEntry(element) {
      if (!element) return;
      if (typeof element.animate === 'function') {
        element.animate(
          [{ transform: 'translateY(var(--gs-fab-exit,112px))' }, { transform: 'translateY(0)' }],
          { duration: 620, easing: 'cubic-bezier(.33,1,.68,1)', fill: 'none' }
        );
        return;
      }
      element.classList.add('enter');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { element.classList.remove('enter'); });
      });
    }
    function setOpen(open) {
      var wasOpen = isOpen();
      panel.classList.toggle('visible', !!open);
      launcher.classList.toggle('open', !!open);
      if (label) label.classList.toggle('open', !!open);
      // Match production's deterministic close choreography: the launcher
      // rises from below the viewport during the panel's 620ms descent.
      if (wasOpen && !open) {
        playFabEntry(launcher);
        playFabEntry(label);
      }
    }
    window.__gsSetOpen = setOpen;
    // In the scenario studio the panel state belongs to the simulation, so it
    // starts closed and only opens when the rule says a visitor would see it.
    setOpen(!GS_SMART.enabled);
    // Entry parity: when the FAB is the first thing shown it slides up from
    // outside the browser edge with the same 0.62s curve production uses.
    if (!isOpen()) {
      [launcher, label].forEach(function (element) {
        playFabEntry(element);
      });
    }
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

  // Preview-only: the renderer's real navigation hooks drive the parent's
  // view state — the tabs ([data-tab]), a bottom menu or any view link
  // ([data-view]: home / list / help / chat), a named back ([data-view-back])
  // and a conversation row ([data-conversation-open]), in Core's order
  // (runtime.js bindPanelNavigation): a back or a row inside an element
  // that names a view is the back or the row, never that view.
  function gsBindTabs() {
    if (GS_SMART.enabled) return;
    function nav(key) {
      parent.postMessage({ source: 'gs-widget-preview', nav: key }, '*');
    }
    document.addEventListener('click', function (e) {
      var target = e.target && e.target.closest ? e.target : null;
      if (!target) return;
      var tab = target.closest('[data-tab]');
      if (tab) { e.preventDefault(); nav(tab.getAttribute('data-tab')); return; }
      var back = target.closest('[data-view-back]');
      if (back) {
        // "back" (a step back inside the view) is the article's; see gsBindArticles.
        if (back.getAttribute('data-view-back') === 'back') return;
        e.preventDefault();
        nav(back.getAttribute('data-view-back') || 'home');
        return;
      }
      if (target.closest('[data-conversation-open]')) { e.preventDefault(); nav('chat'); return; }
      var viewEl = target.closest('[data-view]');
      if (viewEl && viewEl !== document.querySelector('.panel')) {
        e.preventDefault();
        nav(viewEl.getAttribute('data-view'));
      }
    });
  }

  // Preview-only: open a real article and support returning to the list.
  // The markup always comes from the renderer's KB surfaces.
  function gsBindArticles(R) {
    var body = document.querySelector('.panel [data-body]');
    if (!body) return;
    var initialMarkup = body.innerHTML;
    var articleOpen = false;
    function openArticle(index) {
      var vm = (GS_PREVIEW.kbArticleVms || [])[Number(index)];
      if (!vm) return;
      body.innerHTML = R.kbHtml(vm);
      body.scrollTop = 0;
      articleOpen = true;
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
      var stepBack = target.closest('[data-view-back="back"]');
      if (target.closest('[data-kb-action="back"]') || (stepBack && articleOpen)) {
        e.preventDefault();
        body.innerHTML = initialMarkup;
        body.scrollTop = 0;
        articleOpen = false;
        return;
      }
      if (stepBack && !GS_SMART.enabled) {
        e.preventDefault();
        parent.postMessage({ source: 'gs-widget-preview', nav: stepBack.getAttribute('data-view-back-fallback') || 'home' }, '*');
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
    templateId, templateOptions,
    previewMode, smartScenario?.rule, smartScenario?.content, smartScenario?.locale,
    smartScenario?.rtl, stageBackground, stageBar, isInternational, localKit, respokKit,
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
