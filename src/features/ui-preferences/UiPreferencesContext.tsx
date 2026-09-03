/**
 * Applies the signed-in user's personal UI preferences (font size, accent,
 * chroma, panel skin) to <html>. Client-side only, stored per account in
 * localStorage — no backend involvement.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import {
  DEFAULT_UI_PREFERENCES,
  applyUiPreferences,
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from '@/lib/ui-preferences';

interface UiPreferencesContextValue {
  preferences: UiPreferences;
  setPreference: <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => void;
  reset: () => void;
}

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function UiPreferencesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const scopeId = user?.id ?? null;

  const [preferences, setPreferences] = useState<UiPreferences>(() => loadUiPreferences());

  // Re-read (and apply) whenever the account scope changes.
  useEffect(() => {
    const next = loadUiPreferences(scopeId);
    setPreferences(next);
    applyUiPreferences(next);
  }, [scopeId]);

  useEffect(() => {
    applyUiPreferences(preferences);
  }, [preferences]);

  const setPreference = useCallback<UiPreferencesContextValue['setPreference']>(
    (key, value) => {
      setPreferences((prev) => {
        const next = { ...prev, [key]: value };
        saveUiPreferences(next, scopeId);
        return next;
      });
    },
    [scopeId]
  );

  const reset = useCallback(() => {
    const next = { ...DEFAULT_UI_PREFERENCES };
    saveUiPreferences(next, scopeId);
    setPreferences(next);
  }, [scopeId]);

  const value = useMemo(() => ({ preferences, setPreference, reset }), [preferences, setPreference, reset]);

  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferencesContextValue {
  const ctx = useContext(UiPreferencesContext);
  if (!ctx) {
    return {
      preferences: DEFAULT_UI_PREFERENCES,
      setPreference: () => undefined,
      reset: () => undefined,
    };
  }
  return ctx;
}
