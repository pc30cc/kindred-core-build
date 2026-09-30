/**
 * The app a platform-support operator wrote from (docs/PLATFORM_SUPPORT.md):
 * the server stores it as `client_platform` on the conversation and on the
 * contact, and the inbox shows it next to their name — "Site user · Android".
 */
export type ClientPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'web';

/** Product names, so never translated. */
export const CLIENT_PLATFORM_NAMES: Record<ClientPlatform, string> = {
  android: 'Android',
  ios: 'iOS',
  macos: 'macOS',
  windows: 'Windows',
  web: 'Web',
};

/**
 * `client_platform` on the first metadata blob that names a known one —
 * pass the conversation's before the contact's, as for `resolveChannelKey`.
 */
export function resolveClientPlatform(...sources: Array<unknown>): ClientPlatform | null {
  for (const src of sources) {
    const meta = (src ?? {}) as Record<string, unknown>;
    const raw = typeof meta.client_platform === 'string' ? meta.client_platform.trim().toLowerCase() : '';
    if (Object.prototype.hasOwnProperty.call(CLIENT_PLATFORM_NAMES, raw)) return raw as ClientPlatform;
  }
  return null;
}
