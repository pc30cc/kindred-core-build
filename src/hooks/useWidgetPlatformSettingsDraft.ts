/**
 * Super Admin → Widget settings: what a typed field saves, and when.
 *
 * Every keystroke used to send a PATCH and a "Settings saved" toast, and an
 * emptied number field wrote a default. Now a typed value goes into a local
 * draft at once (the field shows it) and is saved `delayMs` after the last
 * change, all waiting fields in one PATCH; a number field calls this only
 * with a value it accepts (shared/platformTuning.ts), so an empty or
 * out-of-range field saves nothing. The page's status line says Saving… /
 * All changes saved / Not saved; a refused save also toasts its reason and
 * the fields of that save go back to the stored values, unless a newer edit
 * replaced them meanwhile. Changes still waiting when the page closes are
 * sent then, not dropped.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUpdateWidgetPlatformSettings, type WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import type { WidgetSaveStatus } from '@/hooks/useWidgetSettingsDraft';

type Patch = Partial<WidgetPlatformSettings>;

export const PLATFORM_DRAFT_DELAY_MS = 800;

const PLATFORM_QUERY_KEY = ['widget-platform-settings'] as const;

export interface WidgetPlatformSettingsDraft {
  /** The stored settings with the draft over them: what every field shows. */
  live: WidgetPlatformSettings | null;
  /** Draft fields and save them once typing stops. */
  setFields: (patch: Patch) => void;
  /** Send every waiting change now. */
  flush: () => void;
  status: WidgetSaveStatus;
  errorMessage: string | null;
}

export function useWidgetPlatformSettingsDraft(
  settings: WidgetPlatformSettings | null | undefined,
  opts: { onError: (err: Error) => void; delayMs?: number },
): WidgetPlatformSettingsDraft {
  const qc = useQueryClient();
  const update = useUpdateWidgetPlatformSettings();
  // mutateAsync, not mutate: every save's own outcome arrives (mutate
  // reports only the latest call's), so the status follows each of them.
  const save = useRef(update.mutateAsync);
  save.current = update.mutateAsync;
  const onError = useRef(opts.onError);
  onError.current = opts.onError;
  const delayMs = opts.delayMs ?? PLATFORM_DRAFT_DELAY_MS;

  const [draft, setDraft] = useState<Patch>({});
  const [status, setStatus] = useState<WidgetSaveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pending = useRef<Patch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(0);
  const id = useRef<string | undefined>(settings?.id);
  id.current = settings?.id;

  /** Drop the drafted keys of `sent` that no newer edit has replaced. */
  const settle = useCallback((sent: Patch) => {
    setDraft((current) => {
      const next: Patch = { ...current };
      for (const key of Object.keys(sent) as Array<keyof Patch>) {
        if (!(key in pending.current) && next[key] === sent[key]) delete next[key];
      }
      return next;
    });
  }, []);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const sent = pending.current;
    pending.current = {};
    const rowId = id.current;
    if (!rowId || Object.keys(sent).length === 0) return;
    inFlight.current += 1;
    setStatus('saving');
    save.current({ id: rowId, updates: sent }).then(
      (saved) => {
        // The stored row as the server answered it, so the field never
        // flashes the old value while the page's settings refetch.
        if (saved) qc.setQueryData(PLATFORM_QUERY_KEY, saved);
        settle(sent);
        inFlight.current -= 1;
        setStatus((s) => (s === 'error' ? s : inFlight.current > 0 || Object.keys(pending.current).length ? 'saving' : 'saved'));
      },
      (err: unknown) => {
        inFlight.current -= 1;
        settle(sent);
        const error = err instanceof Error ? err : new Error(String(err));
        setErrorMessage(error.message);
        setStatus('error');
        onError.current(error);
      },
    );
  }, [qc, settle]);

  const setFields = useCallback((patch: Patch) => {
    setDraft((current) => ({ ...current, ...patch }));
    pending.current = { ...pending.current, ...patch };
    setStatus('saving');
    setErrorMessage(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }, [flush, delayMs]);

  // Leaving the page sends what is still waiting.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const live = useMemo(() => (settings ? ({ ...settings, ...draft } as WidgetPlatformSettings) : null), [settings, draft]);
  return { live, setFields, flush, status, errorMessage };
}
