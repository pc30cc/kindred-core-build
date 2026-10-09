/**
 * Super Admin → Mobile App → App Review (migration 248): the routes behind
 * the account Apple's reviewers sign in with.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let isAdmin = true;
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const rpc = vi.fn(async (_name: string, _args?: Record<string, unknown>) => rpcResult);

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ rpc }),
}));

// The seed records itself on the running edition's settings row (migrations 257, 258).
let edition: 'iran' | 'international' = 'iran';
let settingsRow: Record<string, unknown> | null = { id: 'row-1' };
const saveRow = vi.fn(async (..._args: unknown[]) => ({ data: { id: 'new-row' }, error: null }));
vi.mock('../../../server/services/platformRegion.js', () => ({
  getPlatformEdition: async () => edition,
}));
vi.mock('../../../server/services/editionSettings.js', () => ({
  readEditionSettingsRow: async () => settingsRow,
  saveEditionSettingsRow: (...args: unknown[]) => saveRow(...args),
  respondEditionUnavailable: () => false,
}));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requirePlatformAdmin: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (isAdmin) return 'admin-1';
    res.status(403).json({ error: 'Forbidden' });
    return null;
  },
}));

const { adminAppReviewRouter } = await import('../../../server/routes/adminAppReview.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = {};
    next();
  });
  a.use('/api/admin/mobile-app/app-review', adminAppReviewRouter);
  return a;
}

const STATUS = { email: 'apple@webyar.ai', exists: true, enabled: true, workspace_name: 'Webyar Demo' };

beforeEach(() => {
  isAdmin = true;
  rpcResult = { data: STATUS, error: null };
  rpc.mockClear();
  edition = 'iran';
  settingsRow = { id: 'row-1' };
  saveRow.mockClear();
});

describe('App Review account routes', () => {
  it('are for platform admins only', async () => {
    isAdmin = false;
    expect((await request(app()).get('/api/admin/mobile-app/app-review')).status).toBe(403);
    expect((await request(app()).post('/api/admin/mobile-app/app-review/seed').send({})).status).toBe(403);
    expect((await request(app()).post('/api/admin/mobile-app/app-review/enabled').send({ enabled: true })).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads where the account stands', async () => {
    const res = await request(app()).get('/api/admin/mobile-app/app-review');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STATUS);
    expect(rpc).toHaveBeenCalledWith('app_review_status');
  });

  it('refreshes the content without touching the password when none is given', async () => {
    const res = await request(app()).post('/api/admin/mobile-app/app-review/seed').send({});
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('app_review_seed', { _password_hash: null });
  });

  it('hashes a new password as sign-up does, and never passes it on in the clear', async () => {
    const res = await request(app()).post('/api/admin/mobile-app/app-review/seed').send({ password: 'power%10' });
    expect(res.status).toBe(200);
    const hash = rpc.mock.calls[0][1]?._password_hash as string;
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('power%10');
  });

  it("creates the running edition's settings row before seeding when it has none, from that edition's defaults", async () => {
    edition = 'international';
    settingsRow = null;
    const res = await request(app()).post('/api/admin/mobile-app/app-review/seed').send({});
    expect(res.status).toBe(200);
    expect(saveRow).toHaveBeenCalledTimes(1);
    const [, table, savedEdition, existing, , defaults] = saveRow.mock.calls[0] as unknown[];
    expect(table).toBe('mobile_app_settings');
    expect(savedEdition).toBe('international');
    expect(existing).toBeNull();
    expect(defaults).toMatchObject({ bundle_id: 'com.respok.app', android_package_name: 'com.respok.app' });
    expect(saveRow.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  });

  it('leaves an existing row alone and just seeds', async () => {
    const res = await request(app()).post('/api/admin/mobile-app/app-review/seed').send({});
    expect(res.status).toBe(200);
    expect(saveRow).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('app_review_seed', { _password_hash: null });
  });

  it('refuses a password under eight characters', async () => {
    const res = await request(app()).post('/api/admin/mobile-app/app-review/seed').send({ password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('password_too_short');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('asks for a password when the account has to be created', async () => {
    rpcResult = { data: null, error: { message: 'app_review_password_required' } };
    const res = await request(app()).post('/api/admin/mobile-app/app-review/seed').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('password_required');
  });

  it('turns sign-in on and off', async () => {
    rpcResult = { data: { ...STATUS, enabled: false }, error: null };
    const res = await request(app()).post('/api/admin/mobile-app/app-review/enabled').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(rpc).toHaveBeenCalledWith('app_review_set_enabled', { _enabled: false });
  });

  it('says so when there is no account to switch', async () => {
    rpcResult = { data: null, error: { message: 'app_review_account_missing' } };
    const res = await request(app()).post('/api/admin/mobile-app/app-review/enabled').send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('account_missing');
  });

  it('wants a real boolean', async () => {
    const res = await request(app()).post('/api/admin/mobile-app/app-review/enabled').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
