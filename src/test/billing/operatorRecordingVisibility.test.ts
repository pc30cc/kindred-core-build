/**
 * Operator-side recording visibility — read-only workspace surface.
 *
 * Verifies:
 *   • workspace members can list recordings for a call in their workspace
 *   • cross-workspace access via the recordings list returns 404
 *   • cross-workspace playback-token mint returns 404 (no existence leak)
 *   • playback-token responses never include storage_path / provider URLs
 *   • the minted token is hard-coded to disposition='inline' for operators
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS_OK = '11111111-1111-1111-1111-111111111111';
const WS_OTHER = '22222222-2222-2222-2222-222222222222';
const CALL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REC_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Per-table mock state — each describe sets these before invoking the route.
type TableOp = 'maybeSingle' | 'list';
type TableRow = Record<string, unknown> | null;
type TableHandler = (op: TableOp, eqs: Array<[string, unknown]>) => { data: TableRow | TableRow[]; error: null };
const tableState: Record<string, TableHandler> = {};

interface QueryBuilder {
  _eqs: Array<[string, unknown]>;
  select(): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  order(): QueryBuilder;
  maybeSingle(): Promise<{ data: TableRow | TableRow[]; error: null }>;
  then?: (resolve: (v: { data: TableRow | TableRow[]; error: null }) => void) => void;
}

interface SbMock {
  auth: { getUser: () => Promise<{ data: { user: { id: string } }; error: null }> };
  rpc: (name: string) => Promise<{ data: unknown; error: null }>;
  from(name: string): QueryBuilder;
}

const sbMock: SbMock = {
  auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
  rpc: async (name: string) => {
    if (name === 'is_workspace_member') return { data: true, error: null };
    if (name === 'get_workspace_role') return { data: 'owner', error: null };
    return { data: null, error: null };
  },
  from(name: string) {
    const handler = tableState[name];
    const builder: QueryBuilder = {
      _eqs: [],
      select() { return builder; },
      eq(col: string, val: unknown) { builder._eqs.push([col, val]); return builder; },
      order() { return builder; },
      maybeSingle: async () => (handler ? handler('maybeSingle', builder._eqs) : { data: null, error: null }),
    };
    // Allow `await sb.from(x).select().eq().order()` to resolve as a list.
    Object.defineProperty(builder, 'then', {
      value: (resolve: (v: { data: TableRow | TableRow[]; error: null }) => void) =>
        resolve(handler ? handler('list', builder._eqs) : { data: [], error: null }),
    });
    return builder;
  },
};

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => sbMock }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    return { sessionId: 'test-session', userId: 'u-1', email: 'test@example.com' };
  },
  verifyOriginForMutation: () => true,
}));
vi.mock('../../../server/services/storage/index.js', async () => {
  // The archive routes resolve LiveKit's own recording-storage config via
  // recordingStorageResolver.js (mocked below) and then read bytes through
  // downloadWithConfig — every other export is stubbed to a harmless no-op
  // so importing the call-center router does not blow up.
  return {
    downloadFile: async (_cfg: unknown, _ws: string, key: string) => {
      if (key === 'missing.mp4') return { success: false, error: 'gone' };
      return { success: true, data: Buffer.from(`bytes:${key}`) };
    },
    downloadWithConfig: async (_cfg: unknown, key: string) => {
      if (key === 'missing.mp4') return { success: false, error: 'gone' };
      return { success: true, data: Buffer.from(`bytes:${key}`) };
    },
    uploadFile: async () => ({ success: false, error: 'noop' }),
    deleteFile: async () => ({ success: false, error: 'noop' }),
    resolveStorageConfig: async () => null,
    resolveGlobalStorageConfig: async () => null,
    uploadWithConfig: async () => ({ success: false, error: 'noop' }),
    deleteWithConfig: async () => ({ success: false, error: 'noop' }),
    getFileUrlWithConfig: () => null,
  };
});
vi.mock('../../../server/services/calls/recordingStorageResolver.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../server/services/calls/recordingStorageResolver.js');
  return {
    ...actual,
    resolveRecordingStorageConfig: async () => ({ provider: 's3', accessKeyId: 'k', secretAccessKey: 's', bucket: 'recordings-test' }),
  };
});

import { callCenterRouter } from '../../../server/routes/callCenter';

// ── Minimal req/res + route-lookup mock types ─────────────────────────────
interface MockReq {
  params?: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  serverConfig: { supabaseUrl: string; supabaseServiceRoleKey: string };
}

interface RecordingListItem {
  id: string;
  recording_type: string;
  duration_seconds: number;
  size_bytes: number;
  created_at: string;
  has_storage: boolean;
}

interface TokenResult {
  recording_id: string;
  disposition?: string;
  url?: string;
  error?: string;
}

interface MockJsonBody {
  recordings?: RecordingListItem[];
  disposition?: string;
  url?: string;
  error?: string;
  count?: number;
  results?: TokenResult[];
}

interface MockRes {
  status(code: number): MockRes;
  json(body: MockJsonBody): MockRes;
  setHeader?(key: string, value: unknown): void;
  send?(body: Buffer | string): MockRes;
}

type Handler = (req: MockReq, res: MockRes) => Promise<void> | void;

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: Handler }>;
  };
}

function findHandler(method: string, path: string): Handler {
  const layer = callCenterRouter.stack.find((l) => {
    const route = (l as unknown as RouteLayer).route;
    return route?.path === path && !!route?.methods?.[method];
  });
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stk = (layer as unknown as RouteLayer).route!.stack;
  return stk[stk.length - 1].handle;
}

function makeReqRes(opts: { params?: Record<string, string>; query?: Record<string, string>; body?: Record<string, unknown> } = {}) {
  const req: MockReq = {
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
    serverConfig: {
      supabaseUrl: 'http://x',
      supabaseServiceRoleKey: 'k-operator-test-secret',
    },
  };
  let statusCode = 200;
  let jsonBody: MockJsonBody = {};
  const res: MockRes = {
    status(c: number) { statusCode = c; return res; },
    json(b: MockJsonBody) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

beforeEach(() => {
  for (const k of Object.keys(tableState)) delete tableState[k];
});

describe('GET /calls/:id/recordings', () => {
  const handler = findHandler('get', '/calls/:id/recordings');

  it('returns recordings (without storage_path) when the call is in the workspace', async () => {
    tableState['call_sessions'] = () => ({ data: { id: CALL_ID, workspace_id: WS_OK }, error: null });
    tableState['call_recordings'] = (op: string) => op === 'list' ? ({
      data: [{
        id: REC_ID,
        recording_type: 'composite',
        duration_seconds: 42,
        size_bytes: 1024,
        storage_path: 'workspace/secret/path.mp4',
        created_at: '2025-01-01T00:00:00Z',
      }],
      error: null,
    }) : ({ data: null, error: null });

    const { req, res, get } = makeReqRes({ params: { id: CALL_ID }, query: { workspaceId: WS_OK } });
    await handler(req, res);
    const { statusCode, jsonBody } = get();
    expect(statusCode).toBe(200);
    expect(jsonBody.recordings).toHaveLength(1);
    expect(jsonBody.recordings![0].has_storage).toBe(true);
    expect(jsonBody.recordings![0]).not.toHaveProperty('storage_path');
    expect(JSON.stringify(jsonBody)).not.toContain('workspace/secret/path.mp4');
  });

  it('returns 404 when the call belongs to a different workspace', async () => {
    tableState['call_sessions'] = () => ({ data: { id: CALL_ID, workspace_id: WS_OTHER }, error: null });
    const { req, res, get } = makeReqRes({ params: { id: CALL_ID }, query: { workspaceId: WS_OK } });
    await handler(req, res);
    expect(get().statusCode).toBe(404);
  });
});

describe('POST /calls/:id/recordings/:recordingId/playback-token', () => {
  const handler = findHandler('post', '/calls/:id/recordings/:recordingId/playback-token');

  it('mints an inline-only playback URL when workspace matches', async () => {
    tableState['call_recordings'] = () => ({
      data: {
        id: REC_ID,
        storage_path: 'p.mp4',
        call_session_id: CALL_ID,
        call_sessions: { workspace_id: WS_OK },
      },
      error: null,
    });
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID, recordingId: REC_ID },
      query: { workspaceId: WS_OK },
    });
    await handler(req, res);
    const { statusCode, jsonBody } = get();
    expect(statusCode).toBe(200);
    expect(jsonBody.disposition).toBe('inline');
    expect(jsonBody.url).toMatch(/^\/api\/calls\/recording-playback\//);
    // The streaming URL must not leak provider URLs or storage paths.
    expect(jsonBody.url).not.toContain('p.mp4');
    expect(JSON.stringify(jsonBody)).not.toContain('storage_path');
  });

  it('returns 404 when the recording belongs to a different workspace (no existence leak)', async () => {
    tableState['call_recordings'] = () => ({
      data: {
        id: REC_ID,
        storage_path: 'p.mp4',
        call_session_id: CALL_ID,
        call_sessions: { workspace_id: WS_OTHER },
      },
      error: null,
    });
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID, recordingId: REC_ID },
      query: { workspaceId: WS_OK },
    });
    await handler(req, res);
    expect(get().statusCode).toBe(404);
  });

  it('returns 404 when recording is in workspace but on a different call (no cross-call mint)', async () => {
    tableState['call_recordings'] = () => ({
      data: {
        id: REC_ID,
        storage_path: 'p.mp4',
        call_session_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        call_sessions: { workspace_id: WS_OK },
      },
      error: null,
    });
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID, recordingId: REC_ID },
      query: { workspaceId: WS_OK },
    });
    await handler(req, res);
    expect(get().statusCode).toBe(404);
  });

  it('rejects when the operator passes disposition=attachment via body/query (operator surface is inline-only)', async () => {
    tableState['call_recordings'] = () => ({
      data: {
        id: REC_ID,
        storage_path: 'p.mp4',
        call_session_id: CALL_ID,
        call_sessions: { workspace_id: WS_OK },
      },
      error: null,
    });
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID, recordingId: REC_ID },
      query: { workspaceId: WS_OK, disposition: 'attachment' },
      body: { disposition: 'attachment' },
    });
    await handler(req, res);
    expect(get().jsonBody.disposition).toBe('inline');
  });
});

describe('POST /calls/:id/recordings/:recordingId/download-token', () => {
  const handler = findHandler('post', '/calls/:id/recordings/:recordingId/download-token');

  it('mints an attachment-scoped download URL when workspace matches', async () => {
    tableState['call_recordings'] = () => ({
      data: {
        id: REC_ID,
        storage_path: 'p.mp4',
        call_session_id: CALL_ID,
        call_sessions: { workspace_id: WS_OK },
      },
      error: null,
    });
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID, recordingId: REC_ID },
      query: { workspaceId: WS_OK },
    });
    await handler(req, res);
    const { statusCode, jsonBody } = get();
    expect(statusCode).toBe(200);
    expect(jsonBody.disposition).toBe('attachment');
    expect(jsonBody.url).toMatch(/^\/api\/calls\/recording-playback\//);
    expect(jsonBody.url).toContain('disposition=attachment');
    // No provider URL / storage_path leak.
    expect(jsonBody.url).not.toContain('p.mp4');
    expect(JSON.stringify(jsonBody)).not.toContain('storage_path');
  });

  it('returns 404 when the recording belongs to a different workspace (no existence leak)', async () => {
    tableState['call_recordings'] = () => ({
      data: {
        id: REC_ID,
        storage_path: 'p.mp4',
        call_session_id: CALL_ID,
        call_sessions: { workspace_id: WS_OTHER },
      },
      error: null,
    });
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID, recordingId: REC_ID },
      query: { workspaceId: WS_OK },
    });
    await handler(req, res);
    expect(get().statusCode).toBe(404);
  });

  it('returns 404 when the recording is in workspace but on a different call', async () => {
    tableState['call_recordings'] = () => ({
      data: {
        id: REC_ID,
        storage_path: 'p.mp4',
        call_session_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        call_sessions: { workspace_id: WS_OK },
      },
      error: null,
    });
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID, recordingId: REC_ID },
      query: { workspaceId: WS_OK },
    });
    await handler(req, res);
    expect(get().statusCode).toBe(404);
  });
});

describe('POST /calls/:id/recordings/bulk-download-tokens', () => {
  const handler = findHandler('post', '/calls/:id/recordings/bulk-download-tokens');
  const REC_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const REC_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const REC_OTHER_WS = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  interface RecordingFixture {
    id: string;
    storage_path: string;
    call_session_id: string;
    call_sessions: { workspace_id: string };
  }

  it('mints attachment tokens per-id and isolates cross-workspace/cross-call rows', async () => {
    const fixtures: Record<string, RecordingFixture> = {
      [REC_A]: { id: REC_A, storage_path: 'a.mp4', call_session_id: CALL_ID, call_sessions: { workspace_id: WS_OK } },
      [REC_B]: { id: REC_B, storage_path: 'b.mp4', call_session_id: CALL_ID, call_sessions: { workspace_id: WS_OK } },
      [REC_OTHER_WS]: { id: REC_OTHER_WS, storage_path: 'x.mp4', call_session_id: CALL_ID, call_sessions: { workspace_id: WS_OTHER } },
    };
    tableState['call_recordings'] = (_op: string, eqs: Array<[string, unknown]>) => {
      const idEq = eqs.find(([c]) => c === 'id');
      const row = idEq ? fixtures[idEq[1] as string] : null;
      return { data: row ?? null, error: null };
    };
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID },
      query: { workspaceId: WS_OK },
      body: { recording_ids: [REC_A, REC_B, REC_OTHER_WS, REC_A] }, // duplicate is deduped
    });
    await handler(req, res);
    const { statusCode, jsonBody } = get();
    expect(statusCode).toBe(200);
    // deduped: 3 unique ids
    expect(jsonBody.count).toBe(3);
    const byId: Record<string, TokenResult> = {};
    for (const r of jsonBody.results ?? []) byId[r.recording_id] = r;
    expect(byId[REC_A].disposition).toBe('attachment');
    expect(byId[REC_A].url).toContain('disposition=attachment');
    expect(byId[REC_B].disposition).toBe('attachment');
    // Cross-workspace row returns the same uniform not_found, no token leak.
    expect(byId[REC_OTHER_WS].error).toBe('not_found');
    expect(byId[REC_OTHER_WS]).not.toHaveProperty('url');
    // No provider URL / storage_path leakage anywhere in the response.
    const s = JSON.stringify(jsonBody);
    expect(s).not.toContain('storage_path');
    expect(s).not.toContain('a.mp4');
    expect(s).not.toContain('b.mp4');
    expect(s).not.toContain('x.mp4');
  });

  it('rejects empty and oversized batches', async () => {
    {
      const { req, res, get } = makeReqRes({
        params: { id: CALL_ID }, query: { workspaceId: WS_OK }, body: { recording_ids: [] },
      });
      await handler(req, res);
      expect(get().statusCode).toBe(400);
      expect(get().jsonBody.error).toBe('recording_ids_required');
    }
    {
      const tooMany = Array.from({ length: 26 }, (_, i) =>
        `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, '0')}`,
      );
      const { req, res, get } = makeReqRes({
        params: { id: CALL_ID }, query: { workspaceId: WS_OK }, body: { recording_ids: tooMany },
      });
      await handler(req, res);
      expect(get().statusCode).toBe(400);
      expect(get().jsonBody.error).toBe('too_many_recordings');
    }
  });

  it('rejects malformed recording ids before any lookup', async () => {
    const { req, res, get } = makeReqRes({
      params: { id: CALL_ID }, query: { workspaceId: WS_OK },
      body: { recording_ids: ['not-a-uuid'] },
    });
    await handler(req, res);
    expect(get().statusCode).toBe(400);
    expect(get().jsonBody.error).toBe('invalid_recording_id');
  });
});

describe('POST /calls/:id/recordings/archive', () => {
  const handler = findHandler('post', '/calls/:id/recordings/archive');
  const REC_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const REC_OTHER_WS = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  interface ArchiveRecordingFixture {
    id: string;
    storage_path: string;
    recording_type: string;
    created_at: string;
    call_session_id: string;
    call_sessions: { workspace_id: string };
  }

  function makeRes() {
    let statusCode = 200;
    let jsonBody: MockJsonBody = {};
    let sent: Buffer | string | null = null;
    const headers: Record<string, string> = {};
    const res: MockRes = {
      status(c: number) { statusCode = c; return res; },
      json(b: MockJsonBody) { jsonBody = b; return res; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
      send(b: Buffer | string) { sent = b; return res; },
    };
    return { res, get: () => ({ statusCode, jsonBody, sent, headers }) };
  }

  it('returns a ZIP for authorized recordings and excludes cross-workspace rows via manifest', async () => {
    const fixtures: Record<string, ArchiveRecordingFixture> = {
      [REC_A]: { id: REC_A, storage_path: 'a.mp4', recording_type: 'composite', created_at: '2025-01-01T00:00:00Z', call_session_id: CALL_ID, call_sessions: { workspace_id: WS_OK } },
      [REC_OTHER_WS]: { id: REC_OTHER_WS, storage_path: 'x.mp4', recording_type: 'composite', created_at: '2025-01-01T00:00:00Z', call_session_id: CALL_ID, call_sessions: { workspace_id: WS_OTHER } },
    };
    tableState['call_recordings'] = (_op: string, eqs: Array<[string, unknown]>) => {
      const idEq = eqs.find(([c]) => c === 'id');
      const row = idEq ? fixtures[idEq[1] as string] : null;
      return { data: row ?? null, error: null };
    };
    const req: MockReq = {
      params: { id: CALL_ID },
      query: { workspaceId: WS_OK },
      body: { recording_ids: [REC_A, REC_OTHER_WS] },
      headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
      serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
    };
    const { res, get } = makeRes();
    await handler(req, res);
    const { statusCode, sent, headers } = get();
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toBe('application/zip');
    expect(headers['content-disposition']).toContain('attachment;');
    expect(headers['x-archive-included']).toBe('1');
    expect(headers['x-archive-excluded']).toBe('1');
    // PK\x03\x04 magic
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect((sent as Buffer).slice(0, 4).toString('hex')).toBe('504b0304');
    // Storage path of cross-workspace row must not appear in the response.
    expect((sent as Buffer).toString('binary')).not.toContain('x.mp4');
  });

  it('returns 404 when no recording could be packaged', async () => {
    tableState['call_recordings'] = () => ({ data: null, error: null });
    const req: MockReq = {
      params: { id: CALL_ID },
      query: { workspaceId: WS_OK },
      body: { recording_ids: [REC_A] },
      headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
      serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
    };
    const { res, get } = makeRes();
    await handler(req, res);
    expect(get().statusCode).toBe(404);
    expect(get().jsonBody.error).toBe('no_recordings_available');
  });

  it('rejects oversized batches and empty bodies before any lookup', async () => {
    {
      const req: MockReq = {
        params: { id: CALL_ID },
        query: { workspaceId: WS_OK },
        body: { recording_ids: [] },
        headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
        serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
      };
      const { res, get } = makeRes();
      await handler(req, res);
      expect(get().statusCode).toBe(400);
      expect(get().jsonBody.error).toBe('recording_ids_required');
    }
    {
      const tooMany = Array.from({ length: 26 }, (_, i) =>
        `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, '0')}`,
      );
      const req: MockReq = {
        params: { id: CALL_ID },
        query: { workspaceId: WS_OK },
        body: { recording_ids: tooMany },
        headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
        serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
      };
      const { res, get } = makeRes();
      await handler(req, res);
      expect(get().statusCode).toBe(400);
      expect(get().jsonBody.error).toBe('too_many_recordings');
    }
  });
});

describe('POST /workspaces/recordings/archive (multi-call)', () => {
  const handler = findHandler('post', '/workspaces/recordings/archive');
  const CALL_A = 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa';
  const CALL_B = 'aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa';
  const REC_A1 = 'dddddddd-1111-dddd-dddd-dddddddddddd';
  const REC_B1 = 'dddddddd-2222-dddd-dddd-dddddddddddd';
  const REC_OTHER_WS = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  interface ArchiveRecordingFixture {
    id: string;
    storage_path: string;
    recording_type: string;
    created_at: string;
    call_session_id: string;
    call_sessions: { workspace_id: string };
  }

  function makeRes() {
    let statusCode = 200;
    let jsonBody: MockJsonBody = {};
    let sent: Buffer | string | null = null;
    const headers: Record<string, string> = {};
    const res: MockRes = {
      status(c: number) { statusCode = c; return res; },
      json(b: MockJsonBody) { jsonBody = b; return res; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
      send(b: Buffer | string) { sent = b; return res; },
    };
    return { res, get: () => ({ statusCode, jsonBody, sent, headers }) };
  }

  it('packages recordings across multiple calls and isolates cross-workspace items', async () => {
    const fixtures: Record<string, ArchiveRecordingFixture> = {
      [REC_A1]: { id: REC_A1, storage_path: 'a1.mp4', recording_type: 'composite', created_at: '2025-01-01T00:00:00Z', call_session_id: CALL_A, call_sessions: { workspace_id: WS_OK } },
      [REC_B1]: { id: REC_B1, storage_path: 'b1.mp4', recording_type: 'composite', created_at: '2025-01-01T00:00:00Z', call_session_id: CALL_B, call_sessions: { workspace_id: WS_OK } },
      [REC_OTHER_WS]: { id: REC_OTHER_WS, storage_path: 'x.mp4', recording_type: 'composite', created_at: '2025-01-01T00:00:00Z', call_session_id: CALL_A, call_sessions: { workspace_id: WS_OTHER } },
    };
    tableState['call_recordings'] = (_op: string, eqs: Array<[string, unknown]>) => {
      const idEq = eqs.find(([c]) => c === 'id');
      const row = idEq ? fixtures[idEq[1] as string] : null;
      return { data: row ?? null, error: null };
    };
    const req: MockReq = {
      query: { workspaceId: WS_OK },
      body: { items: [
        { call_id: CALL_A, recording_id: REC_A1 },
        { call_id: CALL_B, recording_id: REC_B1 },
        { call_id: CALL_A, recording_id: REC_OTHER_WS },
      ] },
      headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
      serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
    };
    const { res, get } = makeRes();
    await handler(req, res);
    const { statusCode, sent, headers } = get();
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toBe('application/zip');
    expect(headers['x-archive-included']).toBe('2');
    expect(headers['x-archive-excluded']).toBe('1');
    expect(headers['x-archive-calls']).toBe('2');
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect((sent as Buffer).slice(0, 4).toString('hex')).toBe('504b0304');
    // Cross-workspace storage path must never appear in the ZIP bytes.
    expect((sent as Buffer).toString('binary')).not.toContain('x.mp4');
  });

  it('rejects when a recording_id is bound to a different call than supplied (no cross-call leak)', async () => {
    // recording lives on CALL_B but caller claims it belongs to CALL_A
    tableState['call_recordings'] = () => ({
      data: { id: REC_B1, storage_path: 'b1.mp4', recording_type: 'composite', created_at: '2025-01-01T00:00:00Z', call_session_id: CALL_B, call_sessions: { workspace_id: WS_OK } },
      error: null,
    });
    const req: MockReq = {
      query: { workspaceId: WS_OK },
      body: { items: [{ call_id: CALL_A, recording_id: REC_B1 }] },
      headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
      serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
    };
    const { res, get } = makeRes();
    await handler(req, res);
    expect(get().statusCode).toBe(404);
    expect(get().jsonBody.error).toBe('no_recordings_available');
  });

  it('rejects empty, oversized, and malformed item lists', async () => {
    {
      const req: MockReq = {
        query: { workspaceId: WS_OK }, body: { items: [] },
        headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
        serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
      };
      const { res, get } = makeRes();
      await handler(req, res);
      expect(get().statusCode).toBe(400);
      expect(get().jsonBody.error).toBe('items_required');
    }
    {
      const items = Array.from({ length: 26 }, (_, i) => ({
        call_id: CALL_A,
        recording_id: `dddddddd-dddd-dddd-dddd-${String(i).padStart(12, '0')}`,
      }));
      const req: MockReq = {
        query: { workspaceId: WS_OK }, body: { items },
        headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
        serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
      };
      const { res, get } = makeRes();
      await handler(req, res);
      expect(get().statusCode).toBe(400);
      expect(get().jsonBody.error).toBe('too_many_recordings');
    }
    {
      const req: MockReq = {
        query: { workspaceId: WS_OK },
        body: { items: [{ call_id: 'nope', recording_id: REC_A1 }] },
        headers: { authorization: 'Bearer t' },
      cookies: { gs_session: 't' },
        serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k-operator-test-secret' },
      };
      const { res, get } = makeRes();
      await handler(req, res);
      expect(get().statusCode).toBe(400);
      expect(get().jsonBody.error).toBe('invalid_call_id');
    }
  });
});
