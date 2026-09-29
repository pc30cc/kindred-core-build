import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MOBILE_APP_DEFAULTS,
  normalize,
  toAndroidAppConfig,
  toAndroidPublicConfig,
} from './settings.js';
import { androidLanguageMaintenanceFields } from './androidMaintenance.js';

/**
 * The Android app's default language and maintenance notice (migration 237):
 * what the app reads before sign-in from GET /api/mobile-app/public-config,
 * and again once signed in from GET /api/mobile-app/config.
 */
const NOW = new Date('2026-09-29T12:00:00.000Z');

describe('Android default language and maintenance — served to the app', () => {
  it('ships in Persian with no notice, before sign-in and after', () => {
    expect(toAndroidPublicConfig(MOBILE_APP_DEFAULTS, NOW)).toEqual({
      platform: 'android',
      defaultLanguage: 'fa',
      maintenance: { enabled: false, message: {}, until: null },
    });
    const signedIn = toAndroidAppConfig(MOBILE_APP_DEFAULTS, NOW);
    expect(signedIn.defaultLanguage).toBe('fa');
    expect(signedIn.maintenance).toEqual({ enabled: false, message: {}, until: null });
  });

  it('fills a row written before migration 237 with the defaults', () => {
    const settings = normalize({ app_name: 'Webyar', android_app_show_storage: true });
    expect(settings.android_default_language).toBe('fa');
    expect(settings.android_maintenance_enabled).toBe(false);
    expect(settings.android_maintenance_message).toEqual({});
    expect(settings.android_maintenance_until).toBeNull();
  });

  it('carries the language Super Admin chose, and never an unknown one', () => {
    expect(toAndroidPublicConfig(normalize({ android_default_language: 'tr' }), NOW).defaultLanguage).toBe('tr');
    expect(toAndroidPublicConfig(normalize({ android_default_language: 'en' }), NOW).defaultLanguage).toBe('en');
    expect(toAndroidPublicConfig(normalize({ android_default_language: 'de' }), NOW).defaultLanguage).toBe('fa');
  });

  it('is on with no end time for as long as the switch is on', () => {
    const settings = normalize({ android_maintenance_enabled: true, android_maintenance_message: { en: 'Back soon' } });
    expect(toAndroidPublicConfig(settings, NOW).maintenance).toEqual({
      enabled: true,
      message: { en: 'Back soon' },
      until: null,
    });
  });

  it('is on until its end time, and over by itself once that has passed', () => {
    // As Postgres hands it back; the app is sent UTC `…Z`.
    const settings = normalize({ android_maintenance_enabled: true, android_maintenance_until: '2026-09-29T17:30:00+03:30' });
    expect(toAndroidPublicConfig(settings, NOW).maintenance).toEqual({
      enabled: true,
      message: {},
      until: '2026-09-29T14:00:00.000Z',
    });
    expect(toAndroidPublicConfig(settings, new Date('2026-09-29T14:00:00.000Z')).maintenance.enabled).toBe(false);
    expect(toAndroidPublicConfig(settings, new Date('2026-09-29T15:00:00.000Z')).maintenance.enabled).toBe(false);
    // The signed-in config judges it the same way.
    expect(toAndroidAppConfig(settings, new Date('2026-09-29T15:00:00.000Z')).maintenance.enabled).toBe(false);
  });

  it('stays off when the switch is off, whatever the end time says', () => {
    const settings = normalize({ android_maintenance_enabled: false, android_maintenance_until: '2026-12-01T00:00:00Z' });
    expect(toAndroidPublicConfig(settings, NOW).maintenance.enabled).toBe(false);
  });

  it('drops blank and unknown message languages, and a malformed message or end time', () => {
    const settings = normalize({
      android_maintenance_enabled: true,
      android_maintenance_message: { fa: '  در حال به‌روزرسانی  ', en: '   ', tr: '', de: 'Wartung' },
      android_maintenance_until: 'not a date',
    });
    expect(toAndroidPublicConfig(settings, NOW).maintenance).toEqual({
      enabled: true,
      message: { fa: 'در حال به‌روزرسانی' },
      until: null,
    });
    expect(normalize({ android_maintenance_message: ['x'] }).android_maintenance_message).toEqual({});
    expect(normalize({ android_maintenance_message: { en: 42 } }).android_maintenance_message).toEqual({});
    expect(normalize({ android_maintenance_enabled: 'yes' }).android_maintenance_enabled).toBe(false);
  });

  it('tells the public nothing but the platform, the language and the notice', () => {
    const settings = normalize({
      android_firebase_app_id: '1:123456789012:android:0a1b2c3d4e5f6a7b',
      android_firebase_api_key: 'AIzaSyDq3b7mX0v9QeLr4TnKw2HsZc5Uf8Ga1pE',
      android_firebase_project_id: 'webyar-app',
      android_firebase_sender_id: '123456789012',
    });
    expect(Object.keys(toAndroidPublicConfig(settings, NOW)).sort()).toEqual(['defaultLanguage', 'maintenance', 'platform']);
    expect(Object.keys(toAndroidPublicConfig(settings, NOW).maintenance).sort()).toEqual(['enabled', 'message', 'until']);
  });
});

