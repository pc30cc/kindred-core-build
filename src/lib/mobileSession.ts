/**
 * Mobile (Capacitor/iOS) session token storage.
 *
 * The native app cannot use the web's HttpOnly `gs_session` cookie: it runs
 * from `capacitor://localhost` against a different API origin, so the app
 * holds the SAME opaque 256-bit session token the server already mints for
 * the web and sends it as `Authorization: Bearer <token>`.
 *
 * Storage rules (security-critical):
 *  - the token lives in the iOS KEYCHAIN, via the app's own
 *    `SecureStorage` Capacitor plugin of the former iOS shell;
 *  - it is NEVER written to localStorage, sessionStorage, IndexedDB, cookies
 *    or Capacitor Preferences (all of which are plain, backed-up, and
 *    readable by anything running in the web view);
 *  - if the Keychain plugin is somehow unavailable, we degrade to an
 *    in-memory-only token (the user simply has to log in again after an app
 *    restart) rather than silently falling back to insecure storage.
 *
 * This module is inert on the web: every function short-circuits when
 * `isNativePlatform()` is false, so nothing about the browser session
 * changes.
 */
import { isNativePlatform } from './native';
import { SHIPS_IRAN_KIT } from '../../shared/buildBrand';

const KEYCHAIN_KEY = 'app.session.token';

/**
 * Where the token was kept before the key was renamed. Only the Iranian build
 * (SHIPS_IRAN_KIT) reads it, once, to move the token to KEYCHAIN_KEY: the
 * native shell that holds such a token is the Iranian edition's. A build
 * without that kit (RESPOK's) neither names nor reads it.
 */
const LEGACY_KEYCHAIN_KEY = SHIPS_IRAN_KIT ? 'webyar.session.token' : null;

interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

function securePlugin(): SecureStoragePlugin | null {
  try {
    const plugin = (window as unknown as { Capacitor?: { Plugins?: { SecureStorage?: SecureStoragePlugin } } })
      .Capacitor?.Plugins?.SecureStorage;
    return plugin && typeof plugin.get === 'function' ? (plugin as SecureStoragePlugin) : null;
  } catch {
    return null;
  }
}

/** In-memory mirror so the hot path (every API call) is synchronous. */
let cachedToken: string | null = null;
let hydration: Promise<string | null> | null = null;

/**
 * Loads the token from the Keychain once per app launch. Safe to call
 * repeatedly — subsequent calls await the same promise.
 */
export function hydrateMobileSession(): Promise<string | null> {
  if (!isNativePlatform()) return Promise.resolve(null);
  if (hydration) return hydration;
  hydration = (async () => {
    const plugin = securePlugin();
    if (!plugin) return null;
    try {
      const { value } = await plugin.get({ key: KEYCHAIN_KEY });
      cachedToken = value && typeof value === 'string' ? value : null;
      if (!cachedToken && LEGACY_KEYCHAIN_KEY) cachedToken = await moveLegacyToken(plugin, LEGACY_KEYCHAIN_KEY);
    } catch {
      // A Keychain read failure is NOT a logout signal — it is a device-level
      // error. Leave whatever is cached in memory untouched.
    }
    return cachedToken;
  })();
  return hydration;
}

/** A token still under the old key: moved to KEYCHAIN_KEY (best effort) and returned. */
async function moveLegacyToken(plugin: SecureStoragePlugin, legacyKey: string): Promise<string | null> {
  const { value } = await plugin.get({ key: legacyKey });
  if (!value || typeof value !== 'string') return null;
  try {
    await plugin.set({ key: KEYCHAIN_KEY, value });
    await plugin.remove({ key: legacyKey });
  } catch {
    /* kept under the old key: read from there again next launch */
  }
  return value;
}

/** Synchronous read of the already-hydrated token (null on web). */
export function getMobileSessionTokenSync(): string | null {
  return isNativePlatform() ? cachedToken : null;
}

/** Awaits hydration on first use, then returns the token (null on web). */
export async function getMobileSessionToken(): Promise<string | null> {
  if (!isNativePlatform()) return null;
  if (cachedToken) return cachedToken;
  return hydrateMobileSession();
}

/** Persists a freshly minted session token to the Keychain. */
export async function setMobileSessionToken(token: string): Promise<void> {
  if (!isNativePlatform() || !token) return;
  cachedToken = token;
  hydration = Promise.resolve(token);
  const plugin = securePlugin();
  if (!plugin) return;
  try {
    await plugin.set({ key: KEYCHAIN_KEY, value: token });
  } catch {
    // Keep the in-memory token: the session is still valid for this launch.
  }
}

/**
 * Clears the stored token. ONLY call this for a genuine end-of-session
 * event (confirmed logout, or the server telling us the session is gone) —
 * never for a network error or an API timeout, which must never log a user
 * out of the app.
 */
export async function clearMobileSessionToken(): Promise<void> {
  cachedToken = null;
  hydration = Promise.resolve(null);
  const plugin = securePlugin();
  if (!plugin) return;
  try {
    await plugin.remove({ key: KEYCHAIN_KEY });
    if (LEGACY_KEYCHAIN_KEY) await plugin.remove({ key: LEGACY_KEYCHAIN_KEY });
  } catch {
    /* best effort */
  }
}
