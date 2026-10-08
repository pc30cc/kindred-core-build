/**
 * Workspace panel themes ("قالب"): the looks a Super Admin can switch the
 * whole workspace panel (/app/w/:slug/...) to, platform-wide, from
 * Super Admin → Panel theme. One list for the server, which accepts only
 * these ids, and the dashboard, which applies the chosen one.
 *
 * 'classic' is the panel's own design, unchanged. A theme is a stylesheet
 * scoped to `html[data-panel-theme="<id>"]` (src/themes/<id>/theme.css) plus
 * its card on the admin page (src/themes/registry.ts). Adding one: its id
 * here, its folder, its registry entry. No migration: the column only keeps
 * the value a short slug (database/migrations/253_workspace_panel_theme.sql).
 */
export const PANEL_THEME_IDS = ['classic', 'art'] as const;

export type PanelThemeId = (typeof PANEL_THEME_IDS)[number];

export const DEFAULT_PANEL_THEME: PanelThemeId = 'classic';

export function isPanelThemeId(value: unknown): value is PanelThemeId {
  return typeof value === 'string' && (PANEL_THEME_IDS as readonly string[]).includes(value);
}

/** The stored value as a theme id; anything unknown (or missing) is the default. */
export function resolvePanelTheme(value: unknown): PanelThemeId {
  return isPanelThemeId(value) ? value : DEFAULT_PANEL_THEME;
}
