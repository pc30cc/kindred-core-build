/**
 * Per-user UI preferences (font size, accent colour, chroma, panel skin).
 *
 * Purely presentational and stored per browser profile + account id in
 * localStorage. No backend, no Edge Functions. Values are applied as
 * attributes / CSS variables on <html>, so every token-based component
 * follows automatically.
 */

export type UiFontSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type UiAccent = 'blue' | 'emerald' | 'violet' | 'amber' | 'rose' | 'slate';
export type UiChroma = 'color' | 'mono';
export type UiSkin = 'cloud' | 'linen' | 'graphite';

export interface UiPreferences {
  fontSize: UiFontSize;
  accent: UiAccent;
  chroma: UiChroma;
  skin: UiSkin;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  fontSize: 'md',
  accent: 'blue',
  chroma: 'color',
  skin: 'cloud',
};

export const UI_FONT_SIZE_PX: Record<UiFontSize, number> = {
  xs: 13,
  sm: 14.5,
  md: 16,
  lg: 17.5,
  xl: 19,
};

export const UI_ACCENT_SWATCH: Record<UiAccent, string> = {
  blue: '#3B82F6',
  emerald: '#10B981',
  violet: '#8B5CF6',
  amber: '#F59E0B',
  rose: '#F43F5E',
  slate: '#64748B',
};

const STORAGE_KEY = 'wy-ui-prefs';

function keyFor(scopeId?: string | null) {
  return scopeId ? `${STORAGE_KEY}:${scopeId}` : STORAGE_KEY;
}

/**
 * Partial preference set: only the keys the user explicitly picked. Anything
 * missing falls back to the platform default configured by the super admin.
 */
export type UiPreferencesOverrides = Partial<UiPreferences>;

export function sanitizeUiPreferences(raw: unknown): UiPreferencesOverrides {
  const value = (raw ?? {}) as Partial<UiPreferences>;
  const out: UiPreferencesOverrides = {};
  if ((['xs', 'sm', 'md', 'lg', 'xl'] as const).includes(value.fontSize as UiFontSize)) out.fontSize = value.fontSize as UiFontSize;
  if ((Object.keys(UI_ACCENT_SWATCH) as UiAccent[]).includes(value.accent as UiAccent)) out.accent = value.accent as UiAccent;
  if (value.chroma === 'mono' || value.chroma === 'color') out.chroma = value.chroma;
  if ((['cloud', 'linen', 'graphite'] as const).includes(value.skin as UiSkin)) out.skin = value.skin as UiSkin;
  return out;
}

export function resolveUiPreferences(
  platformDefaults?: UiPreferencesOverrides | null,
  userOverrides?: UiPreferencesOverrides | null
): UiPreferences {
  return {
    ...DEFAULT_UI_PREFERENCES,
    ...sanitizeUiPreferences(platformDefaults),
    ...sanitizeUiPreferences(userOverrides),
  };
}

export function loadUiPreferences(scopeId?: string | null): UiPreferencesOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(keyFor(scopeId)) ?? window.localStorage.getItem(STORAGE_KEY);
    return sanitizeUiPreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

/** Platform defaults cached locally so first paint matches the admin config. */
const PLATFORM_DEFAULTS_KEY = 'wy-ui-platform-defaults';

export function loadPlatformUiDefaults(): UiPreferencesOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PLATFORM_DEFAULTS_KEY);
    return sanitizeUiPreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

export function savePlatformUiDefaults(defaults: UiPreferencesOverrides) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PLATFORM_DEFAULTS_KEY, JSON.stringify(sanitizeUiPreferences(defaults)));
  } catch {
    /* storage unavailable */
  }
}

export function saveUiPreferences(prefs: UiPreferencesOverrides, scopeId?: string | null) {
  if (typeof window === 'undefined') return;
  try {
    const serialized = JSON.stringify(prefs);
    window.localStorage.setItem(keyFor(scopeId), serialized);
    // Mirror to the global key so first paint (before the account resolves)
    // already uses the right settings.
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    /* storage unavailable — preferences stay in-memory for this session */
  }
}

export function applyUiPreferences(prefs: UiPreferences) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--ui-font-size', `${UI_FONT_SIZE_PX[prefs.fontSize]}px`);
  root.dataset.uiFont = prefs.fontSize;
  root.dataset.uiAccent = prefs.accent;
  root.dataset.uiChroma = prefs.chroma;
  root.dataset.uiSkin = prefs.skin;
}
