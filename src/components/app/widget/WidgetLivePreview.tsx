/**
 * WidgetLivePreview — pixel-faithful preview of the real chat widget.
 *
 * Instead of re-implementing the widget in React (which drifted from the real
 * thing), we render the *actual* widget markup inside an isolated iframe that
 * loads the production stylesheet at `/widget/runtime.css`. Every class name
 * below mirrors what `public/widget/runtime.js` emits at runtime, so what the
 * operator sees here is what the visitor gets on their site. Its words are
 * the widget's own (runtime.js's dictionary, loaded in the frame), and its
 * states the real ones: the offline behaviour the workspace chose, whether
 * the team is online now, the pre-chat form the server asks, the welcome the
 * server sends (or none while the AI agent greets).
 */
import { useEffect, useMemo, useRef } from 'react';
import type { WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import type { SmartEvalResult } from '@/lib/widget/smartEngine';
import type { SmartRuleDraft } from '@/lib/widget/smartRules';
import { useArtPreviewStage } from './useArtPreviewStage';
import { useEdition } from '@/hooks/useEdition';
import { resolveChatWidgetTemplate, widgetDateHints } from '../../../../shared/widgetTemplates';
import { INTL_BRAND } from '../../../../shared/internationalMode';
import { WEBYAR_BRAND } from '@/lib/webyarBrand';
import { useBrandAssets } from '@/lib/brandAssets';
import { useLauncherKit } from './launcherKit';
import { previewOfflineMessage, previewOfflineMode, previewPrechatForm } from './previewStates';
import {
  LOCAL_KIT_LAUNCHER_CHAT_GLYPH,
  LOCAL_KIT_LAUNCHER_CLOSE_GLYPH,
  LOCAL_KIT_LAUNCHER_CSS,
} from '../../../../shared/localKitLauncher';
import { SHIPS_IRAN_KIT } from '../../../../shared/buildBrand';
import { resolveLauncherStyle } from '../../../../shared/launcherStyles';
import { onlineFirst, widgetTeamName } from '../../../../shared/widgetTeam';
import { WIDGET_UNCUSTOMISED_COLOR, widgetAccentColor, widgetOwnColor } from '../../../../shared/widgetColor';
import { isAuthoredWidgetText, widgetTextDefault } from '../../../../shared/widgetTextDefaults';
import {
  RESPOK_LAUNCHER_CHAT_GLYPH,
  RESPOK_LAUNCHER_CLOSE_GLYPH,
  RESPOK_LAUNCHER_CSS,
  RESPOK_LAUNCHER_OPEN_GLYPH,
} from '../../../../shared/respokLauncher';

/** `list` is the history: the visitor's previous conversations («گفتگوهای قبلی»). */
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

/**
 * The preview's sample content (a conversation, the list's times, a name),
 * per widget language. Not the widget's words: every string the widget
 * itself shows comes from its own dictionary (public/widget/runtime.js,
 * `__gs_runtime.t`), which the frame loads, so the preview speaks exactly
 * as visitors read it, today's copy included.
 */
const SAMPLES: Record<'en' | 'fa' | 'tr', {
  operator: string; visitor: string; recent: string; earlier: string; name: string; brand: string;
}> = {
  en: {
    operator: 'Hi! How can we help you today?', visitor: 'Hi, I have a question about pricing.',
    recent: '2 min', earlier: 'Yesterday', name: 'Alex Morgan', brand: 'Support',
  },
  fa: {
    operator: 'سلام! چطور می‌توانیم کمکتان کنیم؟', visitor: 'سلام، دربارهٔ تعرفه‌ها سؤال داشتم.',
    recent: '۲ دقیقه', earlier: 'دیروز', name: 'علی رضایی', brand: 'پشتیبانی',
  },
  tr: {
    operator: 'Merhaba! Size nasıl yardımcı olabiliriz?', visitor: 'Merhaba, fiyatlandırma hakkında bir sorum var.',
    recent: '2 dk', earlier: 'Dün', name: 'Alex Morgan', brand: 'Destek',
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

export interface WidgetLivePreviewProps {
  // Widget settings are a loose server record read field by field below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: Record<string, any> | null | undefined;
  prechat?: WidgetPrechatSettings | null;
  /**
   * The Super Admin's pre-chat policy, `{ name, email, phone }` of
   * prechat_<field>_policy (GET /api/widget-settings/platform/public), and
   * whether the plan includes the workspace's own form
   * (`widget_prechat_form`): the form drawn is the one the server asks.
   */
  prechatPolicy?: unknown;
  prechatFormAllowed?: boolean;
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
  /** Operator display name: the thread's sender and the chat header's name. */
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
  /**
   * Whether visitors find the team online right now (GET
   * /api/widget-settings/:id/availability). The home and the chat bar show
   * it; the `offline` view always shows the offline behaviour. Unknown:
   * online, as the frame cannot ask.
   */
  availabilityState?: 'online' | 'offline' | null;
  /** The AI agent greets first, so every template draws no welcome (/config aiAgent.suppressGreeting). */
  aiGreets?: boolean;
  /** The welcome visitors read while the workspace has none of its own (the platform's, else the built-in one). */
  defaultWelcome?: string | null;
  /** Said in the frame where the widget would be, while offline with "Hide the widget". */
  hiddenNote?: string;
}

/** The views that need the chat (production's `features.chat`). */
const CHAT_VIEWS: readonly PreviewView[] = ['chat', 'list', 'prechat', 'offline'];

export function WidgetLivePreview({
  settings, prechat, prechatPolicy, prechatFormAllowed, workspaceName, platformName, poweredBy, brandName, teamMembers, view, kbArticles, kbCategories, onViewChange,
  operatorAvatar, operatorName, previewMode = 'generic', smartScenario, onSmartEvent, templateId, templateOptions,
  availabilityState, aiGreets, defaultWelcome, hiddenNote,
}: WidgetLivePreviewProps) {
  // The mock page around the widget: the panel theme's own colours under
  // Art (useArtPreviewStage), the cool slate otherwise.
  const stage = useArtPreviewStage();
  // The International edition previews its own template and dates
  // (shared/widgetTemplates.ts); the Iranian edition exactly as before.
  const { isInternational } = useEdition();
  // The kit button visitors get (launcherKit.ts, the loader's rule): the
  // Iranian edition (known, never assumed) previews its local kit's button
  // and logo credit; the International edition RESPOK's button where this
  // build ships it (an Iran-brand deployment switched to the International
  // edition shows the plain launcher on its sites, and here).
  // SHIPS_IRAN_KIT is a build-time literal: the RESPOK build drops every
  // branch below that reads it, and the kit's strings and logo with them.
  const { localKit, respokKit, kit, baseSize } = useLauncherKit();
  // A logo the Super Admin uploaded credits the platform in both editions
  // (configSnapshot.ts); absolute already.
  const brandAssets = useBrandAssets();
  const uploadedLogo = brandAssets.source === 'custom' && brandAssets.lockup ? brandAssets.lockup.light : null;
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
    const sample = SAMPLES[locale as keyof typeof SAMPLES] || SAMPLES.en;
    const rtl = smartScenario ? smartScenario.rtl : locale === 'fa';
    const dir = rtl ? 'rtl' : 'ltr';

    // The colour as /config sends it (the seeded #3B82F6 when the workspace
    // has none: shared/widgetColor.ts) and the accent the loader gives the
    // panel: its own, else the kit button's (applyConfigToShell).
    const ownColor = widgetOwnColor(s.primary_color);
    const wireColor = ownColor || WIDGET_UNCUSTOMISED_COLOR;
    const primary: string = widgetAccentColor(s.primary_color, kit);
    const secondary: string = s.secondary_color || wireColor;
    /* Launcher shadow is derived from the accent (same rule as loader.js). */
    const shadowColor: string = shadowFromPrimary(primary);
    // As production's `features.chat`: the Behavior tab's switch only.
    // Availability's live_chat_enabled never hides the chat; it makes the
    // widget offline inside business hours (the offline behaviour). Without
    // the chat a visitor never reaches its views: the frame shows the home.
    const chatEnabled = s.chat_enabled !== false;
    const shown: PreviewView = chatEnabled || !CHAT_VIEWS.includes(view) ? view : 'home';
    // Who answers now: the offline view always shows the offline behaviour.
    const away = shown === 'offline' || availabilityState === 'offline';
    const offlineMode = previewOfflineMode(s.offline_mode);
    const hidden = shown === 'offline' && offlineMode === 'hide_widget';
    const pos = s.position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    /* Header titles use workspace identity only — launcher_text is a launcher
       concern and is not consumed by the presentation layer. */
    // An explicit empty brand_name means "cleared" — show no name at all.
    const title = (typeof s.brand_name === 'string'
      ? s.brand_name.trim()
      : (workspaceName || brandName || sample.brand)) as string;

    // The welcome as /config resolves it (shared/widgetTextDefaults.ts): the
    // workspace's own, else the platform's or the built-in one.
    const welcome = isAuthoredWidgetText(s.welcome_message, 'welcome')
      ? String(s.welcome_message).trim()
      : (defaultWelcome || widgetTextDefault('welcome', locale));
    // The owner's composer text replaces the template's in the composer only
    // (runtime.js, after the chat frame is drawn).
    const placeholder = typeof s.placeholder_text === 'string' ? s.placeholder_text.trim() : '';
    const offlineMsg = previewOfflineMessage(s, locale);

    // Scale is stored as percent (80–140) or multiplier (0.8–1.4) — normalize
    // exactly like public/widget/loader.js does.
    const rawScale = Number(s.fab_scale);
    const fabScale = Math.min(
      1.4,
      Math.max(0.8, !isFinite(rawScale) || rawScale <= 0 ? 1 : rawScale > 3 ? rawScale / 100 : rawScale),
    );
    const fabSize = Math.round(baseSize * fabScale);
    // The launcher as /config sends it (shared/launcherStyles.ts: an unknown
    // icon is `chat`, a pill needs its text; `s` has the plan applied).
    const launcher = resolveLauncherStyle({ shape: s.fab_shape, icon: s.fab_icon, label: s.fab_label });
    // An icon of today's set other than `chat`, by its own keys only (as the
    // loader: "constructor" is no icon).
    const customIcon = typeof s.fab_icon === 'string' && s.fab_icon !== 'chat' && Object.prototype.hasOwnProperty.call(FAB_ICONS, s.fab_icon);
    // The local kit's button (shared/localKitLauncher.ts): its gradient unless
    // the workspace chose its own colour; its bubble unless it chose an icon.
    const kitBrand = SHIPS_IRAN_KIT && localKit && !ownColor;
    const kitBubble = SHIPS_IRAN_KIT && localKit && !customIcon;
    // RESPOK's button (shared/respokLauncher.ts): Ink + Signal unless the
    // workspace chose its own colour; the kit's pills unless it chose an icon.
    const rpkBrand = respokKit && !ownColor;
    const rpkPills = respokKit && !customIcon;
    // The kit's square has the brand's 18px corners (LOCAL_KIT_LAUNCHER_CSS), every other 16px.
    const fabRadius = launcher.shape === 'square' ? (SHIPS_IRAN_KIT && localKit ? '18px' : '16px') : '50%';
    const fabIconColor = s.fab_icon_color || '#fff';
    const fabIcon = customIcon ? FAB_ICONS[s.fab_icon as string] : FAB_ICONS.chat;
    // A launcher style (the pill, the bubble, two bubbles, the agent's face):
    // the loader's classes and texts on the same markup, its look from
    // runtime-fab.css (asked for in the frame, through the manifest); the
    // agent's face is a person's silhouette there, never a letter. The team
    // named as /config names it, in the frame's language
    // (shared/widgetTeam.ts).
    const team = (teamMembers || []).map(({ name, fullName, avatar, online }) => ({
      name: fullName !== undefined ? widgetTeamName(fullName, locale) : name,
      avatar,
      online,
    }));
    const fabStyled = launcher.styled;
    const fabStyleAttrs = fabStyled
      ? ` data-fx="${esc(s.fab_label || '')}" dir="${/^fa/.test(locale) ? 'rtl' : 'ltr'}" style="visibility:hidden"`
      : '';
    const fabStyleClass = fabStyled ? ` fx fx-${launcher.icon} fx-${launcher.shape}${away ? ' fx-off' : ''}` : '';
    const rawFabImage = typeof s.fab_image_url === 'string' ? s.fab_image_url.trim() : '';
    const fabImage = /^https?:\/\//i.test(rawFabImage) ? rawFabImage : '';
    const logo = s.show_logo !== false && s.logo_url ? String(s.logo_url) : '';

    // Strict AND: either column being explicitly false hides the KB surface,
    // exactly like the production bootstrap (`features.knowledgeBase`).
    const kbEnabled = s.kb_enabled !== false && s.knowledge_base_enabled !== false;
    // The launcher's attention pulse: on unless switched off (/config sends
    // `fab.animation: fab_animation ?? true`).
    const animated = s.fab_animation !== false;
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
      platformName: poweredBy?.brand || platformName || brandName || sample.brand,
      // Platform-owned footer payload — mirrors the production bootstrap so the
      // preview reflects super-admin wording/link and plan visibility exactly.
      ...(poweredBy !== undefined
        ? {
            // The International template credits the platform with its logo,
            // as the widget bootstrap does (server/routes/widget.ts).
            // The Iranian edition (known, never assumed) credits its platform
            // with the local kit's Persian logotype the same way. A logo the
            // Super Admin uploaded comes first, in both editions.
            poweredBy: uploadedLogo && poweredBy && (isInternational || localKit)
              ? { ...poweredBy, logo: /^https?:\/\//i.test(uploadedLogo) ? uploadedLogo : `${window.location.origin}${uploadedLogo}` }
              : isInternational && poweredBy
              ? { ...poweredBy, logo: `${window.location.origin}${(logoOpen ? INTL_BRAND.horizontalOpen : INTL_BRAND.horizontal).light}` }
              : SHIPS_IRAN_KIT && localKit && poweredBy
                ? { ...poweredBy, logo: `${window.location.origin}${WEBYAR_BRAND.logo.light}` }
                : poweredBy,
            showPoweredBy: poweredBy !== null,
          }
        : {}),
      replyTimeText: typeof s.reply_time_text === 'string' ? s.reply_time_text.trim() : null,
      welcomeMessage: welcome,
      placeholderText: placeholder,
      // What /config says about now (availability.ts): the state, the
      // offline behaviour and the owner's offline message in this language.
      availability: { state: away ? 'offline' : 'online', offline_mode: offlineMode, offline_message: offlineMsg },
      // The AI agent's greeting replaces the welcome in every template.
      ...(aiGreets ? { aiAgent: { suppressGreeting: true } } : {}),
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
    const previewTab = shown === 'home' ? 'home' : shown === 'kb' ? 'help' : shown === 'list' ? 'list' : 'chat';
    const nowIso = new Date().toISOString();
    const earlierIso = new Date(Date.now() - 90 * 1000).toISOString();

    const payload = {
      locale,
      rtl,
      primary,
      // The colour the renderer is given, as /config sends it.
      primaryColor: wireColor,
      view: shown,
      /** Template id — resolved through the registry inside the frame. */
      templateId: previewTemplateId,
      smart: { enabled: smartDoc, mode: smartSurface?.mode || smartScenario?.rule.presentation_config?.mode || 'launcher_nudge' },
      smartSurface,
      config: previewConfig,
      /** The widget's own words come from its dictionary, loaded in the frame (runtime.js). */
      placeholder,
      /** The offline view: what a new visitor gets while the team is away. */
      offline: { mode: offlineMode, message: offlineMsg, hidden, note: hiddenNote || '' },

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
        isOnline: !away,
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
        /* One conversation per visitor, as Core hands it over (runtime.js
           renderHome): a returning visitor whose conversations have ended,
           so home starts one (or leaves a message: who is online now, the
           team's faces) and links to the history. A live one would be the
           current conversation in place of that button. */
        conversations: [],
        pastCount: 2,
        pastUnread: 0,
      },
      /* The history («Previous conversations»): two finished samples, the
         team's last word and the visitor's; its back goes home. */
      listVm: {
        rtl,
        loading: false,
        error: false,
        chatEnabled,
        back: 'home',
        conversations: [
          {
            id: 'preview-1', status: 'closed', preview: sample.operator, unreadCount: 0, timeLabel: sample.recent,
            lastFromVisitor: false, operatorName: operatorName || title, operatorAvatar: operatorAvatar || '', operatorOnline: false,
          },
          {
            id: 'preview-2', status: 'closed', preview: sample.visitor, unreadCount: 0, timeLabel: sample.earlier,
            lastFromVisitor: true, operatorName: operatorName || title, operatorAvatar: operatorAvatar || '', operatorOnline: false,
          },
        ],
      },
      // The capabilities Core passes to a renderer (production: runtime.js).
      capabilities: { kbNeutral: true, csat: true, reactions: true, orderCard: true, prechatSteps: true, instantAnswers: true, chatMenu: true, awayThread: true, queuePosition: true, emojiSearch: true, dlProgress: true, kbAuthor: true },
      // Who answers the sample conversation (the chat bar Core paints for it).
      chatOperator: { name: operatorName || title, avatar: operatorAvatar || '', online: !away },
      // The pre-chat one question at a time (a renderer declaring prechatSteps,
      // template option prechatMode 'steps'): its sample answers and the
      // edition's phone prefix, as runtime-late.js uses it.
      steps: {
        name: sample.name,
        phonePrefix: isInternational ? '' : '+98',
      },
      // The message left while the team is away (a renderer declaring
      // awayThread), when the workspace's offline behaviour takes one.
      awaySample: offlineMode === 'capture_message'
        ? { sender: 'visitor', senderType: 'visitor', body: sample.visitor, time: nowIso, status: 'sent' } : null,
      // A conversation that already exists: answered, read by the operator.
      messages: [
        {
          sender: 'operator', senderType: 'operator', body: sample.operator, time: earlierIso,
          senderName: operatorName || title, senderAvatar: operatorAvatar || '',
        },
        { sender: 'visitor', senderType: 'visitor', body: sample.visitor, time: nowIso, status: 'seen' },
      ],
      /* A history row opened (one conversation per visitor, a renderer
         drawing the past bar): the same exchange, then its close, read-only. */
      pastMessages: [
        {
          sender: 'operator', senderType: 'operator', body: sample.operator, time: earlierIso,
          senderName: operatorName || title, senderAvatar: operatorAvatar || '',
        },
        { sender: 'visitor', senderType: 'visitor', body: sample.visitor, time: nowIso, status: 'seen' },
        {
          id: 'preview-closed', sender: 'operator', senderType: 'system', body: '', time: nowIso,
          metadata: { kind: 'conversation_closed', agent_name: operatorName || title },
        },
      ],
      // The form as the server asks it: policy, plan, then the row (no row:
      // the policy's defaults, name and email required).
      prechat: previewPrechatForm(prechat, prechatPolicy, { planAllowsForm: prechatFormAllowed }),
      kbVm,
      kbArticleVms,

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
  /* The attention pulse, as loader.js plays it: twice, then still. */
  .launcher.pulse:not(.open):not(.enter){animation:gs-fab-pulse 2.4s ease-in-out 2;}
  @keyframes gs-fab-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.07);}}
  /* The note said where the widget would be (offline, "Hide the widget"). */
  .gs-hidden-note{position:fixed;inset:auto 24px 24px 24px;padding:14px 16px;border-radius:14px;border:1px dashed #94A3B8;background:rgba(255,255,255,.86);color:#334155;font-size:13px;line-height:1.6;text-align:center;}
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
  ${hidden ? `<p class="gs-hidden-note" dir="${dir}">${esc(hiddenNote || '')}</p>` : ''}
  <div class="shell pos-${pos}${respokKit ? (lgOpen ? ' lg-open' : ' lg-thread') : ''}${animated ? ' anim-on' : ''}"${hidden ? ' hidden' : ''}>
    <div class="panel ${pos} visible${rtl ? ' panel-rtl' : ''}${animated ? ' anim-on' : ''}" dir="${dir}"></div>
    <button type="button" class="launcher ${pos}${animated ? ' pulse' : ''}${fabImage ? ' has-image' : ''}${SHIPS_IRAN_KIT && localKit ? ` lk-kit${kitBrand ? ' lk-kit-brand' : ''}${kitBrand && away ? ' lk-kit-offline' : ''}` : ''}${respokKit ? ` rpk-kit${rpkBrand ? ' rpk-kit-brand' : ''}${away ? ' rpk-kit-away' : ''}` : ''}${fabStyleClass}" id="gs-launcher" aria-label="chat"${fabStyleAttrs}>
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
      // The widget's own dictionary (runtime.js, __gs_runtime.t): the frame
      // speaks with the words visitors read, never a copy of them.
      var wordsReady = !!(window.__gs_runtime && window.__gs_runtime.t);
      var mod = null;
      function prepareAndRender() {
        if (!styleReady || !skinReady || !scriptReady || !extrasReady || !wordsReady || !mod || !mod.create) return;
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

      if (!wordsReady) {
        var rt = document.createElement('script');
        rt.src = '/widget/' + ((manifest && manifest['runtime.js']) || 'runtime.js');
        rt.onload = rt.onerror = function () { wordsReady = true; prepareAndRender(); };
        document.body.appendChild(rt);
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
    // The widget's own words (public/widget/runtime.js I18n), as Core hands
    // them to a renderer; without the dictionary (it did not load) nothing,
    // never a raw key.
    var words = window.__gs_runtime && typeof window.__gs_runtime.t === 'function' ? window.__gs_runtime.t : null;
    function t(key) {
      return words ? words(GS_PREVIEW.locale, key) : '';
    }
    // A word this Core may not have yet: another of its words instead.
    function tOr(key, fallbackKey) {
      var v = t(key);
      return v && v !== key ? v : t(fallbackKey);
    }

    var R = mod.create({
      t: t,
      escapeHtml: escapeHtml,
      linkLabel: t('msgOpenLink'),
      config: GS_PREVIEW.config,
      locale: GS_PREVIEW.locale,
      primaryColor: GS_PREVIEW.primaryColor,
      capabilities: GS_PREVIEW.capabilities,
    });
    // Its extras before anything is painted (the renderer refuses a file
    // that is not its own); without them it draws what it draws without.
    if (typeof R.extend === 'function' && window.__gs_mod_extras) R.extend(window.__gs_mod_extras);

    // The renderer's declared features, read as Core reads them (feat() in
    // runtime-ext.js), and the view-model fields Core adds for them: the unread total
    // of a bottom menu (tabs), the search field (kbSearch) and the visitor's
    // first name (visitorName; the preview has no contact, so empty, as Core
    // without one). The default template declares none, so it gets none of
    // these fields. What changed for every
    // template, 'default' included, is the navigation: the history view
    // (list) and the frame following the renderer's own [data-view],
    // [data-view-back] and [data-conversation-open] hooks (gsBindTabs), as
    // the live widget does.
    function feat(name) { return !!(R.features && R.features[name]); }
    var unreadTotal = 0;
    // The current conversation's and the history's (runtime-ext.js unreadTotal).
    (GS_PREVIEW.homeVm.conversations || []).concat(GS_PREVIEW.listVm.conversations || []).forEach(function (c) { unreadTotal += Number(c.unreadCount) || 0; });
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
        if (stepsHead && feat('chatHeader')) stepsHead.innerHTML = R.chatHeaderHtml({ online: GS_PREVIEW.chatOperator.online, typing: false, isNew: false, operator: null });
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
    } else if (view === 'offline') {
      /* A new visitor while the team is away, by the workspace's offline
         behaviour, as Core paints it (runtime.js deriveChatTabState):
         "Show only the offline message": that message alone, as the empty
         thread's welcome, no form, no composer; "Capture a message": the
         message left in the thread (a renderer declaring awayThread, the
         reply saying it comes here: visitor email is off) or the
         leave-a-message form, the owner's offline message as its intro;
         "Hide the widget": nothing (the note above says so). */
      var off = GS_PREVIEW.offline;
      if (off.mode === 'show_offline_message' || off.mode === 'capture_message') {
        if (off.mode === 'capture_message' && !feat('awayThread')) {
          var form = GS_PREVIEW.prechat;
          body.innerHTML = R.contactFallbackHtml({
            isAsked: function (k) { return !!form.asked[k]; },
            isRequired: function (k) { return !!form.required[k]; },
          }, {}, GS_PREVIEW.locale, {
            status: 'offline', offlineMode: off.mode, liveChatEnabled: true,
            introLabel: off.message || undefined,
          });
        } else {
          body.innerHTML = R.chatFrameHtml(GS_PREVIEW.shellVm);
          var offHost = body.querySelector('[data-chat-messages]');
          var offBar = body.querySelector('[data-input-bar]');
          if (off.mode === 'show_offline_message') {
            if (offBar) offBar.style.display = 'none';
            var ownWelcome = GS_PREVIEW.config.welcomeMessage;
            GS_PREVIEW.config.welcomeMessage = off.message || tOr('offlineNotice', 'availOffline');
            try { if (offHost) offHost.innerHTML = R.emptyHtml({}); } finally { GS_PREVIEW.config.welcomeMessage = ownWelcome; }
          } else if (offHost) {
            offHost.innerHTML = R.messagesHtml({ messages: [GS_PREVIEW.awaySample] }, '', {
              awayReply: GS_PREVIEW.config.visitorEmail === true
                ? { at: 0, status: 'ask', value: '', error: '', skip: true }
                : { at: 0, email: '', value: '', error: '', skip: true, status: 'skipped' },
            });
          }
          var offHead = body.querySelector('[data-chat-header]');
          if (offHead && feat('chatHeader') && typeof R.chatHeaderHtml === 'function') {
            offHead.innerHTML = R.chatHeaderHtml({ online: false, typing: false, isNew: true, operator: null });
          }
        }
      }
    } else {
      /* Single-view architecture: chat is a full view (header + messages +
         composer + footer) exactly like production mounts it: a
         conversation that already exists. */
      body.innerHTML = R.chatFrameHtml(GS_PREVIEW.shellVm);
      var msgHost = body.querySelector('[data-chat-messages]');
      if (msgHost) msgHost.innerHTML = R.messagesHtml({ messages: GS_PREVIEW.messages }, '', {});
      /* The chat bar as Core paints it for an existing conversation (feature
         chatHeader: who answers), with its closed menu button (feature
         chatMenu: the notification sounds item, drawn by the extras). */
      var chatHead = body.querySelector('[data-chat-header]');
      if (chatHead && feat('chatHeader') && typeof R.chatHeaderHtml === 'function') {
        chatHead.innerHTML = R.chatHeaderHtml({
          online: GS_PREVIEW.chatOperator.online, typing: false, isNew: false,
          operator: GS_PREVIEW.chatOperator,
          menu: feat('chatMenu') ? { open: false, items: [{ action: 'sound', on: true }] } : null,
        });
      }
      /* Typing state is sr-only in the design — no visible typing row. */
    }

    // The owner's composer text replaces the template's, in the composer
    // only (runtime.js does it once the chat frame is drawn).
    var composer = panel.querySelector('[data-msg-input]');
    if (composer && GS_PREVIEW.placeholder) {
      composer.setAttribute('placeholder', GS_PREVIEW.placeholder);
      if (composer.hasAttribute('aria-label')) composer.setAttribute('aria-label', GS_PREVIEW.placeholder);
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
    gsBindPast(R);
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

  // Preview-only: one conversation per visitor (a renderer drawing
  // pastBarHtml). A history row opens in the frame as Core opens a closed
  // one: its thread and its close, read-only, the renderer's past bar in the
  // composer's place (nothing current here: it starts one, or leaves a
  // message while away); back returns to the history, the bar's button to
  // the chat. In the capture phase, so gsBindTabs never takes these clicks.
  function gsBindPast(R) {
    var panel = document.querySelector('.panel');
    var body = panel && panel.querySelector('[data-body]');
    if (GS_SMART.enabled || GS_PREVIEW.view !== 'list' || typeof R.pastBarHtml !== 'function' || !body) return;
    var listMarkup = body.innerHTML;
    var open = false;
    function feat(name) { return !!(R.features && R.features[name]); }
    function openPast() {
      body.innerHTML = R.chatFrameHtml(GS_PREVIEW.shellVm);
      panel.setAttribute('data-view', 'chat');
      var host = body.querySelector('[data-chat-messages]');
      if (host) host.innerHTML = R.messagesHtml({ messages: GS_PREVIEW.pastMessages }, '', {});
      // The bar as Core paints it for a past thread (runtime-ext.js): back
      // to the history, its day, no presence.
      var head = body.querySelector('[data-chat-header]');
      if (head && feat('chatHeader') && typeof R.chatHeaderHtml === 'function') {
        var op = GS_PREVIEW.chatOperator;
        head.innerHTML = R.chatHeaderHtml({
          online: true, typing: false, isNew: false, operator: { name: op.name, avatar: op.avatar, online: null },
          back: 'list', past: true, when: GS_PREVIEW.listVm.conversations[0].timeLabel,
          pastCount: GS_PREVIEW.homeVm.pastCount, pastUnread: GS_PREVIEW.homeVm.pastUnread, menu: null,
        });
      }
      var bar = body.querySelector('[data-input-bar]');
      if (bar) {
        bar.style.display = 'none';
        bar.insertAdjacentHTML('beforebegin', R.pastBarHtml({ current: false, online: GS_PREVIEW.homeVm.isOnline }));
      }
      open = true;
    }
    document.addEventListener('click', function (e) {
      var target = e.target && e.target.closest ? e.target : null;
      if (!target) return;
      if (!open && target.closest('[data-conversation-open]')) {
        openPast();
      } else if (open && target.closest('[data-view-back]')) {
        body.innerHTML = listMarkup;
        panel.setAttribute('data-view', 'list');
        open = false;
      } else if (open && target.closest('[data-chat-current]')) {
        parent.postMessage({ source: 'gs-widget-preview', nav: 'chat' }, '*');
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

</script>
</body>
</html>`;
    // `phase` intentionally stays out of the dependency list: it is pushed in
    // via postMessage so the frame animates instead of being re-created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings, prechat, prechatPolicy, prechatFormAllowed, workspaceName, platformName, poweredBy, brandName, teamMembers, view, kbArticles, kbCategories, operatorAvatar, operatorName,
    templateId, templateOptions,
    previewMode, smartScenario?.rule, smartScenario?.content, smartScenario?.locale,
    smartScenario?.rtl, stageBackground, stageBar, isInternational, localKit, respokKit, uploadedLogo,
    availabilityState, aiGreets, defaultWelcome, hiddenNote,
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
