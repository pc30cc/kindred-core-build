/**
 * The chat widget's colour (widget_settings.primary_color), one rule for the
 * settings PATCH, GET /config, the panel's picker and its live preview.
 *
 * Stored: `#RRGGBB` (the workspace chose it) or NULL (it did not: "Brand
 * colour"). A widget without a colour of its own wears the brand's: the Iran
 * kit's deep turquoise, RESPOK's Ink, else the product blue the templates
 * were drawn in, on the button and in the panel alike (public/widget/
 * loader.js applyConfigToShell; t1/t2 draw their brand accent).
 *
 * On the wire (/config `primaryColor`) "no colour" is the seeded #3B82F6,
 * which every widget file already reads as uncustomised (loader.js
 * kitBrandColor, presentation-t1/t2 accentTokens), so a cached older loader
 * keeps working. A stored #3B82F6 was the seed every row once got, so it is
 * the brand colour too; a save of it is stored as NULL (migration 279b moves
 * the stored ones), and the picker then shows "Brand colour" chosen.
 *
 * Pure: no I/O.
 */

/** The seeded colour: "uncustomised" on the wire (shared/webyarBrand.ts UNCUSTOMISED_PRIMARY_COLOR). */
export const WIDGET_UNCUSTOMISED_COLOR = '#3B82F6';

/** What a stored or typed colour must look like: six hex digits after `#`. */
export const WIDGET_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** The kit a widget's button wears (loader.js: `lk-kit` in the Iranian edition, `rpk-kit` in RESPOK's build). */
export type WidgetColorKit = 'iran' | 'respok' | null;

const BRAND_COLORS: Record<'iran' | 'respok' | 'none', string> = {
  // The kit's deep turquoise (shared/webyarBrand.ts themeColor; t1/t2 `gs-accent-brand`).
  iran: '#0B7D6C',
  // RESPOK's Ink (t1-intl/t2-intl `gs-accent-brand`, the kit button's ground).
  respok: '#16142B',
  none: WIDGET_UNCUSTOMISED_COLOR,
};

/**
 * The workspace's own colour, upper-case, or null: nothing, anything that is
 * not `#RRGGBB`, or the seeded #3B82F6.
 */
export function widgetOwnColor(value: unknown): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!WIDGET_COLOR_PATTERN.test(v)) return null;
  const up = v.toUpperCase();
  return up === WIDGET_UNCUSTOMISED_COLOR ? null : up;
}

/** The brand's colour a widget without its own wears. */
export function widgetBrandColor(kit: WidgetColorKit): string {
  return BRAND_COLORS[kit ?? 'none'];
}

/** The colour visitors see: the workspace's own, else the brand's. */
export function widgetAccentColor(value: unknown, kit: WidgetColorKit): string {
  return widgetOwnColor(value) ?? widgetBrandColor(kit);
}

/** `primaryColor` of GET /config: the widget's colour, else the workspace branding's, else the seeded one (the brand). */
export function widgetWireColor(widgetColor: unknown, brandingColor?: unknown): string {
  return widgetOwnColor(widgetColor) ?? widgetOwnColor(brandingColor) ?? WIDGET_UNCUSTOMISED_COLOR;
}
