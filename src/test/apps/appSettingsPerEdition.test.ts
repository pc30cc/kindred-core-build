/**
 * Super Admin's app settings are kept per edition (migration 257): the
 * Iranian edition (WebYar) and the International one (RESPOK) each have
 * their own row of desktop_app_settings, macos_app_settings,
 * mobile_app_settings and push_platform_settings, and their own
 * desktop_app_campaigns. After a switch of platform_settings.region_mode,
 * Super Admin and the apps see that edition's values, never the other's:
 *
 *   - the loaders and Super Admin's GET read the running edition's row;
 *   - a save in one edition never changes the other edition's row;
 *   - an edition with no row gets its own brand's defaults, and its first
 *     save creates its row with them;
 *   - no cache serves one edition's settings after a switch to the other;
 *   - an edition that cannot be told: the apps get the defaults without a
 *     read, Super Admin gets 503 and nothing is written;
 *   - the Iranian edition is exactly as before.
 *
 * The database is an in-memory stand-in that applies the filters the code
 * sends, so a query that forgets `.eq('edition', …)` reads or writes the
 * wrong row here as it would in production.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { ServerConfig } from '../../../server/config';

type Row = Record<string, unknown>;
type Edition = 'iran' | 'international';

const state = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international' | null,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Every query: the table, the operation and its filters. */
  log: [] as Array<{ table: string; op: string; filters: Array<[string, unknown]> }>,
  seq: 0,
  shipped: {
    iran: { versionName: '1.4.0', versionCode: 14, sha256: 'a'.repeat(64), sizeBytes: 10, releasedAt: null },
    international: null,
  } as Record<string, { versionName: string; versionCode: number; sha256: string; sizeBytes: number; releasedAt: null } | null>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let values: Record<string, unknown> = {};
      let mode: 'many' | 'single' | 'maybe' = 'many';
      let limit = Number.POSITIVE_INFINITY;
      const run = () => {
        state.log.push({ table, op, filters: [...filters] });
        const rows = (state.tables[table] ??= []);
        const match = (r: Record<string, unknown>) => filters.every(([c, v]) => r[c] === v);
        let result: Array<Record<string, unknown>>;
        if (op === 'insert') {
          state.seq += 1;
          const row = { id: `00000000-0000-4000-8000-${String(state.seq).padStart(12, '0')}`, created_at: new Date(2026, 0, 1, 0, 0, state.seq).toISOString(), ...values };
          rows.push(row);
          result = [row];
        } else if (op === 'update') {
          result = rows.filter(match);
          for (const r of result) Object.assign(r, values);
        } else if (op === 'delete') {
          result = rows.filter(match);
          state.tables[table] = rows.filter((r) => !match(r));
        } else {
          result = rows.filter(match).slice(0, limit);
        }
        const copy = (r: Record<string, unknown>) => structuredClone(r);
        if (mode === 'many') return { data: result.map(copy), error: null };
        if (mode === 'single' && result.length !== 1) return { data: null, error: { message: `expected one row, got ${result.length}` } };
        return { data: result[0] ? copy(result[0]) : null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: (n: number) => { limit = n; return builder; },
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        lt: () => builder,
        insert: (v: Record<string, unknown>) => { op = 'insert'; values = v; return builder; },
        update: (v: Record<string, unknown>) => { op = 'update'; values = v; return builder; },
        delete: () => { op = 'delete'; return builder; },
        maybeSingle: () => { mode = 'maybe'; return builder; },
        single: () => { mode = 'single'; return builder; },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/platformRegion.js')>();
  return {
    ...actual,
    getPlatformEditionOrNull: async () => state.edition,
    getPlatformEdition: async () => {
      if (!state.edition) throw new actual.EditionUnavailableError();
      return state.edition;
    },
  };
});

