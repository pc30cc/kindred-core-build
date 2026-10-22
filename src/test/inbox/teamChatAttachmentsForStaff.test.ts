// @vitest-environment node
/**
 * Team chat is for every member, staff without an Inbox included (the
 * panel's /team-chat page), and its files go through the operator
 * attachment routes with `conversation_id = NULL`. Those routes used to be
 * the Inbox's only, so staff got 403 `inbox_not_allowed` when attaching or
 * opening a file in team chat.
 *
 * Now: a row bound to a conversation keeps the Inbox's door; a team-chat row
 * is reserved by any member, uploaded or deleted by its uploader, and opened
 * by its uploader or by the sender or recipient of the team message that
 * carries it. Inbox roles open any row of their workspace, as before.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  auth: { userId: 'u-staff', isAdmin: false, role: 'analyst' as string | null },
  nextId: 1,
}));

/** Just enough of the supabase-js builder for these routes, over state.tables. */
function fakeClient() {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const rows = (state.tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row | null = null;
      let lim: number | null = null;
      const run = (): Row[] => {
        if (op === 'insert') {
          const row = { id: `att-new-${state.nextId++}`, ...payload };
          rows.push(row);
          return [row];
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') for (const r of hit) Object.assign(r, payload);
        if (op === 'delete') state.tables[table] = rows.filter((r) => !hit.includes(r));
        return lim === null ? hit : hit.slice(0, lim);
      };
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
        or: (expr: string) => {
          const parts = expr.split(',').map((p) => {
            const [col, , ...rest] = p.split('.');
            return [col, rest.join('.')] as const;
          });
          filters.push((r) => parts.some(([col, val]) => r[col] === val));
          return b;
        },
        limit: (n: number) => { lim = n; return b; },
        insert: (p: Row) => { op = 'insert'; payload = p; return b; },
        update: (p: Row) => { op = 'update'; payload = p; return b; },
        delete: () => { op = 'delete'; return b; },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        single: async () => ({ data: run()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(ok, ko),
      };
      return b;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  serverConfigOf: () => ({}),
  authorizeWorkspaceAccess: async () => state.auth,
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  requireLimit: () => async (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../server/services/billing/usageResolvers.js', () => ({
  usageFnForLimit: () => () => 0,
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  uploadFile: async () => ({ success: true, provider: 'local' }),
  resolveStorageConfig: async () => ({ provider: 'local' }),
  downloadFileRange: async () => ({ success: true, data: Buffer.from('bytes'), status: 200, contentLength: 5 }),
}));

const { conversationAttachmentsRouter } = await import('../../../server/routes/conversationAttachments.js');

const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const CONV = '1a2b3c4d-1f2a-4b3c-9d4e-5f6a7b8c9d0e';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/conversation-attachments', conversationAttachmentsRouter);
  return a;
}

function attachment(id: string, over: Row = {}): Row {
  return {
    id,
    workspace_id: WS,
    conversation_id: null,
    storage_path: `workspace/${WS}/attachments/chat/2026/10/${id}-photo.png`,
    file_name: 'photo.png',
    mime_type: 'image/png',
    size_bytes: 5,
    status: 'attached',
    uploaded_by_type: 'agent',
    uploaded_by_id: 'u-colleague',
    ...over,
  };
}

const asStaff = () => { state.auth = { userId: 'u-staff', isAdmin: false, role: 'analyst' }; };
const asAgent = () => { state.auth = { userId: 'u-agent', isAdmin: false, role: 'agent' }; };

beforeEach(() => {
  asStaff();
  state.nextId = 1;
  state.tables = {
    conversations: [{ id: CONV, workspace_id: WS }],
    conversation_attachments: [
      attachment('att-mine', { uploaded_by_id: 'u-staff', status: 'uploading' }),
      attachment('att-mine-sent', { uploaded_by_id: 'u-staff' }),
      attachment('att-to-me'),
      attachment('att-between-others'),
      attachment('att-inbox', { conversation_id: CONV, uploaded_by_id: 'u-staff', status: 'uploaded' }),
    ],
    team_messages: [
      { id: 'tm-1', workspace_id: WS, sender_id: 'u-colleague', recipient_id: 'u-staff', attachment_id: 'att-to-me' },
      { id: 'tm-2', workspace_id: WS, sender_id: 'u-colleague', recipient_id: 'u-other', attachment_id: 'att-between-others' },
    ],
  };
});

describe('team-chat attachments for staff without an Inbox', () => {
  it('reserves a team-chat file (no conversation) for any member', async () => {
    const res = await request(app()).post('/api/conversation-attachments/init').send({
      workspace_id: WS, conversation_id: null, file_name: 'photo.png', mime_type: 'image/png', size_bytes: 5,
    });
    expect(res.status).toBe(200);
    const row = state.tables.conversation_attachments.find((r) => r.id === res.body.attachment_id);
    expect(row).toMatchObject({ conversation_id: null, uploaded_by_type: 'agent', uploaded_by_id: 'u-staff', status: 'uploading' });
  });

  it('keeps the Inbox door for a reservation bound to a conversation', async () => {
    const res = await request(app()).post('/api/conversation-attachments/init').send({
      workspace_id: WS, conversation_id: CONV, file_name: 'photo.png', mime_type: 'image/png', size_bytes: 5,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('inbox_not_allowed');
  });

  it('uploads its own team-chat file, but not into a conversation\'s row', async () => {
    const data = Buffer.from('bytes').toString('base64');
    const ok = await request(app()).post('/api/conversation-attachments/att-mine/upload').send({ workspace_id: WS, data });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('uploaded');

    state.tables.conversation_attachments.find((r) => r.id === 'att-inbox')!.status = 'uploading';
    const refused = await request(app()).post('/api/conversation-attachments/att-inbox/upload').send({ workspace_id: WS, data });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('inbox_not_allowed');
  });

  it('deletes its own team-chat file, but not a conversation\'s', async () => {
    const ok = await request(app()).delete(`/api/conversation-attachments/att-mine?workspace_id=${WS}`);
    expect(ok.status).toBe(200);
    expect(state.tables.conversation_attachments.some((r) => r.id === 'att-mine')).toBe(false);

    const refused = await request(app()).delete(`/api/conversation-attachments/att-inbox?workspace_id=${WS}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('inbox_not_allowed');
    expect(state.tables.conversation_attachments.some((r) => r.id === 'att-inbox')).toBe(true);
  });

  it('still lets only the uploader delete a team-chat file', async () => {
    const res = await request(app()).delete(`/api/conversation-attachments/att-to-me?workspace_id=${WS}`);
    expect(res.status).toBe(403);
    expect(state.tables.conversation_attachments.some((r) => r.id === 'att-to-me')).toBe(true);
  });

  it('opens a team-chat file it sent or received, and no other', async () => {
    expect((await request(app()).get('/api/conversation-attachments/att-mine-sent/file')).status).toBe(200);
    expect((await request(app()).get('/api/conversation-attachments/att-to-me/file')).status).toBe(200);

    const others = await request(app()).get('/api/conversation-attachments/att-between-others/file');
    expect(others.status).toBe(403);
    expect(others.body.error).toBe('forbidden');

    const inbox = await request(app()).get('/api/conversation-attachments/att-inbox/file');
    expect(inbox.status).toBe(403);
    expect(inbox.body.error).toBe('inbox_not_allowed');
  });
});

describe('Inbox roles keep what they had', () => {
  it('reserve for a conversation and open any file of the workspace', async () => {
    asAgent();
    const init = await request(app()).post('/api/conversation-attachments/init').send({
      workspace_id: WS, conversation_id: CONV, file_name: 'photo.png', mime_type: 'image/png', size_bytes: 5,
    });
    expect(init.status).toBe(200);
    expect((await request(app()).get('/api/conversation-attachments/att-inbox/file')).status).toBe(200);
    expect((await request(app()).get('/api/conversation-attachments/att-between-others/file')).status).toBe(200);
  });
});
