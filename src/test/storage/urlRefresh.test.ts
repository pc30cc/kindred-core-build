/**
 * Cached public URLs are derived data.
 *
 * A storage key (`workspace/<id>/…`) is identical on every provider; a public
 * URL names one provider's hostname. The columns that cache a URL for
 * rendering — avatars, logos — therefore go stale the moment the primary
 * changes, and the only reason that is recoverable is that the key is stored
 * next to them.
 *
 * What these tests hold in place: the rebuild uses the key (never guesses one
 * from the old URL), it leaves rows that genuinely have no key alone rather
 * than inventing a link into our storage for them, and re-running it is a
 * no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

/** Tiny in-memory stand-in for the tables the refresh walks. */
const tables: Record<string, Row[]> = {};
const runtimeConfig = new Map<string, unknown>();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let wantedKey: string | null = null;
      // PostgREST builders are thenable: awaiting one runs the query. The
      // refresh awaits `.limit()`, while provider resolution ends in
      // `.single()` / `.maybeSingle()`, so the stand-in supports both.
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => {
          if (column === 'key') wantedKey = String(value);
          return builder;
        },
        single: async () => builder.maybeSingle(),
        maybeSingle: async () => {
          if (table === 'app_runtime_config') {
            return {
              data: wantedKey && runtimeConfig.has(wantedKey)
                ? { key: wantedKey, value: runtimeConfig.get(wantedKey) }
                : null,
              error: null,
            };
          }
          // provider_configs: no workspace override in these tests
          return { data: null, error: null };
        },
        update: (patch: Row) => ({
          eq: async (column: string, value: unknown) => {
            for (const row of tables[table] ?? []) {
              if (row[column] === value) Object.assign(row, patch);
            }
            return { error: null };
          },
        }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          resolve({ data: tables[table] ?? [], error: null }),
      };
      return builder;
    },
  }),
}));

const { refreshStoredFileUrls, storedUrlSourceNames } =
  await import('../../../server/services/storage/urlRefresh.js');

const serverConfig = {} as Parameters<typeof refreshStoredFileUrls>[0];
const WS = '11111111-1111-1111-1111-111111111111';
const KEY = `workspace/${WS}/avatars/telegram/abc.jpg`;

function seedProvider(cdn: string) {
  runtimeConfig.set('default_storage_provider', {
    provider_name: 'bunny_storage',
    config: { username: 'webyar', hostname: 'storage.bunnycdn.com', cdn_url: cdn },
  });
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  runtimeConfig.clear();
  // Every source is walked on each run; seed them empty by default.
  for (const table of ['contacts', 'workspace_branding', 'call_center_settings', 'ai_agent_settings', 'profiles']) {
    tables[table] = [];
  }
});

describe('refreshStoredFileUrls', () => {
  it('covers every column that caches a URL', () => {
    expect(storedUrlSourceNames()).toEqual([
      'contact_avatar', 'workspace_branding', 'call_center_avatar', 'ai_agent_logo', 'account_avatar',
    ]);
  });

  it('rewrites a URL that still points at the previous provider', async () => {
    seedProvider('https://cdn.new-host.example');
    tables.contacts = [{
      id: 'c1', workspace_id: WS,
      avatar_url: `https://cdn.old-host.example/${KEY}`,
      avatar_storage_key: KEY,
    }];

    const report = await refreshStoredFileUrls(serverConfig);

    expect(tables.contacts[0].avatar_url).toBe(`https://cdn.new-host.example/${KEY}`);
    const contacts = report.sources.find((s) => s.name === 'contact_avatar')!;
    expect(contacts.updated).toBe(1);
    expect(contacts.failed).toBe(0);
    expect(report.totalUpdated).toBe(1);
  });

  it('never touches a row that has no key — that link is not ours to rewrite', async () => {
    seedProvider('https://cdn.new-host.example');
    const external = 'https://t.me/i/userpic/320/someone.jpg';
    tables.contacts = [{ id: 'c1', workspace_id: WS, avatar_url: external, avatar_storage_key: null }];

    const report = await refreshStoredFileUrls(serverConfig);

    expect(tables.contacts[0].avatar_url).toBe(external);
    const contacts = report.sources.find((s) => s.name === 'contact_avatar')!;
    expect(contacts.skippedNoKey).toBe(1);
    expect(contacts.updated).toBe(0);
  });

  it('is a no-op when the cached URL already matches the live provider', async () => {
    seedProvider('https://cdn.new-host.example');
    tables.contacts = [{
      id: 'c1', workspace_id: WS,
      avatar_url: `https://cdn.new-host.example/${KEY}`,
      avatar_storage_key: KEY,
    }];

    const first = await refreshStoredFileUrls(serverConfig);
    const second = await refreshStoredFileUrls(serverConfig);

    expect(first.sources.find((s) => s.name === 'contact_avatar')!.unchanged).toBe(1);
    expect(second.totalUpdated).toBe(0);
  });

  it('reads the key out of metadata for the AI agent logo', async () => {
    seedProvider('https://cdn.new-host.example');
    const logoKey = `workspace/${WS}/ai-agent/logo.png`;
    tables.ai_agent_settings = [{
      workspace_id: WS,
      agent_logo_url: `https://cdn.old-host.example/${logoKey}`,
      metadata: { ai_avatar_storage_key: logoKey },
    }];

    await refreshStoredFileUrls(serverConfig);

    expect(tables.ai_agent_settings[0].agent_logo_url).toBe(`https://cdn.new-host.example/${logoKey}`);
  });

  it('reports incomplete when a source filled the batch, so the caller runs it again', async () => {
    seedProvider('https://cdn.new-host.example');
    tables.contacts = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`, workspace_id: WS,
      avatar_url: `https://cdn.old-host.example/${KEY}`,
      avatar_storage_key: KEY,
    }));

    const report = await refreshStoredFileUrls(serverConfig, { limit: 3 });

    expect(report.complete).toBe(false);
    expect(report.sources.find((s) => s.name === 'contact_avatar')!.complete).toBe(false);
  });

  it('counts a row as failed rather than blanking it when no provider resolves', async () => {
    // No default_storage_provider at all.
    tables.profiles = [{ id: 'u1', avatar_url: 'https://cdn.old-host.example/users/u1/a.jpg', avatar_storage_key: 'users/u1/a.jpg' }];

    const report = await refreshStoredFileUrls(serverConfig);

    const account = report.sources.find((s) => s.name === 'account_avatar')!;
    expect(account.updated + account.failed).toBeGreaterThan(0);
    expect(tables.profiles[0].avatar_url).toBeTruthy();
  });
});
