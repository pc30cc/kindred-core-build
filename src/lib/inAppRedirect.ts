/**
 * The `?redirect=` of a sign-in page as a path inside this app, or the
 * fallback.
 *
 * react-router-dom 6 (GHSA-wrjc-x8rr-h8h6, fixed only in 7.18) hands a path
 * such as `/\evil.example` to history.pushState as it is. The browser reads
 * the backslash as a slash (`//evil.example`), the cross-origin pushState
 * throws, and the router falls back to window.location.assign: after signing
 * in, the visitor lands on the other site. So only a value that resolves to
 * this page's own scheme and host is kept, rebuilt from its parts.
 */
export function inAppRedirect(
  raw: string | null | undefined,
  fallback: string,
  base: string = window.location.href,
): string {
  if (!raw || !raw.startsWith('/')) return fallback;
  try {
    const here = new URL(base);
    const url = new URL(raw, here);
    // Scheme and host rather than origin: the iOS shell's capacitor:// page
    // has the opaque origin "null".
    if (url.protocol !== here.protocol || url.host !== here.host) return fallback;
    const target = `${url.pathname}${url.search}${url.hash}`;
    return target.startsWith('//') ? fallback : target;
  } catch {
    return fallback;
  }
}
