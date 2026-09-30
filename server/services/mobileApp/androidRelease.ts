/**
 * The Android build the website hands out.
 *
 * `public/downloads/Webyar-Android.apk` ships with a sidecar,
 * `Webyar-Android.json`, written by the same release that builds the APK:
 * its version name and code, its SHA-256 and size. Super Admin's Android
 * version is read from here rather than typed, so the number in Mobile App →
 * Android is always the number of the app people download
 * (src/test/android/apkRelease.test.ts keeps the two files in step).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ShippedAndroidRelease {
  versionName: string;
  versionCode: number;
  sha256: string;
  sizeBytes: number;
  releasedAt: string | null;
}

const VERSION_NAME = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The sidecar's contents, or null when any field is missing or malformed. */
export function parseShippedRelease(raw: unknown): ShippedAndroidRelease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const versionName = typeof r.versionName === 'string' ? r.versionName.trim() : '';
  const versionCode = typeof r.versionCode === 'number' ? r.versionCode : NaN;
  const sha256 = typeof r.sha256 === 'string' ? r.sha256.trim().toLowerCase() : '';
  const sizeBytes = typeof r.sizeBytes === 'number' ? r.sizeBytes : NaN;
  if (!VERSION_NAME.test(versionName) || versionName.length > 30) return null;
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) return null;
  if (!SHA256.test(sha256) || !Number.isInteger(sizeBytes) || sizeBytes <= 0) return null;
  const releasedAt =
    typeof r.releasedAt === 'string' && !Number.isNaN(Date.parse(r.releasedAt)) ? r.releasedAt : null;
  return { versionName, versionCode, sha256, sizeBytes, releasedAt };
}

// Where the sidecar sits, first match wins: beside the repository's server/
// in development, in /app/public inside the server image (Dockerfile.server
// copies it there), then under the working directory. Same order as the
// Call Widget assets in server/index.ts.
const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHIPPED_RELEASE_FILES = [
  resolve(SERVER_DIR, '..', 'public', 'downloads', 'Webyar-Android.json'),
  resolve(SERVER_DIR, 'public', 'downloads', 'Webyar-Android.json'),
  resolve(process.cwd(), 'public', 'downloads', 'Webyar-Android.json'),
];

function shippedReleaseFile(): string {
  return SHIPPED_RELEASE_FILES.find((path) => existsSync(path)) ?? SHIPPED_RELEASE_FILES[0];
}

let cache: { path: string; mtimeMs: number; value: ShippedAndroidRelease | null } | null = null;

/**
 * The shipped release, read again only when the file changes. Null when the
 * deployment carries no sidecar (a self-host without the download, say):
 * the version stays what Super Admin typed.
 */
export function readShippedAndroidRelease(path: string = shippedReleaseFile()): ShippedAndroidRelease | null {
  try {
    const { mtimeMs } = statSync(path);
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.value;
    const value = parseShippedRelease(JSON.parse(readFileSync(path, 'utf8')));
    cache = { path, mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}

/** Settings with the Android version taken from the shipped release, when there is one. */
export function withShippedVersion<T extends { android_version_name: string; android_version_code: number }>(
  settings: T,
  shipped: ShippedAndroidRelease | null,
): T {
  if (!shipped) return settings;
  return { ...settings, android_version_name: shipped.versionName, android_version_code: shipped.versionCode };
}
