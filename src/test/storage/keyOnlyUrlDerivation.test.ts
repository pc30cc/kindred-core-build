/**
 * KEY-ONLY PERSISTENCE — the database records a storage key and nothing else,
 * and every public link is derived from it at read time.
 *
 * The property these tests exist to pin down is the one the whole design is
 * for: PROMOTING A NEW PRIMARY MUST REWRITE ZERO ROWS. The first read after a
 * promotion already produces the new vendor's URLs, and not a single UPDATE
 * touched a table that holds an avatar or a logo.
 *
 * The rest guard the things that make that safe:
 *   - derivation is scoped by ownership (a key naming another tenant yields
 *     no link at all, never a working cross-tenant one);
 *   - derivation is PURE — no provider HTTP, no usage/quota writes, no
 *     per-row logging — because it runs on every page load;
 *   - provider resolution is memoized, so a page of rows costs ONE lookup;
 *   - a vendor that cannot express a public URL is kept out of the primary
 *     slot entirely, including via `force`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── One fake DB shared by the modules under test ──────────────────

const runtimeConfig = new Map<string, unknown>();
/** Every select issued, so "one provider resolution per request" is provable. */
const selects: string[] = [];
/** Every write issued, so "a promotion rewrites nothing" is provable. */
const writes: Array<{ table: string; op: 'update' | 'insert' | 'upsert' | 'delete' }> = [];

function reset() {
  runtimeConfig.clear();
  selects.length = 0;
  writes.length = 0;
}

/** The fluent PostgREST surface these modules touch. */
type FakeBuilder = {
  select: () => FakeBuilder;
  eq: (col: string, value: string) => FakeBuilder;
  order: () => FakeBuilder;
  limit: () => FakeBuilder;
  is: () => FakeBuilder;
  not: () => FakeBuilder;
  in: () => FakeBuilder;
  single: () => Promise<{ data: unknown; error: unknown }>;
  insert: () => Promise<{ data: unknown; error: unknown }>;
  upsert: () => Promise<{ data: unknown; error: unknown }>;
  update: () => FakeBuilder;
  delete: () => FakeBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (onOk: (v: unknown) => unknown) => Promise<unknown>;
};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let wantedKey: string | null = null;
      const builder: FakeBuilder = {
        select: () => { selects.push(table); return builder; },
        eq: (col: string, value: string) => { if (col === 'key') wantedKey = value; return builder; },
        order: () => builder,
        limit: () => builder,
        is: () => builder,
        not: () => builder,
        in: () => builder,
        single: async () => builder.maybeSingle(),
        insert: async () => { writes.push({ table, op: 'insert' }); return { data: null, error: null }; },
        upsert: async () => { writes.push({ table, op: 'upsert' }); return { data: null, error: null }; },
        update: () => { writes.push({ table, op: 'update' }); return builder; },
        delete: () => { writes.push({ table, op: 'delete' }); return builder; },
        maybeSingle: async () => {
          if (table !== 'app_runtime_config') return { data: null, error: null };
          return {
            data: wantedKey && runtimeConfig.has(wantedKey)
              ? { key: wantedKey, value: runtimeConfig.get(wantedKey) }
              : null,
            error: null,
          };
        },
        then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onOk),
      };
      return builder;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'set_storage_provider_pool') return { data: { ok: true }, error: null };
      const current = (runtimeConfig.get('storage_provider_pool') as Record<string, unknown>) ?? null;
      const revision = typeof current?.revision === 'number' ? current.revision as number : 0;
      runtimeConfig.set('storage_provider_pool', { ...(args._pool as object), revision: revision + 1 });
      if (args._default == null) runtimeConfig.delete('default_storage_provider');
      else runtimeConfig.set('default_storage_provider', args._default);
      return { data: { ok: true, revision: revision + 1 }, error: null };
    },
  }),
}));

const {
  createStorageUrlResolver,
  describeUrlCapability,
  keyBelongsToWorkspace,
  keyBelongsToUser,
  hydrateUserAvatars,
  hydrateContactAvatars,
} = await import('../../../server/services/storage/urlResolver.js');
const { storageConfigFromRecord } = await import('../../../server/services/storage/index.js');
const { adminStorageProvidersRouter, __resetStorageAdminRateLimit } =
  await import('../../../server/routes/adminStorageProviders.js');

const serverConfig = {} as never;

// Two vendors with obviously different hostnames, so a URL names its vendor.
const LOCAL_PUBLIC = 'https://files.old-vendor.test';
const S3_CDN = 'https://cdn.new-vendor.test';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const OTHER_WS = '11111111-2222-3333-4444-555555555555';
const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_USER = '99999999-8888-7777-6666-555555555555';

