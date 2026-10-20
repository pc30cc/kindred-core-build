/**
 * Widget templates per edition (shared/edition.ts) — the chat widget and the
 * call widget, server and client alike.
 *
 * Each edition has its own templates and its own default, so the two
 * products never share a look:
 *
 *   - `iran`          — `default`: the Iran region's shipped design, exactly as it
 *                       always was (same assets, same bytes); `t1` and `t2`
 *                       offered next to it.
 *   - `international` — `intl`: the RESPOK look. Today it is a skin over the
 *                       shared renderer (the same script and base stylesheet,
 *                       plus its own stylesheet with the RESPOK palette); it
 *                       can become a renderer of its own by pointing `script`
 *                       at a new file, with no other change. `t1-intl` and
 *                       `t2-intl` are offered next to it: skins the same way,
 *                       over t1's and t2's renderers (their stylesheet and
 *                       extras too), so they behave exactly as t1 and t2.
 *
 * A template is a descriptor of asset FILE NAMES (public/widget/ for the chat
 * widget, public/call-widget/ for the call widget). The browser registries
 * (public/widget/presentation-registry.js, public/call-widget/presentation-
 * registry.js) list the same ids. Adding a template: add a descriptor here,
 * add it to the edition's `offered` list (and, to make it the edition's
 * default, `default`), add the same entry to the browser registry and ship its
 * asset files (docs/operations/EDITIONS.md).
 *
 * `offered` is what the edition's build ships. Which of those a workspace
 * wears is the Super Admin's catalog (shared/chatTemplateCatalog.ts,
 * migration 275): a template never enabled there is not worn, so adding one
 * to `offered` changes nothing for visitors. Anything not offered — no id, an
 * unknown id, the other edition's id — is the edition's default. An unknown
 * edition (null) is the Iranian one, so nothing changes before the edition is
 * known.
 *
 * Pure: no I/O.
 */
import type { Edition } from './edition.js';
import { SHIPS_IRAN_KIT } from './buildBrand.js';

// ─── Chat widget ───────────────────────────────────────────────────────────

export interface ChatWidgetTemplate {
  id: string;
  /** The renderer script; it registers itself on window under the registry's globalKey. */
  script: `presentation-${string}.js`;
  /** The template's base stylesheet. */
  style: `presentation-${string}.css`;
  /** A stylesheet loaded after `style` (a skin over a shared renderer), or null. */
  skin: `presentation-${string}.css` | null;
  /** The template's font stylesheet, or null. */
  fonts: `presentation-${string}.css` | null;
  /**
   * Its renderer declares Core features (`features` from create()), whose
   * code is Core's lazy module runtime-ext.js: the bootstrap names that
   * module (`config.modules.ext`) for this template only, and the loader
   * fetches it with the template's files. Must match the renderer
   * (src/test/widget/runtimeExt.test.ts).
   */
  coreFeatures: boolean;
  /**
   * The renderer's extras: its markup no first paint needs (`presentation-
   * <renderer>-x.js`, a skin names its renderer's file), which runtime-ext.js
   * requests after the first paint together with Core's late module
   * (runtime-late.js). The bootstrap names both (`config.modules.extras`,
   * `config.modules.late`) only for a template with `coreFeatures` and
   * extras, so `default` and `intl` (null) are unchanged. Must match the
   * registry and the renderer's `extend` (src/test/widget/runtimeExt.test.ts).
   */
  extras: `presentation-${string}-x.js` | null;
  /**
   * Its renderer draws the `conversation_closed` line («X closed the
   * conversation») and, through its extras, the rating card under it. The
   * server writes that visitor-visible row when an operator closes a widget
   * conversation only for a workspace whose effective template has this
   * (server/services/conversationClosedNotice.ts), so a `default` / `intl`
   * workspace gets no new row at all. Must match the renderer's
   * `features.closedNotice` (src/test/widget/runtimeExt.test.ts).
   */
  closedNotice: boolean;
  /**
   * Its renderer draws message reactions: the badge under a bubble and the
   * visitor's heart (shared/messageReactions.ts). The inbox offers operators
   * React on a visitor's message only for a workspace whose effective
   * template has this (server/services/messageReactions.ts
   * workspaceShowsReactions), so a reaction is never given where the visitor
   * cannot see it. Must match the renderer's `features.reactions`.
   */
  reactions: boolean;
}

