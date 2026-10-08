/**
 * The workspace panel's themes ("قالب"), chosen platform-wide by the Super
 * Admin (Super Admin → Panel theme). Shared by the server, which accepts only
 * these ids, and the client, which falls back to the default for anything
 * else (an unknown id, or a database from before migration 253).
 *
 * A theme may also have options (migration 254,
 * `platform_branding.workspace_panel_theme_options`, stored per theme as
 * `{ "<theme>": { "<option>": "<value>" } }`). Each option lists the values
 * it accepts; the first is its default. A theme without options has none.
 * Adding a value or an option needs no migration.
 */

export const PANEL_THEME_IDS = ['classic', 'art'] as const;

export type PanelThemeId = (typeof PANEL_THEME_IDS)[number];

export const DEFAULT_PANEL_THEME: PanelThemeId = 'classic';

export function isPanelThemeId(value: unknown): value is PanelThemeId {
  return typeof value === 'string' && (PANEL_THEME_IDS as readonly string[]).includes(value);
}

export function resolvePanelTheme(value: unknown): PanelThemeId {
  return isPanelThemeId(value) ? value : DEFAULT_PANEL_THEME;
}

/** Art's frame: navigation pills in a top bar, or an inset side menu. */
export const ART_LAYOUTS = ['topnav', 'sidebar'] as const;
export type ArtLayout = (typeof ART_LAYOUTS)[number];

/**
 * Art's colour schemes; `clay` is the original one. `respok` (the RESPOK
 * brand kit's colours) is for international mode only (shared/
 * internationalMode.ts): offered and worn only there, read as clay anywhere
 * else (artPaletteFor).
 */
export const ART_PALETTES = ['clay', 'sage', 'indigo', 'plum', 'ocean', 'saffron', 'graphite', 'respok'] as const;
export type ArtPalette = (typeof ART_PALETTES)[number];

/** Colour schemes offered and worn only in international mode. */
export const INTERNATIONAL_ART_PALETTES: readonly ArtPalette[] = ['respok'];

/** The schemes a Super Admin may pick, in or out of international mode. */
export function artPalettesFor(international: boolean): readonly ArtPalette[] {
  return international ? ART_PALETTES : ART_PALETTES.filter((id) => !INTERNATIONAL_ART_PALETTES.includes(id));
}

/**
 * The scheme to wear: an international-only scheme outside international
 * mode (Persian, or a single-language site) is the default, clay.
 */
export function artPaletteFor(palette: ArtPalette, international: boolean): ArtPalette {
  return !international && INTERNATIONAL_ART_PALETTES.includes(palette) ? ART_PALETTES[0] : palette;
}

/** Every theme's options and the values each accepts (first = default). */
export const PANEL_THEME_OPTIONS = {
  classic: {},
  art: { layout: ART_LAYOUTS, palette: ART_PALETTES },
} as const satisfies Record<PanelThemeId, Record<string, readonly string[]>>;

export type PanelThemeOptions<T extends PanelThemeId = PanelThemeId> = {
  -readonly [K in keyof (typeof PANEL_THEME_OPTIONS)[T]]: (typeof PANEL_THEME_OPTIONS)[T][K] extends readonly (infer V)[] ? V : never;
};

/**
 * A theme's options with every missing or unknown value replaced by its
 * default. `raw` is the stored object for all themes (or anything else).
 */
export function resolvePanelThemeOptions<T extends PanelThemeId>(theme: T, raw: unknown): PanelThemeOptions<T> {
  const spec = PANEL_THEME_OPTIONS[theme] as Record<string, readonly string[]>;
  const all = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const stored = all[theme] && typeof all[theme] === 'object' && !Array.isArray(all[theme]) ? (all[theme] as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(spec)) {
    const value = stored[key];
    out[key] = typeof value === 'string' && values.includes(value) ? value : values[0];
  }
  return out as PanelThemeOptions<T>;
}

/**
 * A theme together with its options, all resolved. `theme` tells which
 * options there are: `if (s.theme === 'art') s.options.layout`.
 */
export type PanelThemeSelection = { [T in PanelThemeId]: { theme: T; options: PanelThemeOptions<T> } }[PanelThemeId];

/** `theme` with its options resolved from `raw` (the stored object for all themes). */
export function resolvePanelThemeSelection(theme: PanelThemeId, raw: unknown): PanelThemeSelection {
  return { theme, options: resolvePanelThemeOptions(theme, raw) } as PanelThemeSelection;
}

/** Every option name any theme has (`layout`, `palette`, ...), once. */
export const PANEL_THEME_OPTION_KEYS: readonly string[] = Array.from(
  new Set(Object.values(PANEL_THEME_OPTIONS).flatMap((spec) => Object.keys(spec))),
);

/** True when `options` sets only known options of `theme` to accepted values. */
export function isValidPanelThemeOptions(theme: PanelThemeId, options: unknown): options is Partial<PanelThemeOptions> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const spec = PANEL_THEME_OPTIONS[theme] as Record<string, readonly string[]>;
  // Own keys only: `'constructor' in spec` is true for any object.
  return Object.entries(options as Record<string, unknown>).every(
    ([key, value]) => Object.prototype.hasOwnProperty.call(spec, key) && typeof value === 'string' && spec[key].includes(value),
  );
}
