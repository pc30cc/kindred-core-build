/**
 * conversation_attachments.storage_provider names the vendor that holds the
 * bytes. The operator and widget init routes used to read
 * `default_storage_provider.value.provider`, while the setting is stored as
 * `{ provider_name, config }`, so every row said "local" although the bytes
 * went to Bunny. Init now resolves the provider with the storage service's own
 * resolveStorageConfig (run for real here, against the setting as production
 * stores it), and a successful upload records the provider uploadFile used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type MockRes = { headersSent: boolean; status(code: number): MockRes; json(body: unknown): MockRes };

const WS = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

const db: {
  defaultStorage: unknown;
  workspaceStorage: Row | null;
  attachment: Row | null;
  inserts: Row[];
  updates: Row[];
} = { defaultStorage: null, workspaceStorage: null, attachment: null, inserts: [], updates: [] };

function table(name: string) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => {
      switch (name) {
        case 'app_runtime_config':
          return { data: db.defaultStorage ? { value: db.defaultStorage } : null, error: null };
        case 'provider_configs':
          return { data: db.workspaceStorage, error: null };
        case 'widget_settings':
          return { data: { enabled: true, chat_enabled: true, attachments_enabled: true }, error: null };
        case 'workspace_members':
          return { data: { role: null, suspended_at: null }, error: null };
        case 'conversation_attachments':
          return { data: db.attachment, error: null };
        default:
          return { data: null, error: null };
      }
    },
    insert: (row: Row) => {
      db.inserts.push(row);
      const created = { id: 'att-new', file_name: row.file_name, mime_type: row.mime_type, size_bytes: row.size_bytes };
      return { select: () => ({ single: async () => ({ data: created, error: null }) }) };
    },
    update: (patch: Row) => ({
      eq: async () => {
        db.updates.push(patch);
        return { data: null, error: null };
      },
    }),
  };
  return builder;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: table, rpc: async () => ({ data: true, error: null }) }),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) =>
    token ? { sessionId: 'test-session', userId: USER, email: 'test@example.com' } : null,
  verifyOriginForMutation: () => true,
}));

vi.mock('../../../server/services/widget/security.js', () => ({
  enforceWidgetToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: () => WS,
  verifyConversationOwnership: async () => ({ valid: true }),
}));

vi.mock('../../../server/middleware/featureGating.js', () => ({
  requireLimit: () => async (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../../server/services/billing/usageResolvers.js', () => ({
  usageFnForLimit: () => () => 0,
}));

// Only the upload itself is replaced; resolveStorageConfig is the real one.
const { uploadFileMock } = vi.hoisted(() => ({ uploadFileMock: vi.fn() }));
vi.mock('../../../server/services/storage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/storage/index.js')>()),
  uploadFile: uploadFileMock,
}));

import { conversationAttachmentsRouter } from '../../../server/routes/conversationAttachments';
import { widgetAttachmentsRouter } from '../../../server/routes/widgetAttachments';

type Handler = (req: Row, res: MockRes, next: () => void) => Promise<unknown> | unknown;
interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: Handler }> };
}

const routers = { operator: conversationAttachmentsRouter, widget: widgetAttachmentsRouter };
type Route = keyof typeof routers;

function handler(route: Route, method: string, path: string): Handler {
  const layer = routers[route].stack.find((l) => {
    const r = (l as unknown as RouteLayer).route;
    return r?.path === path && !!r?.methods?.[method];
  });
  if (!layer) throw new Error(`${route}: route ${method} ${path} not found`);
  const stack = (layer as unknown as RouteLayer).route!.stack;
  return stack[stack.length - 1].handle;
}

async function call(route: Route, method: string, path: string, body: Row) {
  const req: Row = {
    body,
    params: { id: '11111111-1111-1111-1111-111111111111' },
    query: {},
    headers: { authorization: 'Bearer token-x' },
    cookies: { gs_session: 'token-x' },
    serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' },
  };
  let statusCode = 200;
  let jsonBody: unknown;
  const res: MockRes = {
    headersSent: false,
    status(code: number) { statusCode = code; res.headersSent = true; return res; },
    json(b: unknown) { jsonBody = b; res.headersSent = true; return res; },
  };
  await handler(route, method, path)(req, res, () => {});
  return { statusCode, jsonBody };
}

const initBody = (route: Route): Row => ({
  ...(route === 'operator' ? { workspace_id: WS } : {}),
  file_name: 'photo.png',
  mime_type: 'image/png',
  size_bytes: 12,
});

beforeEach(() => {
  db.defaultStorage = null;
  db.workspaceStorage = null;
  db.inserts = [];
  db.updates = [];
  db.attachment = {
    id: '11111111-1111-1111-1111-111111111111',
    workspace_id: WS,
    storage_path: `workspace/${WS}/attachments/chat/2026/10/uuid-photo.png`,
    storage_provider: 'bunny_storage',
    mime_type: 'image/png',
    size_bytes: 12,
    status: 'uploading',
    uploaded_by_id: USER,
    uploaded_by_type: 'agent',
  };
  uploadFileMock.mockReset();
});

describe.each(['operator', 'widget'] as Route[])('%s attachment init: storage_provider', (route) => {
  async function initLabel(): Promise<unknown> {
    const { statusCode } = await call(route, 'post', '/init', initBody(route));
    expect(statusCode).toBe(200);
    expect(db.inserts).toHaveLength(1);
    return db.inserts[0].storage_provider;
  }

  it('is the provider the setting names, as production stores it ({ provider_name, config })', async () => {
    db.defaultStorage = { provider_name: 'bunny_storage', config: { storage_zone: 'zone', api_key: 'key' } };
    expect(await initLabel()).toBe('bunny_storage');
  });

  it('reads the older flattened form ({ provider, ...fields }) as before', async () => {
    db.defaultStorage = { provider: 's3', bucket: 'b', region: 'r' };
    expect(await initLabel()).toBe('s3');
  });

  it("is the workspace's own active provider when it has one", async () => {
    db.defaultStorage = { provider_name: 'bunny_storage', config: {} };
    db.workspaceStorage = { provider_name: 'arvan_storage', config: { bucket: 'b' } };
    expect(await initLabel()).toBe('arvan_storage');
  });

  it('stays "local" for local-disk storage and when nothing is configured', async () => {
    db.defaultStorage = { provider_name: 'local', config: { localPath: '/var/webyar' } };
    expect(await initLabel()).toBe('local');
    db.inserts = [];
    db.defaultStorage = null;
    expect(await initLabel()).toBe('local');
  });
});

describe.each(['operator', 'widget'] as Route[])('%s attachment upload: storage_provider', (route) => {
  const upload = () => call(route, 'post', '/:id/upload', {
    ...(route === 'operator' ? { workspace_id: WS } : {}),
    data: Buffer.from('hello world!').toString('base64'),
  });

  it('records the provider that stored the bytes', async () => {
    uploadFileMock.mockResolvedValue({ success: true, provider: 'arvan_storage' });
    const { statusCode } = await upload();
    expect(statusCode).toBe(200);
    expect(db.updates).toEqual([expect.objectContaining({ status: 'uploaded', storage_provider: 'arvan_storage' })]);
  });

  it('leaves the label alone when the upload result does not name a provider', async () => {
    uploadFileMock.mockResolvedValue({ success: true });
    await upload();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({ status: 'uploaded' });
    expect(db.updates[0]).not.toHaveProperty('storage_provider');
  });

  it('does not touch the label when the upload fails', async () => {
    uploadFileMock.mockResolvedValue({ success: false, error: 'refused', provider: 'bunny_storage' });
    const { statusCode } = await upload();
    expect(statusCode).toBe(502);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({ status: 'failed' });
    expect(db.updates[0]).not.toHaveProperty('storage_provider');
  });
});
