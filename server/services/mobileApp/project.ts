/**
 * Facts about the native iOS app's project (ios/WebyarNative), for the
 * readiness checks and Super Admin's "Deployment status" card.
 *
 * The API image does not ship `ios/` (Dockerfile.server copies `server/`
 * only), so a deployed server cannot look at the project itself. It reads
 * iosProjectFacts.json beside this file instead: the same facts, written
 * from the checkout by `npm run ios:project-facts` and kept honest by
 * project.test.ts, which fails CI as soon as the file and the project
 * disagree. Where the project IS checked out (development, CI), it is read
 * directly.
 *
 * The Xcode project itself is generated from project.yml by XcodeGen and
 * is not committed, so project.yml is what "the project exists" means. Push
 * goes to Apple directly (APNs, server/services/push/apns.ts): the app has
 * no Firebase configuration file, and none is looked for.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface NativeProjectFacts {
  /** ios/WebyarNative/project.yml, the spec the Xcode project is generated from. */
  available: boolean;
  /** A 1024×1024 image listed in the app icon set, and that image on disk. */
  appIcon1024: boolean;
  /** Resources/PrivacyInfo.xcprivacy, bundled into the app target. */
  privacyManifestFile: boolean;
  /** The target's entitlements declare `aps-environment`: the push capability. */
  pushEntitlement: boolean;
  /** The app's UIBackgroundModes. */
  backgroundModes: string[];
}

/** Where the facts came from: the checkout itself, or the file shipped with the server. */
export type NativeProjectSource = 'checkout' | 'snapshot' | 'none';

export const NATIVE_PROJECT_DIR = 'ios/WebyarNative';

const HERE = dirname(fileURLToPath(import.meta.url));
/** server/ in development, /app in the server image. */
const SERVER_DIR = resolve(HERE, '..', '..');
export const NATIVE_PROJECT_SNAPSHOT = resolve(HERE, 'iosProjectFacts.json');

const NONE: NativeProjectFacts = {
  available: false,
  appIcon1024: false,
  privacyManifestFile: false,
  pushEntitlement: false,
  backgroundModes: [],
};

/** Reads the facts from a checkout of the repository at `root`. */
export function readNativeProjectFacts(root: string): NativeProjectFacts {
  const dir = resolve(root, NATIVE_PROJECT_DIR);
  const specPath = resolve(dir, 'project.yml');
  if (!existsSync(specPath)) return { ...NONE };
  const spec = readFileSync(specPath, 'utf8');
  return {
    available: true,
    appIcon1024: hasMarketingIcon(resolve(dir, 'Resources/Assets.xcassets/AppIcon.appiconset')),
    privacyManifestFile: existsSync(resolve(dir, 'Resources/PrivacyInfo.xcprivacy')),
    pushEntitlement: declaresPushEntitlement(spec),
    backgroundModes: backgroundModes(spec),
  };
}

/** The facts this server can know, and where they came from. */
export function inspectNativeProject(): NativeProjectFacts & { source: NativeProjectSource } {
  const root = resolve(SERVER_DIR, '..');
  if (existsSync(resolve(root, NATIVE_PROJECT_DIR, 'project.yml'))) {
    return { ...readNativeProjectFacts(root), source: 'checkout' };
  }
  const snapshot = readSnapshot();
  return snapshot ? { ...snapshot, source: 'snapshot' } : { ...NONE, source: 'none' };
}

export function readSnapshot(path: string = NATIVE_PROJECT_SNAPSHOT): NativeProjectFacts | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<NativeProjectFacts>;
    return {
      available: raw.available === true,
      appIcon1024: raw.appIcon1024 === true,
      privacyManifestFile: raw.privacyManifestFile === true,
      pushEntitlement: raw.pushEntitlement === true,
      backgroundModes: Array.isArray(raw.backgroundModes) ? raw.backgroundModes.filter((m) => typeof m === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** The 1024×1024 marketing icon Apple requires, read from the asset catalog. */
function hasMarketingIcon(iconSet: string): boolean {
  try {
    const json = JSON.parse(readFileSync(resolve(iconSet, 'Contents.json'), 'utf8')) as {
      images?: { size?: string; filename?: string }[];
    };
    return (json.images ?? []).some(
      (image) => image.size === '1024x1024' && Boolean(image.filename) && existsSync(resolve(iconSet, image.filename!)),
    );
  } catch {
    return false;
  }
}

/** `entitlements:` → `properties:` → `aps-environment:` in the XcodeGen spec. */
function declaresPushEntitlement(spec: string): boolean {
  const block = spec.match(/^([ \t]*)entitlements:[ \t]*\n((?:\1[ \t]+.*\n?|[ \t]*\n)*)/m);
  return Boolean(block && /^[ \t]+aps-environment:[ \t]*\S/m.test(block[2]));
}

/** The items listed under `UIBackgroundModes:` in the XcodeGen spec. */
function backgroundModes(spec: string): string[] {
  const inline = spec.match(/^[ \t]*UIBackgroundModes:[ \t]*\[([^\]]*)\]/m);
  if (inline) return inline[1].split(',').map((mode) => mode.trim()).filter(Boolean);
  const block = spec.match(/^([ \t]*)UIBackgroundModes:[ \t]*\n((?:\1[ \t]+-[ \t]*.*\n?)*)/m);
  if (!block) return [];
  return [...block[2].matchAll(/-[ \t]*([\w-]+)/g)].map((m) => m[1]);
}
