/**
 * The chat widget template catalog: which templates a workspace may wear,
 * what the dashboard calls them, and their options. Server and client alike.
 *
 * shared/widgetTemplates.ts says which templates exist and which an edition
 * ships (`offered`). On top of that the Super Admin keeps a catalog per edition
 * (widget_edition_settings.chat_templates, migration 275):
 *
 *   {"default": "<id>",
 *    "items": {"<id>": {"enabled": true, "order": 1,
 *                       "name": {"fa": "…", "en": "…", "tr": "…"},
 *                       "options": {"navStyle": "vb", …}}}}
 *
 * Rules (resolveChatTemplateCatalog):
 *   - Only the ids the edition offers count; anything else in the JSON is
 *     ignored.
 *   - A template never saved is disabled, except the edition's default
 *     (`default` / `intl`): an edition with no row, and a deploy that adds a
 *     template, change nothing for any visitor.
 *   - The catalog's default is an enabled template: a stored default that is
 *     not (or none) gives way to the edition's default, forced on, so at
 *     least one template is always enabled.
 *   - Names are for the dashboard only: never in an id, a file, a class or the
 *     widget config. A language without a name falls back to the dashboard's
 *     i18n default (`widgetCatalog.names.<id>`).
 *
 * A workspace (widget_settings.widget_template_id) wears its choice while the
 * Super Admin keeps it enabled and its plan allows widget_appearance, else the
 * catalog's default (resolveWorkspaceChatTemplate). A disabled choice is kept
 * and comes back once re-enabled. The picker is offered only with two or more
 * templates enabled.
 *
 * Template options are merged code defaults → the Super Admin's option
 * defaults (catalog item `options`) → the workspace's own
 * (widget_settings.widget_template_options), keeping only the keys the
 * template reads and only valid values (resolveChatTemplateOptions). The
 * result reaches the widget as `config.templateOptions`. The server reads it
 * too, for the features it serves on a template's behalf (the rating after a
 * chat, the transcript by email): server/services/widget/configSnapshot.ts
 * `workspaceChatTemplate`.
 *
 * Pure: no I/O.
 */
import type { Edition } from './edition.js';
import { EDITION_CHAT_WIDGET_TEMPLATES, chatWidgetTemplate, type ChatWidgetTemplateId } from './widgetTemplates.js';

// ─── Names ─────────────────────────────────────────────────────────────────

/** The dashboard languages a template may be named in. */
export const CHAT_TEMPLATE_LOCALES = ['fa', 'en', 'tr'] as const;
export type ChatTemplateLocale = (typeof CHAT_TEMPLATE_LOCALES)[number];

/** A display name's longest length, in characters. */
export const CHAT_TEMPLATE_NAME_MAX = 40;

export type ChatTemplateNames = Partial<Record<ChatTemplateLocale, string>>;

/**
 * Typed text made safe to show: control characters and the bidi embeddings,
 * overrides and isolates (U+202A-202E, U+2066-2069) become spaces, runs of
 * white space one space, the ends trimmed. The zero-width non-joiner Persian
 * needs is kept.
 */
export function cleanTemplateText(value: unknown): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    const strip = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
    out += strip ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Length in characters (code points), as a person counts them. */
export function textLength(value: string): number {
  return [...value].length;
}

// ─── Options ───────────────────────────────────────────────────────────────

/** Template 1's bottom menu style; the first is the default. */
export const CHAT_TEMPLATE_NAV_STYLES = ['vb', 'va', 'vc', 'vd'] as const;
/** Template 1's bottom menu labels; the first is the default (`none` = no menu). */
export const CHAT_TEMPLATE_NAV_MODES = ['active', 'both', 'icon', 'text', 'none'] as const;
/** The icons a topic chip may wear (the renderers draw exactly these). */
export const CHAT_TEMPLATE_TOPIC_ICONS = ['truck', 'return', 'ruler', 'card', 'box', 'chat', 'help', 'gift', 'clock', 'tag'] as const;
/**
 * Template 1's pre-chat form: one card with every field (the default), or one
 * question at a time. A conversation keeps the mode its form first rendered
 * in.
 */
export const CHAT_TEMPLATE_PRECHAT_MODES = ['card', 'steps'] as const;

