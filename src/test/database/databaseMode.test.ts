// @vitest-environment node
/**
 * DATABASE_MODE decides once, from the environment, whether this process may
 * use any Supabase service. postgres-only — the default whenever DATABASE_URL
 * is set — must ignore leftover SUPABASE_* variables entirely: no services
 * client, no Supabase Realtime, no signing-secret fallback to the old
 * service-role key, and nothing of Supabase's in the server config.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { databaseMode, ignoredSupabaseVars } from '../../../server/db/mode';
import { closeDataLayer, dataDriver, supabaseServicesClient, workerDatabaseConfig, DIRECT_DATABASE_BASE_URL } from '../../../server/db/index';
import { platformSigningSecret } from '../../../server/lib/platformSecret';

const URL = 'postgresql://app:pw@db.internal:5432/webyar';
const LEGACY = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-value',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value-at-least-32-chars',
};
const SECRET = 'p'.repeat(40);

afterEach(async () => {
  await closeDataLayer();
});

describe('databaseMode', () => {
  it('defaults to postgres-only when DATABASE_URL is set, and to supabase-rest when it is not', () => {
    expect(databaseMode({ DATABASE_URL: URL })).toBe('postgres-only');
    expect(databaseMode({ DATABASE_URL: URL, ...LEGACY })).toBe('postgres-only');
    expect(databaseMode({ ...LEGACY })).toBe('supabase-rest');
    expect(databaseMode({})).toBe('supabase-rest');
  });

  it('accepts the three modes explicitly and refuses anything else', () => {
    expect(databaseMode({ DATABASE_MODE: 'postgres-only', DATABASE_URL: URL })).toBe('postgres-only');
    expect(databaseMode({ DATABASE_MODE: 'postgres+supabase-services', DATABASE_URL: URL, ...LEGACY })).toBe('postgres+supabase-services');
    expect(databaseMode({ DATABASE_MODE: 'supabase-rest', ...LEGACY })).toBe('supabase-rest');
    expect(() => databaseMode({ DATABASE_MODE: 'postgres', DATABASE_URL: URL })).toThrow(/DATABASE_MODE must be one of/);
  });

  it('refuses contradictions instead of guessing — there is no fallback between modes', () => {
    expect(() => databaseMode({ DATABASE_MODE: 'postgres-only' })).toThrow(/requires DATABASE_URL/);
    expect(() => databaseMode({ DATABASE_MODE: 'postgres-only', ...LEGACY })).toThrow(/requires DATABASE_URL/);
    expect(() => databaseMode({ DATABASE_MODE: 'supabase-rest', DATABASE_URL: URL, ...LEGACY })).toThrow(/does not use DATABASE_URL/);
    expect(() => databaseMode({ DATABASE_MODE: 'postgres+supabase-services', DATABASE_URL: URL })).toThrow(/requires SUPABASE_URL/);
  });

  it('reports the legacy variables postgres-only ignores', () => {
    expect(ignoredSupabaseVars({ DATABASE_URL: URL, ...LEGACY })).toEqual(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
    expect(ignoredSupabaseVars({ DATABASE_URL: URL })).toEqual([]);
    expect(ignoredSupabaseVars({ DATABASE_MODE: 'postgres+supabase-services', DATABASE_URL: URL, ...LEGACY })).toEqual([]);
  });

  it('maps every postgres mode to the direct driver', () => {
    expect(dataDriver({ DATABASE_URL: URL })).toBe('postgres');
    expect(dataDriver({ DATABASE_MODE: 'postgres+supabase-services', DATABASE_URL: URL, ...LEGACY })).toBe('postgres');
    expect(dataDriver({ ...LEGACY })).toBe('supabase-rest');
  });
});

describe('postgres-only uses nothing of Supabase', () => {
  it('has no Supabase services client even with every legacy variable set', () => {
    expect(supabaseServicesClient({ DATABASE_URL: URL, ...LEGACY })).toBeNull();
  });

  it('has one in the explicit extras mode, and in the legacy driver', () => {
    expect(supabaseServicesClient({ DATABASE_MODE: 'postgres+supabase-services', DATABASE_URL: URL, ...LEGACY })).not.toBeNull();
    expect(supabaseServicesClient({ ...LEGACY })).not.toBeNull();
  });

  it('never takes the signing root from the old service-role key', () => {
    expect(platformSigningSecret({ DATABASE_URL: URL, ...LEGACY })).toBe('');
    expect(platformSigningSecret({ DATABASE_URL: URL, ...LEGACY, PLATFORM_SIGNING_SECRET: SECRET })).toBe(SECRET);
    // An install still on the legacy driver keeps the old root until it moves.
    expect(platformSigningSecret({ ...LEGACY })).toBe(LEGACY.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('hands workers no Supabase URL or key', () => {
    const cfg = workerDatabaseConfig('[test]', { DATABASE_URL: URL, ...LEGACY, PLATFORM_SIGNING_SECRET: SECRET });
    expect(cfg.supabaseUrl).toBe(DIRECT_DATABASE_BASE_URL);
    expect(cfg.supabaseServiceRoleKey).toBe(SECRET);
    expect(cfg.signingSecret).toBe(SECRET);
  });
});
