import { describe, expect, it } from 'vitest';
import {
  DESKTOP_APP_DEFAULTS,
  DESKTOP_APP_DEFAULT_FEED_URL,
  normalize,
  toPublicDesktopAppConfig,
} from './settings.js';
import { desktopAppSettingsSchema } from '../../routes/adminDesktopApp.js';

describe('desktop app settings — normalize', () => {
  it('fills every missing field from the defaults', () => {
    const settings = normalize({});
    expect(settings).toEqual({ ...DESKTOP_APP_DEFAULTS, updated_at: null });
    expect(settings.update_feed_url).toBe(DESKTOP_APP_DEFAULT_FEED_URL);
  });

  it('keeps stored values and falls back on nonsense', () => {
    const settings = normalize({
      update_channel: 'nightly',
      poll_interval_seconds: 2,
      poll_interval_realtime_seconds: 9999,
      update_check_interval_minutes: '60',
      latest_version: '1.2.3',
      download_url: '',
      update_feed_url: '   ',
      realtime_enabled: false,
      storage_settings_visible: 'no',
    });
    expect(settings.update_channel).toBe('stable');
    expect(settings.poll_interval_seconds).toBe(5);
    expect(settings.poll_interval_realtime_seconds).toBe(900);
    expect(settings.update_check_interval_minutes).toBe(60);
    expect(settings.latest_version).toBe('1.2.3');
    expect(settings.download_url).toBeNull();
    expect(settings.update_feed_url).toBe(DESKTOP_APP_DEFAULT_FEED_URL);
    expect(settings.realtime_enabled).toBe(false);
    expect(settings.storage_settings_visible).toBe(true);
    expect(normalize({ storage_settings_visible: false }).storage_settings_visible).toBe(false);
  });
});

describe('desktop app settings — admin schema', () => {
  it('accepts an empty patch', () => {
    expect(desktopAppSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('validates versions as semver and clears them with an empty string', () => {
    const ok = desktopAppSettingsSchema.parse({ latest_version: '1.4.0-beta.2', minimum_supported_version: '' });
    expect(ok.latest_version).toBe('1.4.0-beta.2');
    expect(ok.minimum_supported_version).toBeNull();
    expect(desktopAppSettingsSchema.safeParse({ latest_version: '1.4' }).success).toBe(false);
    expect(desktopAppSettingsSchema.safeParse({ latest_version: 'v1.4.0' }).success).toBe(false);
  });

  it('requires https URLs', () => {
    expect(desktopAppSettingsSchema.safeParse({ update_feed_url: 'http://example.com/feed' }).success).toBe(false);
    expect(desktopAppSettingsSchema.parse({ download_url: '' }).download_url).toBeNull();
    expect(desktopAppSettingsSchema.parse({ update_feed_url: 'https://example.com/feed' }).update_feed_url)
      .toBe('https://example.com/feed');
  });

  it('enforces the same integer bounds as the database', () => {
    const bad = [
      { update_check_interval_minutes: 14 },
      { update_check_interval_minutes: 1441 },
      { poll_interval_seconds: 4 },
      { poll_interval_seconds: 301 },
      { poll_interval_realtime_seconds: 14 },
      { poll_interval_realtime_seconds: 901 },
      { update_channel: 'nightly' },
    ];
    for (const patch of bad) expect(desktopAppSettingsSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
    expect(
      desktopAppSettingsSchema.safeParse({
        update_check_interval_minutes: 15,
        poll_interval_seconds: 300,
        poll_interval_realtime_seconds: 900,
      }).success,
    ).toBe(true);
  });
});

describe('desktop app settings — public projection', () => {
  it('answers the defaults in the documented shape', () => {
    expect(toPublicDesktopAppConfig(DESKTOP_APP_DEFAULTS)).toEqual({
      update: {
        feedUrl: DESKTOP_APP_DEFAULT_FEED_URL,
        channel: 'stable',
        latestVersion: null,
        minimumSupportedVersion: null,
        downloadUrl: null,
        releaseNotes: null,
        autoUpdate: true,
        checkIntervalMinutes: 240,
      },
      realtime: { enabled: true },
      polling: { intervalSeconds: 15, withRealtimeSeconds: 120 },
      features: { calls: true, storageSettings: true },
    });
  });
});
