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
 *
 * The Origin binds the page only as far as the workspace's allow-list does:
 * with an empty list (the default) or a plan without one, any site may run
 * the widget (server/services/widget/public.ts, getWorkspaceOriginRules), and
 * a request can name any site as its Origin. So the panel never lets the
 * visitor's `page_title` stand for the link: the link reads the page's real
 * host (pageLinkLabel), and the title is shown beside it as plain text.
 */

/**
 * `raw` as an absolute http(s) URL, or null (never throws). A user name or
 * password in it is dropped: a page needs none, and
 * `https://shop.example@evil.example/` must not read as the shop.
 */
export function httpPageUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    return url;
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

/** What a page link reads: where it really goes (its host), never the visitor's title. */
export function pageLinkLabel(url: URL): string {
  return url.hostname;
}
