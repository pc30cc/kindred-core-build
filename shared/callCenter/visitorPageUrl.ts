/**
 * The page a call-widget visitor was on (`page_url` of a call or a callback),
 * as an address the Call Center may link to.
 *
 * The widget sends `location.href`, but the request body is the visitor's to
 * write: it could name any site (or a `javascript:` URL), under a
 * `page_title` of its choosing, and an operator would open it from the call's
 * "Page" link. So the server keeps a page only when it is an http(s) address
 * on the site the widget runs on, the request's Origin: same scheme and host
 * (server/routes/callWidget.ts). The panel checks a call's page again against
 * the call's stored `origin`, for rows written before that check.
 */

/** `raw` as an absolute http(s) URL, or null (never throws). */
export function httpPageUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** `raw` as an http(s) URL on the site `origin` (same scheme and host), or null. */
export function visitorPageUrl(raw: unknown, origin: unknown): URL | null {
  const url = httpPageUrl(raw);
  const site = httpPageUrl(origin);
  if (!url || !site) return null;
  return url.protocol === site.protocol && url.host === site.host ? url : null;
}
