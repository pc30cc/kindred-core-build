import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import {
  callEventLabel,
  callStateLabel,
  callbackStatusLabel,
  consoleErrorMessage,
  endReasonLabel,
  formatCallDuration,
  humanizeCode,
  recordingErrorMessage,
  recordingReasonLabel,
  recordingStateLabel,
  recordingTypeLabel,
  type TFn,
} from '@/features/calls/callLabels';

/**
 * The Call Center operator surfaces used to print the backend's own
 * vocabulary straight into the UI — "ringing", "provider_not_configured",
 * "recording_stop_requested" — and the media console was written entirely in
 * hardcoded English. These tests lock in the two rules that fixed that:
 *
 *   1. Every code the backend can emit has a translation in all three
 *      locales, so nothing falls through to a raw code.
 *   2. An UNKNOWN code (a newer backend, a provider-specific reason) still
 *      degrades to readable text rather than leaking a `callCenter.*.foo`
 *      key path into the operator's screen.
 */

type Dict = Record<string, unknown>;

/** Mirrors the real `t()`: nested lookup, key path on a miss, {{param}} interpolation. */
function makeT(dict: Dict): TFn {
  return (key, params) => {
    const parts = String(key).split('.');
    let cur: unknown = dict;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return String(key);
      cur = (cur as Dict)[p];
    }
    if (typeof cur !== 'string') return String(key);
    let out = cur;
    for (const [k, v] of Object.entries(params || {})) {
      out = out.replace(`{{${k}}}`, String(v));
    }
    return out;
  };
}

const LOCALES: Record<string, Dict> = {
  en: en as unknown as Dict,
  fa: fa as unknown as Dict,
  tr: tr as unknown as Dict,
};

/** Codes the Call Center backend actually writes into `call_sessions.state`. */
const CALL_STATES = [
  'pending', 'queued', 'ringing', 'connecting', 'active',
  'completed', 'ended', 'cancelled', 'missed', 'failed',
];

/** Codes written into `call_sessions.end_reason`. */
const END_REASONS = [
  'operator_ended', 'visitor_ended', 'visitor_cancelled', 'operator_rejected',
  'timeout', 'no_answer', 'transferred', 'failed',
];

/**
 * Event types inserted into `call_events` by the Call Center routes and by
 * `recordingControl.ts`. These are what the Live Desk timeline renders.
 */
const EVENT_TYPES = [
  'call_requested', 'call_queued', 'call_accepted', 'call_rejected',
  'call_ended', 'call_missed', 'call_cancelled', 'call_transferred',
  'recording_start_requested', 'recording_started',
  'recording_stop_requested', 'recording_stopped', 'recording_failed',
  'operator_note_added',
];

/** `call_sessions.recording_state` values, plus the derived UI-only states. */
const RECORDING_STATES = [
  'disabled', 'consent_pending', 'pending', 'recording',
  'finalizing', 'available', 'failed', 'ready',
];

/** `RecordingCapability.reason` codes from `services/callCenter/recording.ts`. */
const RECORDING_REASONS = [
  'platform_disabled', 'plan_forbidden', 'workspace_disabled',
  'provider_not_supported', 'provider_not_configured', 'consent_missing',
];

/** `RecordingControlError` codes thrown by `recordingControl.ts`. */
const RECORDING_ERRORS = [
  'recording_disabled', 'recording_consent_missing', 'provider_not_supported',
  'provider_not_configured', 'room_not_ready', 'recording_not_active',
  'recording_finalizing', 'recording_count_limit_reached',
  'recording_storage_limit_reached',
];

/** Media-console failure codes raised by `OperatorMediaConsole`. */
const CONSOLE_ERRORS = [
  'livekit_client_load_failed', 'livekit_client_invalid',
  'provider_client_not_configured', 'provider_client_not_supported',
  'provider_client_not_ready', 'microphone_permission_denied',
  'camera_permission_denied', 'room_connect_failed', 'room_disconnected',
  'token_expired', 'livekit_url_missing', 'reconnect_failed',
  'backend_end_failed',
];

/** A translated label is never empty and never a leaked `callCenter.*` key path. */
function expectTranslated(value: string, code: string, locale: string) {
  expect(value, `${locale}: "${code}"`).toBeTruthy();
  expect(value, `${locale}: "${code}" leaked a key path`).not.toMatch(/^callCenter\./);
}

