import { describe, expect, it } from 'vitest';
import { androidApkFile, androidReleaseCommands, appReviewAccountFallback, iosBuildCommands } from './nativeBuild';

/**
 * Super Admin → Mobile app shows the commands that build the edition's own
 * apps: WebYar's in Iran (and while the edition is not known), RESPOK's in
 * the International edition.
 */
describe('the iOS build commands', () => {
  const settings = { marketing_version: '1.4.0', build_number: 27 };

  it('build WebYar’s app in Iran exactly as before', () => {
    const before = [
      'brew install xcodegen',
      'cd ios/Webyar',
      'xcodegen generate',
      'open Webyar.xcodeproj',
      'xcodebuild -project Webyar.xcodeproj -scheme Webyar -configuration Release \\\n'
        + '  -destination "generic/platform=iOS" -archivePath build/Webyar.xcarchive \\\n'
        + '  MARKETING_VERSION=1.4.0 CURRENT_PROJECT_VERSION=27 archive',
    ];
    expect(iosBuildCommands(settings, 'iran')).toEqual(before);
    expect(iosBuildCommands(settings, null)).toEqual(before);
  });

  it('build RESPOK’s app with its own scheme abroad', () => {
    const archive = iosBuildCommands(settings, 'international')[4];
    expect(archive).toContain('-scheme Respok ');
    expect(archive).toContain('-archivePath build/Respok.xcarchive');
    expect(archive).not.toContain('-scheme Webyar');
  });
});

describe('the Android release commands', () => {
  const draft = { android_version_name: '1.4.0', android_version_code: 14 };

  it('build the edition’s product flavor, for Play and for the site', () => {
    expect(androidReleaseCommands(draft, 'iran')).toBe([
      'cd android',
      './gradlew :app:bundleWebyarRelease -Pwebyar.versionName=1.4.0 -Pwebyar.versionCode=14',
      './gradlew :app:assembleWebyarRelease -Pwebyar.versionName=1.4.0 -Pwebyar.versionCode=14',
    ].join('\n'));
    expect(androidReleaseCommands(draft, null)).toBe(androidReleaseCommands(draft, 'iran'));
    expect(androidReleaseCommands(draft, 'international')).toBe([
      'cd android',
      './gradlew :app:bundleRespokRelease -Prespok.versionName=1.4.0 -Prespok.versionCode=14',
      './gradlew :app:assembleRespokRelease -Prespok.versionName=1.4.0 -Prespok.versionCode=14',
    ].join('\n'));
  });

  it('name the APK the edition’s site hands out', () => {
    expect(androidApkFile('iran')).toBe('Webyar-Android.apk');
    expect(androidApkFile(null)).toBe('Webyar-Android.apk');
    expect(androidApkFile('international')).toBe('RESPOK-Android.apk');
  });
});

describe('the App Review account before it has loaded', () => {
  it('is WebYar’s address in Iran and nothing abroad', () => {
    expect(appReviewAccountFallback('iran')).toBe('apple@webyar.ai');
    expect(appReviewAccountFallback(null)).toBe('apple@webyar.ai');
    expect(appReviewAccountFallback('international')).toBe('');
  });
});
