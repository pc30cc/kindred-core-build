// @vitest-environment node
/**
 * GET /api/platform/public/config is asked for on every page load and costs
 * four database operations to build. server/services/platformPublicConfig.ts
 * keeps the finished response in memory, bounded by a TTL and dropped by every
 * Super Admin write to the settings behind it. These tests count the database
 * operations: what the cache saves, and that it never serves a value a write
 * has replaced, nor anything private.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  ops: 0,
  fail: false,
  gate: null as Promise<void> | null,
  branding: {} as Row,
  localized: [] as Row[],
  settings: {} as Row,
  widget: {} as Row,
}));

vi.mock('../../../server/supabase.js', () => {
  // The row is read when the query runs; the answer may arrive later (gate).
  const result = async (value: () => unknown) => {
    db.ops += 1;
    const fail = db.fail;
    const data = structuredClone(value());
    if (db.gate) await db.gate;
    if (fail) return { data: null, error: { message: 'connection refused' } };
    return { data, error: null };
  };
  const chain = (value: () => unknown) => {
    const b: any = {
      select: () => b, limit: () => b, order: () => b,
      maybeSingle: () => result(value),
      then: (resolve: any, reject: any) => result(value).then(resolve, reject),
    };
    return b;
  };
  return {
    getServiceClient: () => ({
      from: (table: string) => chain(() => ({
        platform_branding: db.branding,
        platform_branding_localized: db.localized,
        platform_settings: db.settings,
      } as Record<string, unknown>)[table]),
      rpc: (fn: string) => result(() => (fn === 'get_widget_platform_settings' ? db.widget : null)),
    }),
  };
});

import {
  CACHE_TTL_MS,
  getPlatformPublicConfig,
  invalidatePlatformPublicConfig,
  __resetPlatformPublicConfigForTests,
} from '../../../server/services/platformPublicConfig';

const CONFIG = {} as any;

beforeEach(() => {
  __resetPlatformPublicConfigForTests();
  db.ops = 0;
  db.fail = false;
  db.gate = null;
  db.branding = { id: 'b1', logo_url: '/logo.svg', primary_color: '#123456', created_by: 'admin-1', internal_note: 'x' };
  db.localized = [{ id: 'l1', locale: 'fa', platform_name: 'وب‌یار', updated_by: 'admin-1' }];
  db.settings = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa' };
  db.widget = {
    realtime_pending_max: 50,
    realtime_reconnect_jitter_pct: 20,
    alert_webhook_url: 'https://hooks.example.test/x',
    alert_webhook_secret: 'not-for-the-public',
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('platform public config cache', () => {
  it('builds the response with four operations, then serves repeats from memory', async () => {
    const first = await getPlatformPublicConfig(CONFIG);
    expect(db.ops).toBe(4);
    for (let i = 0; i < 50; i++) await getPlatformPublicConfig(CONFIG);
    expect(db.ops).toBe(4);
    expect(await getPlatformPublicConfig(CONFIG)).toEqual(first);
  });

  it('a burst on a cold cache shares one database round', async () => {
    const all = await Promise.all(Array.from({ length: 25 }, () => getPlatformPublicConfig(CONFIG)));
    expect(db.ops).toBe(4);
    expect(new Set(all.map((v) => JSON.stringify(v))).size).toBe(1);
  });

  it('holds nothing private: only the whitelisted fields of each source', async () => {
    const v = await getPlatformPublicConfig(CONFIG);
    expect(v).toEqual({
      branding: { logo_url: '/logo.svg', primary_color: '#123456' },
      localized: [{ locale: 'fa', platform_name: 'وب‌یار' }],
      region: { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa' },
      realtime: { realtime_reconnect_jitter_pct: 20, realtime_pending_max: 50 },
    });
    expect(JSON.stringify(v)).not.toContain('not-for-the-public');
    expect(JSON.stringify(v)).not.toContain('admin-1');
  });

  it('a Super Admin write is visible on the very next read', async () => {
    await getPlatformPublicConfig(CONFIG);
    db.branding = { ...db.branding, primary_color: '#abcdef' };
    invalidatePlatformPublicConfig();
    expect((await getPlatformPublicConfig(CONFIG))!.branding).toMatchObject({ primary_color: '#abcdef' });
    expect(db.ops).toBe(8);
  });

  it('a load already running when a write lands is never stored, even when it finishes last', async () => {
    let release!: () => void;
    db.gate = new Promise<void>((r) => { release = r; });
    const stale = getPlatformPublicConfig(CONFIG);           // reads the old colour, answers late…
    db.branding = { ...db.branding, primary_color: '#abcdef' };
    invalidatePlatformPublicConfig();                         // …the write lands meanwhile
    db.gate = null;
    const fresh = await getPlatformPublicConfig(CONFIG);     // a new load, answered first
    expect(fresh!.branding).toMatchObject({ primary_color: '#abcdef' });
    release();
    expect((await stale)!.branding).toMatchObject({ primary_color: '#123456' });
    // the late, stale answer did not overwrite the fresh one
    expect((await getPlatformPublicConfig(CONFIG))!.branding).toMatchObject({ primary_color: '#abcdef' });
    expect(db.ops).toBe(8);
  });

  it('expires after the TTL even with no write, which bounds what another replica can show', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    await getPlatformPublicConfig(CONFIG);
    vi.setSystemTime(new Date(Date.now() + CACHE_TTL_MS - 1));
    await getPlatformPublicConfig(CONFIG);
    expect(db.ops).toBe(4);
    vi.setSystemTime(new Date(Date.now() + 2));
    await getPlatformPublicConfig(CONFIG);
    expect(db.ops).toBe(8);
  });

  it('a failed read is reported and not remembered', async () => {
    db.fail = true;
    expect(await getPlatformPublicConfig(CONFIG)).toBeNull();
    db.fail = false;
    expect(await getPlatformPublicConfig(CONFIG)).not.toBeNull();
    expect(db.ops).toBe(8);
  });
});
