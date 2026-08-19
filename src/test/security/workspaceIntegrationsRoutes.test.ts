/**
 * GoTrue-off closure (item 6) — email logs, contact channel badges/call
 * history, workspace provider settings, workspace privacy-export storage
 * override, and workspace email templates. These used to be direct
 * browser supabase.from() calls relying on auth.uid()-scoped RLS
 * (owner/admin for email_logs/workspace_provider_settings/provider_configs/
 * email_templates, plain membership for conversations/call_sessions/
 * call_recordings) — all silently broken under first-party auth. Now
 * routed through server/routes/workspaceIntegrations.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        not(col: string, op: string, val: any) {
          if (op === 'is' && val === null) filters.push((r: Row) => r[col] !== null && r[col] !== undefined);
          return builder;
        },
        in(col: string, vals: any[]) { filters.push((r: Row) => vals.includes(r[col])); return builder; },
        order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending ?? true; return builder; },
        limit(n: number) { limitN = n; return builder; },
        insert(payload: Row) {
          const inserted = { id: payload.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
          rows.push(inserted);
          return {
            select: () => ({ single: async () => ({ data: inserted, error: null }) }),
            then: (resolve: any) => resolve({ data: [inserted], error: null }),
          };
        },
        upsert(payload: Row, opts?: { onConflict?: string }) {
          const keys = (opts?.onConflict || 'id').split(',');
          const idx = rows.findIndex((r) => keys.every((k) => r[k] === payload[k]));
          let row: Row;
          if (idx >= 0) { Object.assign(rows[idx], payload); row = rows[idx]; }
          else { row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload }; rows.push(row); }
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            then(resolve: any) {
              for (const r of rows) if (scoped.every((f) => f(r))) Object.assign(r, patch);
              return resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const deleteBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return deleteBuilder; },
            then(resolve: any) {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              return resolve({ data: null, error: null });
            },
          };
          return deleteBuilder;
        },
        maybeSingle: async () => {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          if (limitN != null) matched = matched.slice(0, limitN);
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          if (limitN != null) matched = matched.slice(0, limitN);
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      if (name === 'is_workspace_member') {
        const member = (db.workspace_members || []).find(
          (m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id,
        );
        return { data: !!member, error: null };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 's1', userId: user.userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { workspaceIntegrationsRouter } = await import('../../../server/routes/workspaceIntegrations.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/workspace-integrations', workspaceIntegrationsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const WS_A = crypto.randomUUID();
const WS_B = crypto.randomUUID();
const OWNER_A = crypto.randomUUID();
const AGENT_A = crypto.randomUUID();
const OWNER_B = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'owner-a-token', userId: OWNER_A },
    { token: 'agent-a-token', userId: AGENT_A },
    { token: 'owner-b-token', userId: OWNER_B },
  ];
  db.workspace_members = [
    { workspace_id: WS_A, user_id: OWNER_A, role: 'owner' },
    { workspace_id: WS_A, user_id: AGENT_A, role: 'agent' },
    { workspace_id: WS_B, user_id: OWNER_B, role: 'owner' },
  ];
});

describe('GET /:workspaceId/email-logs — owner/admin only', () => {
  beforeEach(() => {
    db.email_logs = [
      { id: 'l1', workspace_id: WS_A, status: 'sent', created_at: '2026-01-01', recipient_email: 'x@a.com', subject: 's', provider_name: 'p' },
      { id: 'l2', workspace_id: WS_B, status: 'sent', created_at: '2026-01-01', recipient_email: 'y@b.com', subject: 's', provider_name: 'p' },
    ];
  });

  it('owner can read their workspace email logs', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/email-logs`, 'owner-a-token');
    expect(res.status).toBe(200);
    expect(res.json.logs.map((l: any) => l.id)).toEqual(['l1']);
  });

  it('plain member (non owner/admin) is denied', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/email-logs`, 'agent-a-token');
    expect(res.status).toBe(403);
  });

  it('cannot read another workspace\'s email logs even as its own owner', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_B}/email-logs`, 'owner-a-token');
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/email-logs`, null);
    expect(res.status).toBe(401);
  });
});

describe('GET /:workspaceId/contact-channels — member level', () => {
  beforeEach(() => {
    db.conversations = [
      { id: 'c1', workspace_id: WS_A, contact_id: 'contact-1' },
      { id: 'c2', workspace_id: WS_A, contact_id: 'contact-2' },
      { id: 'c3', workspace_id: WS_B, contact_id: 'contact-3' },
    ];
    db.call_sessions = [
      { id: 'call1', context_type: 'conversation', context_id: 'c2', created_at: '2026-01-02' },
    ];
  });

  it('member can read channel badges for their own workspace', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/contact-channels`, 'agent-a-token');
    expect(res.status).toBe(200);
    expect(res.json.channels['contact-1']).toEqual({ chat: true, call: false, calls: 0, lastCallAt: null });
    expect(res.json.channels['contact-2'].call).toBe(true);
    expect(res.json.channels['contact-3']).toBeUndefined();
  });

  it('non-member of the workspace is denied', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/contact-channels`, 'owner-b-token');
    expect(res.status).toBe(403);
  });
});

describe('GET /:workspaceId/contacts/:contactId/calls — tenant isolation', () => {
  beforeEach(() => {
    db.contacts = [
      { id: 'contact-1', workspace_id: WS_A },
      { id: 'contact-x', workspace_id: WS_B },
    ];
    db.conversations = [{ id: 'c1', contact_id: 'contact-1' }];
    db.call_sessions = [{ id: 'call1', context_type: 'conversation', context_id: 'c1', created_at: '2026-01-02', assigned_agent_id: null }];
  });

  it('returns call history for a contact in the caller\'s own workspace', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/contacts/contact-1/calls`, 'owner-a-token');
    expect(res.status).toBe(200);
    expect(res.json.calls).toHaveLength(1);
  });

  it('a contact belonging to a DIFFERENT workspace 404s, even under a valid workspaceId the caller owns', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/contacts/contact-x/calls`, 'owner-a-token');
    expect(res.status).toBe(404);
  });

  it('cannot query another workspace\'s contact at all (denied at the workspace gate)', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_B}/contacts/contact-x/calls`, 'owner-a-token');
    expect(res.status).toBe(403);
  });
});

describe('workspace provider settings — manage:true (owner/admin only)', () => {
  it('owner can read, upsert, and delete a provider setting', async () => {
    const put = await call('PUT', `/api/workspace-integrations/${WS_A}/providers`, 'owner-a-token', {
      provider_type: 'email', provider_name: 'resend', enabled: true, config: {}, secrets: {},
    });
    expect(put.status).toBe(200);
    expect(put.json.setting.workspace_id).toBe(WS_A);

    const get = await call('GET', `/api/workspace-integrations/${WS_A}/providers`, 'owner-a-token');
    expect(get.json.settings).toHaveLength(1);

    const del = await call('DELETE', `/api/workspace-integrations/${WS_A}/providers/email`, 'owner-a-token');
    expect(del.status).toBe(200);
    const after = await call('GET', `/api/workspace-integrations/${WS_A}/providers`, 'owner-a-token');
    expect(after.json.settings).toHaveLength(0);
  });

  it('a plain member cannot read or write provider settings', async () => {
    expect((await call('GET', `/api/workspace-integrations/${WS_A}/providers`, 'agent-a-token')).status).toBe(403);
    expect((await call('PUT', `/api/workspace-integrations/${WS_A}/providers`, 'agent-a-token', {
      provider_type: 'email', provider_name: 'x', enabled: true, config: {}, secrets: {},
    })).status).toBe(403);
  });

  it('rejects an invalid provider_type', async () => {
    const res = await call('PUT', `/api/workspace-integrations/${WS_A}/providers`, 'owner-a-token', {
      provider_type: 'not-a-real-type', provider_name: 'x', enabled: true, config: {}, secrets: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('workspace privacy-export storage override — manage:true', () => {
  it('owner can set and read the storage override; a previous override is deactivated, not left dangling active', async () => {
    const first = await call('PUT', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'owner-a-token', {
      provider_name: 's3', config: { bucket: 'one' },
    });
    expect(first.status).toBe(200);

    const second = await call('PUT', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'owner-a-token', {
      provider_name: 'minio', config: { bucket: 'two' },
    });
    expect(second.status).toBe(200);

    const activeRows = db.provider_configs.filter((r) => r.workspace_id === WS_A && r.is_active);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].provider_name).toBe('minio');

    const get = await call('GET', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'owner-a-token');
    expect(get.json.storage.provider_name).toBe('minio');
  });

  it('a plain member cannot set the storage override', async () => {
    const res = await call('PUT', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'agent-a-token', {
      provider_name: 's3', config: {},
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid provider_name', async () => {
    const res = await call('PUT', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'owner-a-token', {
      provider_name: 'not-a-real-provider', config: {},
    });
    expect(res.status).toBe(400);
  });

  it('owner can clear the override', async () => {
    await call('PUT', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'owner-a-token', { provider_name: 's3', config: {} });
    const del = await call('DELETE', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'owner-a-token');
    expect(del.status).toBe(200);
    const get = await call('GET', `/api/workspace-integrations/${WS_A}/privacy-storage`, 'owner-a-token');
    expect(get.json.storage).toBeNull();
  });
});

describe('workspace email templates — manage:true', () => {
  beforeEach(() => {
    db.email_templates = [
      { id: 't1', workspace_id: WS_A, slug: 'welcome', locale: 'en' },
      { id: 't2', workspace_id: WS_B, slug: 'welcome', locale: 'en' },
    ];
  });

  it('owner reads only their own workspace templates', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/email-templates`, 'owner-a-token');
    expect(res.status).toBe(200);
    expect(res.json.templates.map((t: any) => t.id)).toEqual(['t1']);
  });

  it('a plain member is denied', async () => {
    const res = await call('GET', `/api/workspace-integrations/${WS_A}/email-templates`, 'agent-a-token');
    expect(res.status).toBe(403);
  });
});