describe.each(Object.keys(LOCALES))('call center operator labels (%s)', (locale) => {
  const t = makeT(LOCALES[locale]);

  it('translates every call state', () => {
    for (const code of CALL_STATES) expectTranslated(callStateLabel(t, code), code, locale);
  });

  it('translates every end reason', () => {
    for (const code of END_REASONS) expectTranslated(endReasonLabel(t, code), code, locale);
  });

  it('translates every timeline event type', () => {
    for (const code of EVENT_TYPES) expectTranslated(callEventLabel(t, code), code, locale);
  });

  it('translates every recording state and capability reason', () => {
    for (const code of RECORDING_STATES) expectTranslated(recordingStateLabel(t, code), code, locale);
    for (const code of RECORDING_REASONS) expectTranslated(recordingReasonLabel(t, code), code, locale);
  });

  it('translates every recording-control error code', () => {
    for (const code of RECORDING_ERRORS) {
      // The client sees the code on `err.code` and inside `err.message`.
      expectTranslated(recordingErrorMessage(t, { code }), code, locale);
      expectTranslated(recordingErrorMessage(t, new Error(code)), code, locale);
    }
  });

  it('translates every media-console error code', () => {
    for (const code of CONSOLE_ERRORS) expectTranslated(consoleErrorMessage(t, code), code, locale);
  });

  it('translates recording types and callback statuses', () => {
    for (const code of ['composite', 'individual', 'audio_only']) {
      expectTranslated(recordingTypeLabel(t, code), code, locale);
    }
    for (const code of ['requested', 'pending', 'in_progress', 'scheduled', 'completed', 'cancelled']) {
      expectTranslated(callbackStatusLabel(t, code), code, locale);
    }
  });

  it('localizes duration units', () => {
    const unit = (LOCALES[locale] as { callCenter: { duration: Record<string, string> } })
      .callCenter.duration;
    expect(formatCallDuration(t, 95)).toBe(`1${unit.minuteShort} 35${unit.secondShort}`);
    expect(formatCallDuration(t, 7)).toBe(`7${unit.secondShort}`);
    expect(formatCallDuration(t, null)).toBe(`0${unit.secondShort}`);
  });

  it('degrades an unknown code to readable text, never a key path', () => {
    expect(callStateLabel(t, 'brand_new_state')).toBe('Brand new state');
    expect(callEventLabel(t, 'some_future_event')).toBe('Some future event');
    expect(recordingReasonLabel(t, 'provider_said_no')).toBe('Provider said no');
    expect(consoleErrorMessage(t, 'weird_media_failure')).toBe('Weird media failure');
  });

  it('falls back to the localized unknown label when the code is absent', () => {
    expectTranslated(callStateLabel(t, null), 'null', locale);
    expectTranslated(endReasonLabel(t, undefined), 'undefined', locale);
    expect(callEventLabel(t, null)).toBe('—');
  });

  it('never returns the generic recording error for a known code', () => {
    const generic = t('callCenter.rec.errors.generic');
    for (const code of RECORDING_ERRORS) {
      expect(recordingErrorMessage(t, { code }), code).not.toBe(generic);
    }
    // An unrecognized failure still gets a sentence rather than a raw string.
    expect(recordingErrorMessage(t, new Error('boom'))).toBe(generic);
  });
});

describe('humanizeCode', () => {
  it('turns a snake_case code into a sentence', () => {
    expect(humanizeCode('provider_not_configured')).toBe('Provider not configured');
    expect(humanizeCode('a-b')).toBe('A b');
    expect(humanizeCode('')).toBe('—');
  });
});

describe('operator surfaces carry no hardcoded English', () => {
  /**
   * The media console was the worst offender: phase labels, control buttons,
   * device pickers and error copy were all literal English. Guard the files
   * that an operator actually reads during a call.
   */
  const FILES = [
    'src/components/call-center/OperatorMediaConsole.tsx',
    'src/pages/app/call-center/LiveQueuePage.tsx',
    'src/features/calls/OperatorRecordingControls.tsx',
    'src/features/calls/TransferCallDialog.tsx',
    'src/features/calls/CallNotesPanel.tsx',
  ];

  /** Strip comments so prose explaining the fix is not mistaken for UI copy. */
  function codeOf(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  it.each(FILES)('%s renders no literal English JSX text', (file) => {
    const code = codeOf(file);
    // A JSX text node of two or more English words between tags.
    const offenders = [...code.matchAll(/>\s*([A-Z][a-z]+(?:\s+[A-Za-z]+){1,6})\s*</g)]
      .map((m) => m[1].trim())
      // Single-token identifiers inside expressions are not prose.
      .filter((s) => /\s/.test(s));
    expect(offenders, `hardcoded JSX text in ${file}`).toEqual([]);
  });

  it.each(FILES)('%s passes no literal English to title/placeholder/aria-label', (file) => {
    const code = codeOf(file);
    const offenders = [...code.matchAll(/(?:title|placeholder|aria-label)=["']([A-Z][a-z]+\s+[^"']+)["']/g)]
      .map((m) => m[1]);
    expect(offenders, `hardcoded attribute text in ${file}`).toEqual([]);
  });
});