export type ChatTemplateNavStyle = (typeof CHAT_TEMPLATE_NAV_STYLES)[number];
export type ChatTemplateNavMode = (typeof CHAT_TEMPLATE_NAV_MODES)[number];
export type ChatTemplateTopicIcon = (typeof CHAT_TEMPLATE_TOPIC_ICONS)[number];
export type ChatTemplatePrechatMode = (typeof CHAT_TEMPLATE_PRECHAT_MODES)[number];

export const CHAT_TEMPLATE_LIMITS = {
  /** Topic chips per template. */
  topics: 4,
  /** Characters in a topic's label. */
  topicLabel: 24,
  /** Example questions under Template 2's ask field. */
  askExamples: 2,
  /** Characters in an example question. */
  askExample: 60,
} as const;

export interface ChatTemplateTopic {
  label: string;
  icon: ChatTemplateTopicIcon;
}

export interface ChatTemplateOptions {
  navStyle?: ChatTemplateNavStyle;
  navMode?: ChatTemplateNavMode;
  topics?: ChatTemplateTopic[];
  askExamples?: string[];
  /**
   * Template 1's pre-chat form, `card` (default) or `steps`.
   */
  prechatMode?: ChatTemplatePrechatMode;
  /**
   * The rating card after an operator closes the conversation (Template 2;
   * default on). Off: the closed line only, and POST …/csat answers 403
   * `csat_disabled`.
   */
  csat?: boolean;
  /**
   * The visitor may have the conversation mailed to the address on their
   * contact (the rating card's link and the chat header's menu; default on).
   * Off: neither shows it, and POST …/transcript answers 403
   * `transcript_disabled`.
   */
  transcriptEmail?: boolean;
}

export type ChatTemplateOptionKey = keyof ChatTemplateOptions;

/** Which options each template reads, in the order its settings show them. */
export const CHAT_TEMPLATE_OPTIONS: Readonly<Record<ChatWidgetTemplateId, readonly ChatTemplateOptionKey[]>> = {
  default: [],
  intl: [],
  t1: ['navStyle', 'navMode', 'topics', 'prechatMode', 'transcriptEmail'],
  t2: ['topics', 'askExamples', 'csat', 'transcriptEmail'],
};

/** Every option any template reads. */
export const CHAT_TEMPLATE_OPTION_KEYS: readonly ChatTemplateOptionKey[] = [
  'navStyle', 'navMode', 'topics', 'askExamples', 'prechatMode', 'csat', 'transcriptEmail',
];

/** The options a template reads (none for an unknown id). */
export function chatTemplateOptionKeys(id: string): readonly ChatTemplateOptionKey[] {
  return Object.prototype.hasOwnProperty.call(CHAT_TEMPLATE_OPTIONS, id)
    ? CHAT_TEMPLATE_OPTIONS[id as ChatWidgetTemplateId]
    : [];
}

function optionDefault(key: ChatTemplateOptionKey): ChatTemplateOptions[ChatTemplateOptionKey] {
  switch (key) {
    case 'navStyle': return CHAT_TEMPLATE_NAV_STYLES[0];
    case 'navMode': return CHAT_TEMPLATE_NAV_MODES[0];
    case 'topics': return [];
    case 'askExamples': return [];
    case 'prechatMode': return CHAT_TEMPLATE_PRECHAT_MODES[0];
    case 'csat': return true;
    case 'transcriptEmail': return true;
  }
}

