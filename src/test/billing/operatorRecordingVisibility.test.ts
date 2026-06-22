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
const tableState: Record<string, any> = {};

const sbMock: any = {
  auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
  rpc: async (name: string) => {
    if (name === 'is_workspace_member') return { data: true, error: null };
    if (name === 'get_workspace_role') return { data: 'owner', error: null };
    return { data: null, error: null };
  },
  from(name: string) {
    const handler = tableState[name];
    const builder: any = {
      _eqs: [] as Array<[string, any]>,
      select() { return builder; },
      eq(col: string, val: any) { builder._eqs.push([col, val]); return builder; },
      order() { return builder; },
      maybeSingle: async () => (handler ? handler('maybeSingle', builder._eqs) : { data: null, error: null }),
      then: undefined,
    };
    // Allow `await sb.from(x).select().eq().order()` to resolve as a list.
    builder[Symbol.toPrimitive] = undefined;
    Object.defineProperty(builder, 'then', {
      value: (resolve: any) => resolve(handler ? handler('list', builder._eqs) : { data: [], error: null }),
    });
    return builder;
  },
};

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => sbMock }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));

import { callCenterRouter } from '../../../server/routes/callCenter';

function findHandler(method: string, path: string) {
  const layer = callCenterRouter.stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stk = (layer as any).route.stack;
  return stk[stk.length - 1].handle;
}

function makeReqRes(opts: { params?: any; query?: any; body?: any } = {}) {
  const req: any = {
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    headers: { authorization: 'Bearer t' },
    serverConfig: {
      supabaseUrl: 'http://x',
      supabaseServiceRoleKey: 'k-operator-test-secret',
    },
  };
  let statusCode = 200;
  let jsonBody: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { jsonBody = b; return res; },
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
    expect(jsonBody.recordings[0].has_storage).toBe(true);
    expect(jsonBody.recordings[0]).not.toHaveProperty('storage_path');
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
