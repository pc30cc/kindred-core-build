/**
 * GET /api/mobile-app/public-config?platform=android — what the Android app
 * reads before anyone signs in: the language to open in and whether a
 * maintenance notice is up. Public, never cached, never a failure.
 *
 * The answer is the running edition's (one mobile_app_settings row per
 * edition, migration 257): WebYar's app in Iran, RESPOK's abroad.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** The Iranian edition's row (`row`) and the International edition's (`intlRow`). */
let row: Record<string, unknown> | null = null;
let intlRow: Record<string, unknown> | null = null;
let edition: 'iran' | 'international' | null = 'iran';
let failRead = false;
const requireUser = vi.fn(async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
  res.status(401).json({ error: 'Unauthorized' });
  return null;
});

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => {
    if (failRead) throw new Error('database down');
    let asked: string | null = null;
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === 'edition') asked = value;
        return query;
      },
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: asked === 'iran' ? row : asked === 'international' ? intlRow : null, error: null }),
    };
    return { from: () => query };
  },
}));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => edition,
}));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requireUser,
  authorizeWorkspaceAccess: async () => null,
}));

const { mobilePromotionsRouter } = await import('../../../server/routes/mobilePromotions.js');
const { invalidateMobileAppSettingsCache } = await import('../../../server/services/mobileApp/settings.js');

function app() {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = {};
    next();
  });
  a.use('/api/mobile-app', mobilePromotionsRouter);
  return a;
}

beforeEach(() => {
  row = null;
  intlRow = null;
  edition = 'iran';
  failRead = false;
  requireUser.mockClear();
  invalidateMobileAppSettingsCache();
});

describe('GET /api/mobile-app/public-config', () => {
  it('answers without a session, uncached, with the defaults on a fresh install', async () => {
    const res = await request(app()).get('/api/mobile-app/public-config?platform=android');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      platform: 'android',
      defaultLanguage: 'fa',
      maintenance: { enabled: false, message: {}, until: null },
    });
    expect(requireUser).not.toHaveBeenCalled();
  });

  it('serves the language and the notice Super Admin set', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    row = {
      android_default_language: 'en',
      android_maintenance_enabled: true,
      android_maintenance_message: { en: 'Back at noon', fa: '  ', tr: 'Öğlen dönüyoruz' },
      android_maintenance_until: until,
      android_firebase_api_key: 'AIzaSyDq3b7mX0v9QeLr4TnKw2HsZc5Uf8Ga1pE',
    };
    const res = await request(app()).get('/api/mobile-app/public-config?platform=android');
    expect(res.body).toEqual({
      platform: 'android',
      defaultLanguage: 'en',
      maintenance: { enabled: true, message: { en: 'Back at noon', tr: 'Öğlen dönüyoruz' }, until },
    });
  });

  it('reports a notice past its end time as over', async () => {
    row = { android_maintenance_enabled: true, android_maintenance_until: '2020-01-01T00:00:00Z' };
    const res = await request(app()).get('/api/mobile-app/public-config?platform=android');
    expect(res.body.maintenance.enabled).toBe(false);
  });

  it('answers with the defaults when the settings cannot be read', async () => {
    failRead = true;
    const res = await request(app()).get('/api/mobile-app/public-config?platform=android');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      platform: 'android',
      defaultLanguage: 'fa',
      maintenance: { enabled: false, message: {}, until: null },
    });
  });

  it('tells the iOS app its language and legal links, and nothing of Android\'s', async () => {
    row = {
      ios_default_language: 'fa', android_default_language: 'tr', android_maintenance_enabled: true,
      privacy_policy_url: 'https://webyar.ai/privacy', terms_url: 'https://webyar.ai/terms',
    };
    const res = await request(app()).get('/api/mobile-app/public-config?platform=ios');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      platform: 'ios', defaultLanguage: 'fa',
      privacyPolicyUrl: 'https://webyar.ai/privacy', termsUrl: 'https://webyar.ai/terms',
    });
    expect(requireUser).not.toHaveBeenCalled();
  });

  it('answers the iOS app with English when the settings cannot be read', async () => {
    failRead = true;
    const res = await request(app()).get('/api/mobile-app/public-config?platform=ios');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: 'ios', defaultLanguage: 'en', privacyPolicyUrl: null, termsUrl: null });
  });

  it('knows only Android and iOS', async () => {
    const res = await request(app()).get('/api/mobile-app/public-config?platform=windows');
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaves the signed-in /config behind its session check', async () => {
    const res = await request(app()).get('/api/mobile-app/config?platform=android');
    expect(res.status).toBe(401);
    expect(requireUser).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/mobile-app/public-config — each edition its own', () => {
  it("serves RESPOK's own row abroad, and WebYar's at home, switching at once", async () => {
    row = { ios_default_language: 'fa', privacy_policy_url: 'https://webyar.ai/privacy' };
    intlRow = { ios_default_language: 'tr', privacy_policy_url: 'https://respok.app/privacy' };
    const iran = await request(app()).get('/api/mobile-app/public-config?platform=ios');
    expect(iran.body).toMatchObject({ defaultLanguage: 'fa', privacyPolicyUrl: 'https://webyar.ai/privacy' });
    // The edition switches: the cached Iranian answer is not served to RESPOK's app.
    edition = 'international';
    const intl = await request(app()).get('/api/mobile-app/public-config?platform=ios');
    expect(intl.body).toMatchObject({ defaultLanguage: 'tr', privacyPolicyUrl: 'https://respok.app/privacy' });
    edition = 'iran';
    const back = await request(app()).get('/api/mobile-app/public-config?platform=ios');
    expect(back.body).toMatchObject({ defaultLanguage: 'fa', privacyPolicyUrl: 'https://webyar.ai/privacy' });
  });

  it("never links RESPOK's app to WebYar, even from a cloned row", async () => {
    edition = 'international';
    intlRow = { privacy_policy_url: 'https://webyar.ai/privacy', terms_url: 'https://respok.app/terms' };
    const res = await request(app()).get('/api/mobile-app/public-config?platform=ios');
    expect(res.body).toEqual({ platform: 'ios', defaultLanguage: 'en', privacyPolicyUrl: null, termsUrl: 'https://respok.app/terms' });
  });

  it("an edition with no row yet gets its own defaults, not the other edition's row", async () => {
    edition = 'international';
    row = { android_default_language: 'tr', android_maintenance_enabled: true, android_maintenance_message: { en: 'x' } };
    const res = await request(app()).get('/api/mobile-app/public-config?platform=android');
    // RESPOK's app opens in English; WebYar's in Persian.
    expect(res.body).toEqual({ platform: 'android', defaultLanguage: 'en', maintenance: { enabled: false, message: {}, until: null } });
  });

  it("RESPOK's app falls back to English when its own row names no language", async () => {
    edition = 'international';
    intlRow = { android_default_language: 'de' };
    expect((await request(app()).get('/api/mobile-app/public-config?platform=android')).body.defaultLanguage).toBe('en');
    invalidateMobileAppSettingsCache();
    failRead = true;
    expect((await request(app()).get('/api/mobile-app/public-config?platform=android')).body.defaultLanguage).toBe('en');
  });

  it('answers the defaults, without reading a row, while the edition cannot be told', async () => {
    edition = null;
    row = { android_default_language: 'en' };
    const res = await request(app()).get('/api/mobile-app/public-config?platform=android');
    expect(res.status).toBe(200);
    expect(res.body.defaultLanguage).toBe('fa');
  });
});