/** The code's defaults for a template's options (every key it reads). */
export function chatTemplateOptionDefaults(id: string): ChatTemplateOptions {
  const out: Record<string, unknown> = {};
  for (const key of chatTemplateOptionKeys(id)) out[key] = optionDefault(key);
  return out as ChatTemplateOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/**
 * A typed string far beyond `max` characters before cleaning (4x, in UTF-16
 * units: room for surrogate pairs and white space the cleaning collapses).
 * Refused before it is cleaned: walking a request's megabytes of text one
 * code point at a time would hold the shared backend's event loop for seconds.
 */
function rawTooLong(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > max * 4;
}

/**
 * One option value, cleaned: `{ ok: true, value }` or `{ ok: false }`.
 * A topic or an example question left empty is dropped (the editor sends the
 * row the owner is still typing); one too long, a list too long or an icon
 * outside the list is invalid.
 */
function checkOption(key: ChatTemplateOptionKey, value: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (key) {
    case 'navStyle':
      return oneOf(CHAT_TEMPLATE_NAV_STYLES, value) ? { ok: true, value } : { ok: false };
    case 'navMode':
      return oneOf(CHAT_TEMPLATE_NAV_MODES, value) ? { ok: true, value } : { ok: false };
    case 'prechatMode':
      return oneOf(CHAT_TEMPLATE_PRECHAT_MODES, value) ? { ok: true, value } : { ok: false };
    case 'csat':
    case 'transcriptEmail':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
    case 'topics': {
      if (!Array.isArray(value) || value.length > CHAT_TEMPLATE_LIMITS.topics) return { ok: false };
      const topics: ChatTemplateTopic[] = [];
      for (const item of value) {
        if (!isPlainObject(item) || rawTooLong(item.label, CHAT_TEMPLATE_LIMITS.topicLabel)) return { ok: false };
        const label = cleanTemplateText(item.label);
        if (!label) continue;
        if (textLength(label) > CHAT_TEMPLATE_LIMITS.topicLabel || !oneOf(CHAT_TEMPLATE_TOPIC_ICONS, item.icon)) {
          return { ok: false };
        }
        topics.push({ label, icon: item.icon });
      }
      return { ok: true, value: topics };
    }
    case 'askExamples': {
      if (!Array.isArray(value) || value.length > CHAT_TEMPLATE_LIMITS.askExamples) return { ok: false };
      const examples: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string' || rawTooLong(item, CHAT_TEMPLATE_LIMITS.askExample)) return { ok: false };
        const text = cleanTemplateText(item);
        if (!text) continue;
        if (textLength(text) > CHAT_TEMPLATE_LIMITS.askExample) return { ok: false };
        examples.push(text);
      }
      return { ok: true, value: examples };
    }
    default:
      return { ok: false };
  }
}

/**
 * Stored options, read leniently: only `keys`, only valid values (anything
 * else is left out, so the next level's value applies).
 */
export function readTemplateOptions(raw: unknown, keys: readonly ChatTemplateOptionKey[] = CHAT_TEMPLATE_OPTION_KEYS): ChatTemplateOptions {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(raw)) return out;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const checked = checkOption(key, raw[key]);
    if (checked.ok) out[key] = checked.value;
  }
  return out as ChatTemplateOptions;
}

/**
 * Options from a request (the Super Admin's save, a workspace's PATCH),
 * strictly: unknown keys are dropped, a known key with an invalid value is
 * refused (`invalid_template_options`, naming the key).
 */
export function cleanTemplateOptionsInput(
  input: unknown,
  keys: readonly ChatTemplateOptionKey[] = CHAT_TEMPLATE_OPTION_KEYS,
): { ok: true; value: ChatTemplateOptions } | { ok: false; problem: 'invalid_template_options'; key: string | null } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isPlainObject(input)) return { ok: false, problem: 'invalid_template_options', key: null };
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const checked = checkOption(key, input[key]);
    if (!checked.ok) return { ok: false, problem: 'invalid_template_options', key };
    out[key] = checked.value;
  }
  return { ok: true, value: out as ChatTemplateOptions };
}

// ─── The catalog ───────────────────────────────────────────────────────────

export interface ChatTemplateCatalogEntry {
  id: ChatWidgetTemplateId;
  enabled: boolean;
  order: number;
  /** The Super Admin's display names (dashboard only). */
  name: ChatTemplateNames;
  /** The template's option defaults: the code's, under the Super Admin's (only the keys it reads). */
  options: ChatTemplateOptions;
}

export interface ChatTemplateCatalog {
  edition: Edition;
  /** The template a workspace wears without (or without an available) choice. Always enabled. */
  defaultId: ChatWidgetTemplateId;
  /** Every template the edition offers, in the Super Admin's order. */
  entries: ChatTemplateCatalogEntry[];
}

/** widget_edition_settings.chat_templates, as written by PUT /api/admin/widget-catalog. */
export interface StoredChatTemplateItem {
  enabled?: boolean;
  order?: number;
  name?: ChatTemplateNames;
  options?: ChatTemplateOptions;
}

export interface StoredChatTemplates {
  default?: string;
  items?: Record<string, StoredChatTemplateItem>;
}

