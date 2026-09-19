/**
 * The native app's privacy manifest must describe the native binary.
 *
 * Apple rejects a manifest that under-declares, and the way that happens in
 * practice is drift: someone adds a line of Swift months later that reaches
 * for a required-reason API, and nobody thinks about a plist. So the manifest
 * is not trusted on its own here — it is checked against the sources it claims
 * to describe, and the two have to agree exactly.
 *
 * When this fails, the fix is to correct
 * `ios/WebyarNative/Resources/PrivacyInfo.xcprivacy`, never to relax the
 * detection below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import plist from 'plist';

const APP = 'ios/WebyarNative';
const MANIFEST = join(APP, 'Resources/PrivacyInfo.xcprivacy');
const SOURCES = join(APP, 'Sources');
const PROJECT = join(APP, 'project.yml');
const LOCALES = ['en', 'fa', 'tr'];

/**
 * Apple's five required-reason categories, and the symbols that mean the code
 * has entered one. Keyed by the category string the manifest must carry.
 */
const CATEGORY_SIGNALS: Record<string, RegExp> = {
  NSPrivacyAccessedAPICategoryUserDefaults: /\bUserDefaults\b|\bNSUserDefaults\b/,
  NSPrivacyAccessedAPICategoryFileTimestamp:
    /\battributesOfItem\b|\bcontentModificationDate\b|\bcreationDate\b|\bNSFileCreationDate\b|\bNSFileModificationDate\b|\bresourceValues\s*\(\s*forKeys|\bgetResourceValue\b/,
  NSPrivacyAccessedAPICategoryDiskSpace:
    /\bvolumeAvailableCapacity\w*\b|\bvolumeTotalCapacity\b|\bNSFileSystemFreeSize\b|\bsystemFreeSize\b/,
  NSPrivacyAccessedAPICategorySystemBootTime:
    /\bsystemUptime\b|\bmach_absolute_time\b|\bCLOCK_UPTIME_RAW\b|\bmach_continuous_time\b/,
  NSPrivacyAccessedAPICategoryActiveKeyboards: /\bactiveInputModes\b|\bUITextInputMode\b/,
};

/** Ad and attribution SDKs. Any of these lands IDFA, ATT and a tracking label. */
const TRACKING_SDKS = /GoogleMobileAds|google-mobile-ads|AppLovin|AudienceNetwork|UnityAds|AppsFlyer|adjust|FirebaseAnalytics|Amplitude|Mixpanel|Sentry|Crashlytics/i;

function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...swiftFiles(full));
    else if (entry.name.endsWith('.swift')) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped before scanning. A doc comment that merely *mentions*
 * `systemUptime` — which is exactly how this codebase explains why it does not
 * use something — must not be read as a call to it.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

const manifest = plist.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
const project = readFileSync(PROJECT, 'utf8');
const sources = swiftFiles(SOURCES).map(code).join('\n');

describe('native privacy manifest — placement and shape', () => {
  it('sits where XcodeGen copies it to the bundle root', () => {
    // `Resources` is declared with `buildPhase: resources`, so anything in it
    // is copied verbatim; Apple's tooling only reads the bundle root.
    expect(existsSync(MANIFEST)).toBe(true);
    expect(project).toMatch(/path:\s*Resources\s*\n\s*buildPhase:\s*resources/);
  });

  it('declares all four top-level keys', () => {
    for (const key of [
      'NSPrivacyTracking',
      'NSPrivacyTrackingDomains',
      'NSPrivacyCollectedDataTypes',
      'NSPrivacyAccessedAPITypes',
    ]) {
      expect(manifest).toHaveProperty(key);
    }
  });
});

