/**
 * Domain normalization & matching utilities.
 * Handles www/non-www equivalence, protocol stripping, and subdomain matching.
 */

/**
 * Normalize a raw domain input to a canonical lowercase hostname.
 * Strips protocol, www prefix, trailing slashes, ports, and paths.
 *
 * Examples:
 *   "https://www.Example.com/"  → "example.com"
 *   "http://Example.COM:8080/x" → "example.com"
 *   "www.example.com"           → "example.com"
 *   "example.com"               → "example.com"
 */
export function normalizeDomain(input: string): string {
  let raw = input.trim();

  // If no protocol, prepend one so URL constructor works
  if (!/^https?:\/\//i.test(raw)) {
    raw = 'https://' + raw;
  }

  try {
    const url = new URL(raw);
    let host = url.hostname.toLowerCase();

    // Strip leading www.
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }

    return host;
  } catch {
    // Fallback: lowercase, strip common prefixes
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .replace(/:.*$/, '')
      .toLowerCase()
      .trim();
  }
}

/**
 * Extract hostname from an origin or URL string.
 * Returns lowercase hostname, or null if unparseable.
 */
export function extractHostname(origin: string): string | null {
  try {
    let raw = origin.trim();
    if (!/^https?:\/\//i.test(raw)) {
      raw = 'https://' + raw;
    }
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check if an incoming origin is allowed by the workspace's domain list.
 *
 * Rules:
 * - www and non-www are equivalent by default
 * - Subdomains (app.example.com) only allowed when allowSubdomains is true
 * - Wildcard entries (*.example.com) still supported for backwards compat
 * - An EMPTY / unconfigured allow-list is fail-closed (returns false).
 *   Callers that intentionally want the legacy "unconfigured = allow all"
 *   behaviour must opt in explicitly via `allowWhenUnconfigured`.
 *
 * @param originUrl   - The full origin URL (e.g. "https://www.example.com")
 * @param allowedDomains - Array of stored domain strings (already normalized or raw)
 * @param allowSubdomains - Whether to auto-allow subdomains of registered root domains
 */
export function isOriginAllowed(
  originUrl: string,
  allowedDomains: string[],
  allowSubdomains: boolean = false,
  options: { allowWhenUnconfigured?: boolean } = {},
): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    return options.allowWhenUnconfigured === true;
  }

  const originHost = extractHostname(originUrl);
  if (!originHost) return false;

  // Strip www from origin for comparison
  const originBare = originHost.startsWith('www.')
    ? originHost.slice(4)
    : originHost;

  for (const raw of allowedDomains) {
    // Legacy wildcard support: *.example.com
    if (raw.startsWith('*.')) {
      const wildcardRoot = raw.slice(2).toLowerCase();
      if (
        originBare === wildcardRoot ||
        originHost === wildcardRoot ||
        originHost.endsWith('.' + wildcardRoot)
      ) {
        return true;
      }
      continue;
    }

    const domainBare = normalizeDomain(raw);

    // Exact match (www/non-www equivalent)
    if (originBare === domainBare) return true;

    // Subdomain match
    if (allowSubdomains && originBare.endsWith('.' + domainBare)) {
      return true;
    }
  }

  return false;
}