/** The highest `order` a template may have. */
export const CHAT_TEMPLATE_ORDER_MAX = 99;

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The id a request or a row names, as the edition knows it: a legacy id is
 * mapped to its current name; an id the edition does not offer is null.
 */
export function canonicalChatTemplateId(edition: Edition | null | undefined, requested: unknown): ChatWidgetTemplateId | null {
  const raw = normalizeId(requested);
  if (!raw) return null;
  const id = chatWidgetTemplate(raw)?.id as ChatWidgetTemplateId | undefined;
  if (!id) return null;
  return (EDITION_CHAT_WIDGET_TEMPLATES[edition ?? 'iran'].offered as readonly string[]).includes(id) ? id : null;
}

function readNames(raw: unknown): ChatTemplateNames {
  const out: ChatTemplateNames = {};
  if (!isPlainObject(raw)) return out;
  for (const locale of CHAT_TEMPLATE_LOCALES) {
    const name = cleanTemplateText(raw[locale]);
    if (name) out[locale] = [...name].slice(0, CHAT_TEMPLATE_NAME_MAX).join('');
  }
  return out;
}

function isOrder(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= CHAT_TEMPLATE_ORDER_MAX;
}

/**
 * The edition's catalog from its stored row (`stored` null or anything else
 * unreadable = no row: only the edition's default enabled). `edition` null
 * (unknown) is Iran, as everywhere.
 */
export function resolveChatTemplateCatalog(edition: Edition | null | undefined, stored: unknown): ChatTemplateCatalog {
  const ed: Edition = edition ?? 'iran';
  const spec = EDITION_CHAT_WIDGET_TEMPLATES[ed];
  const root = isPlainObject(stored) ? stored : {};
  const items = isPlainObject(root.items) ? root.items : {};
  const position = (id: string) => spec.offered.indexOf(id as ChatWidgetTemplateId);
  const entries = spec.offered.map((id, index): ChatTemplateCatalogEntry => {
    const item = isPlainObject(items[id]) ? items[id] : {};
    return {
      id,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : id === spec.default,
      order: isOrder(item.order) ? item.order : index,
      name: readNames(item.name),
      options: { ...chatTemplateOptionDefaults(id), ...readTemplateOptions(item.options, chatTemplateOptionKeys(id)) },
    };
  }).sort((a, b) => a.order - b.order || position(a.id) - position(b.id));
  // The default is always an enabled template: a stored default that is not
  // (disabled, not offered, missing) gives way to the edition's default,
  // forced on. That also covers a row with nothing enabled: never zero
  // templates.
  const wanted = canonicalChatTemplateId(ed, root.default);
  let chosen = wanted ? entries.find((e) => e.id === wanted && e.enabled) : undefined;
  if (!chosen) {
    chosen = entries.find((e) => e.id === spec.default) ?? entries[0];
    chosen.enabled = true;
  }
  return { edition: ed, defaultId: chosen.id, entries };
}

/** The enabled templates, in the Super Admin's order. */
export function enabledChatTemplateIds(catalog: ChatTemplateCatalog): ChatWidgetTemplateId[] {
  return catalog.entries.filter((e) => e.enabled).map((e) => e.id);
}

/** Whether a workspace is shown the template picker: two or more templates enabled. */
export function chatTemplatePickerShown(catalog: ChatTemplateCatalog): boolean {
  return enabledChatTemplateIds(catalog).length >= 2;
}

/**
 * The template a workspace wears: its choice while enabled and while the plan
 * allows customising the appearance; otherwise (no choice, an unknown or a
 * disabled one, the plan) the catalog's default.
 */
export function resolveWorkspaceChatTemplate(
  catalog: ChatTemplateCatalog,
  requested: unknown,
  planAllowsChoice = true,
): ChatWidgetTemplateId {
  if (!planAllowsChoice) return catalog.defaultId;
  const id = canonicalChatTemplateId(catalog.edition, requested);
  return id && enabledChatTemplateIds(catalog).includes(id) ? id : catalog.defaultId;
}

/**
 * The options the widget gets for `templateId`: the code's defaults, under the
 * Super Admin's, under the workspace's (only the keys the template reads and
 * only valid values). `{}` for a template without options.
 */
