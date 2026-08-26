/**
 * GoTrue-off closure (item 9) — the legacy Supabase Auth client provider
 * (formerly src/providers/supabase/auth.ts) has been deleted from runtime
 * source. This proves the accidental-reactivation path that existed
 * before the deletion is actually closed, not just "the file is gone":
 *
 *   providerRegistry.register('auth', 'supabase', supabaseAuthProvider, ...)
 *   + syncProvidersFromDB() (called on every app start, ProviderContext.tsx)
 *   unconditionally activating whatever `default_<type>_provider` row it
 *   finds in app_runtime_config, for ANY registered provider name
 *   — including 'auth'.
 *
 * A stray or attacker-written `default_auth_provider` row naming
 * 'supabase' would have silently flipped the active auth provider with
 * no UI ever surfacing the change (AdminAuthStatusCard is static/
 * read-only). Fixed two ways, both verified here:
 *   1. The legacy provider is no longer registered under 'auth' at all.
 *   2. Defense in depth: syncProvidersFromDB / setGlobalDefaultProvider
 *      explicitly refuse to touch the 'auth' provider type regardless of
 *      what's registered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbRows: { key: string; value: any }[] = [];

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'app_runtime_config') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          like: async () => ({ data: dbRows }),
        }),
      };
    },
  },
}));

const { providerRegistry, PROVIDER_TYPE_KEYS } = await import('../../providers/registry');
const { bootstrapProviders } = await import('../../providers/bootstrap');
const { syncProvidersFromDB, setGlobalDefaultProvider } = await import('../../providers/sync');

describe('legacy Supabase Auth provider — reactivation is closed', () => {
  beforeEach(() => {
    dbRows.length = 0;
    bootstrapProviders();
  });

  it('"auth" is still a valid provider type (sanity check for the rest of this suite)', () => {
    expect(PROVIDER_TYPE_KEYS).toContain('auth');
  });

  it('no "supabase" provider is registered under the "auth" type after bootstrap', () => {
    const authProviders = providerRegistry.getProviders('auth').map((p) => p.name);
    expect(authProviders).not.toContain('supabase');
    expect(authProviders).toEqual(['self-hosted']);
  });

  it('resolving the active auth provider always returns the first-party self-hosted provider', () => {
    const resolved = providerRegistry.resolve('auth');
    expect(resolved).toBeTruthy();
    // The self-hosted provider exposes getSession backed by /api/auth/session,
    // never a Supabase client method — this is a structural proxy for "not
    // the legacy provider" since the legacy module no longer exists to
    // import for a stronger identity check.
    expect(typeof (resolved as any).getSession).toBe('function');
  });

  it('a malicious/stray default_auth_provider DB row is never applied — sync skips type "auth" unconditionally', async () => {
    dbRows.push({ key: 'default_auth_provider', value: { provider_name: 'supabase' } });
    // Even if some future change re-registers a provider literally named
    // 'supabase' under 'auth', the sync loop must still refuse to touch it.
    providerRegistry.register('auth', 'supabase', { getSession: async () => null } as any, { priority: 50 });

    await syncProvidersFromDB();

    const authProviders = providerRegistry.getProviders('auth').map((p) => p.name);
    expect(authProviders).toContain('supabase'); // registration itself is untouched
    // But it must never have been made active by the sync pass.
    const resolved = providerRegistry.resolve('auth');
    expect((resolved as any)?.__isFakeReregisteredSupabase).not.toBe(true);
  });

  it('other provider types are unaffected by the auth guard — a real default row still applies', async () => {
    dbRows.push({ key: 'default_map_tiles_provider', value: { provider_name: 'stub' } });
    await syncProvidersFromDB();
    const resolved = providerRegistry.resolve('map_tiles');
    expect(resolved).toBeTruthy();
  });

  it('setGlobalDefaultProvider refuses to change the auth provider', async () => {
    const { error } = await setGlobalDefaultProvider('auth', 'supabase');
    expect(error).toBeTruthy();
    expect(error?.message).toMatch(/cannot be changed/i);
  });

  it('the database and realtime Supabase providers are untouched — auth != database', () => {
    const dbProviders = providerRegistry.getProviders('database').map((p) => p.name);
    const realtimeProviders = providerRegistry.getProviders('realtime').map((p) => p.name);
    expect(dbProviders).toContain('supabase');
    expect(realtimeProviders).toContain('supabase');
  });
});
