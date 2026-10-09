import { beforeEach, describe, expect, it } from 'vitest';
import {
  MACOS_APP_DEFAULTS,
  MACOS_APP_DEFAULT_APPCAST_URL,
  normalizeMacos,
  toPublicMacosAppConfig,
} from './macosSettings.js';
import { macosAppSettingsSchema } from '../../routes/adminMacosApp.js';
import { campaignSchema, campaignPatchSchema } from '../../routes/adminDesktopApp.js';
import { targetsPlatform } from './campaigns.js';
import { __resetLive, addBroadcast, broadcastsAfter, heartbeat, listBroadcasts, platformOf, summary } from './live.js';

describe('macOS app settings — normalize', () => {
  it('fills every missing field from the defaults', () => {
    const settings = normalizeMacos({});
    expect(settings).toEqual({ ...MACOS_APP_DEFAULTS, updated_at: null });
    expect(settings.appcast_url).toBe(MACOS_APP_DEFAULT_APPCAST_URL);
  });

  it('keeps stored values and falls back on nonsense, field by field', () => {
    const settings = normalizeMacos({
      appcast_url: '  ',
      update_channel: 'nightly',
      poll_interval_seconds: 1,
      poll_interval_realtime_seconds: 5000,
      update_check_interval_minutes: '90',
      blocked_versions: ['1.2.0', 'nope', '1.2.0', 7],
      default_language: 'de',
      default_appearance: 'dark',
      email_enabled: false,
      menu_bar_extra_enabled: 'no',
      maintenance_message: { fa: 'به‌روزرسانی سرور', en: '  ', de: 'x' },
      maintenance_until: 'not a date',
      support_url: '',
    });
    expect(settings.appcast_url).toBe(MACOS_APP_DEFAULT_APPCAST_URL);
    expect(settings.update_channel).toBe('stable');
    expect(settings.poll_interval_seconds).toBe(5);
    expect(settings.poll_interval_realtime_seconds).toBe(900);
    expect(settings.update_check_interval_minutes).toBe(90);
    expect(settings.blocked_versions).toEqual(['1.2.0']);
    expect(settings.default_language).toBe('system');
    expect(settings.default_appearance).toBe('dark');
    expect(settings.email_enabled).toBe(false);
    expect(settings.menu_bar_extra_enabled).toBe(true);
    expect(settings.maintenance_message).toEqual({ fa: 'به‌روزرسانی سرور' });
    expect(settings.maintenance_until).toBeNull();
    expect(settings.support_url).toBeNull();
  });
});

