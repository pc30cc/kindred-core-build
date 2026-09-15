/**
 * A WORKSPACE CALLER CANNOT PERSIST A MEDIA URL.
 *
 * The product has exactly one model for a file WebYar manages:
 *
 *     upload/ingest -> WebYar storage -> canonical key in the DB
 *                   -> URL derived at read time
 *
 * and explicitly NOT:
 *
 *     workspace API -> arbitrary https://... -> persisted *_url
 *
 * Several request schemas still allowed the second shape. These tests drive
 * the real routers and prove each of those doors is shut, that the launcher
 * image now goes through a server-owned upload, and that its link follows a
 * provider promotion with no row rewritten — the same acceptance criterion
 * the rest of the key-only work is held to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '55555555-5555-4555-8555-555555555555';
const CONTACT = 'cccccccc-dddd-4eee-8fff-000000000000';

const LOCAL_PUBLIC = 'https://files.old-vendor.test';
const S3_CDN = 'https://cdn.new-vendor.test';

// ── Fake DB ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** The fluent PostgREST surface these routers touch. */
type FakeBuilder = {
  select: () => FakeBuilder;
  eq: (col: string, value: unknown) => FakeBuilder;
  order: () => FakeBuilder;
  limit: () => FakeBuilder;
  in: () => FakeBuilder;
  is: () => FakeBuilder;
  not?: () => FakeBuilder;
  insert: (values: Row | Row[]) => FakeBuilder;
  update: (values: Row) => FakeBuilder;
  single: () => Promise<{ data: unknown; error: unknown }>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (onOk: (v: unknown) => unknown) => Promise<unknown>;
};

/** The slice of a settings response these tests assert on. */
type JsonBody = {
  settings?: { fab_image_url?: string | null; fab_image_storage_key?: string | null };
};


const db: {
  widget_settings: Row;
  contacts: Row[];
  runtimeConfig: Map<string, unknown>;
  /** Every UPDATE, so "a promotion rewrites nothing" is provable. */
  updates: Array<{ table: string; values: Row }>;
} = { widget_settings: {}, contacts: [], runtimeConfig: new Map(), updates: [] };

/** Objects the storage primitives were asked to write / delete. */
const storage: { uploaded: string[]; deleted: string[]; failNext: boolean } = {
  uploaded: [], deleted: [], failNext: false,
};

function seedProvider(primary: 'local' | 's3') {
  const local = { local_path: '/tmp/keyonly-fab', public_url: LOCAL_PUBLIC };
  const s3 = { bucket: 'b', region: 'us-east-1', cdn_url: S3_CDN };
  db.runtimeConfig.set('default_storage_provider', {
    provider_name: primary,
    config: primary === 'local' ? local : s3,
  });
}

