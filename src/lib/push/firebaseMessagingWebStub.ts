/**
 * Build-time stub for `firebase/messaging`.
 *
 * @capacitor-firebase/messaging ships a WEB implementation that statically
 * imports the Firebase JS SDK. Webyar uses this plugin on native iOS/Android
 * only (see src/lib/push/nativePush.ts, which no-ops off native), so the web
 * bundle must not pull in — or require — the optional `firebase` package.
 * Aliasing that specifier here keeps the web build self-contained; every
 * export throws if it is ever reached in a browser.
 */
function unavailable(): never {
  throw new Error('Firebase web messaging is not enabled in this build (native push only).');
}

export const deleteToken = unavailable;
export const getMessaging = unavailable;
export const getToken = unavailable;
export const onMessage = unavailable;
export async function isSupported(): Promise<boolean> {
  return false;
}
