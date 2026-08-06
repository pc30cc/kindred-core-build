/**
 * Smart Engagement — pure, storage-agnostic helpers shared between the
 * production loader (public/widget/loader.js, ES5 IIFE) and this module.
 *
 * IMPORTANT: the loader keeps a hand-written ES5 copy of the functions
 * below (see the `smartFrequency:*` markers in loader.js). Behaviour must
 * stay byte-for-byte identical — src/test/widget/smartLoader.test.ts
 * extracts the loader's copies and runs both over the same inputs.
 */

/** ISO-8601 week key: "<isoYear>-W<ww>" (weeks run Mon-Sun, week 1 owns the year's first Thursday). */
export function isoWeekKey(date: Date): string {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : String(weekNo));
}

/** Versioned frequency-storage key. Publishing a new rule version starts fresh — no inheritance. */
export function buildFrequencyKey(workspaceId: string, ruleId: string, ruleVersion: number | string): string {
  return 'gs:smart:v1:' + workspaceId + ':' + ruleId + ':' + (ruleVersion || 1);
}

/** Versioned session-scoped key (page count, seed) — not per rule. */
export function buildSessionKey(workspaceId: string): string {
  return 'gs:smart:v1:' + workspaceId + ':session';
}

/** Stable idempotency key for a telemetry event; `occurrence` is a deterministic per-rule/event counter so retries reuse the same key. */
export function buildIdempotencyKey(
  sessionId: string,
  ruleId: string,
  ruleVersion: number | string,
  eventType: string,
  occurrence: number
): string {
  return (sessionId + ':' + ruleId + ':' + (ruleVersion || 1) + ':' + eventType + ':' + occurrence).slice(0, 160);
}

/** Dedupe key for `suppressed` telemetry — one per rule+reason per page load. */
export function suppressionDedupeKey(ruleId: string, reason: string): string {
  return ruleId + '::' + reason;
}
