/**
 * Facts about the native iOS app's project (ios/Webyar), for the
 * readiness checks and Super Admin's "Deployment status" card.
 *
 * The project builds two apps from one source (project.yml): WebYar (the
 * `Webyar` target, com.webyar.ai) and RESPOK (the `Respok` target,
 * com.respok.app), each with its own icon set, entitlements and Info.plist.
 * So the facts are per brand: `inspectNativeProject(nativeBrandForEdition(edition))`
 * gives the International edition RESPOK's and every other edition WebYar's.
 * Called with no brand, it answers for WebYar, as it always has.
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
  /** ios/Webyar/project.yml, the spec the Xcode project is generated from. */
  available: boolean;
  /** A 1024×1024 image listed in the app icon set, and that image on disk. */
  appIcon1024: boolean;
  /** Resources/PrivacyInfo.xcprivacy, bundled into the app target. */
  privacyManifestFile: boolean;
  /**
   * The required-reason API categories that manifest declares, without
   * Apple's prefix: `UserDefaults`, `FileTimestamp`, `DiskSpace`…
   */
  privacyApiTypes: string[];
  /**
   * The data types it says the app collects, without Apple's prefix:
   * `EmailAddress`, `UserID`, `CustomerSupport`… — what App Store
   * Connect's App Privacy answers have to cover.
   */
  privacyDataTypes: string[];
  /** The target's entitlements declare `aps-environment`: the push capability. */
  pushEntitlement: boolean;
  /** The app's UIBackgroundModes. */
  backgroundModes: string[];
}

/** Where the facts came from: the checkout itself, or the file shipped with the server. */
export type NativeProjectSource = 'checkout' | 'snapshot' | 'none';

export const NATIVE_PROJECT_DIR = 'ios/Webyar';

/** The two apps the project builds. */
export type NativeBrand = 'webyar' | 'respok';
export const NATIVE_BRANDS: Record<NativeBrand, { target: string; bundleId: string; iconSet: string }> = {
  webyar: { target: 'Webyar', bundleId: 'com.webyar.ai', iconSet: 'Resources/Assets.xcassets/AppIcon.appiconset' },
  respok: { target: 'Respok', bundleId: 'com.respok.app', iconSet: 'Brands/Respok/Assets.xcassets/AppIcon.appiconset' },
};

/** The app an edition ships: RESPOK in the International edition, WebYar in every other. */
export function nativeBrandForEdition(edition: string | null | undefined): NativeBrand {
  return edition === 'international' ? 'respok' : 'webyar';
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** server/ in development, /app in the server image. */
const SERVER_DIR = resolve(HERE, '..', '..');
export const NATIVE_PROJECT_SNAPSHOT = resolve(HERE, 'iosProjectFacts.json');

const NONE: NativeProjectFacts = {
  available: false,
  appIcon1024: false,
  privacyManifestFile: false,
  privacyApiTypes: [],
  privacyDataTypes: [],
  pushEntitlement: false,
  backgroundModes: [],
};

/**
 * Reads one brand's facts from a checkout of the repository at `root`: its
 * target's entitlements and background modes, its own icon set, and the
 * privacy manifest both apps bundle.
 */
export function readNativeProjectFacts(root: string, brand: NativeBrand = 'webyar'): NativeProjectFacts {
  const dir = resolve(root, NATIVE_PROJECT_DIR);
  const specPath = resolve(dir, 'project.yml');
  if (!existsSync(specPath)) return { ...NONE };
  const target = targetBlock(readFileSync(specPath, 'utf8'), NATIVE_BRANDS[brand].target);
  if (target === null) return { ...NONE };
  const manifestPath = resolve(dir, 'Resources/PrivacyInfo.xcprivacy');
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  return {
    available: true,
    appIcon1024: hasMarketingIcon(resolve(dir, NATIVE_BRANDS[brand].iconSet)),
    privacyManifestFile: existsSync(manifestPath),
    privacyApiTypes: manifestValues(manifest, 'NSPrivacyAccessedAPIType', 'NSPrivacyAccessedAPICategory'),
    privacyDataTypes: manifestValues(manifest, 'NSPrivacyCollectedDataType', 'NSPrivacyCollectedDataType'),
    pushEntitlement: declaresPushEntitlement(target),
    backgroundModes: backgroundModes(target),
  };
}

/** Both brands' facts: what iosProjectFacts.json holds. */
export function readAllNativeProjectFacts(root: string): Record<NativeBrand, NativeProjectFacts> {
  return { webyar: readNativeProjectFacts(root, 'webyar'), respok: readNativeProjectFacts(root, 'respok') };
}

/** The facts this server can know about one brand's app, and where they came from. */
export function inspectNativeProject(brand: NativeBrand = 'webyar'): NativeProjectFacts & { source: NativeProjectSource } {
  const root = resolve(SERVER_DIR, '..');
  if (existsSync(resolve(root, NATIVE_PROJECT_DIR, 'project.yml'))) {
    return { ...readNativeProjectFacts(root, brand), source: 'checkout' };
  }
  const snapshot = readSnapshot(NATIVE_PROJECT_SNAPSHOT, brand);
  return snapshot ? { ...snapshot, source: 'snapshot' } : { ...NONE, source: 'none' };
}

/**
 * One brand's facts from the snapshot, which holds `{ webyar, respok }`. A
 * snapshot written before RESPOK's target existed holds WebYar's facts at its
 * top level, and nothing for RESPOK.
 */
export function readSnapshot(path: string = NATIVE_PROJECT_SNAPSHOT, brand: NativeBrand = 'webyar'): NativeProjectFacts | null {
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<NativeBrand, Partial<NativeProjectFacts>>> &
      Partial<NativeProjectFacts>;
    const raw = file[brand] ?? (brand === 'webyar' && 'available' in file ? file : null);
    if (!raw) return null;
    return {
      available: raw.available === true,
      appIcon1024: raw.appIcon1024 === true,
      privacyManifestFile: raw.privacyManifestFile === true,
      privacyApiTypes: strings(raw.privacyApiTypes),
      privacyDataTypes: strings(raw.privacyDataTypes),
      pushEntitlement: raw.pushEntitlement === true,
      backgroundModes: strings(raw.backgroundModes),
    };
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * What a privacy manifest gives for `key`, each time it appears, with
 * Apple's `prefix` taken off — in order and once each. Its comments are
 * skipped: they name categories the app does NOT use.
 */
function manifestValues(manifest: string, key: string, prefix: string): string[] {
  const body = manifest.replace(/<!--[\s\S]*?-->/g, '');
  const pattern = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>\\s*${prefix}(\\w+)\\s*</string>`, 'g');
  return [...new Set([...body.matchAll(pattern)].map((m) => m[1]))];
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

/**
 * The lines of one target under `targets:` in the XcodeGen spec, or null when
 * the spec has no such target: its name at one indentation and everything
 * indented deeper, up to the next line that is not.
 */
function targetBlock(spec: string, target: string): string | null {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line === 'targets:' || /^targets:[ \t]*$/.test(line));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const header = line.match(/^([ \t]+)([\w.-]+):[ \t]*$/);
    if (!header || header[2] !== target) continue;
    const indent = header[1].length;
    const body: string[] = [line];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === '' || (next.match(/^[ \t]*/)![0].length > indent)) body.push(next);
      else break;
    }
    return `${body.join('\n')}\n`;
  }
  return null;
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
