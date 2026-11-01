import { useCallback, useMemo, useState } from 'react';
import type { AgentSettings } from '@/lib/ai-agent-api';
import {
  buildPatch,
  editsAfterSave,
  localizedKey,
  serverLocalized,
  serverValues,
  validateEdits,
  type EditKey,
  type Edits,
  type FieldKey,
  type LocalizedMap,
  type PersonaContext,
  type PersonaFieldError,
  type PersonaValues,
} from './personaForm';

export interface PersonaForm {
  /** The server's latest copy. */
  settings: AgentSettings;
  context: PersonaContext;
  /** What every control shows: the owner's edit, else the server's value. */
  values: PersonaValues;
  set: <K extends FieldKey>(key: K, value: PersonaValues[K]) => void;
  /** Drop one edit: the control shows the server's value again. */
  reset: (key: EditKey) => void;
  localized: (map: LocalizedMap, lang: string) => string;
  setLocalized: (map: LocalizedMap, lang: string, value: string) => void;
  edits: Edits;
  /** The PATCH a save sends now (only what differs from the server's copy). */
  patch: Partial<AgentSettings>;
  changed: EditKey[];
  dirty: boolean;
  errors: Partial<Record<FieldKey, PersonaFieldError>>;
  discard: () => void;
  /** After a successful save of `sent`: the edits not touched since go. */
  markSaved: (sent: Edits) => void;
}

/**
 * One form state for the page: the owner's edits by key over the server's
 * copy (personaForm.ts). A new copy (after any save, instant action or
 * refetch) moves every control nobody is editing and keeps every edit.
 */
export function usePersonaForm(settings: AgentSettings, context: PersonaContext): PersonaForm {
  const [edits, setEdits] = useState<Edits>({});

  const server = useMemo(() => serverValues(settings, context), [settings, context]);
  const values = useMemo(() => ({ ...server, ...edits }) as PersonaValues, [server, edits]);
  const { patch, changed } = useMemo(() => buildPatch(edits, settings, context), [edits, settings, context]);
  const errors = useMemo(() => validateEdits(edits), [edits]);

  const set = useCallback(<K extends FieldKey>(key: K, value: PersonaValues[K]) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback((key: EditKey) => {
    setEdits((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next: Record<string, unknown> = { ...prev };
      delete next[key];
      return next as Edits;
    });
  }, []);

  const localized = useCallback((map: LocalizedMap, lang: string) => {
    const key = localizedKey(map, lang);
    const typed = edits[key];
    return typeof typed === 'string' ? typed : serverLocalized(settings, map, lang);
  }, [edits, settings]);

  const setLocalized = useCallback((map: LocalizedMap, lang: string, value: string) => {
    setEdits((prev) => ({ ...prev, [localizedKey(map, lang)]: value }));
  }, []);

  const discard = useCallback(() => setEdits({}), []);
  const markSaved = useCallback((sent: Edits) => setEdits((current) => editsAfterSave(current, sent)), []);

  return {
    settings,
    context,
    values,
    set,
    reset,
    localized,
    setLocalized,
    edits,
    patch,
    changed,
    dirty: changed.length > 0,
    errors,
    discard,
    markSaved,
  };
}
