/**
 * Widget page saves: the local draft every field edits, the debounced PATCH
 * behind it, and what happens when a save does not go through.
 *
 * Every keystroke updates the draft (and so the preview) at once; the save
 * of a field is sent `delay` ms after its last change. A refused or failed
 * save (a length the server caps, a plan refusal, an ended session, no
 * network) is never silent: the toast says why, the save status reads "Not
 * saved", and each field of that save goes back to the value the server
 * holds unless a newer edit replaced it meanwhile. Leaving the page (another
 * tab of the app, or closing the browser tab) sends the changes still
 * waiting for their delay instead of dropping them.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { toast } from '@/hooks/use-toast';
import { useUpdateWidgetSettings, WidgetSettingsSaveError } from '@/hooks/useWidgetSettings';
import type { WidgetSettings } from '@/types/models';

export type WidgetSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The field labels a refusal names (the first field of its issues). */
const FIELD_LABEL_KEYS: Record<string, string> = {
  brand_name: 'widgetPage.appearance.brandName',
  reply_time_text: 'widgetPage.preview.replyTimeLabel',
  welcome_message: 'widget.welcomeMessage',
  placeholder_text: 'widgetPage.preview.inputPlaceholder',
  fab_label: 'widgetPage.appearance.fabLabel',
  primary_color: 'widget.primaryColor',
  availability_labels: 'widgetPage.availability.copyTitle',
  offline_message_localized: 'widgetPage.availability.offlineMessage',
  business_hours: 'widgetPage.availability.hoursTitle',
  assignment_mode: 'widgetPage.behavior.assignmentMode',
  last_agent_routing_enabled: 'widgetPage.behavior.assignment.lastAgent',
  last_agent_window_days: 'widgetPage.behavior.assignment.lastAgent',
  default_max_concurrent_chats: 'widgetPage.behavior.assignment.capacity',
  first_response_timeout_minutes: 'widgetPage.behavior.assignment.timeout',
};