export const CHAT_WIDGET_TEMPLATES = {
  default: {
    id: 'default',
    script: 'presentation-default.js',
    style: 'presentation-default.css',
    skin: null,
    fonts: 'presentation-default-fonts.css',
    coreFeatures: false,
    extras: null,
    closedNotice: false,
    reactions: false,
  },
  intl: {
    id: 'intl',
    script: 'presentation-default.js',
    style: 'presentation-default.css',
    skin: 'presentation-intl.css',
    fonts: 'presentation-default-fonts.css',
    coreFeatures: false,
    extras: null,
    closedNotice: false,
    reactions: false,
  },
  t1: {
    id: 't1',
    script: 'presentation-t1.js',
    style: 'presentation-t1.css',
    skin: null,
    fonts: 'presentation-default-fonts.css',
    coreFeatures: true,
    extras: 'presentation-t1-x.js',
    closedNotice: false,
    reactions: false,
  },
  t2: {
    id: 't2',
    script: 'presentation-t2.js',
    style: 'presentation-t2.css',
    skin: null,
    fonts: 'presentation-default-fonts.css',
    coreFeatures: true,
    extras: 'presentation-t2-x.js',
    closedNotice: true,
    reactions: true,
  },
  // The International edition's skins over t1 and t2: the renderer, its
  // stylesheet and extras are t1's / t2's, the skin carries the RESPOK
  // palette, type and brand art. The flags follow the renderer.
  't1-intl': {
    id: 't1-intl',
    script: 'presentation-t1.js',
    style: 'presentation-t1.css',
    skin: 'presentation-t1-intl.css',
    fonts: 'presentation-default-fonts.css',
    coreFeatures: true,
    extras: 'presentation-t1-x.js',
    closedNotice: false,
    reactions: false,
  },
  't2-intl': {
    id: 't2-intl',
    script: 'presentation-t2.js',
    style: 'presentation-t2.css',
    skin: 'presentation-t2-intl.css',
    fonts: 'presentation-default-fonts.css',
    coreFeatures: true,
    extras: 'presentation-t2-x.js',
    closedNotice: true,
    reactions: true,
  },
} as const satisfies Record<string, ChatWidgetTemplate>;

export type ChatWidgetTemplateId = keyof typeof CHAT_WIDGET_TEMPLATES;

export interface EditionTemplates<Id extends string> {
  /** The template the edition wears when nothing else is chosen. */
  default: Id;
  /** Every template the edition may wear (the default first). */
  offered: readonly Id[];
}

export const EDITION_CHAT_WIDGET_TEMPLATES: Readonly<Record<Edition, EditionTemplates<ChatWidgetTemplateId>>> = {
  iran: { default: 'default', offered: ['default', 't1', 't2'] },
  international: { default: 'intl', offered: ['intl', 't1-intl', 't2-intl'] },
};

/**
 * Ids a template used to be called (persisted in old rows and embeds). Only
 * the Iran region's rows carry one; the RESPOK build leaves the alias out
 * (SHIPS_IRAN_KIT is a build-time literal there), and the International
 * edition resolves any id it does not offer to `intl` regardless.
 */
const LEGACY_CHAT_TEMPLATE_IDS: Readonly<Record<string, ChatWidgetTemplateId>> = SHIPS_IRAN_KIT ? { 'web-yar': 'default' } : {};

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The requested chat widget template when the edition offers it (a legacy id
 * is first mapped to its current name), else the edition's default. `edition`
 * null (unknown) is Iran. It does not know the Super Admin's catalog: what a
 * workspace wears is resolveWorkspaceChatTemplate (shared/chatTemplateCatalog.ts).
 */
