/**
 * What Super Admin → Mobile app tells an operator to run, per edition: one
 * source builds WebYar's apps for the Iranian edition and RESPOK's for the
 * International one (shared/nativeAppBrands.ts). An edition that is not known
 * yet reads as Iran, as everywhere, so WebYar's commands are exactly what they
 * always were.
 */
import type { Edition } from '../../../../shared/edition';
import { nativeAppBrand } from '../../../../shared/nativeAppBrands';

/**
 * The commands a Mac with Xcode runs, from a fresh checkout to an archive of
 * the edition's iOS app: one Xcode project (ios/Webyar), one scheme per brand.
 */
export function iosBuildCommands(
  settings: { marketing_version: string; build_number: number },
  edition: Edition | null,
): string[] {
  const scheme = nativeAppBrand(edition).iosScheme;
  return [
    'brew install xcodegen',
    'cd ios/Webyar',
    'xcodegen generate',
    'open Webyar.xcodeproj',
    [
      `xcodebuild -project Webyar.xcodeproj -scheme ${scheme} -configuration Release`,
      `-destination "generic/platform=iOS" -archivePath build/${scheme}.xcarchive`,
      `MARKETING_VERSION=${settings.marketing_version} CURRENT_PROJECT_VERSION=${settings.build_number} archive`,
    ].join(' \\\n  '),
  ];
}

/**
 * The Gradle commands that build the edition's Android app with the version
 * recorded in Super Admin: its product flavor's bundle for Play, and its APK
 * for the website's download. The version goes in through the flavor's own
 * properties (`-Pwebyar.versionName`, `-Prespok.versionName`).
 */
export function androidReleaseCommands(
  draft: { android_version_name: string; android_version_code: number },
  edition: Edition | null,
): string {
  const flavor = nativeAppBrand(edition).androidFlavor;
  const task = flavor.charAt(0).toUpperCase() + flavor.slice(1);
  const version = `-P${flavor}.versionName=${draft.android_version_name} -P${flavor}.versionCode=${draft.android_version_code}`;
  return [
    'cd android',
    `./gradlew :app:bundle${task}Release ${version}`,
    `./gradlew :app:assemble${task}Release ${version}`,
  ].join('\n');
}

/** The APK the edition's site hands out (public/downloads/). */
export function androidApkFile(edition: Edition | null): string {
  return nativeAppBrand(edition).androidApkFile;
}

/**
 * The account App Review signs in with when Super Admin has not loaded it
 * yet (migration 248): WebYar's address in Iran, nothing in the
 * International edition, which never falls back to a WebYar address.
 */
export function appReviewAccountFallback(edition: Edition | null): string {
  return edition === 'international' ? '' : 'apple@webyar.ai';
}