vi.mock('../../../server/services/mobileApp/androidRelease.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/mobileApp/androidRelease.js')>()),
  readShippedAndroidRelease: (edition: Edition | null = null) => state.shipped[edition ?? 'iran'] ?? null,
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requirePlatformAdmin: async () => 'admin-1',
  requireUser: async () => 'user-1',
  authorizeWorkspaceAccess: async () => ({ userId: 'user-1' }),
}));

const { adminDesktopAppRouter } = await import('../../../server/routes/adminDesktopApp.js');
const { adminMacosAppRouter } = await import('../../../server/routes/adminMacosApp.js');
const { adminMobileAppRouter } = await import('../../../server/routes/adminMobileApp.js');
const { adminNotificationsRouter } = await import('../../../server/routes/adminNotifications.js');
const publicRoutes = await import('../../../server/routes/desktopAppPublic.js');
const desktop = await import('../../../server/services/desktopApp/settings.js');
const macos = await import('../../../server/services/desktopApp/macosSettings.js');
const campaigns = await import('../../../server/services/desktopApp/campaigns.js');
const mobile = await import('../../../server/services/mobileApp/settings.js');
const push = await import('../../../server/services/push/platformSettings.js');
const retention = await import('../../../server/services/push/logRetention.js');
const { NATIVE_APP_BRANDS } = await import('../../../shared/nativeAppBrands.js');

const CONFIG = {} as ServerConfig;
const WEBYAR_FEED = NATIVE_APP_BRANDS.iran.windowsFeedUrl;
const RESPOK_FEED = NATIVE_APP_BRANDS.international.windowsFeedUrl;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = CONFIG;
    next();
  });
  a.use('/api/admin/desktop-app', adminDesktopAppRouter);
  a.use('/api/admin/macos-app', adminMacosAppRouter);
  a.use('/api/admin/mobile-app', adminMobileAppRouter);
  a.use('/api/admin/notifications', adminNotificationsRouter);
  a.use('/api/platform', publicRoutes.desktopAppPublicRouter);
  return a;
}

const rows = (table: string) => state.tables[table] ?? [];
const rowOf = (table: string, edition: Edition) => rows(table).find((r) => r.edition === edition);
const snapshot = (table: string, edition: Edition) => structuredClone(rowOf(table, edition));
const writes = () => state.log.filter((q) => q.op !== 'select');
const readsOf = (table: string) => state.log.filter((q) => q.table === table && q.op === 'select');

function resetCaches() {
  desktop.invalidateDesktopAppSettingsCache();
  macos.invalidateMacosAppSettingsCache();
  mobile.invalidateMobileAppSettingsCache();
  push.invalidatePushPlatformSettingsCache();
  campaigns.invalidateCampaignCache();
  publicRoutes.invalidateDesktopAppPublicCache();
  publicRoutes.invalidateMacosAppPublicCache();
}

beforeEach(() => {
  state.edition = 'iran';
  state.log = [];
  state.seq = 0;
  state.tables = {
    desktop_app_settings: [
      { id: 'd-iran', edition: 'iran', created_at: '2026-09-21T00:00:00Z', update_feed_url: WEBYAR_FEED, release_notes: 'Webyar 2.6', poll_interval_seconds: 20 },
      { id: 'd-intl', edition: 'international', created_at: '2026-10-09T00:00:00Z', update_feed_url: 'https://app.respok.app/downloads/windows', release_notes: 'RESPOK 2.7', poll_interval_seconds: 45 },
    ],
    macos_app_settings: [
      { id: 'm-iran', edition: 'iran', created_at: '2026-09-24T00:00:00Z', appcast_url: NATIVE_APP_BRANDS.iran.macAppcastUrl, latest_version: '1.2.0' },
    ],
    mobile_app_settings: [],
    push_platform_settings: [],
    desktop_app_campaigns: [],
  };
  resetCaches();
});

// ─── Windows app ───────────────────────────────────────────────────────────

