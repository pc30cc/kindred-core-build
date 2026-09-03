/**
 * Applies UI preferences (font size, accent, chroma, panel skin) to <html>.
 *
 * Resolution order: hard-coded defaults → platform defaults set by the super
 * admin in Admin → Branding → the signed-in user's own overrides
 * (localStorage, per account). Client-side only, no Edge Functions.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_UI_PREFERENCES,
  applyUiPreferences,
  loadPlatformUiDefaults,
  loadUiPreferences,
  resolveUiPreferences,
  savePlatformUiDefaults,
  saveUiPreferences,
  type UiPreferences,
  type UiPreferencesOverrides,
} from '@/lib/ui-preferences';

interface UiPreferencesContextValue {
  /** Effective values currently applied to the UI. */
  preferences: UiPreferences;
  /** Only what this user explicitly overrode. */
  overrides: UiPreferencesOverrides;
  /** Platform-wide defaults configured by the super admin. */
  platformDefaults: UiPreferencesOverrides;
  setPreference: <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => void;
  reset: () => void;
}

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

function usePlatformUiDefaults(): UiPreferencesOverrides {
  const { data } = useQuery({
    queryKey: ['platform_ui_defaults'],
    queryFn: async (): Promise<UiPreferencesOverrides> => {
      const { data, error } = await supabase
        .from('platform_branding')
        .select('default_ui_font_size, default_ui_accent, default_ui_chroma, default_ui_skin')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const row = (data ?? {}) as Record<string, string | null>;
      const next: UiPreferencesOverrides = {
        fontSize: row.default_ui_font_size as UiPreferences['fontSize'] | undefined,
        accent: row.default_ui_accent as UiPreferences['accent'] | undefined,
        chroma: row.default_ui_chroma as UiPreferences['chroma'] | undefined,
        skin: row.default_ui_skin as UiPreferences['skin'] | undefined,
      };
      savePlatformUiDefaults(next);
      return next;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Fall back to the last known defaults so first paint never flashes.
  return data ?? loadPlatformUiDefaults();
}

export function UiPreferencesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const scopeId = user?.id ?? null;
  const platformDefaults = usePlatformUiDefaults();

  const [overrides, setOverrides] = useState<UiPreferencesOverrides>(() => loadUiPreferences());

  useEffect(() => {
    setOverrides(loadUiPreferences(scopeId));
  }, [scopeId]);

  const preferences = useMemo(
    () => resolveUiPreferences(platformDefaults, overrides),
    [platformDefaults, overrides]
  );

  useEffect(() => {
    applyUiPreferences(preferences);
  }, [preferences]);

  const setPreference = useCallback<UiPreferencesContextValue['setPreference']>(
    (key, value) => {
      setOverrides((prev) => {
        const next = { ...prev, [key]: value };
        saveUiPreferences(next, scopeId);
        return next;
      });
    },
    [scopeId]
  );

  const reset = useCallback(() => {
    saveUiPreferences({}, scopeId);
    setOverrides({});
  }, [scopeId]);

  const value = useMemo(
    () => ({ preferences, overrides, platformDefaults, setPreference, reset }),
    [preferences, overrides, platformDefaults, setPreference, reset]
  );

  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferencesContextValue {
  const ctx = useContext(UiPreferencesContext);
  if (!ctx) {
    return {
      preferences: DEFAULT_UI_PREFERENCES,
      overrides: {},
      platformDefaults: {},
      setPreference: () => undefined,
      reset: () => undefined,
    };
  }
  return ctx;
}
