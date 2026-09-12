/**
 * Decode percent-encoded URLs/paths so non-Latin (Persian, Turkish, Arabic…) slugs
 * are displayed the same readable way a browser address bar shows them.
 * Falls back to the raw value when the input is not valid percent-encoding.
 */
export function prettyUrl(value: string | null | undefined): string {
  if (!value) return value ?? '';
  if (!value.includes('%')) return value;
  try {
    return decodeURI(value);
  } catch {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
}