describe('Windows app settings', () => {
  it("Super Admin reads the running edition's row", async () => {
    expect((await request(app()).get('/api/admin/desktop-app/settings')).body.settings).toMatchObject({
      poll_interval_seconds: 20, update_feed_url: WEBYAR_FEED, release_notes: 'Webyar 2.6',
    });
    state.edition = 'international';
    expect((await request(app()).get('/api/admin/desktop-app/settings')).body.settings).toMatchObject({
      poll_interval_seconds: 45, update_feed_url: 'https://app.respok.app/downloads/windows', release_notes: 'RESPOK 2.7',
    });
  });

  it("a save in one edition never changes the other edition's row", async () => {
    const iranBefore = snapshot('desktop_app_settings', 'iran');
    state.edition = 'international';
    const res = await request(app()).put('/api/admin/desktop-app/settings').send({ poll_interval_seconds: 60, calls_enabled: false });
    expect(res.status).toBe(200);
    expect(rowOf('desktop_app_settings', 'international')).toMatchObject({ poll_interval_seconds: 60, calls_enabled: false });
    expect(rowOf('desktop_app_settings', 'iran')).toEqual(iranBefore);

    const intlBefore = snapshot('desktop_app_settings', 'international');
    state.edition = 'iran';
    await request(app()).put('/api/admin/desktop-app/settings').send({ poll_interval_seconds: 30 });
    expect(rowOf('desktop_app_settings', 'iran')).toMatchObject({ poll_interval_seconds: 30 });
    expect(rowOf('desktop_app_settings', 'international')).toEqual(intlBefore);
  });

  it("an edition with no row is served RESPOK's defaults, and its first save creates its own row", async () => {
    state.tables.desktop_app_settings = state.tables.desktop_app_settings.filter((r) => r.edition === 'iran');
    const iranBefore = snapshot('desktop_app_settings', 'iran');
    state.edition = 'international';
    const got = await request(app()).get('/api/admin/desktop-app/settings');
    expect(got.body.settings).toEqual({ ...desktop.DESKTOP_APP_DEFAULTS, update_feed_url: RESPOK_FEED });
    // The app is told the same before anything is saved.
    expect((await desktop.loadDesktopAppSettings(CONFIG)).update_feed_url).toBe(RESPOK_FEED);

    await request(app()).put('/api/admin/desktop-app/settings').send({ calls_enabled: false });
    expect(rows('desktop_app_settings')).toHaveLength(2);
    expect(rowOf('desktop_app_settings', 'international')).toMatchObject({ edition: 'international', update_feed_url: RESPOK_FEED, calls_enabled: false });
    expect(rowOf('desktop_app_settings', 'iran')).toEqual(iranBefore);
  });

  it('the Iranian edition with no row is exactly as before: the defaults, and a first save of only what was sent', async () => {
    state.tables.desktop_app_settings = [];
    expect((await request(app()).get('/api/admin/desktop-app/settings')).body.settings).toEqual(desktop.DESKTOP_APP_DEFAULTS);
    await request(app()).put('/api/admin/desktop-app/settings').send({ calls_enabled: false });
    const { id: _id, created_at: _at, updated_at: _up, ...inserted } = rowOf('desktop_app_settings', 'iran')!;
    expect(inserted).toEqual({ calls_enabled: false, edition: 'iran' });
  });

  it('Super Admin is refused, and nothing is written, while the edition cannot be told', async () => {
    state.edition = null;
    const before = structuredClone(state.tables.desktop_app_settings);
    expect((await request(app()).get('/api/admin/desktop-app/settings')).status).toBe(503);
    const put = await request(app()).put('/api/admin/desktop-app/settings').send({ poll_interval_seconds: 60 });
    expect(put.status).toBe(503);
    expect(put.body).toEqual({ error: 'EDITION_UNAVAILABLE' });
    expect(writes()).toEqual([]);
    expect(state.tables.desktop_app_settings).toEqual(before);
  });

  it('the app is told its edition’s settings, and a switch is seen at once (no cache in between)', async () => {
    expect((await desktop.loadDesktopAppSettings(CONFIG)).poll_interval_seconds).toBe(20);
    expect((await request(app()).get('/api/platform/desktop-app')).body.update.feedUrl).toBe(WEBYAR_FEED);
    state.edition = 'international';
    expect((await desktop.loadDesktopAppSettings(CONFIG)).poll_interval_seconds).toBe(45);
    expect((await request(app()).get('/api/platform/desktop-app')).body.update.feedUrl).toBe('https://app.respok.app/downloads/windows');
    state.edition = 'iran';
    expect((await request(app()).get('/api/platform/desktop-app')).body.polling.intervalSeconds).toBe(20);
  });

  it('the app gets the defaults, without a read, while the edition cannot be told', async () => {
    state.edition = null;
    expect(await desktop.loadDesktopAppSettings(CONFIG)).toEqual(desktop.DESKTOP_APP_DEFAULTS);
    expect(readsOf('desktop_app_settings')).toEqual([]);
  });
});

