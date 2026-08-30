/**
 * Widget template resolution (server side).
 *
 * The canonical list of templates lives in the browser-side registry
 * (`public/widget/presentation-registry.js`). The server never needs to
 * know WHICH templates exist — it only needs a valid template id so it can
 * name the presentation assets in the bootstrap payload. The browser
 * registry does the real resolution (and falls back to its default when an
 * id is unknown), which keeps a new template a zero-server-change addition.
 *
 * Server responsibility here is purely security: the id becomes part of an
 * asset file name, so its shape is strictly validated.
 */
export const DEFAULT_WIDGET_TEMPLATE_ID = 'web-yar';

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Returns a shape-safe template id, falling back to the default. */
export function resolveWidgetTemplateId(input?: string | null): string {
  const id = String(input || '').trim().toLowerCase();
  if (id && TEMPLATE_ID_RE.test(id)) return id;
  return DEFAULT_WIDGET_TEMPLATE_ID;
}

/** Logical manifest keys for a template's renderer + stylesheet. */
export function widgetTemplateAssetKeys(templateId: string) {
  const id = resolveWidgetTemplateId(templateId);
  return {
    script: `presentation-${id}.js` as const,
    style: `presentation-${id}.css` as const,
  };
}
