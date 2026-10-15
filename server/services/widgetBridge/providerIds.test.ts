// @vitest-environment node
/**
 * The widget bridge's provider ids at the API boundary (providerIds.ts):
 * requests may carry the API's `platform` or the stored legacy id; both are
 * stored as the legacy id (no data migration), and every response says
 * `platform`, so no client ever needs the old string.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeProviders } from '../../../shared/widgetBridge.js';
import { IRAN_BRAND_PATTERNS } from '../../../scripts/build/brandAudit.mjs';
import {
  LEGACY_PLATFORM_PROVIDER,
  apiBridgeContact,
  apiBridgeSettings,
  apiBridgeSiteLists,
  storedBridgeProviders,
  toApiProvider,
  toStoredProvider,
} from './providerIds.js';
import { bridgeBatchSchema, bridgeContactSchema, bridgeSettingsSchema } from './validation.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const pool = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../lib/workspaceAuth.js', () => ({ requirePlatformAdmin: vi.fn(async () => 'owner-1') }));
vi.mock('../../db/index.js', () => ({ directPool: () => ({ query: vi.fn(async () => ({ rows: [{ id: WORKSPACE }] })) }) }));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  bridgeConfig: () => ({ appId: 'app' }),
  bridgePool: () => pool,
}));
vi.mock('../../../shared/net/hostGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/net/hostGuard.js')>()),
  checkOutboundUrl: vi.fn(async () => ({ ok: true })),
}));

const { adminWidgetBridgeRouter } = await import('../../routes/adminWidgetBridge.js');
const app = express().use(express.json()).use('/bridge', adminWidgetBridgeRouter);
const api = (path: string) => `/bridge${path}?workspaceId=${WORKSPACE}`;
const identity = { name: 'Name', email: '', phone: '' };
const brandFree = (body: unknown) => !IRAN_BRAND_PATTERNS.some((re: RegExp) => re.test(JSON.stringify(body)));

describe('provider id mapping', () => {
  it('maps the API id to the stored one and back; other ids pass through', () => {
    expect(toStoredProvider('platform')).toBe(LEGACY_PLATFORM_PROVIDER);
    expect(toStoredProvider(LEGACY_PLATFORM_PROVIDER)).toBe(LEGACY_PLATFORM_PROVIDER);
    expect(toApiProvider(LEGACY_PLATFORM_PROVIDER)).toBe('platform');
    for (const id of ['auto', 'crisp', 'raychat', 'goftino', 'custom']) {
      expect(toStoredProvider(id)).toBe(id);
      expect(toApiProvider(id)).toBe(id);
    }
    expect(storedBridgeProviders.map(id => toApiProvider(id))).toEqual([...bridgeProviders]);
  });

  it('the browser-facing ids never carry the brand', () => {
    expect(brandFree(bridgeProviders)).toBe(true);
    expect(brandFree(apiBridgeSettings({ allowedProviders: [...storedBridgeProviders] }))).toBe(true);
    expect(apiBridgeContact({ id: 'c', provider: LEGACY_PLATFORM_PROVIDER })).toEqual({ id: 'c', provider: 'platform' });
    expect(apiBridgeSiteLists({ [LEGACY_PLATFORM_PROVIDER]: { urls: [], includeShared: false }, shared: { urls: ['https://a.example/'], includeShared: false } }))
      .toEqual({ platform: { urls: [], includeShared: false }, shared: { urls: ['https://a.example/'], includeShared: false } });
  });

  it('request schemas accept the old and the new id and parse to the stored one', () => {
    for (const provider of ['platform', LEGACY_PLATFORM_PROVIDER]) {
      expect(bridgeContactSchema.parse({ url: 'https://example.com', provider }).provider).toBe(LEGACY_PLATFORM_PROVIDER);
      expect(bridgeBatchSchema.parse({ clientBatchId: WORKSPACE, body: 'hi', urls: ['https://example.com'], provider }).provider)
        .toBe(LEGACY_PLATFORM_PROVIDER);
    }
    expect(bridgeContactSchema.parse({ url: 'https://example.com' }).provider).toBe('auto');
    expect(bridgeSettingsSchema.parse({ enabled: true, identity, allowedProviders: ['platform', LEGACY_PLATFORM_PROVIDER, 'crisp'] }).allowedProviders)
      .toEqual([LEGACY_PLATFORM_PROVIDER, 'crisp']);
    expect(bridgeSettingsSchema.parse({ enabled: true, identity }).allowedProviders).toEqual([...storedBridgeProviders]);
    expect(bridgeContactSchema.safeParse({ url: 'https://example.com', provider: 'unknown' }).success).toBe(false);
  });
});

describe('admin widget bridge routes', () => {
  beforeEach(() => pool.query.mockReset());

  it('GET /settings returns the neutral id, also for the default', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const fresh = await request(app).get(api('/settings')).expect(200);
    expect(fresh.body.settings.allowedProviders).toEqual([...bridgeProviders]);
    pool.query.mockResolvedValueOnce({ rows: [{ enabled: true, identity, allowedProviders: [LEGACY_PLATFORM_PROVIDER, 'goftino'], roundSize: 1, intervalSeconds: 30 }] });
    const stored = await request(app).get(api('/settings')).expect(200);
    expect(stored.body.settings.allowedProviders).toEqual(['platform', 'goftino']);
    expect(brandFree(stored.body)).toBe(true);
  });

  it.each(['platform', LEGACY_PLATFORM_PROVIDER])('PUT /settings with %s stores the legacy id and answers with the neutral one', async (id) => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).put(api('/settings')).send({ enabled: true, identity, allowedProviders: [id, 'crisp'] }).expect(200);
    expect(JSON.parse(pool.query.mock.calls[0][1][5])).toEqual([LEGACY_PLATFORM_PROVIDER, 'crisp']);
    expect(res.body.settings.allowedProviders).toEqual(['platform', 'crisp']);
  });

  it.each(['platform', LEGACY_PLATFORM_PROVIDER])('POST /contacts with %s stores the legacy id and answers with the neutral one', async (id) => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'c1', url: 'https://example.com/', provider: LEGACY_PLATFORM_PROVIDER }] });
    const res = await request(app).post(api('/contacts')).send({ url: 'https://example.com', provider: id }).expect(201);
    expect(pool.query.mock.calls[0][1][5]).toBe(LEGACY_PLATFORM_PROVIDER);
    expect(res.body.contact.provider).toBe('platform');
  });

  it('GET /contacts maps every stored provider', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1', provider: LEGACY_PLATFORM_PROVIDER }, { id: 'c2', provider: 'crisp' }] });
    const res = await request(app).get(api('/contacts')).expect(200);
    expect(res.body.contacts.map((c: { provider: string }) => c.provider)).toEqual(['platform', 'crisp']);
  });

  it('site lists: stored under the legacy key, read back under the neutral one', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ app_id: 'app' }] });
    await request(app).put(api('/site-lists/platform')).send({ urls: ['example.com'] }).expect(200);
    expect(pool.query.mock.calls[0][1][3]).toBe(LEGACY_PLATFORM_PROVIDER);
    pool.query.mockResolvedValueOnce({ rows: [{ app_id: 'app' }] });
    await request(app).put(api(`/site-lists/${LEGACY_PLATFORM_PROVIDER}`)).send({ urls: [] }).expect(200);
    expect(pool.query.mock.calls[1][1][3]).toBe(LEGACY_PLATFORM_PROVIDER);
    pool.query.mockResolvedValueOnce({ rows: [{ site_lists: { [LEGACY_PLATFORM_PROVIDER]: { urls: ['https://example.com/'], includeShared: false } } }] });
    const res = await request(app).get(api('/site-lists')).expect(200);
    expect(res.body.lists).toEqual({ platform: { urls: ['https://example.com/'], includeShared: false } });
  });

  it('a batch for the platform widget stores the legacy id, with the same idempotency hash either way', async () => {
    const hashes: string[] = [];
    for (const provider of ['platform', LEGACY_PLATFORM_PROVIDER]) {
      pool.query.mockReset();
      pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: WORKSPACE }] });
      await request(app).post(api('/batches')).send({ clientBatchId: WORKSPACE, body: 'hi', urls: ['https://example.com'], provider }).expect(202);
      const insert = pool.query.mock.calls[1][1];
      expect(insert[insert.length - 1]).toBe(LEGACY_PLATFORM_PROVIDER);
      hashes.push(insert[6]);
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});