let localDir: string;

function seedPool(primary: 'local' | 's3') {
  const local = { local_path: localDir, public_url: LOCAL_PUBLIC };
  const s3 = { bucket: 'mirror', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk', cdn_url: S3_CDN };
  runtimeConfig.set('storage_provider_pool', {
    primary,
    replication: { enabled: true, mirrorDeletes: false },
    providers: {
      local: { enabled: true, config: local },
      s3: { enabled: true, config: s3 },
    },
    revision: 1,
  });
  runtimeConfig.set('default_storage_provider', {
    provider_name: primary,
    config: primary === 'local' ? local : s3,
  });
}

beforeEach(() => {
  reset();
  __resetStorageAdminRateLimit();
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyonly-'));
  seedPool('local');
});

afterEach(() => {
  fs.rmSync(localDir, { recursive: true, force: true });
});

// ── Ownership ────────────────────────────────────────────────────

describe('ownership is checked before a URL is built', () => {
  it('derives a link for a key the workspace actually owns', async () => {
    const url = await createStorageUrlResolver(serverConfig)
      .workspace(WS, `workspace/${WS}/avatars/telegram/abc.jpg`);
    expect(url).toBe(`${LOCAL_PUBLIC}/workspace/${WS}/avatars/telegram/abc.jpg`);
  });

  it('returns null — not another tenant\'s link — for a key of a different workspace', async () => {
    const url = await createStorageUrlResolver(serverConfig)
      .workspace(WS, `workspace/${OTHER_WS}/avatars/telegram/abc.jpg`);
    expect(url).toBeNull();
  });

  it('refuses a user key that names a different user', async () => {
    const resolver = createStorageUrlResolver(serverConfig);
    expect(await resolver.user(USER, `users/${USER}/avatar/a.png`))
      .toBe(`${LOCAL_PUBLIC}/users/${USER}/avatar/a.png`);
    expect(await resolver.user(USER, `users/${OTHER_USER}/avatar/a.png`)).toBeNull();
  });

  it('refuses a workspace key handed to the user namespace, and vice versa', async () => {
    const resolver = createStorageUrlResolver(serverConfig);
    expect(await resolver.user(USER, `workspace/${WS}/branding/x.png`)).toBeNull();
    expect(await resolver.workspace(WS, `users/${USER}/avatar/a.png`)).toBeNull();
    expect(await resolver.platform(`workspace/${WS}/branding/x.png`)).toBeNull();
  });

  it('accepts the two legacy key shapes only for their own owner', () => {
    expect(keyBelongsToUser(USER, `avatars/${USER}/a.png`)).toBe(true);
    expect(keyBelongsToUser(USER, `avatars/${OTHER_USER}/a.png`)).toBe(false);
    expect(keyBelongsToWorkspace(WS, `branding/${WS}/icon.png`)).toBe(true);
    expect(keyBelongsToWorkspace(WS, `branding/${OTHER_WS}/icon.png`)).toBe(false);
  });

  it('never derives a link from an empty or absent key', async () => {
    const resolver = createStorageUrlResolver(serverConfig);
    expect(await resolver.workspace(WS, null)).toBeNull();
    expect(await resolver.workspace(WS, '')).toBeNull();
    expect(await resolver.user(null, `users/${USER}/avatar/a.png`)).toBeNull();
  });
});

// ── Purity and cost ──────────────────────────────────────────────

describe('derivation is pure and costs one provider resolution', () => {
  it('resolves the provider once for a whole page of rows', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      avatar_storage_key: `workspace/${WS}/avatars/telegram/${i}.jpg`,
    }));
    const resolver = createStorageUrlResolver(serverConfig);
    const urls = await Promise.all(rows.map((r) => resolver.workspace(WS, r.avatar_storage_key)));

    expect(urls.every((u) => u?.startsWith(LOCAL_PUBLIC))).toBe(true);
    // resolveStorageConfig reads provider_configs then app_runtime_config.
    expect(selects.filter((t) => t === 'provider_configs')).toHaveLength(1);
    expect(selects.filter((t) => t === 'app_runtime_config')).toHaveLength(1);
  });

  it('resolves one provider per workspace, not per row, across several workspaces', async () => {
    const resolver = createStorageUrlResolver(serverConfig);
    for (let i = 0; i < 10; i++) {
      await resolver.workspace(WS, `workspace/${WS}/a/${i}.jpg`);
      await resolver.workspace(OTHER_WS, `workspace/${OTHER_WS}/a/${i}.jpg`);
    }
    expect(selects.filter((t) => t === 'provider_configs')).toHaveLength(2);
  });

  it('issues no provider HTTP and writes no usage/quota/replication row', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('URL derivation must never talk to the provider');
    }) as typeof globalThis.fetch;
    try {
      const resolver = createStorageUrlResolver(serverConfig);
      await resolver.workspace(WS, `workspace/${WS}/avatars/telegram/a.jpg`);
      await resolver.user(USER, `users/${USER}/avatar/a.png`);
      await resolver.platform('platform/call-center/ringback/music.mp3');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(writes).toEqual([]);
  });

  it('hydrates a batch of profile rows and drops the key before it can reach a client', async () => {
    const rows: Array<{ id: string; avatar_storage_key: string | null; avatar_url?: string | null }> = [
      { id: USER, avatar_storage_key: `users/${USER}/avatar/a.png` },
      { id: OTHER_USER, avatar_storage_key: null },
    ];
    await hydrateUserAvatars(serverConfig, rows);

    expect(rows[0].avatar_url).toBe(`${LOCAL_PUBLIC}/users/${USER}/avatar/a.png`);
    expect(rows[1].avatar_url).toBeNull();
    expect(rows.every((r) => !('avatar_storage_key' in r))).toBe(true);
  });

  it('keeps an externally supplied contact avatar and prefers our key when both exist', async () => {
    const rows: Array<Record<string, unknown>> = [
      { id: 'c1', avatar_storage_key: null, avatar_url: 'https://gravatar.test/abc' },
      { id: 'c2', avatar_storage_key: `workspace/${WS}/avatars/telegram/x.jpg`, avatar_url: 'https://stale.test/x.jpg' },
    ];
    await hydrateContactAvatars(serverConfig, WS, rows as never);

    expect(rows[0].avatar_url).toBe('https://gravatar.test/abc');
    expect(rows[1].avatar_url).toBe(`${LOCAL_PUBLIC}/workspace/${WS}/avatars/telegram/x.jpg`);
  });
});