// ─── macOS app ─────────────────────────────────────────────────────────────

describe('macOS app settings', () => {
  it("each edition reads and saves its own row; a new edition starts from RESPOK's appcast", async () => {
    const iranBefore = snapshot('macos_app_settings', 'iran');
    expect((await request(app()).get('/api/admin/macos-app/settings')).body.settings.latest_version).toBe('1.2.0');

    state.edition = 'international';
    const got = (await request(app()).get('/api/admin/macos-app/settings')).body.settings;
    expect(got).toEqual({ ...macos.MACOS_APP_DEFAULTS, appcast_url: NATIVE_APP_BRANDS.international.macAppcastUrl });
    const put = await request(app()).put('/api/admin/macos-app/settings').send({ latest_version: '2.0.0' });
    expect(put.status).toBe(200);
    expect(rowOf('macos_app_settings', 'international')).toMatchObject({
      edition: 'international', latest_version: '2.0.0', appcast_url: NATIVE_APP_BRANDS.international.macAppcastUrl,
    });
    expect(rowOf('macos_app_settings', 'iran')).toEqual(iranBefore);
  });

  it('the Mac app is told its edition’s settings across a switch', async () => {
    expect((await request(app()).get('/api/platform/macos-app')).body.update.latestVersion).toBe('1.2.0');
    state.edition = 'international';
    const intl = (await request(app()).get('/api/platform/macos-app')).body.update;
    expect(intl).toMatchObject({ appcastUrl: NATIVE_APP_BRANDS.international.macAppcastUrl, latestVersion: null });
    expect((await macos.loadMacosAppSettings(CONFIG)).appcast_url).toBe(NATIVE_APP_BRANDS.international.macAppcastUrl);
  });

  it('refuses while the edition cannot be told', async () => {
    state.edition = null;
    expect((await request(app()).put('/api/admin/macos-app/settings').send({ latest_version: '2.0.0' })).status).toBe(503);
    expect(writes()).toEqual([]);
  });
});

// ─── Ads and announcements ─────────────────────────────────────────────────

