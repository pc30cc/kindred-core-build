import { describe, expect, it } from 'vitest';
import {
  APP_REVIEW_ACCOUNT_EMAIL,
  MOBILE_APP_DEFAULTS,
  MOBILE_APP_INTERNATIONAL_DEFAULTS,
  mobileAppDefaults,
  mobileInsertDefaults,
  mobileSettingsForEdition,
  normalize,
} from './settings.js';
import { NATIVE_APP_BRANDS } from '../../../shared/nativeAppBrands.js';

/**
 * Each edition's mobile apps are their own: WebYar's in Iran, RESPOK's in the
 * International edition (one mobile_app_settings row per edition, migration
 * 257). An edition with no row starts from its own brand's defaults, and the
 * International edition is never served a value that names WebYar.
 */
describe('mobile app settings — per edition', () => {
  it("the Iranian edition's defaults are the values it always had", () => {
    expect(MOBILE_APP_DEFAULTS).toMatchObject({
      app_name: 'Webyar',
      display_name: 'Webyar',
      bundle_id: 'com.webyar.app',
      android_package_name: 'com.webyar.ai',
      android_app_name: 'Webyar',
      usage_camera: 'Webyar needs camera access so you can capture and send photos or videos in a conversation.',
      usage_microphone: 'Webyar needs microphone access so you can record and send voice messages to your customers.',
      usage_photo_library: 'Webyar needs photo library access so you can send images and videos in a conversation.',
    });
    expect(mobileAppDefaults('iran')).toBe(MOBILE_APP_DEFAULTS);
    expect(mobileAppDefaults(null)).toBe(MOBILE_APP_DEFAULTS);
    expect(mobileInsertDefaults('iran')).toEqual({});
  });

  it("the International edition's defaults are RESPOK's apps, and name nothing of WebYar's", () => {
    const intl = mobileAppDefaults('international');
    expect(intl).toBe(MOBILE_APP_INTERNATIONAL_DEFAULTS);
    expect(intl).toMatchObject({
      app_name: 'RESPOK',
      display_name: 'RESPOK',
      bundle_id: 'com.respok.app',
      android_package_name: 'com.respok.app',
      android_app_name: 'RESPOK',
      usage_camera: 'RESPOK needs camera access so you can capture and send photos or videos in a conversation.',
      // RESPOK's apps open in English (WebYar's Android app opens in Persian).
      android_default_language: 'en',
      ios_default_language: 'en',
    });
    expect(MOBILE_APP_DEFAULTS.android_default_language).toBe('fa');
    expect(JSON.stringify(intl)).not.toMatch(/webyar|وب.?یار/i);
    expect(NATIVE_APP_BRANDS.international).toMatchObject({ iosBundleId: 'com.respok.app', androidPackage: 'com.respok.app' });
    // The table's column defaults are WebYar's: RESPOK's first row is written out in full.
    const { updated_at: _updatedAt, ...written } = MOBILE_APP_INTERNATIONAL_DEFAULTS;
    expect(mobileInsertDefaults('international')).toEqual(written);
  });

  it("fills a RESPOK row's missing or unusable values from RESPOK's defaults", () => {
    expect(normalize({ android_default_language: 'de' }, 'international')).toMatchObject({
      android_default_language: 'en', app_name: 'RESPOK', bundle_id: 'com.respok.app',
    });
    expect(normalize({ android_default_language: 'de' })).toMatchObject({ android_default_language: 'fa', app_name: 'Webyar' });
  });

  it('leaves the Iranian edition (and an unknown one) exactly as stored', () => {
    const s = normalize({ app_name: 'Webyar', privacy_policy_url: 'https://webyar.ai/privacy', ads_banner: { cta_url: 'https://webyar.ai/pricing' } });
    expect(mobileSettingsForEdition(s, 'iran')).toBe(s);
    expect(mobileSettingsForEdition(s, null)).toBe(s);
  });

  it("serves RESPOK's apps nothing of WebYar's from a cloned row", () => {
    const cloned = normalize({
      app_name: 'Webyar',
      display_name: 'وب‌یار',
      bundle_id: 'com.webyar.app',
      android_package_name: 'com.webyar.ai',
      android_app_name: 'WebYar',
      apple_team_name: 'Webyar Ltd',
      app_sku: 'webyar-ios',
      apple_team_id: 'ABCDE12345',
      url_scheme: 'webyar',
      associated_domains: ['applinks:app.webyar.ai', 'applinks:app.respok.app'],
      app_group_id: 'group.com.webyar.app',
      usage_camera: 'Webyar needs the camera.',
      usage_location: 'Webyar uses your location.',
      privacy_policy_url: 'https://webyar.ai/privacy',
      terms_url: 'https://respok.app/terms',
      support_url: 'https://app.webyar.ai/help',
      copyright: '© 2026 Webyar',
      review_contact_email: 'review@webyar.ai',
      demo_account_username: APP_REVIEW_ACCOUNT_EMAIL,
      ios_app_website_url: 'https://webyar.ai',
      ios_app_website_label: { fa: 'سایت وب‌یار', en: 'Website' },
      android_release_notes: { en: 'Webyar 1.4 is here', tr: 'Yeni sürüm' },
      android_maintenance_message: { fa: 'وبیار در حال به‌روزرسانی است', en: 'Back soon' },
      android_firebase_project_id: 'webyar-app',
      ads_banner: { cta_url: 'https://webyar.ai/pricing', text: { en: { title: 'Upgrade' } } },
      ads_fullscreen: { cta_url: 'https://respok.app/pricing', text: { en: { title: 'Go Pro' } } },
      third_party_sdks: ['Firebase Cloud Messaging', 'Webyar Analytics'],
    });
    const s = mobileSettingsForEdition(cloned, 'international');
    expect(s).toMatchObject({
      // RESPOK's defaults where a value people read is required…
      app_name: 'RESPOK',
      display_name: 'RESPOK',
      android_app_name: 'RESPOK',
      usage_camera: MOBILE_APP_INTERNATIONAL_DEFAULTS.usage_camera,
      // …cleared where it is not…
      apple_team_name: null,
      app_sku: null,
      usage_location: null,
      privacy_policy_url: null,
      support_url: null,
      copyright: null,
      review_contact_email: null,
      ios_app_website_url: null,
      ads_banner: {},
      // …and what is RESPOK's own, or names nobody, stays.
      terms_url: 'https://respok.app/terms',
      ios_app_website_label: { en: 'Website' },
      android_release_notes: { tr: 'Yeni sürüm' },
      android_maintenance_message: { en: 'Back soon' },
      ads_fullscreen: { cta_url: 'https://respok.app/pricing', text: { en: { title: 'Go Pro' } } },
    });
    // The App Review account is one real account in either edition (migration 248): kept.
    expect(s.demo_account_username).toBe(APP_REVIEW_ACCOUNT_EMAIL);
  });

  it('never rewrites an identifier the apps, stores or pushes work by', () => {
    const ids = {
      bundle_id: 'com.webyar.ai',
      android_package_name: 'com.webyar.ai',
      url_scheme: 'webyar',
      associated_domains: ['applinks:app.webyar.ai'],
      app_group_id: 'group.com.webyar.ai',
      apple_team_id: 'ABCDE12345',
      apple_app_id: '6740000000',
      provisioning_profile: 'Webyar App Store',
      android_firebase_project_id: 'webyar-app',
      android_firebase_app_id: '1:123456789012:android:0a1b2c3d4e5f6a70',
      third_party_sdks: ['Firebase Cloud Messaging', 'Webyar Calls'],
    };
    expect(mobileSettingsForEdition(normalize(ids, 'international'), 'international')).toMatchObject(ids);
  });

  it('keeps Turkish words that only look like the name', () => {
    const notes = { tr: 'Web yardım merkezi bağlantısı eklendi.' };
    expect(mobileSettingsForEdition(normalize({ android_release_notes: notes }), 'international').android_release_notes).toEqual(notes);
  });
});
