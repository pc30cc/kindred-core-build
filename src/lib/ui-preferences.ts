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

function sanitize(raw: unknown): UiPreferences {
  const value = (raw ?? {}) as Partial<UiPreferences>;
  return {
    fontSize: (['xs', 'sm', 'md', 'lg', 'xl'] as const).includes(value.fontSize as UiFontSize)
      ? (value.fontSize as UiFontSize)
      : DEFAULT_UI_PREFERENCES.fontSize,
    accent: (Object.keys(UI_ACCENT_SWATCH) as UiAccent[]).includes(value.accent as UiAccent)
      ? (value.accent as UiAccent)
      : DEFAULT_UI_PREFERENCES.accent,
    chroma: value.chroma === 'mono' ? 'mono' : 'color',
    skin: (['cloud', 'linen', 'graphite'] as const).includes(value.skin as UiSkin)
      ? (value.skin as UiSkin)
      : DEFAULT_UI_PREFERENCES.skin,
  };
}

export function loadUiPreferences(scopeId?: string | null): UiPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_UI_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(keyFor(scopeId)) ?? window.localStorage.getItem(STORAGE_KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

export function saveUiPreferences(prefs: UiPreferences, scopeId?: string | null) {
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