describe('macOS app settings — admin schema', () => {
  it('accepts an empty patch', () => {
    expect(macosAppSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('validates versions and the blocked list', () => {
    const ok = macosAppSettingsSchema.parse({
      minimum_supported_version: '1.3.0',
      latest_version: '',
      blocked_versions: ['1.2.1', '1.2.1', '1.2.2-beta.1'],
    });
    expect(ok.minimum_supported_version).toBe('1.3.0');
    expect(ok.latest_version).toBeNull();
    expect(ok.blocked_versions).toEqual(['1.2.1', '1.2.2-beta.1']);
    expect(macosAppSettingsSchema.safeParse({ blocked_versions: ['1.2'] }).success).toBe(false);
    expect(macosAppSettingsSchema.safeParse({ blocked_versions: Array.from({ length: 51 }, (_, i) => `1.0.${i}`) }).success)
      .toBe(false);
  });

  it('requires https for every link and clears with an empty string', () => {
    for (const key of ['appcast_url', 'download_url', 'support_url', 'status_page_url', 'privacy_url', 'terms_url']) {
      expect(macosAppSettingsSchema.safeParse({ [key]: 'http://example.com' }).success, key).toBe(false);
      expect(macosAppSettingsSchema.parse({ [key]: '' })[key as 'support_url']).toBeNull();
    }
  });

  it('enforces the database bounds and vocabularies', () => {
    const bad = [
      { update_check_interval_minutes: 14 },
      { poll_interval_seconds: 301 },
      { poll_interval_realtime_seconds: 14 },
      { update_channel: 'nightly' },
      { default_language: 'de' },
      { default_appearance: 'sepia' },
      { maintenance_until: 'soon' },
    ];
    for (const patch of bad) expect(macosAppSettingsSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
  });

  it('refuses maintenance switched on with nothing to say', () => {
    expect(macosAppSettingsSchema.safeParse({ maintenance_enabled: true, maintenance_message: { fa: ' ' } }).success)
      .toBe(false);
    const ok = macosAppSettingsSchema.parse({
      maintenance_enabled: true,
      maintenance_message: { fa: 'تا ساعت ۲ در دسترس نیستیم', en: '' },
      maintenance_until: '2026-09-25T02:00:00Z',
    });
    expect(ok.maintenance_message).toEqual({ fa: 'تا ساعت ۲ در دسترس نیستیم' });
    expect(ok.maintenance_until).toBe('2026-09-25T02:00:00.000Z');
  });
});

describe('macOS app settings — public projection', () => {
  it('passes the Behaviour tab\'s section switches to the app', () => {
    const s = normalizeMacos({
      contacts_enabled: false,
      visitors_enabled: false,
      web_analytics_enabled: false,
      call_center_enabled: false,
      storage_settings_visible: false,
    });
    const features = toPublicMacosAppConfig(s).features;
    expect(features.contacts).toBe(false);
    expect(features.visitors).toBe(false);
    expect(features.webAnalytics).toBe(false);
    expect(features.callCenter).toBe(false);
    expect(features.storageSettings).toBe(false);
    // A row from before migration 227 keeps both new sections on.
    const old = toPublicMacosAppConfig(normalizeMacos({})).features;
    expect(old.webAnalytics).toBe(true);
    expect(old.storageSettings).toBe(true);
  });

  it('answers the defaults in the documented shape', () => {
    expect(toPublicMacosAppConfig(MACOS_APP_DEFAULTS)).toEqual({
      update: {
        appcastUrl: MACOS_APP_DEFAULT_APPCAST_URL,
        channel: 'stable',
        latestVersion: null,
        minimumSupportedVersion: null,
        blockedVersions: [],
        downloadUrl: null,
        releaseNotes: null,
        autoCheck: true,
        autoDownload: true,
        checkIntervalMinutes: 240,
      },
      realtime: { enabled: true },
      polling: { intervalSeconds: 15, withRealtimeSeconds: 120 },
      features: {
        calls: true,
        videoCalls: true,
        email: true,
        visitors: true,
        callCenter: true,
        colleagues: true,
        contacts: true,
        voiceNotes: true,
        attachments: true,
        webAnalytics: true,
        storageSettings: true,
      },
      system: { menuBarExtra: true, launchAtLogin: true, dockBadge: true, notifications: true },
      defaults: { language: 'system', appearance: 'system', closeToMenuBar: true, launchAtLogin: false },
      maintenance: { enabled: false, message: {}, until: null },
      links: { support: null, status: null, privacy: null, terms: null },
    });
  });

  it('never promises what a switch above it took away', () => {
    const c = toPublicMacosAppConfig({
      ...MACOS_APP_DEFAULTS,
      calls_enabled: false,
      auto_update_enabled: false,
      menu_bar_extra_enabled: false,
      launch_at_login_enabled: false,
      default_launch_at_login: true,
    });
    expect(c.features.videoCalls).toBe(false);
    expect(c.update.autoDownload).toBe(false);
    expect(c.defaults.closeToMenuBar).toBe(false);
    expect(c.defaults.launchAtLogin).toBe(false);
  });

  it('ends maintenance on its own once its end time has passed', () => {
    const base = { ...MACOS_APP_DEFAULTS, maintenance_enabled: true, maintenance_message: { en: 'Upgrading' } };
    expect(toPublicMacosAppConfig({ ...base, maintenance_until: '2000-01-01T00:00:00Z' }).maintenance.enabled).toBe(false);
    expect(toPublicMacosAppConfig({ ...base, maintenance_until: '2999-01-01T00:00:00Z' }).maintenance.enabled).toBe(true);
    expect(toPublicMacosAppConfig({ ...base, maintenance_until: null }).maintenance.enabled).toBe(true);
  });
});

describe('desktop platforms — targeting', () => {
  beforeEach(() => __resetLive());

  it('tells the apps apart by their word, else by their OS line', () => {
    expect(platformOf('macos', 'Windows 11')).toBe('macos');
    expect(platformOf(undefined, 'macOS Version 15.5 (Build 24F74)')).toBe('macos');
    expect(platformOf(undefined, 'Windows 11 Pro')).toBe('windows');
    expect(platformOf(undefined, null)).toBe('windows');
  });

  it('shows a campaign on every app unless it names some', () => {
    expect(targetsPlatform({ platforms: [] }, 'macos')).toBe(true);
    expect(targetsPlatform({ platforms: null }, 'windows')).toBe(true);
    expect(targetsPlatform({}, 'windows')).toBe(true);
    expect(targetsPlatform({ platforms: ['macos'] }, 'windows')).toBe(false);
    expect(targetsPlatform({ platforms: ['windows', 'macos'] }, 'windows')).toBe(true);
  });

  it('accepts platforms on campaigns, and a patch without them leaves them alone', () => {
    const c = campaignSchema.parse({
      kind: 'ad',
      placements: ['inbox_list'],
      platforms: ['macos', 'macos'],
      text: { en: { title: 'Hi' } },
    });
    expect(c.platforms).toEqual(['macos']);
    expect(campaignPatchSchema.parse({ active: false })).toEqual({ active: false });
    expect(campaignSchema.safeParse({ kind: 'ad', placements: ['inbox_list'], platforms: ['linux'], text: {} }).success)
      .toBe(false);
  });

  it('counts each app on its own and in total', () => {
    heartbeat({ sessionId: 'mac000001', userId: 'u1', workspaceId: 'w1', version: '1.0.0', os: 'macOS Version 26.0', platform: 'macos' });
    heartbeat({ sessionId: 'mac000002', userId: 'u2', workspaceId: 'w1', version: '1.0.0', os: 'macOS Version 15.5' });
    heartbeat({ sessionId: 'win000001', userId: 'u3', workspaceId: 'w2', version: '2.0.8', os: 'Windows 11' });
    const mac = summary('macos');
    expect(mac.online).toBe(2);
    expect(mac.users).toBe(2);
    expect(mac.workspaces).toBe(1);
    expect(mac.versions).toEqual([{ version: '1.0.0', count: 2 }]);
    expect(mac.oses).toHaveLength(2);
    expect(mac.platforms).toEqual({ windows: 1, macos: 2 });
    expect(summary().online).toBe(3);
  });

  it('delivers a broadcast only to the apps it names', () => {
    const start = broadcastsAfter(-1).latest;
    addBroadcast({ title: 'Mac only', body: '', severity: 'info', url: null, platforms: ['macos'], createdBy: 'a' });
    addBroadcast({ title: 'Everyone', body: '', severity: 'info', url: null, createdBy: 'a' });
    expect(broadcastsAfter(start, 'macos').items.map((b) => b.title)).toEqual(['Mac only', 'Everyone']);
    expect(broadcastsAfter(start, 'windows').items.map((b) => b.title)).toEqual(['Everyone']);
    // The Windows app, which predates the field, is asked as Windows.
    expect(broadcastsAfter(start).items.map((b) => b.title)).toEqual(['Everyone']);
    expect(listBroadcasts('windows').map((b) => b.title)).toEqual(['Everyone']);
    expect(listBroadcasts().map((b) => b.title)).toEqual(['Everyone', 'Mac only']);
  });
});

describe('macOS app settings — per edition', () => {
  it('leaves the Iranian edition (and an unknown one) exactly as stored', async () => {
    const { macosSettingsForEdition } = await import('./macosSettings.js');
    const s = normalizeMacos({ latest_version: '1.0.0', release_notes: 'First release of Webyar for Mac.' });
    expect(macosSettingsForEdition(s, 'iran')).toBe(s);
    expect(macosSettingsForEdition(s, null)).toBe(s);
  });

  it("points RESPOK at its own appcast, without WebYar's version, link or notes", async () => {
    const { macosSettingsForEdition, macosDefaultAppcastUrl } = await import('./macosSettings.js');
    const cloned = normalizeMacos({
      latest_version: '1.0.0',
      download_url: 'https://raw.githubusercontent.com/pc30cc/mac-os/main/releases/1.0.0/Webyar-1.0.0.dmg',
      release_notes: 'نخستین نسخهٔ Webyar برای مک.',
    });
    const s = macosSettingsForEdition(cloned, 'international');
    expect(s.appcast_url).toBe('https://raw.githubusercontent.com/pc30cc/respok-releases/main/mac/appcast.xml');
    expect(macosDefaultAppcastUrl('international')).toBe(s.appcast_url);
    expect(macosDefaultAppcastUrl(null)).toBe(MACOS_APP_DEFAULT_APPCAST_URL);
    expect(s).toMatchObject({ latest_version: null, download_url: null, release_notes: null });
    const own = normalizeMacos({ appcast_url: s.appcast_url, latest_version: '1.1.7' });
    expect(macosSettingsForEdition(own, 'international').latest_version).toBe('1.1.7');
  });

  it("drops WebYar's help and legal links and notices, and keeps RESPOK's", async () => {
    const { macosSettingsForEdition } = await import('./macosSettings.js');
    const cloned = normalizeMacos({
      privacy_url: 'https://webyar.ai/privacy',
      terms_url: 'https://respok.app/terms',
      support_url: 'https://app.webyar.ai/help',
      maintenance_enabled: true,
      maintenance_message: { fa: 'وب‌یار در حال به‌روزرسانی است', en: 'Back soon', tr: 'Web yardım merkezi güncelleniyor' },
    });
    const s = macosSettingsForEdition(cloned, 'international');
    expect(s).toMatchObject({ privacy_url: null, support_url: null, terms_url: 'https://respok.app/terms' });
    expect(s.maintenance_message).toEqual({ en: 'Back soon', tr: 'Web yardım merkezi güncelleniyor' });
    expect(macosSettingsForEdition(cloned, 'iran')).toBe(cloned);
  });
});