export function resolveChatWidgetTemplate(edition: Edition | null | undefined, requested?: unknown): ChatWidgetTemplateId {
  const spec = EDITION_CHAT_WIDGET_TEMPLATES[edition ?? 'iran'];
  const raw = normalizeId(requested);
  const id = LEGACY_CHAT_TEMPLATE_IDS[raw] ?? raw;
  return (spec.offered as readonly string[]).includes(id) ? (id as ChatWidgetTemplateId) : spec.default;
}

/** A known chat widget template's descriptor, or null. */
export function chatWidgetTemplate(id: unknown): ChatWidgetTemplate | null {
  const raw = normalizeId(id);
  const key = LEGACY_CHAT_TEMPLATE_IDS[raw] ?? raw;
  return Object.prototype.hasOwnProperty.call(CHAT_WIDGET_TEMPLATES, key)
    ? CHAT_WIDGET_TEMPLATES[key as ChatWidgetTemplateId]
    : null;
}

// ─── Call widget ───────────────────────────────────────────────────────────

export interface CallWidgetTemplate {
  id: string;
  /** The presentation script; it registers the template id(s) with CallWidgetPresentations. */
  script: `presentation-${string}.js`;
  /** The template's skin (loaded on its own, next to runtime.css): tokens, fonts and brand rules. */
  style: `presentation-${string}.css`;
  /**
   * The panel module and its stylesheet: everything the open panel draws.
   * Not page-load files: the presentation asks for them on the visitor's
   * first intent (l.js `loadPanel`, a stylesheet link in the shadow root).
   */
  panel: { script: `presentation-${string}.js`; style: `presentation-${string}.css` };
}

const CALL_PANEL = { script: 'presentation-default-panel.js', style: 'presentation-default-panel.css' } as const;

export const CALL_WIDGET_TEMPLATES = {
  default: { id: 'default', script: 'presentation-default.js', style: 'presentation-default.css', panel: CALL_PANEL },
  intl: { id: 'intl', script: 'presentation-default.js', style: 'presentation-intl.css', panel: CALL_PANEL },
} as const satisfies Record<string, CallWidgetTemplate>;

export type CallWidgetTemplateId = keyof typeof CALL_WIDGET_TEMPLATES;

export const EDITION_CALL_WIDGET_TEMPLATES: Readonly<Record<Edition, EditionTemplates<CallWidgetTemplateId>>> = {
  iran: { default: 'default', offered: ['default'] },
  international: { default: 'intl', offered: ['intl'] },
};

/**
 * The call widget template to wear: the stored id when the edition offers it,
 * else the edition's default (`call_center_settings.widget_template_id`
 * defaults to `'default'`, which only the Iranian edition offers).
 */
export function resolveCallWidgetTemplateForEdition(edition: Edition | null | undefined, requested?: unknown): CallWidgetTemplateId {
  const spec = EDITION_CALL_WIDGET_TEMPLATES[edition ?? 'iran'];
  const id = normalizeId(requested);
  return (spec.offered as readonly string[]).includes(id) ? (id as CallWidgetTemplateId) : spec.default;
}

// ─── Dates in widgets ──────────────────────────────────────────────────────

/**
 * The calendar and time zone hints a widget bootstrap carries, so the widget
 * never guesses them from the language:
 *   - `calendar`: the calendar Persian (fa) dates use. Other languages are
 *     Gregorian in every edition.
 *   - `timeZone`: the zone Persian day boundaries and dates are drawn in;
 *     null = the visitor's own zone.
 * Iran: Jalali in Tehran time, exactly as before. International: Gregorian
 * (Persian digits stay) in the visitor's zone.
 */
export interface WidgetDateHints {
  calendar: 'jalali' | 'gregorian';
  timeZone: 'Asia/Tehran' | null;
}

export function widgetDateHints(edition: Edition | null | undefined): WidgetDateHints {
  return (edition ?? 'iran') === 'iran'
    ? { calendar: 'jalali', timeZone: 'Asia/Tehran' }
    : { calendar: 'gregorian', timeZone: null };
}
