/**
 * getPlatformEdition (server/services/platformRegion.ts): one cached
 * platform_settings read shared with the locale clamp; a failed read keeps the
 * last known edition; with none, money paths get a 503 instead of a guess; a
 * Super Admin save invalidates the cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  row: { region_mode: 'iran', active_locales: ['fa'] } as Record<string, unknown> | null,
  error: null as { message: string } | null,
  throws: false,
  reads: 0,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'platform_settings') throw new Error(`unexpected table ${table}`);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.limit = () => b;
      b.maybeSingle = async () => {
        db.reads += 1;
        if (db.throws) throw new Error('network down');
        return { data: db.error ? null : db.row, error: db.error };
      };
      return b;
    },
  }),
}));

const region = await import('../../../server/services/platformRegion.js');
const cfg = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' } as never;

beforeEach(() => {
  region.__resetPlatformRegionCache();
  db.row = { region_mode: 'iran', active_locales: ['fa'] };
  db.error = null;
  db.throws = false;
  db.reads = 0;
  vi.useRealTimers();
});
afterEach(() => vi.useRealTimers());

describe('getPlatformEdition', () => {
  it('is iran for region_mode iran and international otherwise (no row = column default multi)', async () => {
    expect(await region.getPlatformEdition(cfg)).toBe('iran');
    for (const mode of ['multi', 'global', 'turkey']) {
      region.__resetPlatformRegionCache();
      db.row = { region_mode: mode };
      expect(await region.getPlatformEdition(cfg)).toBe('international');
    }
    region.__resetPlatformRegionCache();
    db.row = null;
    expect(await region.getPlatformEdition(cfg)).toBe('international');
  });

  it('shares one cached read with the locale clamp (the Iranian locales are unchanged)', async () => {
    expect(await region.getPlatformAllowedLocales(cfg)).toEqual(['fa']);
    expect(await region.getPlatformEdition(cfg)).toBe('iran');
    expect(await region.clampLocaleToPlatformRegion(cfg, 'en')).toBe('fa');
    expect(db.reads).toBe(1);
  });

  it('keeps the last known edition when a later read fails', async () => {
    vi.useFakeTimers({ now: Date.now() });
    expect(await region.getPlatformEdition(cfg)).toBe('iran');
    vi.advanceTimersByTime(61_000);
    db.throws = true;
    expect(await region.getPlatformEdition(cfg)).toBe('iran');
    db.throws = false;
    db.error = { message: 'permission denied' };
    vi.advanceTimersByTime(6_000);
    expect(await region.getPlatformEdition(cfg)).toBe('iran');
    // The locale clamp keeps its historic failure answer: every language.
    expect(await region.getPlatformAllowedLocales(cfg)).toEqual(['en', 'fa', 'tr']);
  });

  it('refuses (503) rather than guess when no read ever succeeded', async () => {
    db.error = { message: 'down' };
    await expect(region.getPlatformEdition(cfg)).rejects.toBeInstanceOf(region.EditionUnavailableError);
    await expect(region.getPlatformEdition(cfg)).rejects.toMatchObject({ status: 503, code: 'EDITION_UNAVAILABLE' });
    expect(await region.getPlatformEditionOrNull(cfg)).toBeNull();
  });

  it('sees a Super Admin change as soon as the cache is invalidated', async () => {
    expect(await region.getPlatformEdition(cfg)).toBe('iran');
    db.row = { region_mode: 'multi' };
    expect(await region.getPlatformEdition(cfg)).toBe('iran'); // cached
    region.invalidatePlatformRegionCache();
    expect(await region.getPlatformEdition(cfg)).toBe('international');
  });

  it('is invalidated by PUT /platform-settings', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('server/routes/adminManagement.ts', 'utf8');
    const put = src.slice(src.indexOf("adminManagementRouter.put('/platform-settings'"));
    expect(put.slice(0, put.indexOf('\n});'))).toContain('invalidatePlatformRegionCache();');
  });
});
