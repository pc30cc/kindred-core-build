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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  enforceModule: async () => true,
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

// ── Legacy launcher-image backfill (migration 190) ────────────────

/**
 * The launcher image predates the key column: the browser uploaded it and
 * PATCHed the returned provider URL into the row. Migration 190 recovers the
 * key from that URL — conservatively — so an EXISTING WebYar-owned launcher
 * stops being pinned to the provider that was primary when it was uploaded.
 *
 * The backfill is SQL, which this suite cannot execute, so instead of
 * re-implementing it (which would drift silently) these tests READ THE
 * PATTERNS OUT OF THE MIGRATION FILE and evaluate them. The subset used —
 * `[0-9]`, `+`, `\.`, a character class, a capture group and `$` — means the
 * same thing in POSIX ERE and in JavaScript, so evaluating the extracted
 * pattern here is a faithful stand-in. If anybody loosens the SQL, these
 * cases fail.
 */
function readFabBackfill(): { guard: (ws: string, url: string) => boolean; extract: (ws: string, url: string) => string | null } {
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'database/migrations/190_storage_key_ownership.sql'), 'utf8');

  const regexTail = /from '\(workspace\/' \|\| w\.workspace_id::text \|\| '([^']+)'/.exec(sql);
  const likeParts = /LIKE '([^']*)' \|\| w\.workspace_id::text \|\| '([^']*)';/.exec(sql);
  if (!regexTail || !likeParts) throw new Error('migration 190: launcher backfill patterns not found');

  // `split_part(split_part(url, '#', 1), '?', 1)`
  const strip = (url: string) => url.split('#')[0].split('?')[0];
  // `LIKE '%…%'` with no other wildcards is a substring test.
  const likePrefix = likeParts[1].replace(/%/g, '');
  const likeSuffix = likeParts[2].replace(/%/g, '');

  return {
    guard: (ws, url) => strip(url).includes(`${likePrefix}${ws}${likeSuffix}`),
    extract: (ws, url) => {
      const re = new RegExp(`(workspace/${ws}${regexTail[1]}`);
      return re.exec(strip(url))?.[1] ?? null;
    },
  };
}

/** The whole UPDATE: guard, then extract. NULL when either refuses. */
function backfill(ws: string, url: string | null): string | null {
  if (!url) return null;
  const { guard, extract } = readFabBackfill();
  if (!guard(ws, url)) return null;
  return extract(ws, url);
}

describe('migration 190 recovers a legacy launcher key, conservatively', () => {
  const OTHER_WS = '11111111-1111-4111-8111-111111111111';

  it('recovers the key a real pre-migration row can prove', () => {
    // Exactly what src/pages/app/WidgetPage.tsx used to build and store.
    const url = `https://old-provider.example/workspace/${WS}/widget/launcher-123456789.png`;

    expect(backfill(WS, url)).toBe(`workspace/${WS}/widget/launcher-123456789.png`);
  });

  it('does NOT adopt a key that names another workspace', () => {
    const url = `https://old-provider.example/workspace/${OTHER_WS}/widget/launcher-123456789.png`;

    expect(backfill(WS, url)).toBeNull();
    // …and not even when this row's id also appears elsewhere in the URL.
    expect(backfill(WS, `https://cdn.example/${WS}/x/workspace/${OTHER_WS}/widget/launcher-1.png`)).toBeNull();
  });

  it('leaves an arbitrary external image NULL', () => {
    for (const url of [
      'https://external.example/some/avatar.jpg',
      'https://external.example/workspace/not-a-uuid/widget/launcher-1.png',
      `https://external.example/workspace/${WS}/branding/icon.png`,
      `https://external.example/workspace/${WS}/widget/launcher/uuid-name.png`, // new shape, dash vs slash
      `https://external.example/workspace/${WS}/widget/launcher-abc.png`,       // not an epoch
    ]) {
      expect(backfill(WS, url), url).toBeNull();
    }
  });

  it('strips a query string and a fragment before extracting', () => {
    const key = `workspace/${WS}/widget/launcher-1700000000000.webp`;

    expect(backfill(WS, `https://cdn.example/${key}?v=2`)).toBe(key);
    expect(backfill(WS, `https://cdn.example/${key}#frag`)).toBe(key);
    expect(backfill(WS, `https://cdn.example/${key}?v=2#frag`)).toBe(key);
  });

  it('refuses a URL whose path continues past the key', () => {
    // `$`-anchored: the key the uploader wrote was always last in the path.
    expect(backfill(WS, `https://cdn.example/workspace/${WS}/widget/launcher-1.png/extra`)).toBeNull();
  });

  it('every key it does produce satisfies the ownership CHECK', () => {
    const sql = fs.readFileSync(path.resolve(process.cwd(), 'database/migrations/190_storage_key_ownership.sql'), 'utf8');
    expect(sql).toContain("fab_image_storage_key LIKE 'workspace/' || workspace_id::text || '/widget/%'");

    for (const ext of ['png', 'jpg', 'webp']) {
      const key = backfill(WS, `https://cdn.example/workspace/${WS}/widget/launcher-9.${ext}`);
      expect(key).toBe(`workspace/${WS}/widget/launcher-9.${ext}`);
      expect(key!.startsWith(`workspace/${WS}/widget/`)).toBe(true);
    }
  });

  it('does not clear fab_image_url, so the old backend keeps working mid-deploy', () => {
    const sql = fs.readFileSync(path.resolve(process.cwd(), 'database/migrations/190_storage_key_ownership.sql'), 'utf8');
    const update = sql.slice(sql.indexOf('UPDATE public.widget_settings'), sql.indexOf('-- ─── 2.'));
    expect(update).toContain('SET fab_image_storage_key =');
    expect(update).not.toContain('fab_image_url =');
  });
});

describe('a backfilled legacy launcher follows a promotion', () => {
  it('serves the new provider on the next read, with no widget_settings update', async () => {
    // The row exactly as migration 190 leaves it: key recovered, legacy URL
    // still physically present for deploy compatibility.
    const legacyUrl = `https://old-provider.example/workspace/${WS}/widget/launcher-123456789.png`;
    const recovered = backfill(WS, legacyUrl);
    expect(recovered).toBe(`workspace/${WS}/widget/launcher-123456789.png`);

    db.widget_settings.fab_image_storage_key = recovered;
    db.widget_settings.fab_image_url = legacyUrl;
    db.updates = [];

    // Before: the key wins over the stale URL, resolved on the old provider.
    const before = await call('GET', `/api/widget-settings/${WS}`);
    expect(before.body.settings?.fab_image_url).toBe(`${LOCAL_PUBLIC}/${recovered}`);

    seedProvider('s3');

    const after = await call('GET', `/api/widget-settings/${WS}`);
    expect(after.body.settings?.fab_image_url).toBe(`${S3_CDN}/${recovered}`);
    // Promotion rewrote nothing, and the legacy column is untouched.
    expect(db.updates).toEqual([]);
    expect(db.widget_settings.fab_image_url).toBe(legacyUrl);
  });

  it('an unprovable row still falls back to its legacy URL, read-only', async () => {
    const external = 'https://external.example/some/launcher.png';
    db.widget_settings.fab_image_storage_key = backfill(WS, external); // null
    db.widget_settings.fab_image_url = external;

    expect(db.widget_settings.fab_image_storage_key).toBeNull();

    const before = await call('GET', `/api/widget-settings/${WS}`);
    expect(before.body.settings?.fab_image_url).toBe(external);

    // A promotion cannot help it — which is exactly why the backfill matters
    // for the rows it CAN prove.
    seedProvider('s3');
    const after = await call('GET', `/api/widget-settings/${WS}`);
    expect(after.body.settings?.fab_image_url).toBe(external);
  });
});