/** Why a save did not go through, in the dashboard's language. */
export function widgetSaveErrorMessage(err: unknown, t: Translate): string {
  const e = err instanceof WidgetSettingsSaveError ? err : null;
  if (!e || e.code === 'network') return t(e ? 'widgetPage.save.errorNetwork' : 'widgetPage.save.errorGeneric');
  if (e.status === 401) return t('widgetPage.save.errorSession');
  if (e.code === 'plan_upgrade_required') return t('widgetPage.save.errorPlan');
  if (e.status === 400) {
    const field = e.issues[0]?.path.split('.')[0];
    const key = field ? FIELD_LABEL_KEYS[field] : undefined;
    return key
      ? t('widgetPage.save.errorInvalidField', { field: t(key as Parameters<Translate>[0]) })
      : t('widgetPage.save.errorInvalid');
  }
  if (e.status === 403) return t('widgetPage.save.errorForbidden');
  return t('widgetPage.save.errorGeneric');
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export interface WidgetSettingsDraft {
  /** The server's settings with the draft over them: what every field and preview shows. */
  live: Partial<WidgetSettings>;
  draft: Partial<WidgetSettings>;
  setDraft: Dispatch<SetStateAction<Partial<WidgetSettings>>>;
  /** Draft a field and save it `delay` ms after its last change (0: now). */
  setField: (field: keyof WidgetSettings & string, value: unknown, delay?: number) => void;
  /** setField for several fields; `draftOnly` keeps them in the draft and sends nothing (a value not valid yet). */
  setFields: (patch: Partial<WidgetSettings>, opts?: { delay?: number; draftOnly?: boolean }) => void;
  /**
   * Save now, without drafting (a switch that shows the server's value).
   * Resolves true once saved, false when refused — already reported (the
   * toast, the status); it never rejects.
   */
  saveNow: (patch: Partial<WidgetSettings>) => Promise<boolean>;
  /** Drop a field's waiting save (a caller that saves it its own way). */
  cancelField: (field: keyof WidgetSettings & string) => void;
  /** Send every waiting save now. */
  flush: () => void;
  status: WidgetSaveStatus;
  /** The last refusal's message while `status` is `error`. */
  errorMessage: string | null;
}

export function useWidgetSettingsDraft(workspaceId: string | undefined, widget: WidgetSettings | undefined): WidgetSettingsDraft {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const update = useUpdateWidgetSettings(workspaceId);
  const [draft, setDraft] = useState<Partial<WidgetSettings>>({});
  const [status, setStatus] = useState<WidgetSaveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const waiting = useRef<Record<string, unknown>>({});
  const inFlight = useRef(0);
  // The latest of each, for the timers and the unmount / pagehide flush.
  const latest = useRef({ mutateAsync: update.mutateAsync, t, qc, workspaceId });
  latest.current = { mutateAsync: update.mutateAsync, t, qc, workspaceId };

  const send = useCallback((patch: Partial<WidgetSettings>, rollback: boolean): Promise<boolean> => {
    if (!Object.keys(patch).length) return Promise.resolve(true);
    inFlight.current += 1;
    setStatus('saving');
    return latest.current.mutateAsync(patch).then(
      () => {
        inFlight.current -= 1;
        if (inFlight.current === 0 && Object.keys(waiting.current).length === 0) {
          setStatus('saved');
          setErrorMessage(null);
        }
        return true;
      },
      (err: unknown) => {
        inFlight.current -= 1;
        const { t: tr, qc: client, workspaceId: ws } = latest.current;
        const message = widgetSaveErrorMessage(err, tr);
        if (rollback) {
          setDraft((prev) => {
            const next = { ...prev } as Record<string, unknown>;
            for (const [field, value] of Object.entries(patch)) {
              if (field in next && same(next[field], value)) delete next[field];
            }
            return next as Partial<WidgetSettings>;
          });
        }
        void client.invalidateQueries({ queryKey: ['widget-settings', ws] });
        setStatus('error');
        setErrorMessage(message);
        toast({ title: tr('widgetPage.save.failedTitle'), description: message, variant: 'destructive' });
        return false;
      },
    );
  }, []);

  const flushFields = useCallback((fields: string[]) => {
    const patch: Record<string, unknown> = {};
    for (const field of fields) {
      if (!(field in waiting.current)) continue;
      clearTimeout(timers.current[field]);
      delete timers.current[field];
      patch[field] = waiting.current[field];
      delete waiting.current[field];
    }
    void send(patch as Partial<WidgetSettings>, true);
  }, [send]);

  const flush = useCallback(() => flushFields(Object.keys(waiting.current)), [flushFields]);

  const cancelField = useCallback((field: string) => {
    clearTimeout(timers.current[field]);
    delete timers.current[field];
    delete waiting.current[field];
  }, []);

  const setFields = useCallback((patch: Partial<WidgetSettings>, opts: { delay?: number; draftOnly?: boolean } = {}) => {
    const delay = opts.delay ?? 500;
    setDraft((prev) => ({ ...prev, ...patch }));
    const fields = Object.keys(patch);
    if (opts.draftOnly) {
      // The server keeps its last valid value; nothing waits to replace it.
      for (const field of fields) cancelField(field);
      return;
    }
    for (const field of fields) {
      clearTimeout(timers.current[field]);
      waiting.current[field] = (patch as Record<string, unknown>)[field];
    }
    if (delay <= 0) {
      flushFields(fields);
      return;
    }
    setStatus('saving');
    for (const field of fields) {
      timers.current[field] = setTimeout(() => flushFields([field]), delay);
    }
  }, [cancelField, flushFields]);

  const setField = useCallback(
    (field: keyof WidgetSettings & string, value: unknown, delay = 500) =>
      setFields({ [field]: value } as Partial<WidgetSettings>, { delay }),
    [setFields],
  );

  const saveNow = useCallback((patch: Partial<WidgetSettings>) => send(patch, false), [send]);

  // Leaving the page: what still waits for its delay is sent, not dropped.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const onLeave = () => flushRef.current();
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      flushRef.current();
    };
  }, []);

  const live = useMemo<Partial<WidgetSettings>>(() => ({ ...widget, ...draft }), [widget, draft]);

  return { live, draft, setDraft, setField, setFields, saveNow, cancelField, flush, status, errorMessage };
}