/** What Super Admin → Mobile App → Android accepts for them (PUT /api/admin/mobile-app/settings). */
describe('Android default language and maintenance — what Super Admin accepts', () => {
  const schema = z.object(androidLanguageMaintenanceFields);

  it('takes each field on its own, as a partial save sends it', () => {
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ android_default_language: 'tr' })).toEqual({ android_default_language: 'tr' });
    expect(schema.parse({ android_maintenance_enabled: true })).toEqual({ android_maintenance_enabled: true });
  });

  it('refuses a language the app is not written in', () => {
    expect(schema.safeParse({ android_default_language: 'de' }).success).toBe(false);
    expect(schema.safeParse({ android_default_language: 'system' }).success).toBe(false);
    expect(schema.safeParse({ android_maintenance_enabled: 'true' }).success).toBe(false);
  });

  it('trims each message, drops blanks, and caps each language at 500 characters', () => {
    expect(
      schema.parse({ android_maintenance_message: { fa: '  به‌زودی برمی‌گردیم ', en: '   ', tr: '', de: 'x' } }),
    ).toEqual({ android_maintenance_message: { fa: 'به‌زودی برمی‌گردیم' } });
    expect(schema.parse({ android_maintenance_message: { en: null } })).toEqual({ android_maintenance_message: {} });
    expect(schema.safeParse({ android_maintenance_message: { en: 'a'.repeat(500) } }).success).toBe(true);
    expect(schema.safeParse({ android_maintenance_message: { en: ` ${'a'.repeat(500)} ` } }).success).toBe(true);
    expect(schema.safeParse({ android_maintenance_message: { en: 'a'.repeat(501) } }).success).toBe(false);
    expect(schema.safeParse({ android_maintenance_message: 'Back soon' }).success).toBe(false);
  });

  it('allows a notice switched on with no message — the app has its own wording', () => {
    expect(schema.parse({ android_maintenance_enabled: true, android_maintenance_message: {} })).toEqual({
      android_maintenance_enabled: true,
      android_maintenance_message: {},
    });
  });

  it('takes an ISO end time with an offset, or null or empty for none', () => {
    expect(schema.parse({ android_maintenance_until: '2026-09-29T14:00:00.000Z' })).toEqual({
      android_maintenance_until: '2026-09-29T14:00:00.000Z',
    });
    // As Postgres hands it back, so an unchanged draft saves again.
    expect(schema.parse({ android_maintenance_until: '2026-09-29T17:30:00+03:30' })).toEqual({
      android_maintenance_until: '2026-09-29T14:00:00.000Z',
    });
    expect(schema.parse({ android_maintenance_until: null })).toEqual({ android_maintenance_until: null });
    expect(schema.parse({ android_maintenance_until: '' })).toEqual({ android_maintenance_until: null });
  });

  it('refuses an end time that is not an ISO date and time with a zone', () => {
    for (const bad of ['tomorrow', '2026-09-29', '2026-09-29T14:00', '29/09/2026 14:00Z', '2026-13-45T99:99Z']) {
      expect(schema.safeParse({ android_maintenance_until: bad }).success, bad).toBe(false);
    }
  });
});
