/**
 * The Android app's Firebase client identifiers: reading them out of the
 * `google-services.json` Firebase gives for a project, and telling a value
 * in the wrong format before it is saved.
 *
 * The same formats the server enforces on save
 * (server/services/mobileApp/firebaseClient.ts), so the field turns red as
 * it is typed rather than when the save is refused.
 */
import type { MobileAppSettings } from '@/hooks/useMobileApp';

/** `1:<project number>:android:<hex>` — mobilesdk_app_id. */
export const FIREBASE_ANDROID_APP_ID = /^1:(\d{6,20}):android:[0-9a-f]{6,40}$/;
export const FIREBASE_API_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
export const FIREBASE_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const FIREBASE_SENDER_ID = /^\d{6,20}$/;

export type FirebaseClientPatch = Pick<
  MobileAppSettings,
  'android_firebase_app_id' | 'android_firebase_api_key' | 'android_firebase_project_id' | 'android_firebase_sender_id'
>;

export type GoogleServicesResult =
  | { ok: true; patch: FirebaseClientPatch }
  /** Not a google-services.json at all. */
  | { ok: false; reason: 'invalid' }
  /** A real one, for a project with no Android app of this package; `found` lists the ones it has. */
  | { ok: false; reason: 'noPackage'; found: string[] };

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The four values for [packageName] out of a google-services.json.
 *
 * A project's file lists every Android app registered in it, so the one for
 * this package is picked out — and a file for a project that has no such
 * app is said to be that, rather than filling the fields with another app's
 * identifiers.
 */
export function readGoogleServices(source: string, packageName: string): GoogleServicesResult {
  let root: Json | null;
  try {
    root = record(JSON.parse(source));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const project = record(root?.project_info);
  const clients = Array.isArray(root?.client) ? (root?.client as unknown[]) : null;
  const projectId = text(project?.project_id);
  const senderId = text(project?.project_number);
  if (!project || !clients || !projectId || !senderId) return { ok: false, reason: 'invalid' };

  const found: string[] = [];
  for (const entry of clients) {
    const client = record(entry);
    const info = record(client?.client_info);
    const android = record(info?.android_client_info);
    const pkg = text(android?.package_name);
    if (!pkg) continue;
    found.push(pkg);
    if (pkg !== packageName) continue;
    const appId = text(info?.mobilesdk_app_id);
    const keys = Array.isArray(client?.api_key) ? (client?.api_key as unknown[]) : [];
    const apiKey = keys.map((key) => text(record(key)?.current_key)).find(Boolean) ?? null;
    if (!appId || !apiKey) return { ok: false, reason: 'invalid' };
    return {
      ok: true,
      patch: {
        android_firebase_app_id: appId,
        android_firebase_api_key: apiKey,
        android_firebase_project_id: projectId,
        android_firebase_sender_id: senderId,
      },
    };
  }
  return { ok: false, reason: 'noPackage', found };
}

/** All four set: the app can start Firebase. A partial set is served as nothing. */
export function firebaseClientComplete(settings: FirebaseClientPatch): boolean {
  return Boolean(
    settings.android_firebase_app_id?.trim() &&
      settings.android_firebase_api_key?.trim() &&
      settings.android_firebase_project_id?.trim() &&
      settings.android_firebase_sender_id?.trim(),
  );
}

/** Whether the app id and the project number come from the same Firebase project. */
export function firebaseProjectsMatch(settings: FirebaseClientPatch): boolean {
  const appId = settings.android_firebase_app_id?.trim();
  const sender = settings.android_firebase_sender_id?.trim();
  if (!appId || !sender) return true;
  return FIREBASE_ANDROID_APP_ID.exec(appId)?.[1] === sender;
}
