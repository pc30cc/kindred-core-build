/**
 * FIREBASE'S CLIENT IDENTIFIERS FOR THE ANDROID APP.
 *
 * The four values of the `google-services.json` Firebase issues for the
 * Android package: set in Super Admin → Mobile App → Android → Identity,
 * served to the app by GET /api/mobile-app/config (`firebase`), and used by
 * the app to start Firebase for push.
 *
 * Client identifiers, not credentials: every APK built with them carries
 * them in the clear. The key that can actually send — the FCM service
 * account — stays in the server environment and never passes through here.
 */
import { z } from 'zod';

/** `1:<project number>:android:<hex>` — mobilesdk_app_id. */
export const FIREBASE_ANDROID_APP_ID = /^1:(\d{6,20}):android:[0-9a-f]{6,40}$/;
/** client[].api_key[].current_key — Google API keys all start `AIza`. */
export const FIREBASE_API_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
/** project_info.project_id: 6–30 characters, lowercase, digits and hyphens. */
export const FIREBASE_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** project_info.project_number, also the FCM sender id. */
export const FIREBASE_SENDER_ID = /^\d{6,20}$/;

/**
 * One identifier in its own format, so a value pasted into the wrong field
 * is refused at the save rather than failing on every phone. Empty clears it.
 */
function field(pattern: RegExp, message: string) {
  return z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || pattern.test(v), message)
    .transform((v) => (v === '' ? null : v))
    .nullable();
}

export const firebaseClientFields = {
  android_firebase_app_id: field(FIREBASE_ANDROID_APP_ID, 'not an Android Firebase app id').optional(),
  android_firebase_api_key: field(FIREBASE_API_KEY, 'not a Firebase API key').optional(),
  android_firebase_project_id: field(FIREBASE_PROJECT_ID, 'not a Firebase project id').optional(),
  android_firebase_sender_id: field(FIREBASE_SENDER_ID, 'not a Firebase project number').optional(),
};

/**
 * Whether an app id and a project number belong to the same Firebase
 * project — the app id carries the number. Two values from two projects
 * would start Firebase against one and register with the other. Either
 * missing is no disagreement.
 */
export function firebaseProjectsMatch(appId: string | null | undefined, senderId: string | null | undefined): boolean {
  if (!appId || !senderId) return true;
  return FIREBASE_ANDROID_APP_ID.exec(appId)?.[1] === senderId;
}
