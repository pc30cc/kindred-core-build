/**
 * POST /api/conversations/typing — the operator's typing event names who
 * types (g4 f4, server side).
 *
 * The envelope published on the conversation channel carries the typing
 * operator's PUBLIC identity, exactly what the visitor sees on their
 * messages: `name` (profiles.full_name, cleaned) and `avatar` (the same
 * hydrated link /history gives), each only when known, never an id, e-mail or
 * role. The profile is read once a minute per operator, not on every
 * keystroke burst; without a profile, or when the read fails, the event goes
 * out as before. The suppression switch still drops it before any read.
 *
 * The REAL conversationsRouter runs in-process against an in-memory fake of
 * the data layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  profileReads: 0,
  failProfiles: false,
  suppressed: false,
  userId: '',
  published: [] as Array<{ ws: string; cid: string; envelope: { type: string; payload: Record<string, unknown> } }>,
}));

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => (state.tables[table] || []).filter((r) => filters.every((f) => f(r)));
  const b: Record<string, unknown> = {
    select: () => {
      if (table === 'profiles') {
        state.profileReads += 1;
        if (state.failProfiles) throw new Error('connection reset');
      }
      return b;
    },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) => res({ data: rows(), error: null }),
  };
  return b;
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: builder, rpc: async () => ({ data: null, error: null }) }) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: state.userId, isAdmin: false, role: 'agent' }),
}));
vi.mock('../../../server/services/observability/autoActionsCache.js', () => ({
  isActionActive: (a: string) => a === 'disable_typing_temporarily' && state.suppressed,
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = r.avatar_storage_key ? `https://cdn.test/${r.avatar_storage_key}` : null; delete r.avatar_storage_key; }
    return rows;
  },
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishConversationEvent: async (_c: unknown, ws: string, cid: string, envelope: { type: string; payload: Record<string, unknown> }) => {
    state.published.push({ ws, cid, envelope });
    return { ok: true };
  },
  publishOperatorEvent: async () => undefined,
  buildMessageEnvelope: (m: unknown) => ({ type: 'message', payload: m }),
}));

const { conversationsRouter } = await import('../../../server/routes/conversations.js');
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/conversations', conversationsRouter);
const server = http.createServer(app).listen(0);

const WS = crypto.randomUUID();
const CID = crypto.randomUUID();

function typing(): Promise<{ status: number; body: Row }> {
  const payload = JSON.stringify({ workspace_id: WS, conversation_id: CID });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/conversations/typing', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** A new operator per test: the identity cache is per process. */
function operator(profile: Row | null) {
  state.userId = crypto.randomUUID();
  state.tables.profiles = profile ? [{ id: state.userId, email: 'sara@shop.test', role: 'admin', ...profile }] : [];
}

beforeEach(() => {
  state.tables = { conversations: [{ id: CID, workspace_id: WS }] };
  state.profileReads = 0;
  state.failProfiles = false;
  state.suppressed = false;
  state.published.length = 0;
});

describe('operator typing payload', () => {
  it('carries the operator\'s public name and avatar, and nothing else about them', async () => {
    operator({ full_name: 'سارا رضایی', avatar_storage_key: 'avatars/sara.png' });
    const res = await typing();
    expect(res).toEqual({ status: 200, body: { ok: true, published: true } });
    expect(state.published).toHaveLength(1);
    const { ws, cid, envelope } = state.published[0];
    expect([ws, cid, envelope.type]).toEqual([WS, CID, 'typing']);
    expect(Object.keys(envelope.payload)).toEqual(['actor', 'conversation_id', 'ts', 'name', 'avatar']);
    expect(envelope.payload).toMatchObject({ actor: 'agent', conversation_id: CID, name: 'سارا رضایی', avatar: 'https://cdn.test/avatars/sara.png' });
    expect(typeof envelope.payload.ts).toBe('number');
    const text = JSON.stringify(envelope);
    expect(text).not.toContain(state.userId);
    expect(text).not.toContain('sara@shop.test');
    expect(text).not.toContain('admin');
  });

  it('reads the profile once a minute, not on every typing event', async () => {
    operator({ full_name: 'Sara', avatar_storage_key: null });
    await typing();
    await typing();
    await typing();
    expect(state.profileReads).toBe(1);
    expect(state.published.map((p) => p.envelope.payload.name)).toEqual(['Sara', 'Sara', 'Sara']);
    // No avatar: no field.
    expect(Object.keys(state.published[0].envelope.payload)).toEqual(['actor', 'conversation_id', 'ts', 'name']);
  });

  it('a name is cleaned: control characters out, trimmed, at most 80 characters', async () => {
    operator({ full_name: `  Sa\u0000ra\n\u0085 ${'😀'.repeat(100)}  ` });
    await typing();
    const name = String(state.published[0].envelope.payload.name);
    expect(name.startsWith('Sara ')).toBe(true);
    expect(Array.from(name)).toHaveLength(80);
    // eslint-disable-next-line no-control-regex
    expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(name.endsWith('😀')).toBe(true);
  });

  it('without a profile, or when the read fails, the event goes out as before', async () => {
    operator(null);
    await typing();
    operator({ full_name: '   ', avatar_storage_key: null });
    await typing();
    operator({ full_name: 'Sara' });
    state.failProfiles = true;
    const res = await typing();
    expect(res.status).toBe(200);
    expect(state.published.map((p) => Object.keys(p.envelope.payload))).toEqual([
      ['actor', 'conversation_id', 'ts'],
      ['actor', 'conversation_id', 'ts'],
      ['actor', 'conversation_id', 'ts'],
    ]);
  });

  it('the suppression switch drops the event before any profile read', async () => {
    operator({ full_name: 'Sara' });
    state.suppressed = true;
    const res = await typing();
    expect(res.body).toEqual({ ok: true, published: false, reason: 'auto_action_suppressed' });
    expect(state.published).toHaveLength(0);
    expect(state.profileReads).toBe(0);
  });
});

describe('the inbox ignores the operator typing event\'s new fields', () => {
  it('InboxPage drops agent typing by its actor before reading anything else of it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');
    const start = src.indexOf('onTyping: (payload) => {');
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf('\n    },', start));
    // The only field it reads is `actor`; an agent's event returns at once.
    expect([...handler.matchAll(/payload as \{ (\w+)\?/g)].map((m) => m[1])).toEqual(['actor']);
    expect(handler).toContain("if (actor && actor !== 'visitor') return;");
    expect(handler).not.toMatch(/\bname\b|\bavatar\b/);
  });
});
