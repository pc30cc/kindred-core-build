/**
 * Outbound media fetch policy for `<provider>_outbound_media` jobs.
 *
 * The worker downloads the attachment and uploads the bytes to the provider
 * chat, so whatever it fetches ends up readable by whoever is on the other
 * side of that chat. The URL therefore must never be an arbitrary one:
 *
 *   - Legitimate URLs are minted by Core (`server/services/channels/
 *     mediaOutbound.ts`): `<apiBase>/api/conversation-attachments/<uuid>/
 *     public?exp=…&sig=…`, plus the same value as a relative `path`.
 *   - A signed-route URL on one of the worker's own configured Core bases is
 *     trusted as-is (those are frequently internal hostnames such as
 *     `http://core:3000`, which is exactly why the SSRF guard cannot apply).
 *   - ANY other URL — including the signed route on a host we do not know,
 *     e.g. the live public domain Core stamped at enqueue time — must pass the
 *     public-address SSRF guard; each redirect hop is re-validated.
 *   - The relative `path` is only ever combined with an internal base when it
 *     is exactly the signed media route.
 *   - Downloads are streamed with a hard byte cap.
 */
import {
  BoundedFetchError,
  assertPublicHttpUrl,
  fetchBytesBounded,
  type LookupAll,
} from '../../shared/net/boundedFetch.js';

/** Telegram / Bale bot uploads cap at 50 MB; Core itself stores ≤ 25 MB. */
export const OUTBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const MAX_PUBLIC_REDIRECTS = 3;

const SIGNED_ATTACHMENT_PATH_RE =
  /^\/api\/conversation-attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/public$/i;

/** True for `/api/conversation-attachments/<uuid>/public?exp=<n>&sig=<b64url>` (path+query, or a full URL). */
export function isSignedAttachmentUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value, 'http://relative.invalid');
  } catch {
    return false;
  }
  if (!SIGNED_ATTACHMENT_PATH_RE.test(url.pathname)) return false;
  const exp = url.searchParams.get('exp') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  return /^\d{1,12}$/.test(exp) && /^[A-Za-z0-9_-]{16,128}$/.test(sig);
}

/** A relative signed path — must start with a single `/` so it cannot become `//evil.host/...`. */
export function isSignedAttachmentPath(path: string): boolean {
  return /^\/(?!\/)/.test(path) && !/[\s\\]/.test(path) && isSignedAttachmentUrl(path);
}

/** Normalized `protocol//host[:port]` origins of the worker's own Core bases. */
export function trustedCoreOrigins(bases: Array<string | null | undefined>): Set<string> {
  const origins = new Set<string>();
  for (const base of bases) {
    if (!base) continue;
    try {
      const u = new URL(base.trim());
      if (u.protocol === 'http:' || u.protocol === 'https:') origins.add(u.origin.toLowerCase());
    } catch {
      /* ignore malformed env values */
    }
  }
  return origins;
}

export function internalBaseList(bases: Array<string | null | undefined>): string[] {
  return bases.map((b) => (b ? b.trim().replace(/\/+$/, '') : '')).filter(Boolean);
}

/** Ordered, de-duplicated download candidates for one attachment. */
export function outboundMediaCandidates(
  attachment: { url?: unknown; public_url?: unknown; path?: unknown } | null | undefined,
  internalBases: string[],
): string[] {
  const url = String(attachment?.url ?? attachment?.public_url ?? '');
  const relPath = attachment?.path ? String(attachment.path) : null;
  const candidates: string[] = [];
  if (/^https?:\/\//i.test(url)) candidates.push(url);
  // Domain-change resilience: rebuild the signed path against the worker's
  // own Core bases — but ONLY for the exact signed media route.
  if (relPath && isSignedAttachmentPath(relPath)) {
    for (const base of internalBases) candidates.push(`${base}${relPath}`);
  }
  return candidates.filter((u, i, arr) => arr.indexOf(u) === i);
}

/** True when `url` is the signed media route on one of our own Core origins. */
export function isTrustedCoreMediaUrl(url: URL, trusted: Set<string>): boolean {
  if (url.username || url.password) return false;
  return trusted.has(url.origin.toLowerCase()) && isSignedAttachmentUrl(url);
}

export interface OutboundMediaFetchOptions {
  trustedOrigins: Set<string>;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAll;
}

/** Downloads one candidate under the outbound media policy. */
export async function fetchOutboundMediaCandidate(
  candidate: string,
  opts: OutboundMediaFetchOptions,
): Promise<Uint8Array> {
  let initial: URL;
  try {
    initial = new URL(candidate);
  } catch {
    throw new BoundedFetchError('invalid_url');
  }
  const trustedInitial = isTrustedCoreMediaUrl(initial, opts.trustedOrigins);
  const { bytes } = await fetchBytesBounded(candidate, {
    maxBytes: opts.maxBytes ?? OUTBOUND_MEDIA_MAX_BYTES,
    // Core's signed route streams the bytes itself and never redirects.
    maxRedirects: trustedInitial ? 0 : MAX_PUBLIC_REDIRECTS,
    fetchImpl: opts.fetchImpl,
    validate: async (url) => {
      if (isTrustedCoreMediaUrl(url, opts.trustedOrigins)) return;
      // Our own Core serves nothing else the worker should ever download.
      if (opts.trustedOrigins.has(url.origin.toLowerCase())) throw new BoundedFetchError('host_not_allowed');
      await assertPublicHttpUrl(url, { allowHttp: true, lookupImpl: opts.lookupImpl });
    },
  });
  if (bytes.byteLength === 0) throw new BoundedFetchError('empty_body');
  return bytes;
}
