/**
 * CANONICAL CONTRACT for a stored `workspace_domains.domain` value.
 *
 * The origin resolver is INDEXED on the generated column
 * `workspace_domains.normalized_domain`, which is defined as:
 *
 *   regexp_replace(regexp_replace(regexp_replace(
 *     lower(btrim(domain)), '^https?://', ''), '[:/?#].*$', ''), '^www\.', '')
 *
 * Anything the API stores must therefore normalize — through that exact
 * expression — to a plain, lowercase, ASCII (punycode) registrable hostname.
 * If we ever store a value the expression cannot reduce to such a hostname
 * (a wildcard, an IP literal, a value with a port or a path), the row is
 * silently unresolvable: the customer sees a "configured" domain whose widget
 * never gets CORS headers. So the API validates up front and REJECTS instead
 * of storing an unresolvable representation.
 *
 * Explicit decisions:
 *  - protocol  : `http://` / `https://` accepted and STRIPPED; any other
 *                scheme rejected.
 *  - path/query: a bare trailing `/` is stripped; any real path, `?` or `#`
 *                is rejected (it is not part of an origin's host).
 *  - port      : rejected — the widget allow-list matches on HOSTNAME, so a
 *                port would be dropped and mislead the operator.
 *  - whitespace: outer whitespace trimmed; any inner whitespace rejected.
 *  - dots      : leading/trailing/duplicate dots rejected.
 *  - `www.`    : stripped (www and apex are equivalent by design).
 *  - wildcard  : `*.example.com` REJECTED. Subdomain coverage is a per
 *                workspace switch (`widget_settings.allow_subdomains`), which
 *                the indexed resolver understands; a wildcard ROW would not
 *                be found by an exact/suffix index probe. Existing wildcard
 *                rows keep working in `isOriginAllowed()` for backward
 *                compatibility, but no new one can be created.
 *  - localhost / IP literals (v4 and v6): rejected — not routable tenant
 *                origins and not uniquely ownable.
 *  - IDN       : accepted and converted to punycode (`xn--`), so the stored
 *                value matches what a browser sends in `Origin`.
 *  - public suffix: `com.tr`, `co.ir`, `vercel.app`, `github.io` (the Public
 *                Suffix List, its private part included) REJECTED — nobody's
 *                own site, and as a verified domain whose widget allows
 *                subdomains (every signup website's, migration 239) it would
 *                hold every site under it (services/ownerWebsite.ts). A name
 *                under a TLD the list does not know (`shop.example`,
 *                `shop.local`) is accepted as before.
 */

import { parse as parseDomainName } from 'psl';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export type DomainInputResult =
  | { ok: true; domain: string }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): DomainInputResult {
  return { ok: false, code, message };
}

/**
 * The registrable domain of a canonical host by the Public Suffix List
 * (`a.shop.com.tr` → `shop.com.tr`, `a.b.github.io` → `b.github.io`), or
 * null when the host is itself a public suffix. A TLD the list does not know
 * counts as one label (`a.shop.example` → `shop.example`), `.local` too,
 * which the library leaves unread.
 */
export function registrableDomain(host: string): string | null {
  const parsed = parseDomainName(host);
  if ('error' in parsed) return null;
  if (parsed.domain) return parsed.domain;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (!parsed.listed) return labels.slice(-2).join('.');
  // The base of a wildcard rule (`*.paywhirl.com`) is registrable itself,
  // though the library reads it as listed: one more label is a suffix too.
  const deeper = parseDomainName(`x.${host}`);
  return !('error' in deeper) && deeper.domain === null ? host : null;
}

export function parseWorkspaceDomainInput(rawInput: unknown): DomainInputResult {
  if (typeof rawInput !== 'string') return fail('INVALID_TYPE', 'Domain must be a string.');

  let value = rawInput.trim();
  if (!value) return fail('EMPTY', 'Domain is required.');
  if (/\s/.test(value)) return fail('WHITESPACE', 'Domain must not contain spaces.');
  if (value.length > 253 + 8) return fail('TOO_LONG', 'Domain is too long.');

  if (value.startsWith('*.') || value.includes('*')) {
    return fail(
      'WILDCARD_NOT_ALLOWED',
      'Wildcards are not accepted. Add the root domain and enable "allow subdomains" instead.',
    );
  }

  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return fail('INVALID_SCHEME', 'Only http:// and https:// prefixes are accepted.');
    }
    value = value.slice(schemeMatch[0].length);
  } else if (value.includes('://')) {
    return fail('INVALID_SCHEME', 'Only http:// and https:// prefixes are accepted.');
  }

  if (value.includes('@')) return fail('USERINFO_NOT_ALLOWED', 'Credentials are not allowed in a domain.');

  // A single trailing slash is tolerated (people paste "example.com/").
  if (value.endsWith('/')) value = value.slice(0, -1);
  if (/[/?#]/.test(value)) {
    return fail('PATH_NOT_ALLOWED', 'Enter only the domain — no path, query string or fragment.');
  }
  if (value.startsWith('[') || value.includes(':')) {
    // Covers both "example.com:8080" and IPv6 literals.
    return fail('PORT_NOT_ALLOWED', 'Ports and IP literals are not allowed — enter only the hostname.');
  }

  value = value.toLowerCase();
  if (value.startsWith('www.')) value = value.slice(4);
  if (!value) return fail('EMPTY', 'Domain is required.');

  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    return fail('MALFORMED', 'Domain has a misplaced dot.');
  }

  // Internationalized domains → punycode, matching what browsers send.
  let ascii: string;
  try {
    const url = new URL(`https://${value}`);
    ascii = url.hostname.toLowerCase();
    if (url.port || url.pathname !== '/' || url.search || url.hash) {
      return fail('MALFORMED', 'Enter only the domain — no path, port, query string or fragment.');
    }
  } catch {
    return fail('MALFORMED', 'This does not look like a valid domain.');
  }
  if (ascii.startsWith('www.')) ascii = ascii.slice(4);

  if (ascii === 'localhost' || ascii.endsWith('.localhost')) {
    return fail('LOCALHOST_NOT_ALLOWED', 'localhost is not a valid workspace domain.');
  }
  if (IPV4_RE.test(ascii) || ascii.startsWith('[')) {
    return fail('IP_NOT_ALLOWED', 'IP addresses are not valid workspace domains.');
  }

  const labels = ascii.split('.');
  if (labels.length < 2) return fail('MALFORMED', 'Enter a full domain, for example example.com.');
  if (ascii.length > 253) return fail('TOO_LONG', 'Domain is too long.');
  for (const label of labels) {
    if (!label || label.length > 63 || !LABEL_RE.test(label)) {
      return fail('MALFORMED', 'This does not look like a valid domain.');
    }
  }
  if (!TLD_RE.test(labels[labels.length - 1])) {
    return fail('MALFORMED', 'This does not look like a valid domain extension.');
  }
  // Checked without any leading www., as the row's normalize steps store it.
  let bare = ascii;
  while (bare.startsWith('www.')) bare = bare.slice(4);
  if (!registrableDomain(bare)) return fail('MALFORMED', 'This does not look like a valid domain.');

  return { ok: true, domain: ascii };
}