function reset() {
  db.widget_settings = {
    id: 'row-1',
    workspace_id: WS,
    primary_color: '#3B82F6',
    fab_image_storage_key: null,
    fab_image_url: null,
    updated_at: '2020-01-01T00:00:00.000Z',
  };
  db.contacts = [{ id: CONTACT, workspace_id: WS, name: 'Ada', avatar_url: null, avatar_storage_key: null }];
  db.runtimeConfig.clear();
  db.updates = [];
  storage.uploaded = [];
  storage.deleted = [];
  storage.failNext = false;
  seedProvider('local');
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let pending: Row | null = null;
      let wantedKey: string | null = null;

      function matched(): Row[] {
        if (table === 'widget_settings') {
          return filters.every(([c, v]) => db.widget_settings[c] === v) ? [db.widget_settings] : [];
        }
        if (table === 'contacts') {
          return db.contacts.filter((r) => filters.every(([c, v]) => r[c] === v));
        }
        return [];
      }
      function apply(): Row | null {
        const rows = matched();
        for (const r of rows) Object.assign(r, pending);
        return rows[0] ?? null;
      }

      const builder: FakeBuilder = {
        select: () => builder,
        eq: (col: string, value: unknown) => {
          if (col === 'key') wantedKey = String(value);
          else filters.push([col, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        in: () => builder,
        is: () => builder,
        not: () => builder,
        insert: (values: Row | Row[]) => {
          const list = Array.isArray(values) ? values : [values];
          for (const v of list) db.contacts.push({ id: `new-${db.contacts.length}`, ...v });
          return builder;
        },
        update: (values: Row) => {
          pending = values;
          db.updates.push({ table, values });
          return builder;
        },
        single: async () => {
          if (table === 'app_runtime_config') {
            return {
              data: wantedKey && db.runtimeConfig.has(wantedKey)
                ? { key: wantedKey, value: db.runtimeConfig.get(wantedKey) }
                : null,
              error: null,
            };
          }
          const row = pending ? apply() : matched()[0] ?? db.contacts[db.contacts.length - 1] ?? null;
          return { data: row, error: null };
        },
        maybeSingle: async () => builder.single(),
        then: (onOk: (v: unknown) => unknown) => {
          const row = pending ? apply() : null;
          return Promise.resolve({ data: row ? [row] : [], error: null }).then(onOk);
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

// Only the storage PRIMITIVES are faked; key construction, ownership and URL
// derivation are the real implementations under test.
vi.mock('../../../server/services/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/storage/index.js')>();
  return {
    ...actual,
    uploadForOwner: async (_c: unknown, req: { fileKey: string }) => {
      if (storage.failNext) return { success: false, error: 'provider_down' };
      storage.uploaded.push(req.fileKey);
      return { success: true, fileKey: req.fileKey, url: `${LOCAL_PUBLIC}/${req.fileKey}` };
    },
    deleteForOwner: async (_c: unknown, _o: unknown, key: string) => {
      storage.deleted.push(key);
      return { success: true };
    },
    uploadFile: async (_c: unknown, req: { fileKey: string }) => {
      storage.uploaded.push(req.fileKey);
      return { success: true, fileKey: req.fileKey, url: `${LOCAL_PUBLIC}/${req.fileKey}` };
    },
    deleteFile: async () => ({ success: true }),
  };
});

vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>();
  return {
    ...actual,
    authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
  };
});
vi.mock('../../../server/services/phoneVerification/index.js', () => ({
  assertPhoneVerificationSatisfied: async () => {},
}));
vi.mock('../../../server/services/phoneVerification/types.js', () => ({
  PhoneVerificationError: class PhoneVerificationError extends Error {},
}));
vi.mock('../../../server/services/widget/public.js', () => ({
  invalidateWorkspaceOriginCache: () => {},
}));
vi.mock('../../../server/services/widget/entitlements.js', () => ({
  resolveWidgetEntitlements: async () => ({ features: {}, maxDomains: 10 }),
  guardWidgetSettingsPatch: () => ({ ok: true, denied: [] }),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true }),
  requireLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  clearEntitlementCache: () => {},
  checkModuleAccess: async () => ({ allowed: true }),
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../server/services/visitors/networkProfile.js', () => ({
  resolveIpVisibilityPolicy: async () => ({ canViewRawIp: false }),
  resolveContactNetworkProfile: async () => null,
}));

