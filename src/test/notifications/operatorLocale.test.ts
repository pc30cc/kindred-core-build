/**
 * The language a server-written text for an operator is in
 * (server/services/operatorLocale.ts): the operator's own choice, else the
 * platform's default when the platform offers it, else its first language,
 * else English. A Persian platform must not mail a Persian operator who never
 * opened the language picker in English.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };
const db: { platform_settings: Row[]; profiles: Row[] } = { platform_settings: [], profiles: [] };
const reads = vi.hoisted(() => ({ profiles: 0, platform: 0, failProfiles: false, failPlatform: false }));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: 'platform_settings' | 'profiles') {
      let ids: string[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        limit: () => builder,
        in(_col: string, values: string[]) {
          ids = values;
          return builder;
        },
        maybeSingle: async () => {
          reads.platform += 1;
          if (reads.failPlatform) return { data: null, error: { message: 'down' } };
          return { data: db.platform_settings[0] ?? null, error: null };
        },
        then(resolve: (value: Result) => unknown) {
          reads.profiles += 1;
          if (table === 'profiles' && reads.failProfiles) return resolve({ data: null, error: { message: 'down' } });
          const rows = db[table].filter((r) => !ids || ids.includes(String(r.id)));
          return resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  }),
}));

const { operatorFallbackLocale, operatorLocales, operatorLocale, operatorLocaleFrom, __resetOperatorLocaleCache } = await import(
  '../../../server/services/operatorLocale.js'
);
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as ServerConfig;

function platform(row: Row) {
  db.platform_settings = [row];
}

beforeEach(() => {
  db.platform_settings = [];
  db.profiles = [];
  reads.profiles = 0;
  reads.platform = 0;
  reads.failProfiles = false;
  reads.failPlatform = false;
  __resetOperatorLocaleCache();
  __resetPlatformRegionCache();
});

describe('operatorFallbackLocale', () => {
  it('is the platform default when the platform offers it', async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'fa', 'tr'], default_locale: 'tr' });
    expect(await operatorFallbackLocale(CONFIG)).toBe('tr');
  });

  it('reads a region-tagged default as its base language', async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'fa'], default_locale: 'fa-IR' });
    expect(await operatorFallbackLocale(CONFIG)).toBe('fa');
  });

  it('is the first allowed locale when the default is not offered', async () => {
    platform({ region_mode: 'iran', active_locales: null, default_locale: 'en' });
    expect(await operatorFallbackLocale(CONFIG)).toBe('fa');
    __resetOperatorLocaleCache();
    __resetPlatformRegionCache();
    platform({ region_mode: 'multi', active_locales: ['tr', 'en'], default_locale: null });
    expect(await operatorFallbackLocale(CONFIG)).toBe('tr');
  });

  it('is English with no settings row (every language allowed, en first)', async () => {
    expect(await operatorFallbackLocale(CONFIG)).toBe('en');
  });

  it('never throws when the read fails', async () => {
    reads.failPlatform = true;
    await expect(operatorFallbackLocale(CONFIG)).resolves.toBe('en');
  });

  it('is cached until reset', async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'fa'], default_locale: 'fa' });
    expect(await operatorFallbackLocale(CONFIG)).toBe('fa');
    const before = reads.platform;
    db.platform_settings[0].default_locale = 'en';
    expect(await operatorFallbackLocale(CONFIG)).toBe('fa');
    expect(reads.platform).toBe(before);
    __resetOperatorLocaleCache();
    expect(await operatorFallbackLocale(CONFIG)).toBe('en');
  });
});

describe('operatorLocales', () => {
  it("uses each operator's own choice, base tag, else the platform's language", async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'fa', 'tr'], default_locale: 'fa' });
    db.profiles = [
      { id: 'u-en', preferred_locale: 'en' },
      { id: 'u-tr', preferred_locale: 'tr-TR' },
      { id: 'u-none', preferred_locale: null },
      { id: 'u-odd', preferred_locale: 'de' },
    ];
    const map = await operatorLocales(CONFIG, ['u-en', 'u-tr', 'u-none', 'u-odd', 'u-missing']);
    expect(Object.fromEntries(map)).toEqual({
      'u-en': 'en',
      'u-tr': 'tr',
      'u-none': 'fa',
      'u-odd': 'fa',
      'u-missing': 'fa',
    });
    expect(reads.profiles).toBe(1);
  });

  it('a null preferred_locale on a Persian platform is Persian, not English', async () => {
    platform({ region_mode: 'iran', active_locales: null, default_locale: null });
    db.profiles = [{ id: 'u1', preferred_locale: null }];
    expect((await operatorLocales(CONFIG, ['u1'])).get('u1')).toBe('fa');
  });

  it('gives everyone the fallback when the profiles read fails', async () => {
    platform({ region_mode: 'turkey', active_locales: null, default_locale: 'tr' });
    reads.failProfiles = true;
    expect(Object.fromEntries(await operatorLocales(CONFIG, ['a', 'b']))).toEqual({ a: 'tr', b: 'tr' });
  });

  it('reads nothing for no ids', async () => {
    expect((await operatorLocales(CONFIG, [])).size).toBe(0);
    expect(reads.profiles).toBe(0);
  });
});

describe('operatorLocale', () => {
  it('caches per user until reset', async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'fa', 'tr'], default_locale: 'en' });
    db.profiles = [{ id: 'u1', preferred_locale: 'fa' }];
    expect(await operatorLocale(CONFIG, 'u1')).toBe('fa');
    db.profiles[0].preferred_locale = 'tr';
    expect(await operatorLocale(CONFIG, 'u1')).toBe('fa');
    expect(reads.profiles).toBe(1);
    __resetOperatorLocaleCache();
    expect(await operatorLocale(CONFIG, 'u1')).toBe('tr');
  });

  it('is the platform language without a user', async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'tr' });
    expect(await operatorLocale(CONFIG, null)).toBe('tr');
    expect(reads.profiles).toBe(0);
  });
});

describe('a language the platform does not offer is not the operator\'s', () => {
  // The dashboard switches such a language to the platform's first one
  // (src/hooks/usePlatformRegion.ts), and every account from before
  // migration 158 still carries 'en': on a Persian-only platform that
  // operator reads Persian everywhere, so the server writes Persian too.
  it("a Persian-only platform: a legacy 'en' profile reads Persian", async () => {
    platform({ region_mode: 'iran', active_locales: null, default_locale: 'fa' });
    db.profiles = [
      { id: 'u-legacy', preferred_locale: 'en' },
      { id: 'u-fa', preferred_locale: 'fa' },
    ];
    expect(Object.fromEntries(await operatorLocales(CONFIG, ['u-legacy', 'u-fa']))).toEqual({ 'u-legacy': 'fa', 'u-fa': 'fa' });
    expect(await operatorLocale(CONFIG, 'u-legacy')).toBe('fa');
  });

  it('a multi-language platform keeps a choice it offers and replaces one it does not', async () => {
    platform({ region_mode: 'multi', active_locales: ['tr', 'fa'], default_locale: 'tr' });
    db.profiles = [
      { id: 'u-en', preferred_locale: 'en' },
      { id: 'u-fa', preferred_locale: 'fa-IR' },
    ];
    expect(Object.fromEntries(await operatorLocales(CONFIG, ['u-en', 'u-fa']))).toEqual({ 'u-en': 'tr', 'u-fa': 'fa' });
  });

  it('operatorLocaleFrom: the same rule for a reader that has the profile already (push, the email dispatcher)', async () => {
    platform({ region_mode: 'iran', active_locales: null, default_locale: null });
    expect(await operatorLocaleFrom(CONFIG, 'en')).toBe('fa');
    expect(await operatorLocaleFrom(CONFIG, null)).toBe('fa');
    expect(await operatorLocaleFrom(CONFIG, 'fa-IR')).toBe('fa');
    __resetOperatorLocaleCache();
    __resetPlatformRegionCache();
    platform({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en' });
    expect(await operatorLocaleFrom(CONFIG, 'tr-TR')).toBe('tr');
    expect(await operatorLocaleFrom(CONFIG, 'fa')).toBe('en');
    expect(await operatorLocaleFrom(CONFIG, 'de')).toBe('en');
  });

  it('a platform whose languages cannot be read keeps the operator\'s choice', async () => {
    reads.failPlatform = true;
    db.profiles = [{ id: 'u-tr', preferred_locale: 'tr' }];
    expect((await operatorLocales(CONFIG, ['u-tr'])).get('u-tr')).toBe('tr');
  });
});
