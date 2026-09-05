/**
 * ONE shared authenticated transport for first-party API calls.
 *
 *  - Web      → unchanged: `credentials: 'include'`, so the existing
 *               HttpOnly `gs_session` cookie is sent exactly as before.
 *  - Native   → the opaque session token from the iOS Keychain is attached
 *    (Capacitor) as `Authorization: Bearer <token>`; cookies are not used.
 *
 * `installAuthTransport()` additionally patches `window.fetch` INSIDE THE
 * NATIVE SHELL ONLY, so that the dozens of existing first-party API modules
 * (all of which already call `fetch` with `credentials: 'include'`) become
 * Bearer-authenticated without a second, divergent mobile auth path. On the
 * web the patch is never installed and `fetch` is untouched.
 *
 * The token is attached ONLY to first-party API URLs (same origin as the
 * app, or the configured API base). Third-party URLs never see it.
 */
import { API_BASE } from './apiBase';
import { isNativePlatform } from './native';
import { getMobileSessionTokenSync, hydrateMobileSession } from './mobileSession';

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** True for URLs that belong to this app's own backend. */
export function isFirstPartyApiUrl(input: string): boolean {
  const raw = String(input || '');
  // Relative URL → same origin as the app → first-party by definition.
  if (raw.startsWith('/')) return true;
  const target = normalizeOrigin(raw);
  if (!target) return false;
  const apiOrigin = API_BASE ? normalizeOrigin(API_BASE) : null;
  if (apiOrigin && target === apiOrigin) return true;
  try {
    if (target === window.location.origin.toLowerCase()) return true;
  } catch {
    /* no window (tests) */
  }
  return false;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request)?.url ?? '';
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers || {});
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  // Lets the backend recognise a native client on the login endpoint and in
  // audit logs. Harmless (and absent) on the web.
  if (!headers.has('X-Client-Platform')) headers.set('X-Client-Platform', 'ios');
  return { ...init, headers };
}

/**
 * Authenticated fetch for first-party API calls. Use this instead of a bare
 * `fetch` for anything that needs the signed-in user.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = urlOf(input);
  if (!isNativePlatform() || !isFirstPartyApiUrl(url)) {
    return fetch(input, { credentials: 'include', ...init });
  }
  const token = getMobileSessionTokenSync() ?? (await hydrateMobileSession());
  if (!token) return fetch(input, { ...init });
  return fetch(input, withBearer(init, token));
}

let installed = false;

/**
 * Native-only global transport install. Called once at app start, AFTER the
 * Keychain token has been hydrated, so every existing API module gets the
 * Bearer header without being rewritten.
 */
export function installAuthTransport(): void {
  if (installed || typeof window === 'undefined' || !isNativePlatform()) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = urlOf(input);
      if (!isFirstPartyApiUrl(url)) return original(input, init);
      const token = getMobileSessionTokenSync();
      if (!token) return original(input, init);
      return original(input, withBearer(init, token));
    } catch {
      return original(input, init);
    }
  }) as typeof window.fetch;
}
