/**
 * iOS keyboards silently insert invisible bidi/zero-width marks, non-breaking
 * spaces and Persian digits. They are never part of a real credential but they
 * do make an otherwise correct email/password mismatch on the server.
 */
const INVISIBLE_RE = /[\u200B-\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const PERSIAN_DIGITS = /[\u06F0-\u06F9\u0660-\u0669]/g;

export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_RE, '').replace(/\u00A0/g, ' ');
}

export function normalizeEmail(value: string): string {
  return stripInvisible(value)
    .replace(PERSIAN_DIGITS, (d) => String(((d.codePointAt(0) as number) & 0xf)))
    .trim()
    .toLowerCase();
}
