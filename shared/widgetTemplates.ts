/**
 * Widget templates per edition (shared/edition.ts) — the chat widget and the
 * call widget, server and client alike.
 *
 * Each edition has its own templates and its own default, so the two
 * products never share a look:
 *
 *   - `iran`          — `default`: the shipped WebYar design, exactly as it
 *                       always was (same assets, same bytes).
 *   - `international` — `intl`: the RESPOK look. Today it is a skin over the
 *                       shared renderer (the same script and base stylesheet,
 *                       plus its own stylesheet with the RESPOK palette); it
 *                       can become a renderer of its own by pointing `script`
 *                       at a new file, with no other change.
 *
 * A template is a descriptor of asset FILE NAMES (public/widget/ for the chat
 * widget, public/call-widget/ for the call widget). The browser registries
 * (public/widget/presentation-registry.js, public/call-widget/presentation-
 * registry.js) list the same ids. Adding a template: add a descriptor here,
 * add it to the edition's `offered` list (and, to make it the edition's
 * default, `default`), add the same entry to the browser registry and ship its
 * asset files (docs/operations/EDITIONS.md).
 *
 * A stored template id (a settings row; one day an admin's choice) is honoured
 * only when the edition offers it; anything else — no id, an unknown id, the
 * other edition's id — is the edition's default. An unknown edition (null) is
 * the Iranian one, so nothing changes before the edition is known.
 *
 * Pure: no I/O.
 */
import type { Edition } from './edition.js';

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
}

export const CHAT_WIDGET_TEMPLATES = {
  default: {
    id: 'default',
    script: 'presentation-default.js',
    style: 'presentation-default.css',
    skin: null,
    fonts: 'presentation-default-fonts.css',
  },
  intl: {
    id: 'intl',
    script: 'presentation-default.js',
    style: 'presentation-default.css',
    skin: 'presentation-intl.css',
    fonts: 'presentation-default-fonts.css',
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
  iran: { default: 'default', offered: ['default'] },
  international: { default: 'intl', offered: ['intl'] },
};

/** Ids a template used to be called (persisted in old rows and embeds). */
const LEGACY_CHAT_TEMPLATE_IDS: Readonly<Record<string, ChatWidgetTemplateId>> = { 'web-yar': 'default' };

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The chat widget template to wear: the requested id when the edition offers
 * it (a legacy id is first mapped to its current name), else the edition's
 * default. `edition` null (unknown) is Iran.
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
  /** The template's complete stylesheet (loaded on its own, next to runtime.css). */
  style: `presentation-${string}.css`;
}

export const CALL_WIDGET_TEMPLATES = {
  default: { id: 'default', script: 'presentation-default.js', style: 'presentation-default.css' },
  intl: { id: 'intl', script: 'presentation-default.js', style: 'presentation-intl.css' },
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
