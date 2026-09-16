/**
 * Call Center — shared label resolvers.
 *
 * Every operator surface (Live Desk, call log, overview, media console)
 * renders the SAME raw backend vocabulary: `call_sessions.state`,
 * `end_reason`, `call_events.event_type`, `recording_state` and the
 * recording capability `reason` codes. Before this module each page
 * printed those codes verbatim ("ringing", "provider_not_configured",
 * "recording_stop_requested"), which is both untranslated and unreadable.
 *
 * These helpers map a code to a localized label with a safe fallback:
 * `t()` returns the key path when a key is missing, so an unknown code
 * coming from a newer backend degrades to a humanized version of the code
 * instead of leaking `callCenter.states.some_new_state` into the UI.
 */
import type { TranslationKey } from '@/i18n';

export type TFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** `some_unknown_code` → `Some unknown code`. */
export function humanizeCode(code: string): string {
  const s = code.replace(/[_-]+/g, ' ').trim();
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lookup(t: TFn, namespace: string, code: string | null | undefined): string | null {
  if (!code) return null;
  const key = `${namespace}.${code}`;
  const value = t(key as TranslationKey);
  // A miss returns the key path itself — treat that as "no translation".
  return value === key ? null : value;
}

function resolve(t: TFn, namespace: string, code: string | null | undefined, fallbackKey?: string): string {
  const hit = lookup(t, namespace, code);
  if (hit) return hit;
  if (code) return humanizeCode(code);
  if (fallbackKey) {
    const v = t(fallbackKey as TranslationKey);
    if (v !== fallbackKey) return v;
  }
  return '—';
}

/** `pending` / `ringing` / `active` / … → localized call state. */
export function callStateLabel(t: TFn, state: string | null | undefined): string {
  return resolve(t, 'callCenter.states', state, 'callCenter.states.unknown');
}

/** `visitor_ended` / `operator_ended` / … → localized end reason. */
export function endReasonLabel(t: TFn, reason: string | null | undefined): string {
  return resolve(t, 'callCenter.endReasons', reason, 'callCenter.endReasons.unknown');
}

/** `call_accepted` / `recording_started` / … → localized timeline entry. */
export function callEventLabel(t: TFn, eventType: string | null | undefined): string {
  return resolve(t, 'callCenter.events', eventType);
}

/** `recording` / `finalizing` / `available` / … → localized recording state. */
export function recordingStateLabel(t: TFn, state: string | null | undefined): string {
  return resolve(t, 'callCenter.rec.state', state, 'callCenter.rec.state.disabled');
}

/** `provider_not_configured` / `plan_forbidden` / … → why recording is unavailable. */
export function recordingReasonLabel(t: TFn, reason: string | null | undefined): string {
  return resolve(t, 'callCenter.rec.reason', reason, 'callCenter.rec.reason.unknown');
}

/**
 * Turn a thrown recording-control error into an operator-readable sentence.
 * The server sends a stable `error` code; the client's `jsonFetch` puts it on
 * both `err.code` and `err.message`, so match on either.
 */
export function recordingErrorMessage(t: TFn, error: unknown): string {
  const raw = String(
    (error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null)
      || (error instanceof Error ? error.message : error)
      || '',
  );
  const codes = [
    'recording_consent_missing',
    'provider_not_configured',
    'provider_not_supported',
    'room_not_ready',
    'recording_count_limit_reached',
    'recording_storage_limit_reached',
    'recording_not_active',
    'recording_finalizing',
    'recording_disabled',
  ];
  // Longest-first so `recording_disabled` never shadows a more specific code.
  for (const code of codes) {
    if (raw.includes(code)) return t(`callCenter.rec.errors.${code}` as TranslationKey);
  }
  return t('callCenter.rec.errors.generic');
}

/** Media-console error codes → operator-readable sentence. */
export function consoleErrorMessage(t: TFn, code: string | null | undefined): string {
  if (!code) return t('callCenter.console.error.unknown');
  const hit = lookup(t, 'callCenter.console.error', code);
  return hit ?? humanizeCode(code);
}

/** `composite` / `individual` / `audio_only` → localized recording type. */
export function recordingTypeLabel(t: TFn, type: string | null | undefined): string {
  return resolve(t, 'callCenter.recordingTypes', type, 'callCenter.recordingTypes.unknown');
}

/** `pending` / `in_progress` / … → localized callback status. */
export function callbackStatusLabel(t: TFn, status: string | null | undefined): string {
  return resolve(t, 'callCenter.callbackStatus', status);
}

/** One `<value, unit>` pair of a split duration, e.g. `5` + "minutes". */
export interface DurationPart {
  value: number;
  unit: string;
}

/**
 * Split a duration into localized `<value, unit>` pairs.
 *
 * Units are spelled out ("minutes" / "ثانیه" / "saniye"), never abbreviated:
 * a lone "ث" or "د" next to a number reads as noise rather than as a unit.
 * `<CallDuration>` renders the unit at a smaller size so the number still
 * carries the tile, and this function keeps the same wording for the plain
 * string form.
 *
 * A zero or missing duration still yields one part, so a metric tile shows
 * "0 seconds" rather than going blank.
 */
export function callDurationParts(t: TFn, seconds: number | null | undefined): DurationPart[] {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const parts: DurationPart[] = [];
  if (m > 0) {
    parts.push({ value: m, unit: t(m === 1 ? 'callCenter.duration.minute' : 'callCenter.duration.minutes') });
  }
  if (s > 0 || parts.length === 0) {
    parts.push({ value: s, unit: t(s === 1 ? 'callCenter.duration.second' : 'callCenter.duration.seconds') });
  }
  return parts;
}

/**
 * Human-readable duration ("5 minutes 30 seconds") with localized units.
 * Prefer `<CallDuration>` where the unit should be visually de-emphasized.
 */
export function formatCallDuration(t: TFn, seconds: number | null | undefined): string {
  return callDurationParts(t, seconds).map((p) => `${p.value} ${p.unit}`).join(' ');
}
