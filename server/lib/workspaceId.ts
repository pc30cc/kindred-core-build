/**
 * One spelling per workspace id.
 *
 * PostgreSQL's uuid input accepts upper case, braces, missing hyphens and a
 * hyphen after any group of four digits, and reads them all as the same row.
 * A cache keyed on the raw string would give every spelling of one real
 * workspace its own entry (a full rebuild each, in the main LRU) and its own
 * rate-limit bucket. Every widget entry point therefore canonicalises the id
 * it is given before any cache, bucket, token or query sees it.
 */

/**
 * The canonical form (lower case, 8-4-4-4-12) of a uuid in any spelling
 * PostgreSQL accepts, or null when `value` is not one.
 */
export function canonicalWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  let s = value.trim();
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  s = s.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
