/**
 * GET /api/mobile-app/public-config?platform=android — what the Android app
 * reads before anyone signs in: the language to open in and whether a
 * maintenance notice is up. Public, never cached, never a failure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let row: Record<string, unknown> | null = null;
let failRead = false;
const requireUser = vi.fn(async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
  res.status(401).json({ error: 'Unauthorized' });
  return null;
});

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => {
    if (failRead) throw new Error('database down');
    const query = {
      select: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: row, error: null }),
    };
    return { from: () => query };
  },
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

  it('knows only Android', async () => {
    const res = await request(app()).get('/api/mobile-app/public-config?platform=ios');
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaves the signed-in /config behind its session check', async () => {
    const res = await request(app()).get('/api/mobile-app/config?platform=android');
    expect(res.status).toBe(401);
    expect(requireUser).toHaveBeenCalledTimes(1);
  });
});
