import { describe, expect, it } from 'vitest';
import { MOBILE_APP_DEFAULTS, normalize, toAndroidAppConfig } from './settings.js';

/**
 * What the installed Android app reads from `GET /api/mobile-app/config`.
 *
 * The defaults are the contract with phones already in people's hands: a
 * row written before these columns existed, or a failed read, must leave the
 * app behaving as it did — every section shown — with the one deliberate
 * change that the name on the profile is read-only until allowed.
 */
describe('Android in-app config', () => {
  it('ships with every section shown and the name locked', () => {
    expect(toAndroidAppConfig(MOBILE_APP_DEFAULTS)).toEqual({
      platform: 'android',
      showStorage: true,
      showSecurity: true,
      showNotificationSettings: true,
      allowWallpaperColors: true,
      profileNameEditable: false,
      profilePhoneEditable: false,
      profilePhotoEditable: true,
    });
  });

  it('fills a row from before the Android columns with the defaults', () => {
    const settings = normalize({ app_name: 'Webyar', bundle_id: 'com.webyar.native' });
    expect(settings.android_app_show_storage).toBe(true);
    expect(settings.android_app_profile_name_editable).toBe(false);
    expect(settings.android_package_name).toBe('com.webyar.operator');
    expect(settings.android_release_notes).toEqual({});
  });

  it('carries a switch turned off in Super Admin through to the app', () => {
    const settings = normalize({ android_app_show_storage: false, android_app_profile_name_editable: true });
    const config = toAndroidAppConfig(settings);
    expect(config.showStorage).toBe(false);
    expect(config.profileNameEditable).toBe(true);
  });

  it('says nothing about the Play record or the iOS app', () => {
    const keys = Object.keys(toAndroidAppConfig(MOBILE_APP_DEFAULTS));
    expect(keys.some((key) => /version|sdk|package|bundle|track|rollout|notes/i.test(key))).toBe(false);
  });

  it('never lets a malformed release-notes value through', () => {
    expect(normalize({ android_release_notes: ['x'] }).android_release_notes).toEqual({});
    expect(normalize({ android_version_code: 'abc' }).android_version_code).toBe(1);
  });
});
