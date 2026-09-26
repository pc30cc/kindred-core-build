/**
 * Validation helpers for dates arriving in request input (query/body).
 *
 * `new Date(<bad input>).toISOString()` throws a RangeError ("Invalid time
 * value"), and a plain `\d{4}-\d{2}-\d{2}` regex still admits impossible
 * calendar dates (2024-13-01 throws; 2024-02-31 silently rolls over to
 * March). Validate first and answer 400 instead.
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real calendar date written as YYYY-MM-DD. */
export function isValidYmdDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = YMD_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** True when `new Date(value).toISOString()` will not throw. */
export function isParseableDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}