describe('native privacy manifest — required-reason APIs match the sources', () => {
  const declared = (manifest.NSPrivacyAccessedAPITypes as { NSPrivacyAccessedAPIType: string }[])
    .map((entry) => entry.NSPrivacyAccessedAPIType)
    .sort();

  const detected = Object.entries(CATEGORY_SIGNALS)
    .filter(([, signal]) => signal.test(sources))
    .map(([category]) => category)
    .sort();

  it('declares every category the Swift sources actually touch', () => {
    // Under-declaring is the rejection. Over-declaring is also wrong: Apple
    // asks for the reason a category is used, and there is no honest reason
    // for one the code never enters.
    expect(declared).toEqual(detected);
  });

  it('gives every declared category at least one reason code', () => {
    for (const entry of manifest.NSPrivacyAccessedAPITypes as {
      NSPrivacyAccessedAPIType: string;
      NSPrivacyAccessedAPITypeReasons?: string[];
    }[]) {
      expect(entry.NSPrivacyAccessedAPITypeReasons?.length, entry.NSPrivacyAccessedAPIType)
        .toBeGreaterThan(0);
    }
  });

  it('uses CA92.1 for UserDefaults, which is the app-only reason', () => {
    const defaults = (manifest.NSPrivacyAccessedAPITypes as {
      NSPrivacyAccessedAPIType: string;
      NSPrivacyAccessedAPITypeReasons: string[];
    }[]).find((e) => e.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryUserDefaults');
    // CA92.1 is only honest while there is no app group: it covers defaults
    // that no other process can read.
    expect(defaults?.NSPrivacyAccessedAPITypeReasons).toContain('CA92.1');
    expect(project).not.toContain('com.apple.security.application-groups');
  });
});

describe('native privacy manifest — tracking', () => {
  it('claims no tracking, and links nothing that would make that false', () => {
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
    // If this fails, an ad or analytics SDK was added. The manifest, the ATT
    // prompt and the App Store product page all change together — see the
    // header of PrivacyInfo.xcprivacy.
    expect(project).not.toMatch(TRACKING_SDKS);
    expect(sources).not.toMatch(/advertisingIdentifier|ATTrackingManager|AppTrackingTransparency/);
  });

  it('asks for no tracking permission while it does not track', () => {
    expect(project).not.toContain('NSUserTrackingUsageDescription');
  });

  it('marks no collected type as used for tracking', () => {
    for (const entry of manifest.NSPrivacyCollectedDataTypes as {
      NSPrivacyCollectedDataType: string;
      NSPrivacyCollectedDataTypeTracking: boolean;
      NSPrivacyCollectedDataTypeLinked: boolean;
      NSPrivacyCollectedDataTypePurposes: string[];
    }[]) {
      // A type flagged for tracking while NSPrivacyTracking is false is a
      // contradiction Apple's own validation rejects.
      expect(entry.NSPrivacyCollectedDataTypeTracking, entry.NSPrivacyCollectedDataType).toBe(false);
      expect(typeof entry.NSPrivacyCollectedDataTypeLinked).toBe('boolean');
      expect(entry.NSPrivacyCollectedDataTypePurposes.length).toBeGreaterThan(0);
    }
  });
});

describe('native app — permission purpose strings', () => {
  const keys = [...new Set(project.match(/NS\w+UsageDescription/g) ?? [])];

  it('asks for exactly the permissions the sources need', () => {
    // The microphone covers calls AND recorded voice notes; the camera covers
    // video calls. Photos go through `PhotosPicker`, which runs out of process
    // and must NOT carry a usage string.
    expect(keys.sort()).toEqual(['NSCameraUsageDescription', 'NSMicrophoneUsageDescription']);
    expect(project).not.toContain('NSPhotoLibraryUsageDescription');
    expect(sources).toMatch(/PhotosPicker/);
  });

  it('localizes every purpose string in all three languages', () => {
    for (const locale of LOCALES) {
      const strings = readFileSync(join(APP, `Resources/${locale}.lproj/InfoPlist.strings`), 'utf8');
      for (const key of keys) {
        expect(strings, `${key} missing from ${locale}`).toContain(`"${key}"`);
      }
    }
  });

  it('says voice notes in the microphone string, because the app records them', () => {
    // 5.1.1 wants the string to cover every use, and `VoiceRecorder` is one
    // the operator meets long before they ever place a call.
    expect(sources).toMatch(/playAndRecord/);
    const en = readFileSync(join(APP, 'Resources/en.lproj/InfoPlist.strings'), 'utf8');
    expect(en).toMatch(/NSMicrophoneUsageDescription[^\n]*voice note/i);
  });
});

describe('native app — background modes are earned', () => {
  it('declares audio only, and the sources justify it', () => {
    expect(project).toMatch(/UIBackgroundModes:\s*\n\s*-\s*audio\s*\n/);
    // `audio` is reviewed closely. It is here because a call must survive the
    // screen locking, and LiveKit holds the session.
    expect(sources).toMatch(/LiveKit/);
  });

  it('does not claim voip without PushKit, which iOS would kill it for', () => {
    if (/-\s*voip\b/.test(project)) {
      expect(sources).toMatch(/PKPushRegistry/);
      expect(sources).toMatch(/CXProvider/);
    }
  });
});