export function resolveChatTemplateOptions(
  catalog: ChatTemplateCatalog,
  templateId: string,
  workspaceOptions: unknown,
): ChatTemplateOptions {
  const keys = chatTemplateOptionKeys(templateId);
  if (!keys.length) return {};
  const entry = catalog.entries.find((e) => e.id === templateId);
  return {
    ...chatTemplateOptionDefaults(templateId),
    ...(entry ? readTemplateOptions(entry.options, keys) : {}),
    ...readTemplateOptions(workspaceOptions, keys),
  };
}

// ─── The Super Admin's save ────────────────────────────────────────────────

export interface ChatTemplateCatalogInput {
  defaultId: string;
  templates: Array<{
    id: string;
    enabled: boolean;
    order?: number;
    name?: Partial<Record<ChatTemplateLocale, string | null>>;
    options?: unknown;
  }>;
}

export type ChatTemplateCatalogProblem =
  | 'template_not_offered'
  | 'duplicate_template'
  | 'name_too_long'
  | 'invalid_template_options'
  | 'invalid_order'
  | 'no_template_enabled'
  | 'default_not_enabled';

/**
 * Validates a Super Admin save for the edition and builds the row to store.
 * Ids missing from the body keep their stored item (an older admin page can
 * never erase a newer template's settings); ids the edition does not offer
 * are refused in the body and dropped from the stored row.
 */
export function cleanChatTemplateCatalogInput(
  edition: Edition,
  input: ChatTemplateCatalogInput,
  previous: unknown,
): { ok: true; value: StoredChatTemplates } | { ok: false; problem: ChatTemplateCatalogProblem; id?: string } {
  const spec = EDITION_CHAT_WIDGET_TEMPLATES[edition];
  const prevRoot = isPlainObject(previous) ? previous : {};
  const prevItems = isPlainObject(prevRoot.items) ? prevRoot.items : {};
  const items: Record<string, StoredChatTemplateItem> = {};
  // Keep what is stored for every offered id (read back in its clean shape).
  for (const id of spec.offered) {
    const item = isPlainObject(prevItems[id]) ? prevItems[id] : null;
    if (!item) continue;
    const kept: StoredChatTemplateItem = {};
    if (typeof item.enabled === 'boolean') kept.enabled = item.enabled;
    if (isOrder(item.order)) kept.order = item.order;
    const names = readNames(item.name);
    if (Object.keys(names).length) kept.name = names;
    const options = readTemplateOptions(item.options, chatTemplateOptionKeys(id));
    if (Object.keys(options).length) kept.options = options;
    items[id] = kept;
  }

  const seen = new Set<string>();
  for (const template of input.templates) {
    const id = canonicalChatTemplateId(edition, template.id);
    if (!id || normalizeId(template.id) !== id) return { ok: false, problem: 'template_not_offered', id: String(template.id) };
    if (seen.has(id)) return { ok: false, problem: 'duplicate_template', id };
    seen.add(id);
    const item: StoredChatTemplateItem = { enabled: template.enabled === true };
    if (template.order !== undefined) {
      if (!isOrder(template.order)) return { ok: false, problem: 'invalid_order', id };
      item.order = template.order;
    }
    const names: ChatTemplateNames = {};
    for (const locale of CHAT_TEMPLATE_LOCALES) {
      const name = cleanTemplateText(template.name?.[locale]);
      if (!name) continue;
      if (textLength(name) > CHAT_TEMPLATE_NAME_MAX) return { ok: false, problem: 'name_too_long', id };
      names[locale] = name;
    }
    if (Object.keys(names).length) item.name = names;
    const options = cleanTemplateOptionsInput(template.options, chatTemplateOptionKeys(id));
    if (!options.ok) return { ok: false, problem: 'invalid_template_options', id };
    if (Object.keys(options.value).length) item.options = options.value;
    items[id] = item;
  }

  const enabled = spec.offered.filter((id) => (typeof items[id]?.enabled === 'boolean' ? items[id].enabled : id === spec.default));
  if (!enabled.length) return { ok: false, problem: 'no_template_enabled' };
  const defaultId = canonicalChatTemplateId(edition, input.defaultId);
  if (!defaultId || !enabled.includes(defaultId)) return { ok: false, problem: 'default_not_enabled' };
  return { ok: true, value: { default: defaultId, items } };
}