// ── The acceptance criterion: promotion rewrites nothing ─────────

interface FakeRes {
  statusCode: number;
  /**
   * Whatever the handler serialized. Typed loosely on purpose: each test
   * asserts on the specific field it cares about.
   */
  body: Record<string, unknown> & { reason?: string; error?: string; providers?: unknown };
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

/** Tables that hold an avatar or a logo. A promotion must not touch any. */
const URL_BEARING_TABLES = [
  'contacts', 'profiles', 'workspace_branding',
  'call_center_settings', 'ai_agent_settings', 'platform_call_center_settings',
];

async function callRoute(method: string, routePath: string, params: Record<string, string>, body: unknown) {
  const stack = (adminStorageProvidersRouter as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: unknown, res: unknown, next: () => void) => unknown }>;
      };
    }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route ${method} ${routePath} not found`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res: FakeRes = {
    statusCode: 200,
    body: {},
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload as FakeRes['body']; return res; },
  };
  await handler({ params, body, serverConfig, adminUser: { id: 'admin-1' } }, res, () => {});
  return res;
}

describe('promoting a new primary rewrites zero rows', () => {
  it('serves the new vendor\'s URLs on the very next read, with no UPDATE to any URL-bearing table', async () => {
    const contactKey = `workspace/${WS}/avatars/telegram/a.jpg`;
    const profileKey = `users/${USER}/avatar/a.png`;

    // Before: links name the old vendor.
    const before = createStorageUrlResolver(serverConfig);
    expect(await before.workspace(WS, contactKey)).toBe(`${LOCAL_PUBLIC}/${contactKey}`);
    expect(await before.user(USER, profileKey)).toBe(`${LOCAL_PUBLIC}/${profileKey}`);

    // Promote. `force` stands in for the sync proof, which is a separate
    // gate with its own suite (storagePoolPromotion.test.ts) — what matters
    // here is what promotion does to the rows.
    writes.length = 0;
    const res = await callRoute('post', '/:providerName/primary', { providerName: 's3' }, { force: true });
    expect(res.statusCode).toBe(200);

    // After: the FIRST read already names the new vendor. Nothing was
    // rebuilt, refreshed or migrated in between.
    const after = createStorageUrlResolver(serverConfig);
    expect(await after.workspace(WS, contactKey)).toBe(`${S3_CDN}/${contactKey}`);
    expect(await after.user(USER, profileKey)).toBe(`${S3_CDN}/${profileKey}`);

    // And the promotion itself wrote to no table that holds a link.
    const touched = writes.filter((w) => URL_BEARING_TABLES.includes(w.table));
    expect(touched).toEqual([]);
  });

  it('a resolver created before the promotion keeps its own snapshot — the cache is request-scoped', async () => {
    const key = `workspace/${WS}/avatars/telegram/a.jpg`;
    const held = createStorageUrlResolver(serverConfig);
    expect(await held.workspace(WS, key)).toBe(`${LOCAL_PUBLIC}/${key}`);

    await callRoute('post', '/:providerName/primary', { providerName: 's3' }, { force: true });

    // The in-flight request finishes consistently…
    expect(await held.workspace(WS, key)).toBe(`${LOCAL_PUBLIC}/${key}`);
    // …and the next one sees the new primary.
    expect(await createStorageUrlResolver(serverConfig).workspace(WS, key)).toBe(`${S3_CDN}/${key}`);
  });
});

// ── Provider capability ──────────────────────────────────────────

describe('a vendor that cannot express a public URL is never promoted', () => {
  it('reports capability per vendor from a real probe, not a name list', () => {
    expect(describeUrlCapability(storageConfigFromRecord('s3', {
      bucket: 'b', region: 'us-east-1', cdn_url: S3_CDN,
    })).capable).toBe(true);

    expect(describeUrlCapability(storageConfigFromRecord('bunny_storage', {
      storage_zone: 'zone', api_key: 'k',
    })).capable).toBe(true);

    // Routed to the S3 upload handler for interop, but with no URL builder.
    for (const vendor of ['gcs', 'azure_blob']) {
      const capability = describeUrlCapability(storageConfigFromRecord(vendor, { bucket: 'b' }));
      expect(capability.capable).toBe(false);
      expect(capability.reason).toBe('no_public_url_builder');
    }

    // The local provider without a public_url produces a relative path,
    // which renders as a broken link in a visitor's browser.
    const local = describeUrlCapability(storageConfigFromRecord('local', { local_path: '/tmp/x' }));
    expect(local.capable).toBe(false);
    expect(local.reason).toBe('not_an_absolute_url');

    expect(describeUrlCapability(null).capable).toBe(false);
  });

  it('refuses promotion of such a vendor even with force', async () => {
    runtimeConfig.set('storage_provider_pool', {
      primary: 'local',
      replication: { enabled: true, mirrorDeletes: false },
      providers: {
        local: { enabled: true, config: { local_path: localDir, public_url: LOCAL_PUBLIC } },
        gcs: { enabled: true, config: { bucket: 'b', access_key_id: 'ak', secret_access_key: 'sk' } },
      },
      revision: 1,
    });

    const forced = await callRoute('post', '/:providerName/primary', { providerName: 'gcs' }, { force: true });
    expect(forced.statusCode).toBe(409);
    expect(forced.body.reason).toBe('no_public_url');

    const plain = await callRoute('post', '/:providerName/primary', { providerName: 'gcs' }, {});
    expect(plain.statusCode).toBe(409);
    expect(plain.body.reason).toBe('no_public_url');

    // The pointer every read resolves through is untouched.
    expect((runtimeConfig.get('default_storage_provider') as { provider_name: string }).provider_name).toBe('local');
  });

  it('refuses a local primary with no public base URL, naming the fixable cause', async () => {
    runtimeConfig.set('storage_provider_pool', {
      primary: 's3',
      replication: { enabled: true, mirrorDeletes: false },
      providers: {
        s3: { enabled: true, config: { bucket: 'b', region: 'us-east-1', cdn_url: S3_CDN } },
        local: { enabled: true, config: { local_path: localDir } },
      },
      revision: 1,
    });
    runtimeConfig.set('default_storage_provider', {
      provider_name: 's3',
      config: { bucket: 'b', region: 'us-east-1', cdn_url: S3_CDN },
    });

    const res = await callRoute('post', '/:providerName/primary', { providerName: 'local' }, { force: true });
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('no_public_url');
    expect(String(res.body.error)).toContain('public');
  });

  it('surfaces the capability on the pool listing so the screen can explain it', async () => {
    runtimeConfig.set('storage_provider_pool', {
      primary: 'local',
      replication: { enabled: true, mirrorDeletes: false },
      providers: {
        local: { enabled: true, config: { local_path: localDir, public_url: LOCAL_PUBLIC } },
        gcs: { enabled: true, config: { bucket: 'b' } },
      },
      revision: 1,
    });

    const res = await callRoute('get', '/', {}, undefined);
    const providers = res.body.providers as Array<{ name: string; canServePublicUrls: boolean }>;
    expect(providers.find((p) => p.name === 'local')?.canServePublicUrls).toBe(true);
    expect(providers.find((p) => p.name === 'gcs')?.canServePublicUrls).toBe(false);
  });
});
