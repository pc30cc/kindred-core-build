/**
 * Widget template resolution (server side).
 *
 * Which templates exist, and which one each edition wears, is decided in
 * shared/widgetTemplates.ts (the browser registry,
 * `public/widget/presentation-registry.js`, lists the same ids). The server
 * resolves the template for the platform's edition and names its assets in
 * the bootstrap payload: the Iranian edition always gets `default`, exactly
 * as before; the International edition gets `intl`.
 *
 * The id becomes part of asset FILE NAMES, so an id that is not a known
 * template is still strictly shape-validated before a name is built from it.
 */
import type { Edition } from '../../../shared/edition.js';
import { chatWidgetTemplate, resolveChatWidgetTemplate } from '../../../shared/widgetTemplates.js';

export const DEFAULT_WIDGET_TEMPLATE_ID = 'default';

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Ids this template used to be called, mapped to what it is called now.
 *
 * The id is baked into asset FILE NAMES, so unlike the browser registry —
 * which can simply fall back for anything it does not recognise — the server
 * would happily build `presentation-web-yar.js` out of a stale id and serve
 * the loader a 404. A settings row or an embed written before the rename has
 * to land on the real files.
 */
const LEGACY_TEMPLATE_IDS: Record<string, string> = { 'web-yar': 'default' };

/** Returns a shape-safe template id, falling back to the default. */
export function resolveWidgetTemplateId(input?: string | null): string {
  const id = String(input || '').trim().toLowerCase();
  if (id && LEGACY_TEMPLATE_IDS[id]) return LEGACY_TEMPLATE_IDS[id];
  if (id && TEMPLATE_ID_RE.test(id)) return id;
  return DEFAULT_WIDGET_TEMPLATE_ID;
}

/**
 * The template the widget wears in this edition (shared/widgetTemplates.ts):
 * a requested id the edition offers, else the edition's default. An unknown
 * edition (null) is the Iranian one: `default`.
 */
export function resolveEditionWidgetTemplateId(edition: Edition | null, requested?: string | null): string {
  return resolveChatWidgetTemplate(edition, requested);
}

/**
 * Logical manifest keys for a template's renderer, stylesheet, skin and font
 * asset.
 *
 * A known template (shared/widgetTemplates.ts) names its own files — a skin
 * reuses another template's renderer and base stylesheet and adds `skin`.
 * Any other shape-safe id follows the file-name convention
 * `presentation-<id>.js/.css/-fonts.css` with no skin.
 *
 * `fonts` and `skin` are optional at runtime (a template may ship none), so
 * callers must tolerate the manifest lacking the key.
 */
export function widgetTemplateAssetKeys(templateId: string): {
  script: `presentation-${string}.js`;
  style: `presentation-${string}.css`;
  fonts: `presentation-${string}.css`;
  skin: `presentation-${string}.css` | null;
} {
  const id = resolveWidgetTemplateId(templateId);
  const known = chatWidgetTemplate(id);
  if (known) {
    return {
      script: known.script,
      style: known.style,
      fonts: known.fonts ?? (`presentation-${id}-fonts.css` as const),
      skin: known.skin,
    };
  }
  return {
    script: `presentation-${id}.js` as const,
    style: `presentation-${id}.css` as const,
    fonts: `presentation-${id}-fonts.css` as const,
    skin: null,
  };
}
