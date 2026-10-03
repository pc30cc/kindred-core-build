import { describe, expect, it } from 'vitest';
import { MOBILE_APP_DEFAULTS, normalize, toAndroidAppConfig, toIosAppConfig, toIosPublicConfig } from './settings.js';

/**
 * What the installed iOS app reads from `GET /api/mobile-app/config?platform=ios`:
 * which of the Contacts, Visitors and Website analytics tabs it may show.
 */
describe('iOS in-app config', () => {
  it('ships with every tab shown', () => {
    expect(toIosAppConfig(MOBILE_APP_DEFAULTS)).toEqual({
      platform: 'ios',
      showContacts: true,
      showVisitors: true,
      showWebAnalytics: true,
      showAIQueue: true,
      showColleagues: true,
      showStorage: true,
      showSupport: true,
      supportUrl: null,
      websiteUrl: null,
      websiteLabel: {},
    });
  });

  it('names and points the Website row as Super Admin set it (migration 246)', () => {
    const config = toIosAppConfig(normalize({
      ios_app_website_url: 'https://webyar.ai',
      ios_app_website_label: { fa: ' سایت وبیار ', en: 'Webyar site', tr: '', de: 'Nein' },
    }));
    expect(config.websiteUrl).toBe('https://webyar.ai');
    // Trimmed, blanks dropped, only the app's languages.
    expect(config.websiteLabel).toEqual({ fa: 'سایت وبیار', en: 'Webyar site' });
  });

  it('opens in the language Super Admin chose, English until then (migration 247)', () => {
    expect(toIosPublicConfig(MOBILE_APP_DEFAULTS)).toEqual({
      platform: 'ios', defaultLanguage: 'en', privacyPolicyUrl: null, termsUrl: null,
    });
    expect(toIosPublicConfig(normalize({ ios_default_language: 'fa' })).defaultLanguage).toBe('fa');
    expect(toIosPublicConfig(normalize({ ios_default_language: 'tr' })).defaultLanguage).toBe('tr');
    // A row from before 247, or a value the app does not speak.
    expect(toIosPublicConfig(normalize({})).defaultLanguage).toBe('en');
    expect(toIosPublicConfig(normalize({ ios_default_language: 'de' })).defaultLanguage).toBe('en');
    // Android's choice is Android's.
    expect(toIosPublicConfig(normalize({ android_default_language: 'tr' })).defaultLanguage).toBe('en');
  });

  it('links the App Store record\'s privacy policy and terms before sign-in', () => {
    const config = toIosPublicConfig(normalize({
      privacy_policy_url: 'https://webyar.ai/privacy',
      terms_url: 'https://webyar.ai/terms',
    }));
    expect(config.privacyPolicyUrl).toBe('https://webyar.ai/privacy');
    expect(config.termsUrl).toBe('https://webyar.ai/terms');
    expect(toIosPublicConfig(normalize({ privacy_policy_url: '' })).privacyPolicyUrl).toBeNull();
  });

  it('leaves the Website row to the platform when nothing is set', () => {
    // Rows from before 246, an emptied field, a label that is not an object.
    expect(toIosAppConfig(normalize({})).websiteUrl).toBeNull();
    expect(toIosAppConfig(normalize({ ios_app_website_url: '' })).websiteUrl).toBeNull();
    expect(toIosAppConfig(normalize({ ios_app_website_label: 'Website' })).websiteLabel).toEqual({});
    // The support link is not the website.
    expect(toIosAppConfig(normalize({ ios_app_support_url: 'https://t.me/x' })).websiteUrl).toBeNull();
  });

  it('points Support at the in-app link Super Admin set', () => {
    const config = toIosAppConfig(normalize({
      ios_app_support_url: 'https://t.me/webyar_support',
      support_url: 'https://webyar.ai/support',
    }));
    expect(config.supportUrl).toBe('https://t.me/webyar_support');
  });

  it('falls back to the App Store support URL, then to nothing', () => {
    expect(toIosAppConfig(normalize({ support_url: 'https://webyar.ai/support' })).supportUrl)
      .toBe('https://webyar.ai/support');
    // Nothing set anywhere: the app keeps the platform's own help centre.
    expect(toIosAppConfig(normalize({})).supportUrl).toBeNull();
    // An emptied field is not a link.
    expect(toIosAppConfig(normalize({ ios_app_support_url: '' })).supportUrl).toBeNull();
  });

  it('keeps Settings → Storage on for rows written before migration 232', () => {
    const config = toIosAppConfig(normalize({ ios_app_show_colleagues: false }));
    expect(config).toMatchObject({ showColleagues: false, showStorage: true });
  });

  it('hides Settings → Storage when Super Admin turned it off, and nothing else', () => {
    const config = toIosAppConfig(normalize({ ios_app_show_storage: false }));
    expect(config).toMatchObject({
      showStorage: false,
      showContacts: true,
      showVisitors: true,
      showWebAnalytics: true,
      showAIQueue: true,
      showColleagues: true,
    });
  });

  it('keeps Settings → Online support on for rows written before migration 245', () => {
    const config = toIosAppConfig(normalize({ ios_app_show_storage: false }));
    expect(config).toMatchObject({ showStorage: false, showSupport: true });
  });

  it('hides Settings → Online support only on iOS when Super Admin turned it off', () => {
    const settings = normalize({ ios_app_show_support: false });
    expect(toIosAppConfig(settings)).toMatchObject({ showSupport: false, showStorage: true, showColleagues: true });
    expect(toAndroidAppConfig(settings).showSupport).toBe(true);
    // And Android's own switch leaves iOS alone.
    expect(toIosAppConfig(normalize({ android_app_show_support: false })).showSupport).toBe(true);
  });

  it('keeps the Inbox AI and Colleagues tabs on for rows written before migration 230', () => {
    const config = toIosAppConfig(normalize({ ios_app_show_contacts: false }));
    expect(config).toMatchObject({ showContacts: false, showAIQueue: true, showColleagues: true });
  });

  it('hides the Inbox AI and Colleagues tabs Super Admin turned off', () => {
    const config = toIosAppConfig(normalize({ ios_app_show_ai_queue: false, ios_app_show_colleagues: false }));
    expect(config).toMatchObject({ showAIQueue: false, showColleagues: false, showContacts: true });
  });

  it('keeps every tab on for rows written before migration 229', () => {
    const config = toIosAppConfig(normalize({ android_app_show_visitors: false }));
    expect(config).toMatchObject({ showContacts: true, showVisitors: true, showWebAnalytics: true });
  });

  it('hides a tab Super Admin turned off, and only on iOS', () => {
    const settings = normalize({ ios_app_show_contacts: false, ios_app_show_visitors: false, ios_app_show_web_analytics: false });
    expect(toIosAppConfig(settings)).toMatchObject({ showContacts: false, showVisitors: false, showWebAnalytics: false });
    expect(toAndroidAppConfig(settings)).toMatchObject({ showVisitors: true, showWebAnalytics: true });
  });

  it('says nothing about the App Store record', () => {
    const keys = Object.keys(toIosAppConfig(MOBILE_APP_DEFAULTS));
    expect(keys.some((key) => /version|bundle|team|notes|build/i.test(key))).toBe(false);
  });
});
