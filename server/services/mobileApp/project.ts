/**
 * Facts about the native iOS project ON DISK, as seen by the running server.
 *
 * The Express deployable does not always ship `ios/` (the API image has no
 * reason to carry an Xcode project), so "file missing" and "this deployment
 * has no native project checked out" are two different answers. When the
 * project is absent entirely, `available` is false and the readiness engine
 * downgrades those checks to `manual` instead of failing a build the server
 * simply cannot see.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export interface NativeProjectFacts {
  available: boolean;
  googleServicePlist: boolean;
  appIcon1024: boolean;
  privacyManifestFile: boolean;
  entitlementsFile: boolean;
}

const ROOT = process.cwd();
const IOS_APP = resolve(ROOT, 'ios/App/App');

export function inspectNativeProject(): NativeProjectFacts {
  const available = existsSync(resolve(ROOT, 'ios/App/App.xcodeproj'));
  if (!available) {
    return {
      available: false,
      googleServicePlist: false,
      appIcon1024: false,
      privacyManifestFile: false,
      entitlementsFile: false,
    };
  }
  return {
    available: true,
    googleServicePlist: existsSync(resolve(IOS_APP, 'GoogleService-Info.plist')),
    appIcon1024: hasMarketingIcon(),
    privacyManifestFile: existsSync(resolve(IOS_APP, 'PrivacyInfo.xcprivacy')),
    entitlementsFile: existsSync(resolve(IOS_APP, 'App.entitlements')),
  };
}

/** The 1024×1024 marketing icon Apple requires, read from the asset catalog. */
function hasMarketingIcon(): boolean {
  const contents = resolve(IOS_APP, 'Assets.xcassets/AppIcon.appiconset/Contents.json');
  if (!existsSync(contents)) return false;
  try {
    const json = JSON.parse(readFileSync(contents, 'utf8')) as {
      images?: { size?: string; filename?: string }[];
    };
    return (json.images ?? []).some(
      (image) => image.size === '1024x1024' && Boolean(image.filename),
    );
  } catch {
    return false;
  }
}