describe('desktop ads and announcements', () => {
  const IRAN_ID = '11111111-1111-4111-8111-111111111111';
  const INTL_ID = '22222222-2222-4222-8222-222222222222';
  const campaign = (id: string, edition: Edition, name: string) => ({
    id, edition, name, kind: 'ad', placements: ['inbox_list'], target_plans: [], platforms: [],
    text: { en: { title: name } }, active: true, priority: 0, created_at: '2026-10-01T00:00:00Z',
  });

  beforeEach(() => {
    state.tables.desktop_app_campaigns = [campaign(IRAN_ID, 'iran', 'WebYar spring'), campaign(INTL_ID, 'international', 'RESPOK launch')];
  });

  it('Super Admin lists only the running edition’s campaigns', async () => {
    const iran = (await request(app()).get('/api/admin/desktop-app/campaigns')).body.campaigns;
    expect(iran.map((c: Row) => c.id)).toEqual([IRAN_ID]);
    state.edition = 'international';
    const intl = (await request(app()).get('/api/admin/desktop-app/campaigns')).body.campaigns;
    expect(intl.map((c: Row) => c.id)).toEqual([INTL_ID]);
  });

  it('a new campaign belongs to the running edition', async () => {
    state.edition = 'international';
    const res = await request(app()).post('/api/admin/desktop-app/campaigns').send({
      kind: 'announcement', placements: ['banner'], text: { en: { title: 'Maintenance' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.campaign.edition).toBe('international');
  });

  it('the other edition’s campaign cannot be changed or deleted, even by its id', async () => {
    state.edition = 'international';
    const before = structuredClone(state.tables.desktop_app_campaigns.find((c) => c.id === IRAN_ID));
    const put = await request(app()).put(`/api/admin/desktop-app/campaigns/${IRAN_ID}`).send({ name: 'hijacked', active: false });
    expect(put.status).toBe(404);
    await request(app()).delete(`/api/admin/desktop-app/campaigns/${IRAN_ID}`);
    expect(state.tables.desktop_app_campaigns.find((c) => c.id === IRAN_ID)).toEqual(before);
    // Its own is changed and deleted as before.
    expect((await request(app()).put(`/api/admin/desktop-app/campaigns/${INTL_ID}`).send({ name: 'RESPOK v2' })).body.campaign.name).toBe('RESPOK v2');
    await request(app()).delete(`/api/admin/desktop-app/campaigns/${INTL_ID}`);
    expect(state.tables.desktop_app_campaigns.map((c) => c.id)).toEqual([IRAN_ID]);
  });

  it('the apps are shown the running edition’s campaigns, across a switch, and none while it cannot be told', async () => {
    expect((await campaigns.loadLiveCampaigns(CONFIG)).map((c) => c.id)).toEqual([IRAN_ID]);
    state.edition = 'international';
    expect((await campaigns.loadLiveCampaigns(CONFIG)).map((c) => c.id)).toEqual([INTL_ID]);
    state.edition = null;
    state.log = [];
    expect(await campaigns.loadLiveCampaigns(CONFIG)).toEqual([]);
    expect(readsOf('desktop_app_campaigns')).toEqual([]);
  });

  it('refuses while the edition cannot be told', async () => {
    state.edition = null;
    expect((await request(app()).get('/api/admin/desktop-app/campaigns')).status).toBe(503);
    expect((await request(app()).post('/api/admin/desktop-app/campaigns').send({
      kind: 'ad', placements: ['inbox_list'], text: { en: { title: 'x' } },
    })).status).toBe(503);
    expect((await request(app()).delete(`/api/admin/desktop-app/campaigns/${IRAN_ID}`)).status).toBe(503);
    expect(writes()).toEqual([]);
  });
});

// ─── Mobile apps ───────────────────────────────────────────────────────────

describe('mobile app settings', () => {
  const webyarRow = () => ({
    id: 'mob-iran', edition: 'iran', created_at: '2026-09-21T00:00:00Z',
    app_name: 'Webyar', display_name: 'Webyar', bundle_id: 'com.webyar.app', android_package_name: 'com.webyar.ai',
    android_app_name: 'Webyar', android_version_name: '1.0.0', android_version_code: 1, ios_default_language: 'fa',
    privacy_policy_url: 'https://webyar.ai/privacy',
  });

  it("an edition with no row is served RESPOK's identity, naming nothing of WebYar's", async () => {
    state.tables.mobile_app_settings = [webyarRow()];
    state.edition = 'international';
    const res = await request(app()).get('/api/admin/mobile-app/settings');
    expect(res.status).toBe(200);
    expect(res.body.environment.provisioned).toBe(false);
    expect(res.body.settings).toMatchObject({
      app_name: 'RESPOK', display_name: 'RESPOK', bundle_id: 'com.respok.app',
      android_package_name: 'com.respok.app', android_app_name: 'RESPOK', privacy_policy_url: null,
    });
    expect(JSON.stringify(res.body.settings)).not.toMatch(/webyar/i);
  });

  it("the first save abroad creates RESPOK's row with RESPOK's identity, and leaves WebYar's alone", async () => {
    state.tables.mobile_app_settings = [webyarRow()];
    const iranBefore = snapshot('mobile_app_settings', 'iran');
    state.edition = 'international';
    const res = await request(app()).put('/api/admin/mobile-app/settings').send({ ios_default_language: 'tr' });
    expect(res.status).toBe(200);
    expect(rowOf('mobile_app_settings', 'international')).toMatchObject({
      edition: 'international', ios_default_language: 'tr', app_name: 'RESPOK', display_name: 'RESPOK',
      bundle_id: 'com.respok.app', android_package_name: 'com.respok.app', android_app_name: 'RESPOK',
      usage_camera: expect.stringMatching(/^RESPOK needs camera access/),
    });
    expect(rowOf('mobile_app_settings', 'iran')).toEqual(iranBefore);
    expect(res.body.settings.bundle_id).toBe('com.respok.app');
  });

  it("the shipped Android version is written into the running edition's row only", async () => {
    state.tables.mobile_app_settings = [webyarRow(), { ...webyarRow(), id: 'mob-intl', edition: 'international', app_name: 'RESPOK', android_version_name: '0.9.0', android_version_code: 9 }];
    const intlBefore = snapshot('mobile_app_settings', 'international');
    const iran = await request(app()).get('/api/admin/mobile-app/settings');
    expect(iran.body.settings).toMatchObject({ android_version_name: '1.4.0', android_version_code: 14 });
    expect(rowOf('mobile_app_settings', 'iran')).toMatchObject({ android_version_name: '1.4.0', android_version_code: 14 });
    expect(rowOf('mobile_app_settings', 'international')).toEqual(intlBefore);

    // RESPOK has no shipped APK yet: its own typed version stands, nothing is written.
    state.edition = 'international';
    state.log = [];
    const iranAfter = snapshot('mobile_app_settings', 'iran');
    const intl = await request(app()).get('/api/admin/mobile-app/settings');
    expect(intl.body.settings).toMatchObject({ app_name: 'RESPOK', android_version_name: '0.9.0', android_version_code: 9 });
    expect(intl.body.environment.androidRelease).toBeNull();
    expect(writes()).toEqual([]);
    expect(rowOf('mobile_app_settings', 'iran')).toEqual(iranAfter);
  });

  it('a checklist tick is recorded on the running edition’s row', async () => {
    state.tables.mobile_app_settings = [webyarRow()];
    state.edition = 'international';
    await request(app()).post('/api/admin/mobile-app/checklist').send({ key: 'screenshots', done: true });
    expect(rowOf('mobile_app_settings', 'international')?.checklist).toMatchObject({ screenshots: { done: true, by: 'admin-1' } });
    expect(rowOf('mobile_app_settings', 'iran')?.checklist).toBeUndefined();
  });

  it('the Iranian edition is exactly as before', async () => {
    const res = await request(app()).get('/api/admin/mobile-app/settings');
    expect(res.body.settings).toEqual({ ...mobile.MOBILE_APP_DEFAULTS, android_version_name: '1.4.0', android_version_code: 14 });
    await request(app()).put('/api/admin/mobile-app/settings').send({ ios_default_language: 'fa' });
    const { id: _id, created_at: _at, updated_at: _up, ...inserted } = rowOf('mobile_app_settings', 'iran')!;
    expect(inserted).toEqual({ ios_default_language: 'fa', android_version_name: '1.4.0', android_version_code: 14, edition: 'iran' });
  });

  it('the apps are told their edition’s settings across a switch', async () => {
    state.tables.mobile_app_settings = [webyarRow(), { id: 'mob-intl', edition: 'international', created_at: '2026-10-09T00:00:00Z', ios_default_language: 'en', privacy_policy_url: 'https://respok.app/privacy' }];
    expect(await mobile.loadMobileAppSettings(CONFIG)).toMatchObject({ ios_default_language: 'fa', privacy_policy_url: 'https://webyar.ai/privacy' });
    state.edition = 'international';
    expect(await mobile.loadMobileAppSettings(CONFIG)).toMatchObject({ ios_default_language: 'en', privacy_policy_url: 'https://respok.app/privacy', bundle_id: 'com.respok.app' });
  });

  it('refuses while the edition cannot be told', async () => {
    state.edition = null;
    expect((await request(app()).get('/api/admin/mobile-app/settings')).status).toBe(503);
    expect((await request(app()).put('/api/admin/mobile-app/settings').send({ ios_default_language: 'en' })).status).toBe(503);
    expect((await request(app()).post('/api/admin/mobile-app/checklist').send({ key: 'x', done: true })).status).toBe(503);
    expect(writes()).toEqual([]);
  });
});

// ─── Push policy ───────────────────────────────────────────────────────────

describe('push policy (Super Admin → Notifications)', () => {
  beforeEach(() => {
    state.tables.push_platform_settings = [
      { id: 'p-iran', edition: 'iran', created_at: '2026-09-21T00:00:00Z', dispatch_log_retention_days: 90, sound_name: 'webyar.caf' },
    ];
  });

  it("each edition reads and saves its own row; a save abroad leaves WebYar's alone", async () => {
    const iranBefore = snapshot('push_platform_settings', 'iran');
    expect((await request(app()).get('/api/admin/notifications/settings')).body.settings.sound_name).toBe('webyar.caf');
    state.edition = 'international';
    const got = await request(app()).get('/api/admin/notifications/settings');
    expect(got.body.provisioned).toBe(false);
    expect(got.body.settings).toEqual(push.pushPlatformDefaults('international'));
    const put = await request(app()).put('/api/admin/notifications/settings').send({ dispatch_log_retention_days: 7 });
    expect(put.status).toBe(200);
    expect(rowOf('push_platform_settings', 'international')).toMatchObject({ edition: 'international', dispatch_log_retention_days: 7 });
    expect(rowOf('push_platform_settings', 'iran')).toEqual(iranBefore);
  });

  it('dispatch uses the running edition’s policy, across a switch', async () => {
    state.tables.push_platform_settings.push({ id: 'p-intl', edition: 'international', created_at: '2026-10-09T00:00:00Z', sound_name: 'respok.caf' });
    expect((await push.loadPushPlatformSettings(CONFIG)).sound_name).toBe('webyar.caf');
    state.edition = 'international';
    expect((await push.loadPushPlatformSettings(CONFIG)).sound_name).toBe('respok.caf');
    state.edition = null;
    state.log = [];
    expect(await push.loadPushPlatformSettings(CONFIG)).toEqual(push.PUSH_PLATFORM_DEFAULTS);
    expect(readsOf('push_platform_settings')).toEqual([]);
  });

  it('the log cleanup goes by the running edition’s retention, and records the run on its row', async () => {
    expect((await retention.dispatchLogStats(CONFIG)).retentionDays).toBe(90);
    state.edition = 'international';
    expect((await retention.dispatchLogStats(CONFIG)).retentionDays).toBe(30);
    state.tables.push_platform_settings.push({ id: 'p-intl', edition: 'international', created_at: '2026-10-09T00:00:00Z' });
    await retention.purgeDispatchLog(CONFIG, 30);
    expect(rowOf('push_platform_settings', 'international')?.dispatch_log_purged_count).toBe(0);
    expect(rowOf('push_platform_settings', 'iran')?.dispatch_log_purged_count).toBeUndefined();
  });

  it('nothing is cleaned up, automatically or from the screen, while the edition cannot be told', async () => {
    state.edition = null;
    expect(await retention.runDispatchLogJanitorOnce(CONFIG)).toBeNull();
    expect((await request(app()).post('/api/admin/notifications/log/purge').send({ days: 1 })).status).toBe(503);
    expect((await request(app()).get('/api/admin/notifications/log/stats')).status).toBe(503);
    expect(state.log.filter((q) => q.table === 'push_dispatch_log')).toEqual([]);
    expect(writes()).toEqual([]);
  });
});
