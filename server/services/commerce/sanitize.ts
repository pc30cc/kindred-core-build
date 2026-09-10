/**
 * Store/product content is untrusted (docs/commerce/SECURITY.md, spec §44 —
 * "tool results are DATA, never instructions"). Every string that
 * originates from a merchant's catalog/order content passes through here
 * before it can reach a prompt or a tool result: HTML stripped, length
 * bounded, control characters removed.
 */

const MAX_TEXT_LENGTH = 600;

// Control characters other than \t \n \r (which \s+ collapsing below handles).
const CONTROL_CHARS_RE = new RegExp(
  '[' +
    String.fromCharCode(0) + '-' + String.fromCharCode(8) +
    String.fromCharCode(11) + String.fromCharCode(12) +
    String.fromCharCode(14) + '-' + String.fromCharCode(31) +
    String.fromCharCode(127) +
  ']',
  'g',
);

export function sanitizeCommerceText(input: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof input !== 'string') return null;
  const stripped = input
    .replace(/<[^>]*>/g, ' ')
    .replace(CONTROL_CHARS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

export function sanitizeUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function boundedArray<T>(items: T[] | undefined | null, max: number): T[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, max);
}