const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
const { contactsRouter } = await import('../../../server/routes/contacts.js');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig: unknown }).serverConfig = { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' };
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use('/api/widget-settings', widgetSettingsRouter);
app.use('/api/contacts', contactsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: JsonBody }> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { done({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }); }
        catch (e) { fail(e); }
      });
    });
    req.on('error', fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('base64');

beforeEach(reset);

// ── 1-3. Contacts ────────────────────────────────────────────────

describe('contacts: no avatar URL is writable', () => {
  const EXTERNAL = { avatar_url: 'https://external.example/avatar.jpg' };

  it('POST /contacts rejects avatar_url', async () => {
    const res = await call('POST', '/api/contacts', { workspace_id: WS, name: 'Grace', ...EXTERNAL });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('avatar_url');
    expect(db.contacts.some((c) => c.avatar_url === EXTERNAL.avatar_url)).toBe(false);
  });

  it('POST /contacts/bulk rejects avatar_url', async () => {
    const res = await call('POST', '/api/contacts/bulk', {
      workspace_id: WS,
      contacts: [{ name: 'Grace', ...EXTERNAL }],
    });

    expect(res.status).toBe(400);
    expect(db.contacts.some((c) => c.avatar_url === EXTERNAL.avatar_url)).toBe(false);
  });

  it('PATCH /contacts/:id rejects avatar_url and leaves the stored key alone', async () => {
    db.contacts[0].avatar_storage_key = `workspace/${WS}/avatars/telegram/a.jpg`;

    const res = await call('PATCH', `/api/contacts/${CONTACT}`, { name: 'Ada L.', ...EXTERNAL });

    expect(res.status).toBe(400);
    expect(db.contacts[0].avatar_url).toBeNull();
    expect(db.contacts[0].avatar_storage_key).toBe(`workspace/${WS}/avatars/telegram/a.jpg`);
    // Rejected outright — not "accepted minus the field".
    expect(db.contacts[0].name).toBe('Ada');
  });

  it('a create without an avatar still works, and stores neither avatar column', async () => {
    const res = await call('POST', '/api/contacts', { workspace_id: WS, name: 'Grace', email: 'g@example.com' });

    expect(res.status).toBe(200);
    const created = db.contacts[db.contacts.length - 1];
    expect(created.name).toBe('Grace');
    expect(created.avatar_url).toBeUndefined();
    expect(created.avatar_storage_key).toBeUndefined();
  });
});

// ── 6-11. Widget launcher image ──────────────────────────────────

describe('widget launcher image is key-only', () => {
  it('the generic settings PATCH rejects fab_image_url', async () => {
    const res = await call('PATCH', `/api/widget-settings/${WS}`, {
      fab_image_url: 'https://external.example/launcher.png',
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('fab_image_url');
    expect(db.widget_settings.fab_image_url).toBeNull();
    expect(db.widget_settings.fab_image_storage_key).toBeNull();
  });

  it('the upload endpoint persists the storage key and no URL', async () => {
    const res = await call('POST', `/api/widget-settings/${WS}/fab-image`, {
      contentType: 'image/png', data: PNG, fileName: 'launcher.png',
    });

    expect(res.status).toBe(200);
    // Server-built key, in the namespace migration 190's CHECK requires.
    expect(db.widget_settings.fab_image_storage_key).toMatch(
      new RegExp(`^workspace/${WS}/widget/launcher/`),
    );
    expect(storage.uploaded).toEqual([db.widget_settings.fab_image_storage_key]);
    // Nothing provider-shaped was written to the row.
    expect(db.widget_settings.fab_image_url).toBeNull();
    const written = db.updates.filter((u) => u.table === 'widget_settings');
    expect(JSON.stringify(written)).not.toContain('https://');
  });

  it('the API response carries a link DERIVED from that key', async () => {
    const res = await call('POST', `/api/widget-settings/${WS}/fab-image`, {
      contentType: 'image/png', data: PNG,
    });

    expect(res.body.settings.fab_image_url)
      .toBe(`${LOCAL_PUBLIC}/${db.widget_settings.fab_image_storage_key}`);
    // The key itself is never handed to a client.
    expect(res.body.settings.fab_image_storage_key).toBeUndefined();
  });

  it('promoting a new primary changes the link with ZERO widget_settings updates', async () => {
    await call('POST', `/api/widget-settings/${WS}/fab-image`, { contentType: 'image/png', data: PNG });
    const key = db.widget_settings.fab_image_storage_key;

    const before = await call('GET', `/api/widget-settings/${WS}`);
    expect(before.body.settings.fab_image_url).toBe(`${LOCAL_PUBLIC}/${key}`);

    // The promotion itself is covered by keyOnlyUrlDerivation.test.ts; here
    // only its effect matters — the pointer every read resolves through.
    db.updates = [];
    seedProvider('s3');

    const after = await call('GET', `/api/widget-settings/${WS}`);
    expect(after.body.settings.fab_image_url).toBe(`${S3_CDN}/${key}`);
    // Not one row was rewritten to make that true.
    expect(db.updates).toEqual([]);
    expect(db.widget_settings.fab_image_storage_key).toBe(key);
  });

  it('replacing the image deletes the previous object and keeps exactly one key', async () => {
    await call('POST', `/api/widget-settings/${WS}/fab-image`, { contentType: 'image/png', data: PNG });
    const first = db.widget_settings.fab_image_storage_key;

    await call('POST', `/api/widget-settings/${WS}/fab-image`, { contentType: 'image/png', data: PNG });
    const second = db.widget_settings.fab_image_storage_key;

    expect(second).not.toBe(first);
    expect(storage.deleted).toEqual([first]);
  });

  it('DELETE clears the key, clears any legacy URL, and removes the object', async () => {
    await call('POST', `/api/widget-settings/${WS}/fab-image`, { contentType: 'image/png', data: PNG });
    const key = db.widget_settings.fab_image_storage_key;
    db.widget_settings.fab_image_url = 'https://legacy.example/old.png';

    const res = await call('DELETE', `/api/widget-settings/${WS}/fab-image`);

    expect(res.status).toBe(200);
    expect(db.widget_settings.fab_image_storage_key).toBeNull();
    expect(db.widget_settings.fab_image_url).toBeNull();
    expect(storage.deleted).toContain(key);
    expect(res.body.settings.fab_image_url).toBeNull();
  });

  it('refuses a type it cannot serve, and a file over the cap, without touching storage', async () => {
    const wrongType = await call('POST', `/api/widget-settings/${WS}/fab-image`, {
      contentType: 'image/svg+xml', data: PNG,
    });
    expect(wrongType.status).toBe(415);

    const tooBig = await call('POST', `/api/widget-settings/${WS}/fab-image`, {
      contentType: 'image/png', data: Buffer.alloc(3 * 1024 * 1024).toString('base64'),
    });
    expect(tooBig.status).toBe(413);

    expect(storage.uploaded).toEqual([]);
    expect(db.widget_settings.fab_image_storage_key).toBeNull();
  });

  it('writes no key when the upload itself failed', async () => {
    storage.failNext = true;

    const res = await call('POST', `/api/widget-settings/${WS}/fab-image`, {
      contentType: 'image/png', data: PNG,
    });

    expect(res.status).toBe(502);
    expect(db.widget_settings.fab_image_storage_key).toBeNull();
  });

  it('the legacy URL fallback is READ-ONLY: it renders, but nothing can create one', async () => {
    // A row written by the old browser-upload path: URL, no key.
    db.widget_settings.fab_image_url = 'https://legacy-vendor.example/launcher.png';

    const read = await call('GET', `/api/widget-settings/${WS}`);
    expect(read.body.settings.fab_image_url).toBe('https://legacy-vendor.example/launcher.png');

    // …and no request can put a new value there.
    const write = await call('PATCH', `/api/widget-settings/${WS}`, {
      fab_image_url: 'https://external.example/new.png',
    });
    expect(write.status).toBe(400);
    expect(db.widget_settings.fab_image_url).toBe('https://legacy-vendor.example/launcher.png');

    // A real upload replaces it with a key and clears it.
    await call('POST', `/api/widget-settings/${WS}/fab-image`, { contentType: 'image/png', data: PNG });
    expect(db.widget_settings.fab_image_url).toBeNull();
    expect(db.widget_settings.fab_image_storage_key).toBeTruthy();
  });

  it('a key of another workspace is never turned into a link', async () => {
    db.widget_settings.fab_image_storage_key =
      'workspace/11111111-1111-4111-8111-111111111111/widget/launcher/x.png';

    const res = await call('GET', `/api/widget-settings/${WS}`);

    expect(res.body.settings.fab_image_url).toBeNull();
  });
});
